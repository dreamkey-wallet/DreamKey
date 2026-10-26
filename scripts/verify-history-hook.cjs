/* Exercise the actual history hook with deterministic React lifecycle / storage fixtures. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const tick = () => new Promise((done) => setImmediate(done));
function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function compiled(relative, dependencies, globals = {}) {
  const source = fs.readFileSync(path.join(root, relative), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module, exports: module.exports,
    require: (name) => Object.prototype.hasOwnProperty.call(dependencies, name) ? dependencies[name] : require(name),
    AbortController, URLSearchParams, setTimeout, clearTimeout, console, ...globals,
  }, { filename: relative });
  return module.exports;
}
const historyApi = compiled('src/core/asset-history.ts', { ethers: require('ethers') });
const assetsApi = compiled('src/ui/wallet-assets-loader.ts', { ethers: require('ethers') });
const network = { id: 'bsc', chainId: 56, name: 'BSC', nativeSymbol: 'BNB', rpcUrl: 'https://fixture.invalid' };
const eth = { id: 'eth', chainId: 1, name: 'Ethereum', nativeSymbol: 'ETH', rpcUrl: 'https://eth-fixture.invalid' };
const account = `0x${'1'.repeat(40)}`;
const otherAccount = `0x${'2'.repeat(40)}`;
const recipient = `0x${'3'.repeat(40)}`;
function record(number, overrides = {}) {
  const hash = `0x${number.toString(16).padStart(64, '0')}`;
  return { id: `${hash}:external`, hash, chainId: 56, accountAddress: account, symbol: 'BNB', decimals: 18,
    rawValue: '1000000000000000000', from: account, to: recipient, direction: 'out', state: 'confirmed',
    timestamp: 1700000000 + number, blockNumber: 100 + number, source: 'explorer', type: 'transfer', ...overrides };
}
function rows(highest, count, overrides = {}) {
  return Array.from({ length: count }, (_, index) => record(highest - index, overrides));
}
function pageFor(selectedNetwork = network, selectedAccount = account) {
  return { scope: `${selectedNetwork.chainId}:${selectedAccount.toLowerCase()}:native`, provider: selectedNetwork.chainId === 56 ? 'BscTrace' : 'Blockscout', streams: { external: 2 } };
}
function result(records, extra = {}) { return { records, source: 'BscTrace', coverage: 'indexed', hasMore: false, ...extra }; }

/* Only hooks used by useAssetHistory are mocked; render/effect cleanup/dependency semantics are preserved. */
function reactHarness() {
  const slots = [];
  let index = 0, dirty = false, hook, args, output;
  const sameDeps = (a, b) => !!a && !!b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const react = {
    useState(initial) {
      const position = index++;
      if (!slots[position]) slots[position] = { type: 'state', value: typeof initial === 'function' ? initial() : initial };
      const cell = slots[position];
      return [cell.value, (next) => { const value = typeof next === 'function' ? next(cell.value) : next; if (!Object.is(value, cell.value)) { cell.value = value; dirty = true; } }];
    },
    useRef(initial) {
      const position = index++;
      if (!slots[position]) slots[position] = { type: 'ref', value: { current: initial } };
      return slots[position].value;
    },
    useCallback(callback, deps) {
      const position = index++;
      if (!slots[position] || !sameDeps(slots[position].deps, deps)) slots[position] = { type: 'callback', value: callback, deps };
      return slots[position].value;
    },
    useEffect(effect, deps) {
      const position = index++;
      const previous = slots[position];
      if (!previous || !sameDeps(previous.deps, deps)) slots[position] = { type: 'effect', deps, effect, cleanup: previous?.cleanup, pending: true };
    },
  };
  function render() {
    dirty = false;
    index = 0;
    output = hook(...args);
    const pending = slots.filter((slot) => slot.type === 'effect' && slot.pending);
    pending.forEach((slot) => { slot.pending = false; slot.cleanup?.(); });
    pending.forEach((slot) => { slot.cleanup = slot.effect(); });
  }
  return { react,
    mount(fn, values) { hook = fn; args = values; render(); },
    update(values) { args = values; render(); },
    get current() { return output; },
    async settle() {
      for (let pass = 0; pass < 12; pass += 1) { await tick(); if (dirty) render(); }
    },
    unmount() { slots.filter((slot) => slot.type === 'effect').forEach((slot) => slot.cleanup?.()); },
  };
}
function fixture(initialNetwork = network, initialAccount = account) {
  const harness = reactHarness();
  const queries = [], saves = [], reads = [], timers = new Map(), records = new Map(), subscribers = new Map();
  const storageKey = (chainId, address) => `${chainId}:${address.toLowerCase()}`;
  const notify = (chainId, address) => { subscribers.get(storageKey(chainId, address))?.forEach((callback) => callback()); };
  const storage = {
    async loadTransactions(chainId, address) { const delayed = reads.shift(); return delayed ? delayed.promise : (records.get(storageKey(chainId, address)) ?? []).map((item) => ({ ...item })); },
    async saveTransaction(value) {
      saves.push(value);
      await tick(); // Keychain completion occurs after the request can settle.
      const key = storageKey(value.chainId, value.accountAddress);
      records.set(key, historyApi.mergeAssetTransactions(records.get(key) ?? [], [value]));
      notify(value.chainId, value.accountAddress);
    },
    subscribeTransactions(chainId, address, callback) {
      const key = storageKey(chainId, address);
      const set = subscribers.get(key) ?? new Set(); set.add(callback); subscribers.set(key, set);
      return () => { set.delete(callback); if (!set.size) subscribers.delete(key); };
    },
  };
  const api = { ...historyApi, listAssetTransactions(query) { const response = deferred(); queries.push({ query, response }); return response.promise; } };
  const hooks = compiled('src/ui/useAssetHistory.ts', {
    react: harness.react, '../core/asset-history.js': api, '../native/transaction-storage.js': storage,
    './wallet-assets-loader.js': assetsApi,
  }, { setInterval(callback, duration) { const id = Symbol(); timers.set(id, { callback, duration }); return id; }, clearInterval(id) { timers.delete(id); } });
  const core = { vault: { isLocked: () => false }, getRpcTransport: () => async () => ({ json: async () => ({ result: null }) }) };
  harness.mount(hooks.useAssetHistory, [core, initialAccount, initialNetwork]);
  return { harness, queries, saves, timers, core, notify,
    deferNextLocalRead() { const read = deferred(); reads.push(read); return read; },
    setLocal(chainId, address, values) { records.set(storageKey(chainId, address), values); },
    select(selectedNetwork, selectedAccount, token) { harness.update([core, selectedAccount, selectedNetwork, token]); },
  };
}

