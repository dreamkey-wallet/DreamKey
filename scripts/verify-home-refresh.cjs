/* Mount the production home screen with offline data and controlled RPC probes. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
function text(node) {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  return text(node.props?.children);
}
function find(node, type, predicate = () => true) {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) return node.map((child) => find(child, type, predicate)).find(Boolean) ?? null;
  if (node.type === type && predicate(node)) return node;
  return find(node.props?.children, type, predicate);
}
function fixture() {
  const slots = [];
  let index = 0, mounted = false, dirty = false, focused = true, tree, props, updatesAfterUnmount = 0;
  const calls = { probes: [], balances: 0, prices: [] };
  const cached = new Map(), preferences = new Map(), listeners = new Map();
  const unknown = { status: 'unknown' };
  const publish = (chainId, url, health) => {
    const key = `${chainId}:${url}`;
    cached.set(key, health);
    for (const listener of listeners.get(key) ?? []) listener();
  };
  let balanceGate = null, priceGate = null;
  const same = (left, right) => left && right && left.length === right.length && left.every((value, i) => Object.is(value, right[i]));
  const react = {
    createElement(type, config, ...children) { return { type, props: { ...config, children: children.length === 1 ? children[0] : children } }; },
    useState(initial) {
      const position = index++;
      if (!slots[position]) slots[position] = { kind: 'state', value: typeof initial === 'function' ? initial() : initial };
      const slot = slots[position];
      return [slot.value, (next) => {
        if (!mounted) updatesAfterUnmount += 1;
        const value = typeof next === 'function' ? next(slot.value) : next;
        if (!Object.is(value, slot.value)) { slot.value = value; dirty = true; }
      }];
    },
    useRef(initial) { const position = index++; if (!slots[position]) slots[position] = { kind: 'ref', value: { current: initial } }; return slots[position].value; },
    useMemo(factory, deps) {
      const position = index++;
      if (!slots[position] || !same(slots[position].deps, deps)) slots[position] = { kind: 'memo', deps, value: factory() };
      return slots[position].value;
    },
    useCallback(callback, deps) { return react.useMemo(() => callback, deps); },
    useSyncExternalStore(subscribe, getSnapshot) {
      const [, redraw] = react.useState(0);
      react.useEffect(() => subscribe(() => redraw((value) => value + 1)), [subscribe]);
      return getSnapshot();
    },
    useEffect(effect, deps) {
      const position = index++;
      const previous = slots[position];
      if (!previous || !same(previous.deps, deps)) slots[position] = { kind: 'effect', deps, effect, cleanup: previous?.cleanup, pending: true };
    },
  };
  const colors = { red: '#red', green: '#green', muted: '#muted', accent: '#accent', accentBright: '#bright' };
  const native = Object.fromEntries(['ActivityIndicator', 'Pressable', 'RefreshControl', 'ScrollView', 'Text', 'View'].map((type) => [type, type]));
  Object.assign(native, { Alert: { alert() { assert.fail('Unexpected alert'); } }, StyleSheet: { create: (value) => value, hairlineWidth: 1 }, useWindowDimensions: () => ({ fontScale: 1 }) });
  const refreshBalances = () => { calls.balances += 1; return balanceGate?.promise ?? Promise.resolve(); };
  const refreshPrices = (force) => { calls.prices.push(force); return priceGate?.promise ?? Promise.resolve(); };
  const assets = [{ id: 'native', symbol: 'BNB', balance: '2', loading: false }];
  const valuation = { assets: { native: { priceUsd: 21, valueUsd: 42 } }, totalUsd: 42, complete: true, missingCount: 0, loading: false, stale: false, error: null, refresh: refreshPrices };
  const env = { assets, loading: false, prices: valuation, contextKey: null };
  const core = { getAccount: () => ({ address: '0x1111111111111111111111111111111111111111' }), isWatchOnly: () => false };
  const networkA = { id: 'bsc', chainId: 56, name: 'BNB Chain', nativeSymbol: 'BNB', rpcUrl: 'https://bsc.fixture.invalid' };
  const networkB = { id: 'eth', chainId: 1, name: 'Ethereum', nativeSymbol: 'ETH', rpcUrl: 'https://eth.fixture.invalid' };
  const routes = new Map([[56, [networkA.rpcUrl]], [1, [networkB.rpcUrl]]]);
  const readPool = (chainId, urls) => {
    const values = urls.map((url) => cached.get(`${chainId}:${url}`) ?? unknown);
    return values.find((health) => health.status === 'ok') ?? values.find((health) => health.status === 'slow')
      ?? values.find((health) => health.status === 'unknown') ?? values[0] ?? unknown;
  };
  const probeOne = (chainId, url) => {
    const gate = deferred();
    const call = { chainId, url, resolve: (health) => { publish(chainId, url, health); gate.resolve(health); } };
    calls.probes.push(call);
    return gate.promise;
  };
  const dependencies = {
    react, 'react-native': native, 'react-native-safe-area-context': { SafeAreaView: 'SafeAreaView' },
    '@react-navigation/native': {
      useIsFocused: () => focused,
      useFocusEffect(callback) { react.useEffect(() => focused ? callback() : undefined, [focused, callback]); },
    },
    '../../i18n.js': { useI18n: () => ({ language: 'zh', t: (key) => key }) },
    '../../context/WalletContext.js': { useWalletContext: () => ({ revision: 1, selectedAccountIndex: 0, manager: { getSelected: () => ({ label: 'Fixture' }) }, lock: async () => {} }) },
    '../icons.js': Object.fromEntries(['ArrowDownLeft', 'ArrowUpRight', 'ChevronDown', 'Compass', 'Eye', 'LockKeyhole', 'NetworkMark', 'RefreshCw', 'Settings', 'TokenIcon', 'Wallet'].map((name) => [name, name])),
    '../appStyles.js': { colors, styles: {} }, '../AppSimpleScreens.js': { LoadingScreen: 'LoadingScreen' },
    '../useWalletAssets.js': {
      useWalletAssets: (_core, account, network) => ({ assets: env.assets, loading: env.loading, error: null, refresh: refreshBalances, contextKey: env.contextKey ?? `${network.id}:${account}` }),
      displayAssetBalance: (value) => value,
    },
    '../useAssetPrices.js': { useAssetPrices: () => ({ ...env.prices, refresh: refreshPrices }) },
    '../../core/asset-prices.js': { formatUsd: (value) => `$${value}` },
    '../TransferScreens.js': { AssetsManagerScreen: 'AssetsManagerScreen' }, '../AssetDetailScreen.js': { AssetDetailScreen: 'AssetDetailScreen' },
    '../../core/rpc-endpoints.js': {
      getRpcEndpointUrls: (network) => preferences.has(network.chainId) ? [preferences.get(network.chainId)] : routes.get(network.chainId) ?? [network.rpcUrl],
      getRpcEndpointsHealth: readPool,
      subscribeRpcEndpointHealth(chainId, url, listener) {
        const key = `${chainId}:${url}`;
        const current = listeners.get(key) ?? new Set();
        current.add(listener); listeners.set(key, current);
        return () => { current.delete(listener); if (!current.size) listeners.delete(key); };
      },
      probeRpcEndpoints(chainId, urls) {
        return Promise.all(urls.map((url) => probeOne(chainId, url))).then(() => readPool(chainId, urls));
      },
    },
  };
  const filename = path.resolve(__dirname, '../src/ui/wallet/WalletRouteScreens.tsx');
  const source = fs.readFileSync(filename, 'utf8') + '\nexport { WalletHomeContent as TestHome };\n';
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, console, URL, require(name) { assert.ok(name in dependencies, `Unexpected dependency ${name}`); return dependencies[name]; } }, { filename });
  function render() {
    dirty = false; index = 0; tree = module.exports.TestHome(props);
    const pending = slots.filter((slot) => slot.kind === 'effect' && slot.pending);
    pending.forEach((slot) => { slot.pending = false; slot.cleanup?.(); });
    pending.forEach((slot) => { slot.cleanup = slot.effect(); });
  }
  const result = {
    calls, preferences, routes, colors, networkA, networkB, env, assets, valuation, publish,
    mount() { mounted = true; props = { core, network: networkA, navigation: { navigate() {}, reset() {} } }; render(); },
    update(input) { props = { ...props, ...input }; render(); },
    focus(value) { focused = value; render(); },
    async settle() { for (let pass = 0; pass < 8; pass += 1) { await tick(); if (mounted && dirty) render(); } },
    refresh() { find(tree, 'ScrollView').props.refreshControl.props.onRefresh(); },
    get refreshing() { return find(tree, 'ScrollView').props.refreshControl.props.refreshing; },
    get status() { return find(tree, 'Pressable', (node) => node.props.accessibilityLabel === '切换 RPC 节点'); },
    get latency() { return text(result.status); },
    get dot() { return find(result.status, 'View').props.style.at(-1).backgroundColor; },
    get body() { return text(tree); },
    gateData() { balanceGate = deferred(); priceGate = deferred(); return { balances: balanceGate, prices: priceGate }; },
    clearDataGates() { balanceGate = null; priceGate = null; },
    unmount() { slots.filter((slot) => slot.kind === 'effect').forEach((slot) => slot.cleanup?.()); mounted = false; },
    get updatesAfterUnmount() { return updatesAfterUnmount; },
  };
  return result;
}

async function main() {
  const h = fixture();
  h.mount();
  await h.settle();
  assert.equal(h.calls.probes.length, 1, 'Entering home probes the displayed node once');
  h.calls.probes[0].resolve({ status: 'ok', latencyMs: 120 });
  await h.settle();
  assert.equal(h.latency, '', 'Home shows only the status dot; milliseconds remain in the node picker');
  assert.equal(h.dot, h.colors.green);
  assert.equal(h.refreshing, false, 'Automatic focus refresh stays silent');

  h.env.loading = true;
  h.env.prices = { ...h.valuation, loading: true, complete: false };
  h.update({}); await h.settle();
  assert.equal(h.refreshing, false, 'Background balance and price work does not show manual refresh progress');
  assert.ok(h.body.includes('$42'), 'Background work keeps the settled current-wallet valuation');
  assert.ok(h.body.includes('estimatedAssetValue'), 'A retained amount is marked as an estimate');
  h.focus(false);
  h.env.prices = { ...h.valuation, assets: {}, totalUsd: null, loading: false, complete: false };
  h.update({}); await h.settle();
  assert.ok(h.body.includes('$42'), 'Disabling prices off screen does not clear the home snapshot');
  h.env.prices = { ...h.valuation, assets: {}, totalUsd: null, loading: true, complete: false };
  h.focus(true); await h.settle();
  assert.ok(h.body.includes('$42'), 'Returning home retains the current-wallet snapshot during loading');
  h.calls.probes.at(-1).resolve({ status: 'ok', latencyMs: 140 });
  await h.settle();
  h.env.loading = false; h.env.prices = h.valuation;
  h.update({}); await h.settle();

  const gates = h.gateData();
  const beforeBalance = h.calls.balances, beforePrices = h.calls.prices.length, beforeProbe = h.calls.probes.length;
  h.refresh();
  await h.settle();
  assert.equal(h.calls.probes.length, beforeProbe + 1, 'Pull-to-refresh includes a fresh RPC status probe');
  assert.equal(h.calls.balances, beforeBalance + 1);
  assert.equal(h.calls.prices.length, beforePrices + 1);
  assert.equal(h.calls.prices.at(-1), true, 'Manual refresh also forces price refresh');
  assert.equal(h.refreshing, true);
  assert.equal(h.dot, h.colors.green, 'The previous status stays visible while probing');
  assert.ok(h.body.includes('$42'), 'Refreshing node status keeps the settled valuation visible');
  gates.balances.resolve(); gates.prices.resolve();
  await h.settle();
  assert.equal(h.refreshing, true, 'Refresh waits for the node probe as well as balances and prices');
  h.calls.probes.at(-1).resolve({ status: 'slow', latencyMs: 940 });
  await h.settle();
  assert.equal(h.latency, '');
  assert.equal(h.dot, '#e5be6c', 'A slow usable node remains yellow');
  assert.equal(h.refreshing, false);
  h.clearDataGates();

  h.refresh();
  await h.settle();
  h.calls.probes.at(-1).resolve({ status: 'offline' });
  await h.settle();
  assert.equal(h.latency, '');
  assert.equal(h.dot, h.colors.red);

  const beforeFocus = h.calls.probes.length;
  h.focus(false); await h.settle();
  assert.equal(h.calls.probes.length, beforeFocus, 'An unfocused home does not initiate probes');
  h.preferences.set(56, 'https://bsc-backup.fixture.invalid');
  h.publish(56, 'https://bsc-backup.fixture.invalid', { status: 'offline' });
  h.focus(true); await h.settle();
  assert.equal(h.dot, h.colors.red, 'Returning from the picker immediately uses its selected red-node measurement');
  assert.equal(h.calls.probes.length, beforeFocus + 1, 'Returning home rechecks node status');
  assert.equal(h.calls.probes.at(-1).url, 'https://bsc-backup.fixture.invalid', 'A selection made in the picker is measured when returning');
  h.calls.probes.at(-1).resolve({ status: 'ok', latencyMs: 88 });
  await h.settle();
  assert.equal(h.dot, h.colors.green, 'A newly selected node updates the status dot');
  h.publish(56, 'https://bsc-backup.fixture.invalid', { status: 'offline' });
  await h.settle();
  assert.equal(h.dot, h.colors.red, 'A later shared measurement updates home without a separate stale snapshot');

  h.refresh(); await h.settle();
  const oldNetwork = h.calls.probes.at(-1);
  h.update({ network: h.networkB }); await h.settle();
  assert.equal(h.dot, '#e5be6c', 'A new network begins with its own unknown status');
  const newNetwork = h.calls.probes.at(-1);
  assert.equal(newNetwork.chainId, 1);
  newNetwork.resolve({ status: 'ok', latencyMs: 33 });
  await h.settle();
  oldNetwork.resolve({ status: 'slow', latencyMs: 1500 });
  await h.settle();
  assert.equal(h.dot, h.colors.green, 'A late old-network response cannot overwrite the active node');

  h.refresh(); await h.settle();
  const earlier = h.calls.probes.at(-1);
  h.refresh(); await h.settle();
  const later = h.calls.probes.at(-1);
  earlier.resolve({ status: 'slow', latencyMs: 900 });
  await h.settle();
  assert.equal(h.refreshing, true, 'Earlier refresh completion cannot clear the newer refresh');
  later.resolve({ status: 'ok', latencyMs: 44 });
  await h.settle();
  assert.equal(h.dot, h.colors.green);
  assert.equal(h.refreshing, false);

  const walletGates = h.gateData();
  h.refresh(); await h.settle();
  const oldWallet = h.calls.probes.at(-1);
  h.env.contextKey = 'wallet-B';
  h.env.assets = [{ ...h.assets[0], balance: null }];
  h.env.loading = true;
  h.env.prices = { ...h.valuation, assets: {}, totalUsd: null, loading: true, complete: false };
  h.update({}); await h.settle();
  assert.ok(!h.body.includes('$42'), 'Another wallet never inherits a saved valuation');
  assert.equal(h.refreshing, false);
  h.env.contextKey = 'eth:0'; h.update({}); await h.settle();
  assert.equal(h.refreshing, false, 'An A to B to A switch cannot restore an abandoned spinner');
  walletGates.balances.resolve(); walletGates.prices.resolve(); oldWallet.resolve({ status: 'ok', latencyMs: 50 });
  await h.settle();
  assert.equal(h.refreshing, false);
  h.clearDataGates();

  h.refresh(); await h.settle();
  const detached = h.calls.probes.at(-1);
  h.unmount();
  detached.resolve({ status: 'ok', latencyMs: 22 });
  await h.settle();
  assert.equal(h.updatesAfterUnmount, 0, 'A late probe or refresh completion cannot update an unmounted home');

  const automatic = fixture();
  const primary = automatic.networkA.rpcUrl, backup = 'https://bsc-backup.fixture.invalid';
  automatic.routes.set(56, [primary, backup]);
  automatic.publish(56, primary, { status: 'offline' });
  automatic.publish(56, backup, { status: 'ok', latencyMs: 109 });
  automatic.mount(); await automatic.settle();
  assert.equal(automatic.dot, automatic.colors.green, 'Automatic mode uses the healthy fallback status when its primary is red');
  assert.deepEqual(automatic.calls.probes.map((call) => call.url), [primary, backup], 'Home checks the actual automatic route rather than only its first node');
  automatic.publish(56, backup, { status: 'slow', latencyMs: 950 });
  await automatic.settle();
  assert.equal(automatic.dot, '#e5be6c', 'Automatic mode stays usable with only a slow fallback');
  automatic.publish(56, backup, { status: 'offline' });
  await automatic.settle();
  assert.equal(automatic.dot, automatic.colors.red, 'Automatic mode is red only if all route members are unavailable');
  automatic.publish(56, backup, { status: 'ok', latencyMs: 99 });
  automatic.focus(false); automatic.preferences.set(56, primary); automatic.focus(true);
  await automatic.settle();
  assert.equal(automatic.dot, automatic.colors.red, 'A manual red node ignores another healthy automatic fallback');
  assert.equal(automatic.calls.probes.at(-1).url, primary);
  automatic.unmount();
  console.log('Home refresh verification passed: dot-only status updates, silent background refresh, retained current-wallet values, complete refresh indicator, focus/preference changes, wallet/network isolation and stale/unmount protection. Offline fixture only.');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
