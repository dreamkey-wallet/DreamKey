/* Security-boundary checks use public accounts, fake RPCs and no user secrets. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const modules = new Map();

function load(relative) {
  const filename = path.join(root, relative);
  if (modules.has(filename)) return modules.get(filename).exports;
  const entry = new Module(filename, module);
  entry.filename = filename;
  entry.paths = Module._nodeModulePaths(path.dirname(filename));
  const requireNormally = entry.require.bind(entry);
  entry.require = (specifier) => {
    const source = specifier.startsWith('.') ? path.resolve(path.dirname(filename), specifier.replace(/\.js$/, '.ts')) : undefined;
    return source && fs.existsSync(source) ? load(path.relative(root, source)) : requireNormally(specifier);
  };
  modules.set(filename, entry);
  entry._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
  } }).outputText, filename);
  return entry.exports;
}

async function main() {
  const { WalletProvider } = load('src/provider/wallet-provider.ts');
  const { createWalletProvider } = load('src/provider/wallet-core-adapter.ts');
  const { PermissionManager } = load('src/provider/permissions.ts');
  const { evaluateDappUrl } = load('src/dapp/urlPolicy.ts');
  const { parseBridgeMessage } = load('src/dapp/providerBridge.ts');
  const account = `0x${'1'.repeat(40)}`;
  const origin = 'https://fixture.invalid';
  const rpcCalls = [];
  const network = { id: 'bsc', chainId: 56, rpcUrl: 'https://rpc.invalid' };
  let signedTransactions = [];
  let signedMessages = 0;
  const wallet = {
    getNetwork: () => network, listNetworks: () => [network],
    listAccounts: () => [{ address: account, index: 0 }], getAccount: () => ({ address: account, index: 0 }),
    signMessage: async () => { signedMessages += 1; return 'fixture-signature'; },
    getSigner: () => ({ sendTransaction: async (tx) => { signedTransactions.push(tx); return { hash: 'fixture-hash' }; } }),
  };
  const direct = new WalletProvider({
    ...network, accounts: [account], requestAccounts: () => [account],
    fetch: async (_url, init) => { rpcCalls.push(JSON.parse(init.body)); return { ok: true, status: 200, json: async () => ({ result: '0x0' }) }; },
  }).forOrigin(origin);
  await direct.request({ method: 'eth_requestAccounts' });
  for (const method of ['personal_unlockAccount', 'personal_signTransaction', 'eth_signTransaction', 'eth_sendRawTransaction', 'admin_addPeer', 'debug_setHead', 'wallet_sendCalls']) {
    await assert.rejects(direct.request({ method, params: [] }), (error) => error.code === 4200, method);
  }
  await assert.rejects(direct.request({ method: 'personal_sign', params: ['hello', account] }), (error) => error.code === 4200);
  await assert.rejects(direct.request({ method: 'eth_sendTransaction', params: [{ from: account, to: account }] }), (error) => error.code === 4200);
  assert.equal(rpcCalls.length, 0, 'unrecognized writes and signing methods never reach the configured RPC');
  await direct.request({ method: 'eth_getBalance', params: [account, 'latest'] });
  assert.equal(rpcCalls.length, 1, 'ordinary public chain reads remain available');

  const chainRoot = new WalletProvider({ ...network, rpcUrls: { 1: 'https://eth-rpc.invalid' }, accounts: [account], requestAccounts: () => [account] });
  const unconnected = chainRoot.forOrigin('https://unconnected.invalid');
  await assert.rejects(unconnected.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x1' }] }), (error) => error.code === 4100);
  assert.equal(chainRoot.chainId, '0x38', 'an unconnected origin cannot change the global network');
  await unconnected.request({ method: 'eth_requestAccounts' });
  await unconnected.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x1' }] });
  assert.equal(chainRoot.chainId, '0x1', 'connected sites retain configured-network switching');
  await unconnected.request({ method: 'wallet_revokePermissions', params: [{ eth_accounts: {} }] });
  await assert.rejects(unconnected.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x38' }] }), (error) => error.code === 4100);
  assert.equal(chainRoot.chainId, '0x1', 'revoked sites lose network-changing authority');

  const closed = createWalletProvider(wallet, 'bsc').forOrigin(origin);
  await assert.rejects(closed.request({ method: 'eth_requestAccounts' }), (error) => error.code === 4001, 'missing approval callback fails closed');
  const closedSigner = createWalletProvider(wallet, 'bsc', { requestAccounts: () => [account] }).forOrigin(origin);
  await closedSigner.request({ method: 'eth_requestAccounts' });
  await assert.rejects(closedSigner.request({ method: 'personal_sign', params: ['hello', account] }), (error) => error.code === 4001);
  assert.equal(signedMessages, 0, 'missing signing approval callback cannot sign');

  const previews = [];
  const rootProvider = createWalletProvider(wallet, 'bsc', {
    requestAccounts: () => [account], approve: (request) => { previews.push(request); return true; },
  });
  const site = rootProvider.forOrigin(origin);
  await site.request({ method: 'eth_requestAccounts' });
  await site.request({ method: 'eth_sendTransaction', params: [{ from: account, to: account, gas: '0x5208', input: '0xaabb', value: '0x0' }] });
  assert.equal(previews.at(-1).params[0].data, '0xaabb', 'input alias is visible to approval as calldata');
  assert.equal(signedTransactions.at(-1).gasLimit, '0x5208', 'the exact reviewed JSON-RPC gas reaches the ethers signer');
  assert.equal(signedTransactions.at(-1).gas, undefined);
  assert.equal(signedTransactions.at(-1).input, undefined);
  const submitted = signedTransactions.length;
  const previewed = previews.length;
  for (const fields of [
    { data: '0xaabb', input: '0xccdd' }, { gas: '0x5208', gasLimit: '0x5300' },
    { gasPrice: '0x1', maxFeePerGas: '0x2' }, { maxFeePerGas: '0x1', maxPriorityFeePerGas: '0x2' },
    { authorizationList: [] }, { accessList: [] }, { customData: { arbitrary: true } },
    { data: '0xa' }, { value: '-1' }, { value: '1' }, { to: 'attacker.eth' }, { type: '0x4' },
  ]) {
    await assert.rejects(site.request({ method: 'eth_sendTransaction', params: [{ from: account, to: account, ...fields }] }), (error) => error.code === -32602);
  }
  await assert.rejects(site.request({ method: 'eth_sendTransaction', params: [{ from: account, chainId: '0x1' }] }), (error) => error.code === 4901);
  assert.equal(previews.length, previewed, 'malformed/hidden/unsupported transaction fields are rejected before approval');
  assert.equal(signedTransactions.length, submitted);

  let approvePending;
  const racingProvider = createWalletProvider(wallet, 'bsc', {
    requestAccounts: () => [account], approve: () => new Promise((resolve) => { approvePending = resolve; }),
  });
  const racingSite = racingProvider.forOrigin(origin);
  await racingSite.request({ method: 'eth_requestAccounts' });
  const pending = racingSite.request({ method: 'personal_sign', params: ['hello', account] });
  racingProvider.permissions.revoke(origin);
  approvePending(true);
  await assert.rejects(pending, (error) => error.code === 4100, 'revoking permission while a prompt is open cancels the signature');
  assert.equal(signedMessages, 0);
  const typed = { domain: { name: 'Fixture', chainId: 1 }, types: { Message: [{ name: 'value', type: 'string' }] }, message: { value: 'hello' }, primaryType: 'Message' };
  await assert.rejects(site.request({ method: 'eth_signTypedData_v4', params: [account, typed] }), (error) => error.code === 4901, 'typed-data requests cannot silently target another network');
  for (const chainId of ['0x38invalid', '0x38.0', '56.0', '0', 0, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => rootProvider.setChainId(chainId), (error) => error.code === -32602);
  }

  // Native WebView messages are already decoded JSON, but the standalone
  // provider is also a public in-process API. The caller and approval callback
  // must not alter bytes/amounts after the user sees the approval.
  const signedSnapshots = [];
  const snapshotPreviews = [];
  let acceptSnapshot;
  const snapshotWallet = { ...wallet,
    signMessage: async (_index, message) => { signedSnapshots.push(message); return 'fixture-signature'; },
    getSigner: () => ({
      sendTransaction: async (tx) => { signedSnapshots.push(tx); return { hash: 'fixture-hash' }; },
      signTypedData: async (domain, types, message) => { signedSnapshots.push({ domain, types, message }); return 'fixture-signature'; },
    }),
  };
  const snapshotSite = createWalletProvider(snapshotWallet, 'bsc', {
    requestAccounts: () => [account],
    approve: (request) => { snapshotPreviews.push(request.params); return new Promise((resolve) => { acceptSnapshot = resolve; }); },
  }).forOrigin(origin);
  await snapshotSite.request({ method: 'eth_requestAccounts' });
  const personalParams = ['approved message', account];
  const messagePending = snapshotSite.request({ method: 'personal_sign', params: personalParams });
  personalParams[0] = 'different message';
  assert.equal(Reflect.set(snapshotPreviews.at(-1), '0', 'approval callback tampering'), false);
  acceptSnapshot(true);
  await messagePending;
  assert.equal(signedSnapshots.at(-1), 'approved message', 'signing uses the exact approved message snapshot');

  const txParams = [{ from: account, to: account, value: '0x1', data: '0xaabb', gas: '0x5208' }];
  const txPending = snapshotSite.request({ method: 'eth_sendTransaction', params: txParams });
  txParams[0].value = '0xffff';
  txParams[0].data = '0xccdd';
  assert.equal(Reflect.set(snapshotPreviews.at(-1)[0], 'value', '0xff'), false);
  acceptSnapshot(true);
  await txPending;
  assert.equal(signedSnapshots.at(-1).value, '0x1');
  assert.equal(signedSnapshots.at(-1).data, '0xaabb', 'transaction bytes and amount cannot change during confirmation');

  const mutableTyped = { ...typed, domain: { name: 'Fixture', chainId: 56 }, message: { value: 'approved content' } };
  const typedParams = [account, mutableTyped];
  const typedPending = snapshotSite.request({ method: 'eth_signTypedData_v4', params: typedParams });
  mutableTyped.domain.chainId = 1;
  mutableTyped.message.value = 'different content';
  assert.equal(Reflect.set(snapshotPreviews.at(-1)[1].message, 'value', 'callback tampering'), false);
  acceptSnapshot(true);
  await typedPending;
  assert.equal(signedSnapshots.at(-1).domain.chainId, 56);
  assert.equal(signedSnapshots.at(-1).message.value, 'approved content', 'nested EIP-712 payload remains the reviewed snapshot');

  let available = [account];
  const permissions = new PermissionManager(() => available);
  permissions.grantAccounts(origin);
  available = [];
  assert.deepEqual(permissions.getAccounts(origin), [], 'removing the last account does not revive stored grants');
  for (const url of ['https://[::1]/', 'https://[2::1]/', 'https://[::ffff:7f00:1]/', 'https://[fc00::1]/', 'https://[fe80::1]/', 'https://169.254.169.254/', 'https://100.64.0.1/', 'https://0.1.2.3/', 'https://device.local/', 'https://test.localhost/']) {
    assert.equal(evaluateDappUrl(url).allowed, false, url);
  }
  assert.equal(evaluateDappUrl('https://[2606:4700:4700::1111]/').allowed, true);
  assert.equal(evaluateDappUrl('https://app.example/').allowed, true);
  assert.equal(parseBridgeMessage(JSON.stringify({ type: 'wallet:provider-request', id: '1', request: { method: 'eth_chainId', params: ['x'.repeat(262144)] } })), undefined, 'oversized bridge messages are rejected before parsing/approval');
  console.log('DApp security verification passed: fail-closed approvals, RPC method boundaries, immutable approval/signing payloads, connected-origin chain switching, exact gas/calldata, hidden field rejection, typed chain binding, permission revocation, strict chain IDs, and private URL/message limits. No live RPC or user keys.');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
