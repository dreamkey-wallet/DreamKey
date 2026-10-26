/* Verify built-in EVM networks through the real Provider adapter, offline. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const Module = require('node:module');
const root = path.resolve(__dirname, '..');
const modules = new Map();

function load(relativePath) {
  const filename = path.join(root, relativePath);
  if (modules.has(filename)) return modules.get(filename).exports;
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
  } }).outputText;
  const entry = new Module(filename, module);
  entry.filename = filename;
  entry.paths = Module._nodeModulePaths(path.dirname(filename));
  const requireNormally = entry.require.bind(entry);
  entry.require = (specifier) => {
    const source = specifier.startsWith('.') ? path.resolve(path.dirname(filename), specifier.replace(/\.js$/, '.ts')) : undefined;
    return source && fs.existsSync(source) ? load(path.relative(root, source)) : requireNormally(specifier);
  };
  modules.set(filename, entry);
  entry._compile(compiled, filename);
  return entry.exports;
}

async function verify() {
  const { DEFAULT_NETWORKS } = load('src/core/networks.ts');
  const { createWalletProvider } = load('src/provider/wallet-core-adapter.ts');
  assert.deepEqual(DEFAULT_NETWORKS.map(({ chainId, nativeSymbol }) => [chainId, nativeSymbol]), [
    [56, 'BNB'], [1, 'ETH'], [42161, 'ETH'], [137, 'POL'], [8453, 'ETH'],
  ]);
  assert.equal(new Set(DEFAULT_NETWORKS.map(({ id }) => id)).size, DEFAULT_NETWORKS.length);
  assert.equal(new Set(DEFAULT_NETWORKS.map(({ rpcUrl }) => rpcUrl)).size, DEFAULT_NETWORKS.length);
  for (const network of DEFAULT_NETWORKS) {
    assert.ok(network.rpcFallbackUrls.length >= 1);
    for (const url of [network.rpcUrl, ...network.rpcFallbackUrls, network.explorerUrl]) assert.equal(new URL(url).protocol, 'https:');
  }
  const address = '0x1111111111111111111111111111111111111111';
  const reads = [];
  const sends = [];
  const wallet = {
    listNetworks: () => DEFAULT_NETWORKS,
    getNetwork: (id) => DEFAULT_NETWORKS.find((network) => network.id === id),
    listAccounts: () => [{ address, index: 0 }],
    getAccount: () => ({ address, index: 0 }),
    getRpcTransport: (networkId) => async (url, init) => {
      const payload = JSON.parse(init.body);
      reads.push({ networkId, url, method: payload.method });
      return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: payload.id, result: '0x123' }) };
    },
    getSigner: (index, networkId) => ({ sendTransaction: async (transaction) => {
      sends.push({ index, networkId, transaction }); return { hash: '0xfixture' };
    } }),
  };
  const provider = createWalletProvider(wallet, DEFAULT_NETWORKS[0].id, {
    approve: () => true, requestAccounts: () => [address],
  });
  const allowed = provider.forOrigin('https://allowed.example');
  const other = provider.forOrigin('https://other.example');
  await allowed.request({ method: 'eth_requestAccounts' });
  const events = [];
  provider.on('chainChanged', (chainId) => events.push(chainId));
  for (const network of DEFAULT_NETWORKS.slice(1)) {
    const chainId = `0x${network.chainId.toString(16)}`;
    await allowed.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] });
    assert.equal(provider.chainId, chainId);
    assert.equal(other.chainId, chainId);
    assert.deepEqual(await other.request({ method: 'eth_accounts' }), [], 'grants stay isolated across network switches');
    assert.equal(await allowed.request({ method: 'eth_blockNumber' }), '0x123');
    assert.deepEqual(reads.at(-1), { networkId: network.id, url: network.rpcUrl, method: 'eth_blockNumber' });
    await allowed.request({ method: 'wallet_addEthereumChain', params: [{ chainId, rpcUrls: ['https://attacker.invalid'] }] });
    assert.equal(provider.rpcUrl, network.rpcUrl, 'website cannot replace the built-in RPC');
    await allowed.request({ method: 'eth_sendTransaction', params: [{ from: address, to: address, value: '0x0' }] });
    assert.equal(sends.at(-1).networkId, network.id, 'approved transfer uses the selected chain');
  }
  assert.deepEqual(events, ['0x1', '0xa4b1', '0x89', '0x2105']);
  await assert.rejects(allowed.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x999' }] }), (error) => error.code === 4902);
  assert.equal(sends.length, 4, 'one captured send per approved request; no live broadcast');
  console.log('Network verification passed: five mainnet configurations, native currencies, chain events, shared RPC routing, signing chain, built-in endpoint protection and origin permissions. Offline fixtures only.');
}
verify().catch((error) => { console.error(error); process.exitCode = 1; });
