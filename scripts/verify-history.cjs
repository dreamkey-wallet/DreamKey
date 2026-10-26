/* Exercise real history parsing, local persistence and recording with public offline fixtures. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'wallet-history-'));
const secureValues = new Map();
let failStorage = false;
const keychainPath = path.join(output, 'keychain.cjs');
global.__historyKeychainFixture = {
  ACCESSIBLE: { WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'device' },
  async getGenericPassword({ service }) { return secureValues.has(service) ? { password: secureValues.get(service) } : false; },
  async setGenericPassword(_username, password, { service }) { if (failStorage) return false; secureValues.set(service, password); return true; },
};
fs.writeFileSync(keychainPath, 'module.exports = global.__historyKeychainFixture;');
for (const entry of ['src/core/asset-history.ts', 'src/core/wallet-core.ts', 'src/native/transaction-storage.ts', 'src/provider/wallet-core-adapter.ts']) require('./compile-ts-fixture.cjs')(entry, output, { 'react-native-keychain': keychainPath });
const history = require(path.join(output, 'core/asset-history.js'));
const storage = require(path.join(output, 'native/transaction-storage.js'));
const account = `0x${'1'.repeat(40)}`;
const peer = `0x${'2'.repeat(40)}`;
const token = `0x${'3'.repeat(40)}`;
const otherToken = `0x${'4'.repeat(40)}`;
const h = (n) => `0x${n.toString(16).padStart(64, '0')}`;
const network = { id: 'fixture', chainId: 56, name: 'Fixture', nativeSymbol: 'BNB', rpcUrl: 'https://fixture.invalid' };
const query = { network, accountAddress: account, symbol: 'BNB' };
const base = { id: 'fixture', hash: h(1), chainId: 56, accountAddress: account, symbol: 'BNB', decimals: 18, rawValue: '1000000000000000000', from: account, to: peer, direction: 'out', state: 'pending', timestamp: 1700000000, source: 'local', type: 'transfer' };
const item = (n, extras = {}) => ({ category: 'external', hash: h(n), from: account, to: peer, value: '0xde0b6b3a7640000', blockNum: '0x64', blockTimeStamp: 1700000001, receiptsStatus: 1, input: '0x', ...extras });
const ok = (data) => ({ ok: true, status: 200, json: async () => data });
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function verify() {
  const calls = [];
  const first = await history.listAssetTransactions({ ...query, localRecords: [base], fetch: async (url) => {
    calls.push(url);
    return ok({ data: { total: 1, total_num: 1, list: url.includes('Internal') ? [item(2, { from: peer, to: account, traceIndex: 3 })] : [item(1)] } });
  } });
  assert.equal(first.source, 'BscTrace');
  assert.equal(first.coverage, 'indexed');
  assert.equal(first.records.length, 2, 'indexed confirmation replaces matching local pending submission');
  assert.equal(first.records.find((record) => record.hash === h(1)).state, 'confirmed');
  assert.equal(first.records.find((record) => record.hash === h(2)).direction, 'in', 'contract internal currency receipts appear');
  assert.equal(first.hasMore, false);
  assert.equal(calls.length, 2, 'native history uses indexed external and internal streams, not block scanning');

  const tokenQuery = { ...query, tokenAddress: token, tokenDecimals: 6, symbol: 'USDC' };
  const mixed = await history.listAssetTransactions({ ...tokenQuery, fetch: async () => ok({ data: { total: 500, total_num: 1200, list: Array.from({ length: 100 }, (_, index) => item(index + 10, { category: '20', contractAddress: index === 1 ? token : otherToken, value: '0x1e8480', logIndex: index })) } }) });
  assert.equal(mixed.records.length, 1, 'token history filters by chain and contract, never ticker');
  assert.equal(mixed.records[0].rawValue, '2000000');
  assert.equal(mixed.records[0].decimals, 6);
  assert.equal(mixed.warning, 'history-limited', 'public explorer 500-item cap is explicit');
  assert.equal(mixed.hasMore, true);
  let nextUrl;
  await history.listAssetTransactions({ ...tokenQuery, page: mixed.nextPage, fetch: async (url) => { nextUrl = url; return ok({ data: { total: 100, list: [] } }); } });
  assert.match(nextUrl, /page=2/);
  await assert.rejects(history.listAssetTransactions({ ...query, page: mixed.nextPage }), /different asset/);

  const zeroes = await history.listAssetTransactions({ ...query, fetch: async (url) => ok({ data: { total: 2, list: url.includes('Internal') ? [item(4, { from: peer, to: account, value: '0x0' })] : [item(5, { from: peer, to: account, value: '0x0' }), item(6, { value: '0x0', input: '0xa9059cbb', receiptsStatus: 0 })] } }) });
  assert.equal(zeroes.records.length, 1, 'incoming zero-value calls are not displayed as received currency');
  assert.equal(zeroes.records[0].type, 'interaction');
  assert.equal(zeroes.records[0].state, 'failed');

  const ethereum = { ...query, network: { ...network, chainId: 1, nativeSymbol: 'ETH' } };
  const eth = await history.listAssetTransactions({ ...ethereum, fetch: async (url) => ok({ items: url.includes('internal-transactions') ? [] : [{ hash: h(8), from: { hash: peer }, to: { hash: account }, value: '1000000000000000000', block_number: 100, timestamp: '2023-11-14T22:13:20.000000Z', result: 'success', status: 'ok', raw_input: '0x' }], next_page_params: url.includes('internal-transactions') ? null : { block_number: 100, index: 4, items_count: 50 } }) });
  assert.equal(eth.source, 'Blockscout');
  assert.equal(eth.records[0].timestamp, 1700000000, 'timestamps are Unix seconds');
  assert.equal(eth.records[0].direction, 'in');
  assert.equal(eth.hasMore, true);
  const ethToken = await history.listAssetTransactions({ ...ethereum, tokenAddress: token, tokenDecimals: 6, symbol: 'TEST', fetch: async (url) => { assert.match(url, /token-transfers/); assert.match(url, /token=/); return ok({ items: [{ transaction_hash: h(9), from: { hash: account }, to: { hash: peer }, token: { address_hash: token }, total: { value: '1234567', decimals: '6' }, log_index: 4, block_number: 100, timestamp: '2023-11-14T22:13:20.000000Z' }], next_page_params: null }); } });
  assert.equal(ethToken.records[0].rawValue, '1234567');
  assert.equal(ethToken.records[0].tokenAddress.toLowerCase(), token);

  for (const [chainId, nativeSymbol, apiHost] of [[42161, 'ETH', 'arbitrum.blockscout.com'], [137, 'POL', 'polygon.blockscout.com'], [8453, 'ETH', 'base.blockscout.com']]) {
    const chainQuery = { network: { ...network, chainId, nativeSymbol, explorerUrl: 'https://untrusted.fixture.invalid' }, accountAddress: account };
    const chainCalls = [];
    const nativeHistory = await history.listAssetTransactions({ ...chainQuery, localRecords: [base], fetch: async (url) => {
      chainCalls.push(url);
      assert.equal(new URL(url).host, apiHost, 'history API is pinned by chain, never DApp-supplied explorer URL');
      return ok({ items: url.includes('internal-transactions')
        ? [{ transaction_hash: h(41), from: { hash: peer }, to: { hash: account }, value: '250000000000000000', index: 2, success: true, block_number: 100, timestamp: '2023-11-14T22:13:20.000000Z' }]
        : [{ hash: h(40), from: { hash: account }, to: { hash: peer }, value: '1000000000000000000', block_number: 100, timestamp: '2023-11-14T22:13:20.000000Z', result: 'success', status: 'ok', raw_input: '0x' },
          { hash: h(42), from: { hash: peer }, to: { hash: otherToken }, value: '1000000000000000000', block_number: 100, timestamp: '2023-11-14T22:13:20.000000Z', result: 'success', status: 'ok', raw_input: '0x' }],
        next_page_params: url.includes('internal-transactions') ? null : { block_number: 100, index: 4, items_count: 50, bad_path: { url: 'https://untrusted.fixture.invalid' } } });
    } });
    assert.equal(nativeHistory.source, 'Blockscout');
    assert.equal(nativeHistory.records.length, 2, 'native history includes outgoing transfers and incoming internal traces only for this account');
    assert.ok(nativeHistory.records.every((record) => record.chainId === chainId && record.symbol === nativeSymbol && record.decimals === 18), 'new chain history metadata includes Polygon POL with 18 decimals');
    assert.deepEqual(nativeHistory.records.map((record) => record.direction).sort(), ['in', 'out']);
    assert.equal(chainCalls.length, 2);
    assert.equal(nativeHistory.hasMore, true);
    assert.deepEqual(nativeHistory.nextPage.streams, { external: { block_number: 100, index: 4, items_count: 50 } });
    let paginationCalls = 0;
    const lastPage = await history.listAssetTransactions({ ...chainQuery, page: nativeHistory.nextPage, fetch: async (url) => {
      paginationCalls += 1;
      const request = new URL(url);
      assert.equal(request.host, apiHost);
      assert.match(request.pathname, /\/transactions$/);
      assert.equal(request.searchParams.get('block_number'), '100');
      assert.equal(request.searchParams.get('index'), '4');
      assert.equal(request.searchParams.get('items_count'), '50');
      return ok({ items: [], next_page_params: null });
    } });
    assert.equal(paginationCalls, 1, 'completed internal stream is not queried again on external pagination');
    assert.equal(lastPage.hasMore, false);
    await assert.rejects(history.listAssetTransactions({ ...chainQuery, network: { ...chainQuery.network, chainId: 1 }, page: nativeHistory.nextPage }), /different asset/);

    const chainTokenQuery = { ...chainQuery, tokenAddress: token, tokenDecimals: 6, symbol: 'USDC' };
    const tokenFixture = (n, from, to, contract, logIndex) => ({ transaction_hash: h(n), from: { hash: from }, to: { hash: to }, token: { address_hash: contract }, total: { value: '1234567', decimals: '6' }, log_index: logIndex, block_number: 100, timestamp: '2023-11-14T22:13:20.000000Z' });
    const chainTokens = await history.listAssetTransactions({ ...chainTokenQuery, localRecords: [{ ...base, tokenAddress: token, symbol: 'USDC', decimals: 6 }], fetch: async (url) => {
      const request = new URL(url);
      assert.equal(request.host, apiHost);
      assert.match(request.pathname, /\/token-transfers$/);
      assert.equal(request.searchParams.get('type'), 'ERC-20');
      assert.equal(request.searchParams.get('token'), token);
      return ok({ items: [tokenFixture(43, account, peer, token, 1), tokenFixture(44, peer, account, token, 2), tokenFixture(45, account, peer, otherToken, 3), tokenFixture(46, peer, otherToken, token, 4)], next_page_params: { block_number: 100, index: 2, token: otherToken, type: 'ERC-721' } });
    } });
    assert.equal(chainTokens.records.length, 2, 'same-symbol contracts and history from another chain/account cannot cross into this asset');
    assert.ok(chainTokens.records.every((record) => record.chainId === chainId && record.tokenAddress.toLowerCase() === token && record.decimals === 6));
    assert.deepEqual(chainTokens.records.map((record) => record.direction).sort(), ['in', 'out']);
    await history.listAssetTransactions({ ...chainTokenQuery, page: chainTokens.nextPage, fetch: async (url) => {
      const request = new URL(url);
      assert.equal(request.searchParams.get('token'), token, 'server cursor cannot replace selected contract');
      assert.equal(request.searchParams.get('type'), 'ERC-20', 'server cursor cannot replace selected token type');
      return ok({ items: [], next_page_params: null });
    } });

    const pendingRecord = { ...base, chainId, symbol: nativeSymbol };
    let unavailableRpcCalls = 0;
    const unavailable = await history.listAssetTransactions({ ...chainQuery, localRecords: [base, pendingRecord], fetch: async () => ({ ok: false, status: 403, json: async () => { throw new Error('HTML challenge is not history'); } }), rpc: async () => { unavailableRpcCalls += 1; throw new Error('Native history must not query receipts'); } });
    assert.equal(unavailable.warning, 'history-unavailable', 'indexer challenge/outage is explicit, never a complete empty history');
    assert.equal(unavailable.coverage, 'local');
    assert.equal(unavailable.records.length, 1);
    assert.equal(unavailable.records[0].state, 'pending', 'an indexer outage preserves local pending status until details confirm it');
    assert.equal(unavailable.updatedLocalRecords, undefined);
    assert.equal(unavailableRpcCalls, 0, 'native history never queries pending receipts');

    const recentChainTokens = await history.listAssetTransactions({ ...chainTokenQuery, fetch: async () => { throw new Error('fixture outage'); }, rpc: async (method, params) => {
      if (method === 'eth_blockNumber') return '0x400';
      if (method === 'eth_getBlockByNumber') return { timestamp: '0x6553f100' };
      assert.equal(method, 'eth_getLogs');
      assert.equal(params[0].address, token);
      return [{ address: token, topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', `0x${account.slice(2).padStart(64, '0')}`, `0x${peer.slice(2).padStart(64, '0')}`], data: `0x${'1e8480'.padStart(64, '0')}`, blockNumber: '0x3ff', transactionHash: h(47), logIndex: '0x1', removed: false }];
    } });
    assert.equal(recentChainTokens.source, 'RPC');
    assert.equal(recentChainTokens.warning, 'recent-history-only');
    assert.equal(recentChainTokens.records.length, 1);
    assert.equal(recentChainTokens.records[0].chainId, chainId);
    assert.equal(recentChainTokens.records[0].tokenAddress.toLowerCase(), token);
  }

  let pendingRpcCalls = 0;
  const pendingRpc = async () => { pendingRpcCalls += 1; throw new Error('List must not query pending receipts'); };
  const localFailure = await history.listAssetTransactions({ ...query, localRecords: [base, { ...base, chainId: 1 }, { ...base, accountAddress: peer, direction: 'in' }], fetch: async () => { throw new Error('fixture indexer outage'); }, rpc: pendingRpc });
  assert.equal(localFailure.coverage, 'local');
  assert.equal(localFailure.warning, 'history-unavailable');
  assert.equal(localFailure.records.length, 1, 'local entries cannot cross account or chain');
  assert.equal(localFailure.records[0].state, 'pending');
  assert.equal(localFailure.updatedLocalRecords, undefined);
  const absent = await history.listAssetTransactions({ ...query, localRecords: [base], fetch: async () => { throw new Error('outage'); }, rpc: pendingRpc });
  assert.equal(absent.records[0].state, 'pending', 'list refresh preserves a locally pending transaction');
  assert.equal(pendingRpcCalls, 0, 'list loading and refresh never request pending receipts');

  const transferTopic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  const rpcCalls = [];
  const recent = await history.listAssetTransactions({ ...tokenQuery, fetch: async () => { throw new Error('fixture outage'); }, rpc: async (method, params) => {
    rpcCalls.push({ method, params });
    if (method === 'eth_blockNumber') return '0xbb8';
    if (method === 'eth_getBlockByNumber') return { timestamp: '0x6553f100' };
    assert.equal(method, 'eth_getLogs');
    return [{ address: token, topics: [transferTopic, `0x${account.slice(2).padStart(64, '0')}`, `0x${peer.slice(2).padStart(64, '0')}`], data: `0x${'1e8480'.padStart(64, '0')}`, blockNumber: '0xbb7', transactionHash: h(12), logIndex: '0x1', removed: false }];
  } });
  assert.equal(recent.coverage, 'recent');
  assert.equal(recent.warning, 'recent-history-only');
  assert.equal(recent.fromBlock, 953);
  assert.equal(recent.toBlock, 3000);
  assert.equal(recent.records.length, 1, 'self/outgoing/incoming query duplicates share log identity');
  assert.equal(rpcCalls.filter((call) => call.method === 'eth_getLogs').length, 4, 'fallback logs are bounded to 2048 blocks with both directions');
  assert.equal(recent.records[0].timestamp, 1700000000);

  const distinct = history.mergeAssetTransactions([
    { ...base, source: 'explorer', state: 'confirmed', id: 'log:1' },
    { ...base, source: 'explorer', state: 'confirmed', id: 'log:2' }, base,
  ]);
  assert.equal(distinct.length, 2, 'distinct logs within one transaction are preserved');
  assert.equal(history.validateAssetTransaction({ ...base, rawValue: '-1' }), null);
  assert.equal(history.validateAssetTransaction({ ...base, from: peer, to: otherToken }), null);
  assert.equal(history.filterAssetTransactions([base, { ...base, tokenAddress: token }], query).length, 1);

  await Promise.all([storage.saveTransaction(base), storage.saveTransaction({ ...base, id: 'second', hash: h(2), timestamp: 1700000002 }), storage.saveTransaction({ ...base, state: 'confirmed', blockNumber: 100 })]);
  const stored = await storage.loadTransactions(56, account);
  assert.equal(stored.length, 2, 'concurrent serialized writes retain all submissions and confirmations');
  assert.equal(stored.find((record) => record.hash === base.hash).state, 'confirmed');
  assert.deepEqual(await storage.loadTransactions(1, account), []);
  assert.deepEqual(await storage.loadTransactions(56, peer), []);
  failStorage = true;
  await assert.rejects(storage.saveTransaction({ ...base, id: 'failure', hash: h(3) }), /save/);
  failStorage = false;

  const { WalletCore } = require(path.join(output, 'core/wallet-core.js'));
  const recorded = [];
  const wallet = WalletCore.fromMnemonic('test test test test test test test test test test test junk', { networks: [network], transactionRecorder: async (record) => { recorded.push(record); throw new Error('fixture save failure'); } });
  const from = wallet.getAccount(0).address;
  let sends = 0;
  wallet.providers.set(network.id, { send: async () => '0x38', getTransactionReceipt: async (hash) => ({ status: 1, blockNumber: 100, gasUsed: 21000n, gasPrice: 2n, hash }), getBlockNumber: async () => 101 });
  wallet.getSigner = () => ({ sendTransaction: async (tx) => { sends += 1; return { hash: h(sends + 20), from, to: tx.to, value: tx.value ?? 0n, data: tx.data ?? '0x' }; } });
  const sent = await wallet.sendNative(0, network.id, peer, '1');
  await tick();
  assert.equal(sends, 1, 'storage failure cannot repeat an accepted broadcast');
  assert.equal(sent.hash, h(21));
  assert.equal(recorded[0].rawValue, '1000000000000000000');
  assert.equal(recorded[0].state, 'pending');
  await wallet.getTransactionStatus(network.id, sent.hash);
  await tick();
  assert.equal(recorded[1].state, 'confirmed');
  const erc = await wallet.sendErc20(0, network.id, { address: token, decimals: 6, symbol: 'TEST' }, peer, '2.5');
  await tick();
  assert.equal(recorded.at(-1).rawValue, '2500000');
  assert.equal(recorded.at(-1).tokenAddress.toLowerCase(), token);
  assert.equal(recorded.at(-1).to.toLowerCase(), peer, 'token recipient comes from prepared transfer, not contract transaction target');
  wallet.recordSubmittedTransaction(network.id, { hash: h(23), from, to: token, value: 0n, data: '0x095ea7b3' });
  await tick();
  assert.equal(recorded.at(-1).type, 'interaction');
  assert.equal(recorded.at(-1).tokenAddress, undefined, 'arbitrary DApp approvals never appear as token transfers');
  assert.equal(recorded.at(-1).symbol, 'BNB');

  const { createWalletProvider } = require(path.join(output, 'provider/wallet-core-adapter.js'));
  wallet.getRpcTransport = () => async () => ok({ jsonrpc: '2.0', id: 1, result: '0x38' });
  const provider = createWalletProvider(wallet, network.id, { approve: async () => true });
  const site = provider.forOrigin('https://fixture.example');
  await site.request({ method: 'eth_requestAccounts' });
  const dappHash = await site.request({ method: 'eth_sendTransaction', params: [{ from, to: peer, value: '0x1' }] });
  await tick();
  assert.equal(dappHash, h(23));
  assert.equal(recorded.at(-1).hash, dappHash, 'EIP-1193 adapter also records accepted DApp sends');
  assert.equal(recorded.at(-1).type, 'transfer');
  assert.equal(recorded.at(-1).rawValue, '1');
  assert.equal(sends, 3, 'DApp storage failure still returns success and broadcasts exactly once');

  console.log('History verification passed: BSC/ETH/Arbitrum/Polygon/Base indexed send/receive and internal traces, POL metadata, chain-pinned indexers, strict token filtering, isolated pagination and explicit caps/outages, bounded ERC-20 log fallback, account/chain isolation, preserved pending records without receipt queries, durable concurrent records, successful-broadcast recording failures never replay. No live RPC or transaction broadcast.');
}
verify().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => { delete global.__historyKeychainFixture; fs.rmSync(output, { recursive: true, force: true }); });