async function initialDeduplication() {
  const f = fixture();
  const first = f.harness.current.refresh();
  assert.equal(f.harness.current.refresh(), first, 'mount/pull refresh shares the in-flight Promise');
  await f.harness.settle();
  assert.equal(f.queries.length, 1, 'mount and concurrent refresh issue one indexer request');
  f.queries[0].response.resolve(result([record(1)]));
  await first; await f.harness.settle();
  assert.equal(f.harness.current.records.length, 1);
  assert.equal(f.harness.current.loading, false);
  f.harness.unmount();
}
async function staleContextIsolation() {
  const f = fixture();
  await f.harness.settle();
  f.select(eth, otherAccount);
  assert.equal(f.harness.current.records.length, 0, 'new context never shows old-account rows');
  await f.harness.settle();
  assert.equal(f.queries.length, 2);
  assert.equal(f.queries[1].query.accountAddress, otherAccount);
  assert.equal(f.queries[1].query.network.chainId, 1);
  assert.equal(f.queries[1].query.page, undefined, 'pagination is reset when account/network changes');
  const current = record(2, { chainId: 1, accountAddress: otherAccount, from: otherAccount, symbol: 'ETH' });
  f.queries[1].response.resolve(result([current])); await f.harness.settle();
  const key = f.harness.current.key;
  f.queries[0].response.resolve(result([record(99)]));
  await f.harness.settle();
  assert.equal(f.harness.current.key, key);
  assert.equal(f.harness.current.records[0].hash, current.hash, 'old result cannot overwrite new-account history');
  assert.equal(f.saves.length, 0, 'history loading never writes detail confirmation storage');
  const token = { address: `0x${'4'.repeat(40)}`, symbol: 'USDT', decimals: 6, name: 'Tether' };
  f.select(eth, otherAccount, token); await f.harness.settle();
  assert.equal(f.harness.current.records.length, 0, 'asset switch discards native records');
  assert.equal(f.queries[2].query.tokenAddress, token.address);
  assert.equal(f.queries[2].query.page, undefined);
  f.queries[2].response.resolve(result([])); await f.harness.settle();
  f.harness.unmount();
}
async function paginationMerge() {
  const f = fixture(); await f.harness.settle();
  const page = pageFor();
  f.queries[0].response.resolve(result([record(10)], { hasMore: true, nextPage: page })); await f.harness.settle();
  const first = f.harness.current.loadMore();
  assert.equal(f.harness.current.loadMore(), first, 'load-more double tap shares one request');
  await f.harness.settle();
  assert.equal(f.queries[1].query.page, page, 'opaque cursor is passed through without reconstruction');
  f.queries[1].response.resolve(result([record(10), record(5)])); await first; await f.harness.settle();
  assert.deepEqual(Array.from(f.harness.current.records, (value) => value.id), [record(10).id, record(5).id], 'pages merge in order without duplicate records');
  assert.equal(f.harness.current.hasMore, false);
  await f.harness.current.loadMore(); await f.harness.settle();
  assert.equal(f.queries.length, 2, 'completed pagination sends no further request');
  const refresh = f.harness.current.refresh(); await f.harness.settle();
  assert.equal(f.queries[2].query.page, undefined, 'manual refresh starts at the initial page');
  f.queries[2].response.resolve(result([record(11)])); await refresh; await f.harness.settle();
  assert.equal(f.harness.current.records.length, 1, 'refresh replaces previously paged remote data');
  f.harness.unmount();
}
async function completeProviderPageRemainsVisible() {
  const f = fixture(); await f.harness.settle();
  const all = rows(55, 55);
  f.queries[0].response.resolve(result(all)); await f.harness.settle();
  assert.equal(f.harness.current.records.length, 55, 'all records in a provider page are visible without a local display cap');
  assert.deepEqual(Array.from(f.harness.current.records, (value) => value.id), all.map((value) => value.id));
  const displayed = f.harness.current.records;
  f.select(network, account); await f.harness.settle();
  assert.equal(f.harness.current.records, displayed, 'unchanged history keeps its array reference stable across navigation rerenders');
  assert.equal(f.queries.length, 1, 'navigation rerender does not requery history');
  assert.equal(f.harness.current.hasMore, false);
  await f.harness.current.loadMore(); await f.harness.settle();
  assert.equal(f.queries.length, 1, 'a completed provider page does not repeat the remote request');
  f.harness.unmount();
}
async function completeProviderPageUsesRemoteCursor() {
  const f = fixture(); await f.harness.settle();
  const page = pageFor();
  f.queries[0].response.resolve(result(rows(100, 40), { hasMore: true, nextPage: page })); await f.harness.settle();
  assert.equal(f.harness.current.records.length, 40);
  const more = f.harness.current.loadMore(); await f.harness.settle();
  assert.equal(f.queries.length, 2);
  assert.equal(f.queries[1].query.page, page);
  f.queries[1].response.resolve(result(rows(65, 20))); await more; await f.harness.settle();
  assert.equal(f.harness.current.records.length, 55, 'overlap between provider pages is deduplicated');
  assert.equal(new Set(f.harness.current.records.map((value) => value.id)).size, 55);
  assert.equal(f.harness.current.hasMore, false);
  f.harness.unmount();
}
async function irregularProviderPagesMergeCompletely() {
  const f = fixture(); await f.harness.settle();
  const page = pageFor();
  f.queries[0].response.resolve(result(rows(80, 25), { hasMore: true, nextPage: page })); await f.harness.settle();
  assert.equal(f.harness.current.records.length, 25, 'a provider page is displayed completely');
  const more = f.harness.current.loadMore();
  assert.equal(f.harness.current.loadMore(), more, 'double-tapping a remote page shares one request');
  await f.harness.settle();
  assert.equal(f.queries.length, 2, 'load more fetches the next remote cursor once');
  assert.equal(f.queries[1].query.page, page);
  f.queries[1].response.resolve(result(rows(60, 25))); await more; await f.harness.settle();
  assert.equal(f.harness.current.records.length, 45, 'the remote page merges every distinct result with prior records');
  assert.deepEqual(Array.from(f.harness.current.records, (value) => value.id), rows(80, 45).map((value) => value.id), 'overlapping provider records are deduplicated without dropping history');
  await f.harness.current.loadMore(); await f.harness.settle();
  assert.equal(f.harness.current.records.length, 45);
  assert.equal(f.queries.length, 2, 'the final overlapping page does not repeat the provider request');
  assert.equal(f.harness.current.hasMore, false);
  f.harness.unmount();
}
async function refreshAndContextResetProviderPages() {
  const f = fixture(); await f.harness.settle();
  f.queries[0].response.resolve(result(rows(60, 60))); await f.harness.settle();
  assert.equal(f.harness.current.records.length, 60);
  const refresh = f.harness.current.refresh(); await f.harness.settle();
  assert.equal(f.queries.length, 2);
  assert.equal(f.queries[1].query.page, undefined, 'manual refresh restarts the remote history cursor');
  f.queries[1].response.resolve(result(rows(100, 60))); await refresh; await f.harness.settle();
  assert.equal(f.harness.current.records.length, 60, 'manual refresh displays its full initial provider page');
  assert.equal(f.harness.current.records[0].id, record(100).id);
  f.select(eth, otherAccount);
  assert.equal(f.harness.current.records.length, 0, 'context switch immediately hides the expanded previous list');
  await f.harness.settle();
  assert.equal(f.queries[2].query.page, undefined);
  f.queries[2].response.resolve(result(rows(150, 45, { chainId: 1, accountAddress: otherAccount, from: otherAccount, symbol: 'ETH' }))); await f.harness.settle();
  assert.equal(f.harness.current.records.length, 45, 'a new account and network display the full new provider page');
  assert.ok(f.harness.current.records.every((value) => value.chainId === 1 && value.accountAddress === otherAccount));
  f.harness.unmount();
}
async function storageMergeRetainsCompleteRecords() {
  const f = fixture(); await f.harness.settle();
  const all = rows(55, 55);
  f.queries[0].response.resolve(result(all)); await f.harness.settle();
  const local = record(100, { source: 'local' });
  f.setLocal(56, account, [local]); f.notify(56, account); await f.harness.settle();
  assert.equal(f.harness.current.records.length, 56, 'storage merge preserves every provider record and the new local record');
  assert.equal(f.harness.current.records[0].id, local.id);
  const newer = record(101, { source: 'local' });
  f.setLocal(56, account, [newer, local]); f.notify(56, account); await f.harness.settle();
  assert.equal(f.harness.current.records.length, 57, 'another storage merge retains all existing records');
  assert.equal(f.harness.current.records[0].id, newer.id);
  await f.harness.current.loadMore(); await f.harness.settle();
  assert.equal(f.harness.current.records.length, 57, 'the completed remote page preserves its merged records');
  assert.equal(new Set(f.harness.current.records.map((value) => value.id)).size, 57);
  assert.equal(f.harness.current.hasMore, false);
  assert.equal(f.queries.length, 1, 'storage updates issue no remote requests');
  f.harness.unmount();
}
async function failedRequestsKeepExpandedPage() {
  const f = fixture(); await f.harness.settle();
  const page = pageFor();
  f.queries[0].response.resolve(result(rows(100, 40), { hasMore: true, nextPage: page })); await f.harness.settle();
  assert.equal(f.harness.current.records.length, 40);
  const more = f.harness.current.loadMore(); await f.harness.settle();
  f.queries[1].response.reject(new Error('fixture remote page unavailable')); await more; await f.harness.settle();
  assert.equal(f.harness.current.records.length, 40, 'a failed next-page request preserves the complete loaded list');
  assert.equal(f.harness.current.hasMore, true, 'failed page leaves its remote cursor available for retry');
  const retry = f.harness.current.loadMore(); await f.harness.settle();
  assert.equal(f.queries[2].query.page, page, 'retry uses the same opaque cursor after a page failure');
  f.queries[2].response.resolve(result(rows(65, 20))); await retry; await f.harness.settle();
  assert.equal(f.harness.current.records.length, 55, 'retry adds only deduplicated records after the existing 40');
  const refresh = f.harness.current.refresh(); await f.harness.settle();
  f.queries[3].response.reject(new Error('fixture refresh unavailable')); await refresh; await f.harness.settle();
  assert.equal(f.harness.current.records.length, 55, 'failed manual refresh preserves every loaded record');
  assert.equal(f.harness.current.loading, false);
  assert.equal(f.harness.current.loadingMore, false);
  f.harness.unmount();
}
async function detailConfirmationStorageDoesNotRequestHistory() {
  const f = fixture();
  const pending = record(20, { source: 'local', state: 'pending' });
  f.setLocal(56, account, [pending]); await f.harness.settle();
  f.queries[0].response.resolve(result([pending])); await f.harness.settle();
  assert.equal(f.harness.current.records[0].state, 'pending');
  const confirmed = { ...pending, state: 'confirmed', blockNumber: 120 };
  f.setLocal(56, account, [confirmed]); f.notify(56, account); await f.harness.settle();
  assert.equal(f.harness.current.records[0].state, 'confirmed', 'detail confirmation merges through storage without a list refresh');
  assert.equal(f.harness.current.records[0].blockNumber, 120);
  assert.equal(f.queries.length, 1, 'detail confirmation never starts another remote history request');
  assert.equal(f.saves.length, 0, 'the list never writes confirmation storage itself');
  assert.equal(f.timers.size, 0, 'confirmed history has no pending polling timer');
  f.harness.unmount();
}
async function storageEventDuringRequestIsNotLost() {
  const f = fixture(); await f.harness.settle();
  const pending = record(30, { source: 'local', state: 'pending' });
  f.setLocal(56, account, [pending]); f.notify(56, account); await f.harness.settle();
  f.queries[0].response.resolve(result([])); await f.harness.settle();
  assert.equal(f.queries.length, 1, 'a storage update merges locally without repeating the indexer request');
  assert.equal(f.harness.current.records[0].hash, pending.hash, 'new locally submitted transfer appears without manual refresh');
  assert.equal(f.timers.size, 0, 'pending transfers do not start background history polling');
  f.harness.unmount();
  assert.equal(f.timers.size, 0, 'history remains free of polling timers after unmount');
}
async function latestStorageReadWins() {
  const f = fixture(); await f.harness.settle();
  f.queries[0].response.resolve(result([])); await f.harness.settle();
  const oldRead = f.deferNextLocalRead();
  const refresh = f.harness.current.refresh(); await f.harness.settle();
  const pending = record(40, { source: 'local', state: 'pending' });
  f.setLocal(56, account, [pending]); f.notify(56, account); await f.harness.settle();
  assert.equal(f.harness.current.records[0].hash, pending.hash, 'storage notification publishes before a slow earlier read completes');
  oldRead.resolve([]); await f.harness.settle();
  assert.equal(f.queries.length, 2);
  f.queries[1].response.resolve(result([])); await refresh; await f.harness.settle();
  assert.equal(f.harness.current.records[0].hash, pending.hash, 'an older storage read cannot erase the newest submitted transfer');
  f.harness.unmount();
}
async function staleStorageReadIsolation() {
  const f = fixture(); await f.harness.settle();
  f.queries[0].response.resolve(result([])); await f.harness.settle();
  const staleRead = f.deferNextLocalRead();
  f.notify(56, account); await f.harness.settle();
  f.select(eth, otherAccount); await f.harness.settle();
  const current = record(50, { chainId: 1, accountAddress: otherAccount, from: otherAccount, symbol: 'ETH' });
  f.queries[1].response.resolve(result([current])); await f.harness.settle();
  staleRead.resolve([record(99, { source: 'local' })]); await f.harness.settle();
  assert.equal(f.harness.current.records.length, 1);
  assert.equal(f.harness.current.records[0].hash, current.hash, 'late old-account storage callbacks cannot enter current scope');
  f.harness.unmount();
}
async function lockedAndUnmountedResultsIgnored() {
  const locked = fixture(); await locked.harness.settle();
  locked.core.vault.isLocked = () => true;
  locked.queries[0].response.resolve(result([record(60)]));
  await locked.harness.settle();
  assert.equal(locked.harness.current.records.length, 0, 'locked wallet cannot publish late history');
  assert.equal(locked.saves.length, 0, 'list results never write transaction storage');
  locked.harness.unmount();
  const unmounted = fixture(); await unmounted.harness.settle();
  unmounted.harness.unmount();
  unmounted.queries[0].response.resolve(result([record(61)]));
  await tick(); await tick();
  assert.equal(unmounted.saves.length, 0, 'unmounted list never writes transaction storage');
}
async function verify() {
  await initialDeduplication();
  await staleContextIsolation();
  await paginationMerge();
  await completeProviderPageRemainsVisible();
  await completeProviderPageUsesRemoteCursor();
  await irregularProviderPagesMergeCompletely();
  await refreshAndContextResetProviderPages();
  await storageMergeRetainsCompleteRecords();
  await failedRequestsKeepExpandedPage();
  await detailConfirmationStorageDoesNotRequestHistory();
  await storageEventDuringRequestIsNotLost();
  await latestStorageReadWins();
  await staleStorageReadIsolation();
  await lockedAndUnmountedResultsIgnored();
  console.log('History hook verification passed: initial deduplication, complete provider pages, opaque remote cursors, overlap deduplication, refresh/context isolation, stale-result rejection, detail confirmation storage merging without RPC or list writeback, and no background polling. No live RPC or secrets.');
}
verify().catch((error) => { console.error(error); process.exitCode = 1; });
