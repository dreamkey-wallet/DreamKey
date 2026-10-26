/* Exercise the real landing tab with an offline React hook fixture. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const slots = [];
let index = 0;
let tree;
let props;
let dialogs = [];
let language = 'zh';
const opened = [], toggled = [], changed = [];
let cleared = 0;
const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
const react = {
  memo: (component) => component,
  useState(initial) { const position = index++; if (!slots[position]) slots[position] = { value: initial }; const state = slots[position]; return [state.value, (next) => { state.value = typeof next === 'function' ? next(state.value) : next; }]; },
  useMemo(callback, deps) { const position = index++; if (!slots[position] || !same(slots[position].deps, deps)) slots[position] = { value: callback(), deps }; return slots[position].value; },
  useCallback(callback, deps) { return this.useMemo(() => callback, deps); },
  useEffect() { index += 1; },
  createElement(type, config, ...children) { return { type, props: { ...config, children: children.length === 1 ? children[0] : children } }; },
};
// Named hook imports are called without a receiver.
react.useCallback = (callback, deps) => react.useMemo(() => callback, deps);
const native = Object.fromEntries(['FlatList', 'KeyboardAvoidingView', 'Pressable', 'Text', 'TextInput', 'View'].map((value) => [value, value]));
Object.assign(native, {
  Alert: { alert: (...args) => dialogs.push(args) },
  Keyboard: { dismiss() {} },
  Platform: { OS: 'android' },
  StyleSheet: { create: (value) => value },
  useWindowDimensions: () => ({ width: 390 }),
});
const dependencies = {
  react,
  'react-native': native,
  'react-native-safe-area-context': { SafeAreaView: 'SafeAreaView' },
  '../i18n.js': { useI18n: () => ({ language }) },
  './icons.js': Object.fromEntries(['ArrowLeft', 'ArrowUpRight', 'Bookmark', 'ChevronRight', 'Clock3', 'Globe2', 'QrCode', 'Search', 'ShieldCheck', 'Star', 'Trash2', 'NetworkMark', 'X'].map((value) => [value, value])),
  '../dapp/DappFavicon.js': { DappFavicon: 'DappFavicon' },
  './QRScannerModal.js': { QrScannerModal: 'QrScannerModal' },
  './dapp/PopularDappsSection.js': { PopularDappsSection: 'PopularDappsSection' },
};
const fixture = { exports: {} };
const filename = path.join(__dirname, '../src/ui/DappLandingScreen.tsx');
const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true } }).outputText;
vm.runInNewContext(code, { module: fixture, exports: fixture.exports, URL, Set, require: (name) => { assert.ok(name in dependencies, `Unexpected dependency ${name}`); return dependencies[name]; } }, { filename });
function render() { index = 0; tree = fixture.exports.DappLandingScreen(props); }
function findAll(node, type, result = []) {
  if (!node || typeof node !== 'object') return result;
  if (Array.isArray(node)) { node.forEach((child) => findAll(child, type, result)); return result; }
  if (node.type === type) result.push(node);
  findAll(node.props?.children, type, result);
  findAll(node.props?.ListHeaderComponent, type, result);
  return result;
}
function list() { return findAll(tree, 'FlatList')[0]; }
function discovery() { return list().props.ListHeaderComponent.props.children[0]; }
const history = Array.from({ length: 30 }, (_, number) => `https://fixture${number}.example/app`);
const favorites = [history[4]];
props = { favorites, history, urlInput: '', onUrlChange: (value) => changed.push(value), onOpen: (url) => opened.push(url), onToggleFavorite: (url) => toggled.push(url), onClearHistory: () => { cleared += 1; }, onBack() {}, networkName: 'BSC', networkChainId: 56 };
render();
const favoriteList = findAll(tree, 'FlatList').find((node) => node.props.horizontal);
assert.ok(favoriteList, 'Favorites use their own horizontal virtualized list');
assert.equal(favoriteList.props.data, favorites);
assert.ok(favoriteList.props.initialNumToRender <= 3, 'Only a few favorite cards mount when changing tabs');
assert.ok(favoriteList.props.maxToRenderPerBatch <= 3);
assert.equal(favoriteList.props.getItemLayout(null, 2).length, 148);
assert.equal(favoriteList.props.getItemLayout(null, 2).offset, 320, 'Favorite offsets include each inter-card gap');
const favorite = favoriteList.props.renderItem({ item: history[4] });
favorite.props.onOpen(history[4]);
assert.deepEqual(opened, [history[4]]);
opened.length = 0;
const initialDiscovery = discovery();
const initialData = list().props.data;
assert.equal(initialData.length, 0);
assert.ok(list().props.initialNumToRender <= 3, 'A tab press cannot synchronously create ten history icons');
assert.ok(list().props.maxToRenderPerBatch <= 3, 'Later rows mount in small batches');
assert.ok(list().props.windowSize <= 5, 'Off-screen rows use a bounded render window');
assert.equal(list().props.extraData, favorites, 'Unchanged favorite state does not allocate a new extraData object');
findAll(tree, 'Pressable').filter((node) => node.props.accessibilityRole === 'tab')[1].props.onPress();
render();
assert.equal(list().props.data, history, 'Switching tabs shows the already loaded local history');
assert.equal(discovery(), initialDiscovery, 'Changing the lower tab reuses the heavy address/popular header subtree');
const row = list().props.renderItem({ item: history[4] });
assert.equal(row.props.favorite, true);
assert.equal(row.props.onOpen, props.onOpen, 'A row retains the caller navigation action');
assert.equal(row.props.onToggleFavorite, props.onToggleFavorite);
row.props.onOpen(history[4]);
row.props.onToggleFavorite(history[4]);
assert.deepEqual(opened, [history[4]], 'History still opens the exact saved website');
assert.deepEqual(toggled, [history[4]], 'The row toggles only the selected favorite');
const clear = findAll(tree, 'Pressable').find((node) => node.props.accessibilityLabel === '清除访问记录？');
clear.props.onPress();
assert.equal(cleared, 0, 'A clear action still waits for confirmation');
dialogs.at(-1)[2][1].onPress();
assert.equal(cleared, 1);
const newFavorites = [];
props = { ...props, favorites: newFavorites };
render();
assert.equal(list().props.renderItem({ item: history[4] }).props.favorite, false, 'Favorite state updates without rebuilding cached website metadata');
findAll(tree, 'Pressable').filter((node) => node.props.accessibilityRole === 'tab')[0].props.onPress();
render();
assert.equal(list().props.data, initialData, 'An empty tab reuses a stable data reference');
for (let count = 0; count < 6; count += 1) {
  findAll(tree, 'Pressable').filter((node) => node.props.accessibilityRole === 'tab')[count % 2].props.onPress();
  render();
}
assert.equal(opened.length, 1, 'Repeated tab switches never navigate or open a website');
language = 'en';
props = { ...props, history: [] };
render();
assert.equal(list().props.data.length, 0, 'Cleared history is reflected without another request');
assert.equal(findAll(tree, 'Pressable').filter((node) => node.props.accessibilityRole === 'tab')[1].props.accessibilityState.selected, true);
const hasEmptyText = (node) => JSON.stringify(node).includes('No Visits Yet');
assert.ok(hasEmptyText(list().props.ListEmptyComponent), 'An empty recent tab is localized');
assert.ok(JSON.stringify(discovery()).includes('Explore Web3'), 'The reused discovery header updates with the language');
const button = (label) => findAll(tree, 'Pressable').find((node) => node.props.accessibilityLabel === label);
button('Scan QR Code').props.onPress();
render();
assert.equal(findAll(tree, 'QrScannerModal')[0].props.visible, true, 'Scanning still opens from the memoized address form');
findAll(tree, 'QrScannerModal')[0].props.onScanned('https://scanned.example/path');
render();
assert.equal(findAll(tree, 'QrScannerModal')[0].props.visible, false);
assert.equal(opened.at(-1), 'https://scanned.example/path');
props = { ...props, urlInput: ' https://typed.example/path ' };
render();
button('Clear Website Address').props.onPress();
assert.equal(changed.at(-1), '');
findAll(tree, 'TextInput')[0].props.onSubmitEditing();
assert.equal(opened.at(-1), 'https://typed.example/path', 'The cached input action uses the latest address');
findAll(tree, 'Pressable').find((node) => findAll(node, 'Text').some((child) => child.props.children === 'Add to Favorites')).props.onPress();
assert.equal(toggled.at(-1), props.urlInput, 'Address favorites still use the caller URL normalization');
console.log('DApp landing verification passed: bounded favorites/history, stable discovery header/data, tab switching, navigation/favorite actions, clear confirmation, localization and address/QR controls. Offline fixture only.');
