/* Mount the real history screen and hooks with offline navigation/RPC fixtures. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const ethers = require('ethers');

const root = path.resolve(__dirname, '..');
const tick = () => new Promise((done) => setImmediate(done));
const account = `0x${'1'.repeat(40)}`;
const peer = `0x${'2'.repeat(40)}`;
const network = { id: 'bsc', chainId: 56, name: 'BSC', nativeSymbol: 'BNB', rpcUrl: 'https://fixture.invalid' };
const ethereum = { id: 'ethereum', chainId: 1, name: 'Ethereum', nativeSymbol: 'ETH', rpcUrl: 'https://eth.fixture.invalid' };
function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function compile(relative, dependencies, globals = {}) {
  const code = ts.transpileModule(fs.readFileSync(path.join(root, relative), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module, exports: module.exports, console, setTimeout, clearTimeout, URL, URLSearchParams, AbortController,
    require(name) {
      if (Object.prototype.hasOwnProperty.call(dependencies, name)) return dependencies[name];
      if (name === 'ethers') return ethers;
      throw new Error(`Unexpected history screen dependency: ${name}`);
    },
    ...globals,
  }, { filename: relative });
  return module.exports;
}
function createHarness() {
  const slots = [];
  let index = 0, dirty = false, mounted = false, component, props, tree, focused = true;
  const sameDeps = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const react = {
    Fragment: 'Fragment', memo: (fn) => fn,
    createElement(type, config, ...children) {
      const next = { ...(config || {}) };
      if (children.length === 1) next.children = children[0];
      else if (children.length > 1) next.children = children;
      return typeof type === 'function' ? type(next) : { type, props: next };
    },
    useState(initial) {
      const position = index++;
      if (!slots[position]) slots[position] = { kind: 'state', value: typeof initial === 'function' ? initial() : initial };
      const cell = slots[position];
      return [cell.value, (next) => {
        if (!mounted) return;
        const value = typeof next === 'function' ? next(cell.value) : next;
        if (!Object.is(value, cell.value)) { cell.value = value; dirty = true; }
      }];
    },
    useRef(initial) {
      const position = index++;
      if (!slots[position]) slots[position] = { kind: 'ref', value: { current: initial } };
      return slots[position].value;
    },
    useMemo(factory, deps) {
      const position = index++;
      if (!slots[position] || !sameDeps(slots[position].deps, deps)) slots[position] = { kind: 'memo', deps, value: factory() };
      return slots[position].value;
    },
    useCallback(callback, deps) { return react.useMemo(() => callback, deps); },
    useEffect(effect, deps) {
      const position = index++;
      const old = slots[position];
      if (!old || !sameDeps(old.deps, deps)) slots[position] = { kind: 'effect', deps, effect, cleanup: old?.cleanup, pending: true };
    },
  };
  function render() {
    index = 0; dirty = false; tree = component(props);
    const pending = slots.filter((slot) => slot.kind === 'effect' && slot.pending);
    pending.forEach((slot) => { slot.pending = false; slot.cleanup?.(); });
    pending.forEach((slot) => { slot.cleanup = slot.effect(); });
  }
  return { react,
    navigation: {
      useIsFocused: () => focused,
      useFocusEffect(callback) { react.useEffect(() => focused ? callback() : undefined, [focused, callback]); },
    },
    mount(fn, nextProps) { component = fn; props = nextProps; mounted = true; render(); },
    update(changes) { props = { ...props, ...changes }; render(); },
    setFocus(next) { focused = next; render(); },
    get tree() { return tree; },
    async settle() { for (let pass = 0; pass < 12; pass += 1) { await tick(); if (mounted && dirty) render(); } },
    unmount() { mounted = false; slots.filter((slot) => slot.kind === 'effect').forEach((slot) => slot.cleanup?.()); },
  };
}
function text(node) {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  return node.props ? text(node.props.children) : '';
}
function findAll(node, type, found = []) {
  if (!node) return found;
  if (Array.isArray(node)) { node.forEach((child) => findAll(child, type, found)); return found; }
  if (node.type === type) found.push(node);
  if (node.props) for (const name of ['children', 'ListHeaderComponent', 'ListFooterComponent', 'ListEmptyComponent']) findAll(node.props[name], type, found);
  return found;
}
function button(f, title) {
  const node = findAll(f.harness.tree, 'Pressable').find((value) => text(value) === title);
  assert.ok(node, `Expected button: ${title}`);
  return node;
}
const list = (f) => findAll(f.harness.tree, 'FlatList')[0];
const refreshControl = (f) => list(f).props.refreshControl.props;
function record(number, changes = {}) {
  const hash = `0x${number.toString(16).padStart(64, '0')}`;
  return { id: `${hash}:external`, hash, chainId: 56, accountAddress: account, from: account, to: peer,
    direction: 'out', state: 'confirmed', rawValue: '1000000000000000000', symbol: 'BNB', decimals: 18,
    timestamp: 1700000000 + number, blockNumber: 100 + number, source: 'explorer', type: 'transfer', ...changes };
}
const result = (records, extra = {}) => ({ records, coverage: 'indexed', source: 'fixture', hasMore: false, ...extra });
const quotes = () => ({ native: { priceUsd: '600', timestamp: 1700000000 }, tokens: {}, fetchedAt: 1700000000000, error: false });

async function fixture() {
  const harness = createHarness();
  const histories = [], balances = [], prices = [], selected = [], timers = new Map(), listeners = new Set(), storageListeners = new Set();
  let saved = [];
  const timerApi = { setInterval(callback, duration) { const id = Symbol(); timers.set(id, { callback, duration }); return id; }, clearInterval(id) { timers.delete(id); } };
  const appState = { currentState: 'active', addEventListener(event, callback) { assert.equal(event, 'change'); listeners.add(callback); return { remove() { listeners.delete(callback); } }; } };
  const native = { ...Object.fromEntries(['ActivityIndicator', 'FlatList', 'Pressable', 'RefreshControl', 'Text', 'View'].map((name) => [name, name])), AppState: appState,
    Linking: { openURL() { throw new Error('Offline history test must not open URLs'); } }, StyleSheet: { create: (value) => value, hairlineWidth: 1 } };
  const core = {
    vault: { isLocked: () => false }, isWatchOnly: () => false, getAccount: () => ({ address: account }),
    getNativeBalance(_index, id) { const response = deferred(); balances.push({ id, response }); return response.promise; },
    getRpcTransport: () => async () => { throw new Error('Fixture history API must capture all reads'); },
  };
  const loader = compile('src/ui/wallet-assets-loader.ts', {});
  const walletHook = compile('src/ui/useWalletAssets.ts', { react: harness.react, './wallet-assets-loader.js': loader,
    '../native/token-storage.js': { loadTokens: async () => [], subscribeTokens: () => () => {} } });
  const historyApi = compile('src/core/asset-history.ts', {});
  const historyHook = compile('src/ui/useAssetHistory.ts', { react: harness.react, './wallet-assets-loader.js': loader,
    '../core/asset-history.js': { ...historyApi, listAssetTransactions(query) { const response = deferred(); histories.push({ query, response }); return response.promise; } },
    '../native/transaction-storage.js': {
      loadTransactions: async () => saved,
      saveTransaction: async () => { throw new Error('No receipt persistence is expected in this fixture'); },
      subscribeTransactions(_chainId, _account, callback) { storageListeners.add(callback); return () => storageListeners.delete(callback); },
    },
  }, timerApi);
  const priceApi = compile('src/core/asset-prices.ts', {});
  const priceHook = compile('src/ui/useAssetPrices.ts', { react: harness.react, 'react-native': native,
    '../core/asset-prices.js': { ...priceApi, assetPriceService: { getQuotes(chainId, addresses, force) { const response = deferred(); prices.push({ chainId, addresses, force, response }); return response.promise; } } },
  }, timerApi);
  const screen = compile('src/ui/AssetDetailScreen.tsx', { react: harness.react, 'react-native': native,
    'react-native-safe-area-context': { SafeAreaView: 'SafeAreaView' }, '@react-navigation/native': harness.navigation,
    '../core/asset-prices.js': priceApi, '../i18n.js': { useI18n: () => ({ language: 'zh' }) },
    './icons.js': new Proxy({}, { get: (_target, name) => (props) => ({ type: `icon:${String(name)}`, props }) }),
    './theme.js': compile('src/ui/theme.ts', {}), './useWalletAssets.js': walletHook, './useAssetHistory.js': historyHook, './useAssetPrices.js': priceHook,
  }).AssetDetailScreen;
  harness.mount(screen, { core, accountIndex: 0, network, onBack() {}, onSend() {}, onReceive() {}, onTransaction(value) { selected.push(value); } });
  await harness.settle();
  return { harness, histories, balances, prices, selected, timers, listeners,
    setAppState(next) { appState.currentState = next; [...listeners].forEach((callback) => callback(next)); },
    setLocal(records) { saved = records; [...storageListeners].forEach((callback) => callback()); },
  };
}

async function navigationKeepsHistorySnapshot() {
  const f = await fixture();
  assert.equal(f.histories.length, 1, 'first history entry starts one initial request');
  assert.equal(f.balances.length, 1);
  assert.equal(f.prices.length, 1);
  assert.equal(refreshControl(f).refreshing, false, 'initial loading does not activate pull-to-refresh');
  const incoming = record(3, { direction: 'in', from: peer, to: account });
  const outgoing = record(2);
  const page = { scope: `56:${account}:native`, provider: 'BscTrace', streams: { external: 2 } };
  f.histories[0].response.resolve(result([incoming, outgoing], { hasMore: true, nextPage: page }));
  f.balances[0].response.resolve('2'); f.prices[0].response.resolve(quotes()); await f.harness.settle();
  button(f, '加载更多').props.onPress(); await f.harness.settle();
  assert.equal(f.histories.length, 2);
  assert.equal(f.histories[1].query.page, page, 'explicit pagination uses the retained cursor');
  const older = record(1, { direction: 'in', from: peer, to: account });
  f.histories[1].response.resolve(result([older])); await f.harness.settle();
  button(f, '转入').props.onPress(); await f.harness.settle();
  assert.equal(list(f).props.data.length, 2);
  const rows = list(f).props.data;
  list(f).props.renderItem({ item: rows[0] }).props.onPress();
  assert.equal(f.selected[0].hash, incoming.hash, 'a list row opens its exact transaction');
  f.harness.setFocus(false); await f.harness.settle();
  f.setAppState('background'); f.setAppState('active');
  for (const timer of f.timers.values()) timer.callback();
  f.harness.setFocus(true); await f.harness.settle();
  assert.equal(f.histories.length, 2, 'returning from details never reloads history');
  assert.equal(f.balances.length, 1, 'returning from details never reloads balances');
  assert.equal(f.prices.length, 1, 'returning/resuming never reloads this page prices');
  assert.equal(list(f).props.data, rows, 'return preserves the selected filter and loaded pages');
  assert.equal(refreshControl(f).refreshing, false);
  assert.equal(f.timers.size, 0, 'history snapshots have no background polling timers');

  refreshControl(f).onRefresh(); await f.harness.settle();
  assert.equal(refreshControl(f).refreshing, true, 'only manual refresh opens the refresh indicator');
  assert.equal(f.histories.length, 3); assert.equal(f.balances.length, 2); assert.equal(f.prices.length, 2);
  assert.equal(f.histories[2].query.page, undefined, 'manual refresh starts from the newest page');
  assert.equal(f.prices[1].force, true, 'manual refresh requests fresh quotes');
  assert.equal(list(f).props.data.length, 2, 'refresh keeps existing rows visible');
  f.balances[1].response.resolve('3'); await f.harness.settle();
  assert.equal(refreshControl(f).refreshing, true, 'refresh indicator waits for history and prices');
  f.histories[2].response.resolve(result([record(4, { direction: 'in', from: peer, to: account })])); await f.harness.settle();
  assert.equal(refreshControl(f).refreshing, true, 'refresh indicator waits for the final price request');
  f.prices[1].response.resolve(quotes()); await f.harness.settle();
  assert.equal(refreshControl(f).refreshing, false);
  assert.equal(list(f).props.data.length, 1, 'manual refresh replaces the prior remote pages');
  f.harness.unmount();
}

async function storageAndContextChangesStayControlled() {
  const f = await fixture();
  const pending = record(8, { source: 'local', state: 'pending' });
  f.histories[0].response.resolve(result([pending])); f.balances[0].response.resolve('2'); f.prices[0].response.resolve(quotes()); await f.harness.settle();
  f.setLocal([{ ...pending, state: 'confirmed' }]); await f.harness.settle();
  assert.equal(list(f).props.data[0].state, 'confirmed', 'details storage updates merge without a remote refresh');
  assert.equal(f.histories.length, 1);
  assert.equal(f.timers.size, 0, 'pending transfers never poll the full list');
  button(f, '转入').props.onPress(); await f.harness.settle();
  assert.equal(list(f).props.data.length, 0);
  f.harness.update({ network: ethereum }); await f.harness.settle();
  assert.equal(list(f).props.data.length, 0, 'new chain never shows the previous chain records');
  assert.equal(f.histories.length, 2); assert.equal(f.balances.length, 2); assert.equal(f.prices.length, 2);
  const ethRecord = record(9, { chainId: 1, symbol: 'ETH' });
  f.histories[1].response.resolve(result([ethRecord])); f.balances[1].response.resolve('1'); f.prices[1].response.resolve(quotes()); await f.harness.settle();
  assert.equal(list(f).props.data.length, 1, 'context change resets the direction filter and loads once');
  f.harness.setFocus(false); f.harness.setFocus(true); await f.harness.settle();
  assert.equal(f.histories.length, 2);
  f.harness.unmount();
}

(async () => {
  await navigationKeepsHistorySnapshot();
  await storageAndContextChangesStayControlled();
  console.log('History screen verification passed: first/context loads, detail-return snapshot and filter/page retention, no background history polling, storage-only status merges, manual pagination and coordinated manual refresh feedback. Real screen and hooks; no live RPC or secrets.');
})().catch((error) => { console.error(error); process.exitCode = 1; });
