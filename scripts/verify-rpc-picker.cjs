/* Mount the real RPC picker with a shared, offline health registry. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const tick = () => new Promise((resolve) => setImmediate(resolve));
function all(node, type, result = []) {
  if (!node || typeof node !== 'object') return result;
  if (Array.isArray(node)) { node.forEach((child) => all(child, type, result)); return result; }
  if (node.type === type) result.push(node);
  all(node.props?.children, type, result);
  return result;
}
function text(node) {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  return text(node.props?.children);
}
function fixture() {
  const slots = [];
  let index = 0, dirty = false, mounted = true, tree, selectedNetworkId = 'bsc', language = 'zh', updatesAfterUnmount = 0;
  const same = (left, right) => left && right && left.length === right.length && left.every((value, i) => Object.is(value, right[i]));
  const react = {
    createElement(type, config, ...children) { return { type, props: { ...config, children: children.length === 1 ? children[0] : children } }; },
    useReducer(reducer, initial) {
      const position = index++;
      if (!slots[position]) {
        const cell = slots[position] = { value: initial };
        cell.dispatch = (action) => { if (!mounted) updatesAfterUnmount += 1; cell.value = reducer(cell.value, action); dirty = true; };
      }
      return [slots[position].value, slots[position].dispatch];
    },
    useEffect(effect, deps) {
      const position = index++;
      const old = slots[position];
      if (!old || !same(old.deps, deps)) slots[position] = { kind: 'effect', deps, effect, cleanup: old?.cleanup, pending: true };
    },
  };
  const urls = ['https://first.example/rpc', 'https://second.example/rpc', 'https://third.example/rpc'];
  const networks = { bsc: { id: 'bsc', chainId: 56, name: 'BNB Chain' }, eth: { id: 'eth', chainId: 1, name: 'Ethereum' } };
  const health = new Map(), listeners = new Map(), preferred = new Map();
  const probes = [], writes = [], navigation = [];
  const key = (chainId, url) => `${chainId}:${url}`;
  function publish(chainId, url, value) {
    const id = key(chainId, url);
    health.set(id, value);
    for (const listener of listeners.get(id) ?? []) listener();
  }
  const colors = { red: '#red', green: '#green', muted: '#muted' };
  const native = Object.fromEntries(['Pressable', 'ScrollView', 'Text', 'View'].map((type) => [type, type]));
  native.StyleSheet = { create: (value) => value };
  const dependencies = {
    react, 'react-native': native, 'react-native-safe-area-context': { SafeAreaView: 'SafeAreaView' },
    '../i18n.js': { useI18n: () => ({ language, t: (value) => value }) },
    '../context/WalletContext.js': { useWalletContext: () => ({ core: { getNetwork: (id) => networks[id] }, selectedNetworkId }) },
    './icons.js': { Check: 'Check' }, './appStyles.js': { colors, styles: {} }, './AppSimpleScreens.js': { LoadingScreen: 'LoadingScreen' }, './primitives.js': { PageHeader: 'PageHeader' },
    '../core/rpc-endpoints.js': {
      getPreferredRpcEndpoint: (chainId) => preferred.get(chainId),
      getRpcEndpointChoices: () => urls,
      supportsRpcEndpointPreference: () => true,
      getRpcEndpointHealth: (chainId, url) => health.get(key(chainId, url)) ?? { status: 'unknown' },
      subscribeRpcEndpointHealth(chainId, url, listener) {
        const id = key(chainId, url), entry = listeners.get(id) ?? new Set();
        entry.add(listener); listeners.set(id, entry);
        return () => { entry.delete(listener); if (!entry.size) listeners.delete(id); };
      },
      probeRpcEndpoint(chainId, url) {
        let resolve;
        const promise = new Promise((done) => { resolve = done; });
        probes.push({ chainId, url, resolve(value) { publish(chainId, url, value); resolve(value); } });
        return promise;
      },
      setPreferredRpcEndpoint(chainId, url) { preferred.set(chainId, url); return true; },
      clearPreferredRpcEndpoint: (chainId) => preferred.delete(chainId),
    },
    '../native/rpc-preferences-storage.js': { rpcPreferencesStorage: {
      async set(chainId, url) { writes.push({ chainId, url }); },
      async clear(chainId) { writes.push({ chainId }); },
    } },
  };
  const filename = path.resolve(__dirname, '../src/ui/RpcRouteScreen.tsx');
  const source = fs.readFileSync(filename, 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, URL, require(name) { assert.ok(name in dependencies, `Unexpected dependency ${name}`); return dependencies[name]; } }, { filename });
  function render() {
    index = 0; dirty = false;
    tree = module.exports.RpcRouteScreen({ navigation: { navigate: (...args) => navigation.push(args), goBack: () => navigation.push('back') } });
    const pending = slots.filter((cell) => cell.kind === 'effect' && cell.pending);
    for (const cell of pending) { cell.pending = false; cell.cleanup?.(); }
    for (const cell of pending) cell.cleanup = cell.effect();
  }
  return {
    urls, probes, writes, navigation, listeners, colors, preferred, publish,
    mount: render,
    network(id) { selectedNetworkId = id; render(); },
    language(value) { language = value; render(); },
    get rows() { return all(tree, 'Pressable').filter((node) => node.props.accessibilityRole === 'radio'); },
    get body() { return text(tree); },
    dot(row) { return all(row, 'View').find((node) => Array.isArray(node.props.style) && node.props.style[0]?.width === 9).props.style[1].backgroundColor; },
    async settle() { for (let count = 0; count < 5; count += 1) { await tick(); if (mounted && dirty) render(); } },
    unmount() { for (const cell of slots.filter((item) => item.kind === 'effect')) cell.cleanup?.(); mounted = false; },
    get updatesAfterUnmount() { return updatesAfterUnmount; },
  };
}

async function main() {
  const h = fixture();
  h.mount();
  assert.equal(h.probes.length, 3);
  assert.match(text(h.rows[1]), /检测中/);
  h.probes[0].resolve({ status: 'ok', latencyMs: 109 });
  await h.settle();
  assert.match(text(h.rows[1]), /109 ms/, 'A completed healthy node updates before the remaining probes finish');
  assert.equal(h.dot(h.rows[1]), h.colors.green);
  assert.match(text(h.rows[2]), /检测中/);

  h.probes[1].resolve({ status: 'offline', latencyMs: 109 });
  await h.settle();
  assert.match(text(h.rows[2]), /不可用/);
  assert.doesNotMatch(text(h.rows[2]), /109 ms/, 'Offline status cannot be presented as usable response latency');
  assert.equal(h.dot(h.rows[2]), h.colors.red);
  h.probes[2].resolve({ status: 'slow', latencyMs: 940 });
  await h.settle();
  assert.match(text(h.rows[3]), /940 ms/);
  assert.equal(h.dot(h.rows[3]), '#e5be6c', 'High-latency nodes remain usable');

  const ordering = h.rows.slice(1).map((row) => row.props.key);
  h.rows[2].props.onPress();
  await h.settle();
  assert.equal(h.preferred.get(56), h.urls[1]);
  assert.equal(h.rows[2].props.accessibilityState.checked, true, 'Selecting an offline node retains that selection');
  assert.deepEqual(h.rows.slice(1).map((row) => row.props.key), ordering, 'Selection never reorders the picker');
  assert.deepEqual(h.navigation, [], 'Selecting a node does not navigate or pick another node');
  assert.deepEqual(h.writes, [{ chainId: 56, url: h.urls[1] }]);
  assert.equal(h.probes.length, 3, 'Selection does not launch a new conflicting measurement');

  h.publish(56, h.urls[0], { status: 'offline' });
  await h.settle();
  assert.match(text(h.rows[1]), /不可用/, 'The latest shared measurement replaces prior picker state');
  assert.equal(h.dot(h.rows[1]), h.colors.red);
  assert.equal(h.rows[2].props.accessibilityState.checked, true);
  h.rows[0].props.onPress();
  await h.settle();
  assert.equal(h.rows[0].props.accessibilityState.checked, true);
  assert.equal(h.preferred.has(56), false, 'Only choosing Automatic clears manual selection');

  h.network('eth');
  await h.settle();
  assert.equal(h.listeners.size, 3);
  assert.match(text(h.rows[1]), /检测中/, 'A different network cannot inherit old measurements for the same URL');
  const oldUpdates = h.body;
  h.publish(56, h.urls[0], { status: 'slow', latencyMs: 1500 });
  await h.settle();
  assert.equal(h.body, oldUpdates, 'A departed network no longer drives picker updates');
  h.probes.at(-3).resolve({ status: 'offline', latencyMs: 20 });
  await h.settle();
  h.language('en');
  assert.match(text(h.rows[1]), /Unavailable/);
  assert.doesNotMatch(text(h.rows[1]), /20 ms/);
  h.unmount();
  assert.equal(h.listeners.size, 0);
  h.probes.at(-1).resolve({ status: 'ok', latencyMs: 80 });
  await h.settle();
  assert.equal(h.updatesAfterUnmount, 0);
  console.log('RPC picker verification passed: immediate per-node/shared status, unavailable display, usable slow nodes, sticky manual selection/order, explicit automatic mode and lifecycle isolation. Offline fixture only.');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
