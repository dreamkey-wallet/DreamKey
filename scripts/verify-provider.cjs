/* Exercises wallet-provider state and approvals without a device or live RPC. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wallet-provider-'));

// Transpile only this pure TypeScript layer. This adds no test framework and
// keeps React Native, native modules and any real wallet keys out of the check.
function loadProviderLayer(filename) {
  for (const name of ['wallet-provider', 'wallet-core-adapter']) require('./compile-ts-fixture.cjs')(`src/provider/${name}.ts`, outputRoot);
  return require(path.join(outputRoot, 'provider', filename));
}

async function verify() {
  const { WalletProvider } = loadProviderLayer('wallet-provider.js');
  const { createWalletProvider } = require(path.join(outputRoot, 'provider/wallet-core-adapter.js'));
  const account = `0x${'1'.repeat(40)}`;
  const sites = ['https://first.example', 'https://second.example', 'https://reject.example'];
  const promptedOrigins = [];
  const rpcCalls = [];
  let signerChain;
  const root = new WalletProvider({
    rpcUrl: 'https://bsc.example', chainId: 56,
    rpcUrls: { 1: 'https://eth.example' }, accounts: [account],
    requestAccounts: async (origin) => { promptedOrigins.push(origin); return origin === sites[2] ? [] : [account]; },
    fetch: async (url, init) => { rpcCalls.push({ url, body: JSON.parse(init.body) }); return { ok: true, status: 200, json: async () => ({ result: '0x0' }) }; },
    signer: async () => { signerChain = root.chainId; return 'signed'; },
  });
  const first = root.forOrigin(sites[0]);
  const second = root.forOrigin(sites[1]);
  assert.equal(root.forOrigin(sites[0]), first, 'origin scopes are cached');
  assert.deepEqual(await first.request({ method: 'eth_accounts' }), []);
  await first.request({ method: 'wallet_requestPermissions', params: [{ eth_accounts: {} }] });
  assert.deepEqual(promptedOrigins, [sites[0]], 'permission requests go through host approval');
  assert.deepEqual(await first.request({ method: 'eth_accounts' }), [account]);
  assert.deepEqual(await second.request({ method: 'eth_accounts' }), [], 'one website cannot read another website grant');
  await assert.rejects(root.forOrigin(sites[2]).request({ method: 'wallet_requestPermissions', params: [{ eth_accounts: {} }] }), (error) => error.code === 4001);
  assert.deepEqual(await root.forOrigin(sites[2]).request({ method: 'wallet_getPermissions' }), [], 'rejected permission does not create a grant');

  const chainEvents = [];
  const originEvents = [];
  root.on('chainChanged', (chain) => chainEvents.push(chain));
  root.on('accountsChanged', (accounts, origin) => originEvents.push({ accounts, origin }));
  await first.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x1' }] });
  assert.equal(root.chainId, '0x1', 'root signer sees the shared chain');
  assert.equal(root.forOrigin(sites[0]).chainId, '0x1', 'later scoped requests retain the selected chain');
  assert.equal(second.chainId, '0x1', 'all scopes share chain state');
  await first.request({ method: 'eth_getBalance', params: [account, 'latest'] });
  assert.equal(rpcCalls[0].url, 'https://eth.example', 'reads use the switched chain RPC');
  await first.request({ method: 'wallet_addEthereumChain', params: [{ chainId: '0x1', rpcUrls: ['https://untrusted.example'] }] });
  assert.equal(root.rpcUrl, 'https://eth.example', 'Dapps cannot replace a built-in chain RPC');
  await assert.rejects(first.request({ method: 'wallet_addEthereumChain', params: [{ chainId: '0x89', rpcUrls: ['https://custom.example'] }] }), (error) => error.code === 4200);
  await first.request({ method: 'personal_sign', params: ['0x01', account] });
  assert.equal(signerChain, '0x1', 'signer closure sees the switched chain');
  assert.deepEqual(chainEvents, ['0x1']);
  await first.request({ method: 'wallet_revokePermissions', params: [{ eth_accounts: {} }] });
  assert.deepEqual(originEvents.at(-1), { accounts: [], origin: sites[0] }, 'root account events include their origin');
  root.disconnect();
  assert.equal(first.isConnected(), false, 'connection state is shared');
  await assert.rejects(second.request({ method: 'eth_accounts' }), (error) => error.code === 4900);
  first.connect();
  assert.equal(root.isConnected(), true);

  // Verify the real adapter resolves the signer network after a scoped switch.
  let sentOnNetwork;
  const networks = [
    { id: 'bsc', chainId: 56, rpcUrl: 'https://bsc.example' },
    { id: 'eth', chainId: 1, rpcUrl: 'https://eth.example' },
  ];
  const wallet = {
    getNetwork: (id) => networks.find((network) => network.id === id),
    listNetworks: () => networks,
    listAccounts: () => [{ address: account, index: 0 }],
    getAccount: () => ({ address: account, index: 0 }),
    getSigner: (_index, network) => ({ sendTransaction: async () => { sentOnNetwork = network; return { hash: '0xhash' }; } }),
  };
  const adapterRoot = createWalletProvider(wallet, 'bsc', { approve: async () => true, requestAccounts: async () => [account] });
  const adapterSite = adapterRoot.forOrigin(sites[0]);
  await adapterSite.request({ method: 'eth_requestAccounts' });
  await adapterSite.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x1' }] });
  await adapterRoot.forOrigin(sites[0]).request({ method: 'eth_sendTransaction', params: [{ from: account, to: account, value: '0x0' }] });
  assert.equal(sentOnNetwork, 'eth', 'wallet adapter signs on the switched network');

  // The adapter must reuse the matching core transport after chain changes;
  // the wallet owns endpoint selection rather than an individual Dapp.
  const coreTransportReads = [];
  const transportWallet = {
    ...wallet,
    getRpcTransport: (networkId) => async (url, init) => {
      coreTransportReads.push({ networkId, url, payload: JSON.parse(init.body) });
      return { ok: true, status: 200, json: async () => ({ result: '0x64' }) };
    },
  };
  const transportRoot = createWalletProvider(transportWallet, 'bsc', { requestAccounts: () => [account] });
  const transportSite = transportRoot.forOrigin(sites[0]);
  assert.equal(await transportSite.request({ method: 'eth_blockNumber' }), '0x64');
  await transportSite.request({ method: 'eth_requestAccounts' });
  await transportSite.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x1' }] });
  assert.equal(await transportSite.request({ method: 'eth_blockNumber' }), '0x64');
  assert.deepEqual(coreTransportReads.map(({ networkId, url }) => ({ networkId, url })), [
    { networkId: 'bsc', url: 'https://bsc.example' }, { networkId: 'eth', url: 'https://eth.example' },
  ], 'Dapp reads follow the selected chain through the shared core transport');

  const accountTwo = `0x${'2'.repeat(40)}`;
  let selectedSignerIndex;
  const multiAccountWallet = {
    ...wallet,
    listAccounts: () => [{ address: account, index: 0 }, { address: accountTwo, index: 1 }],
    getSigner: (index) => ({ sendTransaction: async () => { selectedSignerIndex = index; return { hash: '0xhash' }; } }),
  };
  const selectedRoot = createWalletProvider(multiAccountWallet, 'bsc', { approve: async () => true, requestAccounts: async () => [accountTwo] });
  const selectedSite = selectedRoot.forOrigin(sites[0]);
  await selectedSite.request({ method: 'eth_requestAccounts' });
  await selectedSite.request({ method: 'eth_sendTransaction', params: [{ to: account, value: '0x0' }] });
  assert.equal(selectedSignerIndex, 1, 'transaction without from uses the account granted to the origin');

  // A visible confirmation remains tied to the network it originally showed.
  let resolveApproval;
  const racingRoot = createWalletProvider(wallet, 'bsc', {
    requestAccounts: async () => [account],
    approve: () => new Promise((resolve) => { resolveApproval = resolve; }),
  });
  const racingSite = racingRoot.forOrigin(sites[0]);
  await racingSite.request({ method: 'eth_requestAccounts' });
  const pendingSignature = racingSite.request({ method: 'eth_sendTransaction', params: [{ from: account, to: account, value: '0x0' }] });
  await racingSite.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x1' }] });
  resolveApproval(true);
  await assert.rejects(pendingSignature, (error) => error.code === 4901, 'network change during approval rejects stale signing request');
  console.log('Provider verification passed: origin isolation, approval rejection, chain/RPC state, selected signer account/network, built-in RPC protection, and confirmation chain guard.');
}

verify().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => fs.rmSync(outputRoot, { recursive: true, force: true }));
