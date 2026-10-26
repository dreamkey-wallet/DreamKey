/* Public in-memory fixtures for the production app's background lock boundary. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
function compile(source, globals = {}) {
  const module = { exports: {} };
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React } }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, ...globals });
  return module.exports;
}
const { WalletSessionGuard } = compile(fs.readFileSync(path.join(root, 'src/core/session-guard.ts'), 'utf8'));
let nativeVisibilityListener, appStateListener;
const visibilityNative = {
  initialState: { state: 'foreground', revision: 0 },
  async getState() { return this.initialState; }, addListener() {}, removeListeners() {},
};
const { subscribeAppVisibility } = compile(fs.readFileSync(path.join(root, 'src/native/app-visibility.ts'), 'utf8'), {
  require(name) {
    assert.equal(name, 'react-native');
    return {
      Platform: { OS: 'android' }, NativeModules: { DreamKeyAppVisibility: visibilityNative },
      NativeEventEmitter: class { addListener(event, listener) { assert.equal(event, 'DreamKeyAppVisibilityChange'); nativeVisibilityListener = listener; return { remove() {} }; } },
      AppState: { currentState: 'active', addEventListener(event, listener) { appStateListener = listener; return { remove() {} }; } },
    };
  },
});
let visibilityRevision = 0;
const changeListener = (state) => nativeVisibilityListener({ state, revision: ++visibilityRevision });
const source = ts.createSourceFile('App.tsx', fs.readFileSync(path.join(root, 'App.tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declaration = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'App');
assert.ok(declaration);
const slots = []; let cursor = 0; const effects = [];
const equal = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
const hooks = {
  useState(initial) { const index = cursor++; slots[index] ??= { value: typeof initial === 'function' ? initial() : initial }; return [slots[index].value, (value) => { slots[index].value = typeof value === 'function' ? value(slots[index].value) : value; }]; },
  useRef(initial) { const index = cursor++; return slots[index] ??= { current: initial }; },
  useMemo(factory, deps) { const index = cursor++; if (!slots[index] || !equal(slots[index].deps, deps)) slots[index] = { value: factory(), deps }; return slots[index].value; },
  useCallback(value, deps) { return this.useMemo(value === undefined ? () => undefined : () => value, deps); },
  useEffect(callback, deps) { const index = cursor++; if (!slots[index] || !equal(slots[index].deps, deps)) effects.push(() => { slots[index]?.cleanup?.(); slots[index] = { deps, cleanup: callback() }; }); },
};
hooks.useCallback = (value, deps) => hooks.useMemo(() => value, deps);
const React = { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }) };
const screenNames = ['WelcomeScreen', 'WalletSetupScreen', 'CreateScreen', 'CreateVerifyScreen', 'ImportScreen', 'UnlockScreen', 'HomeRouteScreen', 'AccountsScreen', 'NetworkRouteScreen', 'RpcRouteScreen', 'AssetsRouteScreen', 'AssetRouteScreen', 'SendScreen', 'ReceiveRouteScreen', 'TransactionRouteScreen', 'BrowserScreen', 'PermissionRouteScreen', 'SignRequestRouteScreen', 'SettingsScreen', 'InviteFriendsRouteScreen', 'LanguageSettingsScreen', 'SecuritySettingsScreen', 'PasswordSettingsScreen', 'AboutRouteScreen'];
class Storage {}
class LanguageStorage { async load() { return null; } }
class Manager { dispose() { for (const core of this.cores ?? []) core.vault.forget(); this.cores = []; } }
const app = compile(`${declaration.getText(source)}\nexports.App = App;`, {
  React, ...hooks, WalletSessionGuard, WalletManager: Manager,
  ReactNativeKeychainVaultStorage: Storage, ReactNativeKeychainBiometricAuthenticator: Storage,
  ReactNativeWalletPasswordVerifier: Storage, ReactNativeWalletManagerStorage: Storage,
  ReactNativeLanguageStorage: LanguageStorage, DEFAULT_NETWORKS: [{ id: 'fixture' }], saveTransaction() {},
  subscribeAppVisibility,
  SafeAreaProvider: 'SafeAreaProvider', I18nProvider: 'I18nProvider', WalletContext: { Provider: 'WalletProvider' }, AppNavigator: 'AppNavigator', UpdateProvider: 'UpdateProvider',
  ...Object.fromEntries(screenNames.map((name) => [name, name])),
});
let tree;
function render() { cursor = 0; tree = app.App(); while (effects.length) effects.shift()(); }
function find(node, type) { if (node?.type === type) return node; for (const child of node?.props?.children ?? []) { const found = find(child, type); if (found) return found; } }
function context() { return find(tree, 'WalletProvider').props.value; }
function fixtureCore() { return { forgotten: false, isWatchOnly: () => false, vault: { forget() { this.owner.forgotten = true; } } }; }
function core() { const value = fixtureCore(); value.vault.owner = value; return value; }
render();
let value = context(); const selected = core(), other = core(), draft = core(); let rejected = 0;
value.manager.cores = [selected, other]; value.setCore(selected); value.setCreationCore(draft);
value.setPendingApproval({ resolve(approved) { assert.equal(approved, false); rejected += 1; } }); render();
value = context(); const captured = value.session.capture(); const navigatorKey = find(tree, 'AppNavigator').props.key;
assert.equal(appStateListener, undefined, 'Android native visibility must replace onPause-based AppState background');
// Permission, biometric and chooser overlays pause the Activity without stopping it.
appStateListener?.('background'); render();
assert.equal(selected.forgotten, false, 'A visible Activity under a system prompt must keep the wallet session');
assert.equal(context().session.isCurrent(captured), true);
assert.equal(rejected, 0, 'System prompts must not reject pending DApp approval');
assert.equal(find(tree, 'AppNavigator').props.key, navigatorKey);
changeListener('foreground'); changeListener('background');
assert.equal(selected.forgotten || other.forgotten || draft.forgotten, false, 'Backgrounding must not lock wallets');
assert.equal(rejected, 0, 'Backgrounding must not reject pending DApp approvals');
assert.equal(value.session.isCurrent(captured), false, 'Background pauses the session guard without clearing wallet state');
changeListener('foreground');
assert.equal(selected.forgotten || other.forgotten || draft.forgotten, false, 'Returning to foreground must preserve wallets');
assert.equal(value.session.isCurrent(captured), false, 'Authentication captured before background must stay invalid after resume');
const resumed = value.session.capture();
assert.equal(value.session.isCurrent(resumed), true, 'New authentication may start after resume');
// The explicit lock action remains the security boundary for clearing
// controlled wallets, drafts, approvals and session cleanups.
void value.lock();
assert.equal(selected.forgotten && other.forgotten && draft.forgotten, true, 'Explicit lock must forget every controlled wallet and draft synchronously');
assert.equal(rejected, 1, 'Explicit lock must reject pending DApp approvals');
assert.equal(value.session.isCurrent(captured), false);
render(); assert.equal(context().core, null); assert.equal(context().creationCore, null);
assert.equal(find(tree, 'AppNavigator').props.key, navigatorKey, 'Manual lock keeps the navigation container stable while clearing wallet state');
changeListener('foreground');
assert.equal(context().session.isCurrent(captured), false, 'Returning to the foreground cannot revive an old authentication');
const next = context().session.capture(); assert.equal(context().session.isCurrent(next), true);
let released = 0;
const unregister = context().session.onInvalidate(() => { released += 100; }); unregister();
context().session.onInvalidate(() => { released += 1; });
const draftOnly = core(); context().setCreationCore(draftOnly); render(); changeListener('background');
assert.equal(draftOnly.forgotten, false, 'Backgrounding must not lock a first-wallet creation draft');
void context().lock();
assert.equal(draftOnly.forgotten, true, 'Explicit lock must clear a first-wallet creation draft');
assert.equal(released, 1, 'Pending restore cleanups run immediately, while completed resources can unregister');
console.log('Session security verification passed: background preserves wallet state; explicit lock clears wallets/drafts, rejects approvals and invalidates authentication. Public fixtures only.');
