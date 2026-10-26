/* Execute production App screen functions with public fixtures and isolated hook/native mocks. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const source = fs.readFileSync(path.resolve(__dirname, '../App.tsx'), 'utf8');
const parsed = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const publicPassword = 'public auth fixture password';
const tick = () => new Promise((resolve) => setImmediate(resolve));
const t = (key) => key;
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function flatten(node) { if (node == null || typeof node === 'boolean') return []; if (Array.isArray(node)) return node.flatMap(flatten); return [node, ...(node.props ? flatten(node.props.children) : [])]; }
function text(node) { return flatten(node).filter((value) => typeof value === 'string' || typeof value === 'number').join(''); }

function fixture(overrides = {}) {
  const options = { vaultExists: false, collectionExists: false, configured: true, biometricEnabled: true, biometricAvailable: true, ...overrides };
  const calls = { present: [], loaded: [], saved: [], cleared: [], biometric: [], verified: [], preference: [], managerPersist: 0, vaultPersist: 0, cores: [], managers: [], selected: [], alerts: [], navigation: [], dismissed: 0, gestures: [] };
  const storage = { async hasWallet() { calls.present.push('vault'); return options.vaultExists; }, async load() { calls.loaded.push('vault'); return 'public legacy vault fixture'; }, async save(value) { calls.saved.push(['vault', value]); }, async clear() { calls.cleared.push('vault'); }, setPasswordMode() {}, setBiometricEnabled() {} };
  const managerStorage = { async hasWallet() { calls.present.push('manager'); return options.collectionExists; }, async load() { calls.loaded.push('manager'); return 'serializedManager' in options ? options.serializedManager : 'public collection fixture'; }, async save(value) { calls.saved.push(['manager', value]); }, async clear() { calls.cleared.push('manager'); }, setPasswordMode() {}, setBiometricEnabled() {} };
  const passwordVerifier = {
    async isConfigured() { return options.configured; }, async isBiometricEnabled() { return options.biometricEnabled; },
    async verify(value) { calls.verified.push(value); return options.configured && value === publicPassword; },
    async setPassword(value) { calls.preference.push(['password', value]); options.configured = true; },
    async setPasswordMode(value) { calls.preference.push(['passwordMode', value]); },
    async setBiometricEnabled(value) { calls.preference.push(['biometric', value]); options.biometricEnabled = value; },
    async clearPassword() { calls.preference.push(['clearPassword']); options.configured = false; },
  };
  const biometric = { async isAvailable() { return options.biometricAvailable; }, async authenticate(reason) { calls.biometric.push(reason); return options.biometricAvailable; } };
  const core = { isWatchOnly: () => false, vault: { async persist() { calls.vaultPersist += 1; }, serialize() { return 'public vault fixture'; } } };
  const manager = { getSelectedCore: () => core, list: () => [{ id: 'public-wallet-fixture' }], async persist() { calls.managerPersist += 1; }, async addCoreAndPersist() { return { id: 'public-wallet-fixture' }; }, async selectAndPersist() {} };
  const context = { storage, managerStorage, passwordVerifier, biometric, manager, core, setCore(value) { calls.cores.push(value); }, setManager(value) { calls.managers.push(value); }, setSelectedAccountIndex(value) { calls.selected.push(value); }, setRevision(fn) { assert.equal(fn(0), 1); } };
  let generation = 0, foreground = true;
  const cleanups = new Set();
  context.session = { capture: () => generation, isCurrent: (value) => foreground && value === generation, assertCurrent(value) { if (!this.isCurrent(value)) throw new Error('Wallet session has expired'); }, onInvalidate(callback) { cleanups.add(callback); return () => cleanups.delete(callback); }, invalidate() { generation += 1; for (const callback of cleanups) callback(); cleanups.clear(); }, setForeground(value) { foreground = value; } };
  const navigation = { navigate(name, params) { calls.navigation.push({ method: 'navigate', name, params }); }, replace(name, params) { calls.navigation.push({ method: 'replace', name, params }); }, reset(value) { calls.navigation.push({ method: 'reset', value }); }, goBack() { calls.navigation.push({ method: 'back' }); }, setOptions(options) { calls.gestures.push(options.gestureEnabled); } };
  return { options, calls, context, navigation, core, manager };
}

function mount(name, app, props = {}) {
  const declaration = parsed.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(declaration, `Production ${name} must exist`);
  const slots = []; let cursor = 0, tree; const effects = [];
  const sameDeps = (left, right) => left && right && left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
  const useEffect = (callback, deps) => { const index = cursor++; const prior = slots[index]; if (!prior || !sameDeps(prior.deps, deps)) { effects.push(() => { prior?.cleanup?.(); slots[index] = { deps, cleanup: callback() }; }); } };
  const hooks = {
    useState(initial) { const index = cursor++; if (!slots[index]) slots[index] = { value: typeof initial === 'function' ? initial() : initial }; return [slots[index].value, (next) => { slots[index].value = typeof next === 'function' ? next(slots[index].value) : next; }]; },
    useRef(initial) { const index = cursor++; return slots[index] ??= { current: initial }; },
    useCallback(callback, deps) { const index = cursor++; if (!slots[index] || !sameDeps(slots[index].deps, deps)) slots[index] = { value: callback, deps }; return slots[index].value; },
    useEffect,
    useFocusEffect(callback) { useEffect(callback, [callback]); },
  };
  const React = { ...hooks, createElement(type, props, ...children) { return { type, props: { ...(props || {}), children: children.length === 1 ? children[0] : children } }; } };
  const names = ['SafeAreaView', 'StatusBar', 'View', 'Text', 'TextInput', 'Pressable', 'KeyboardAvoidingView', 'ScrollView', 'ActivityIndicator', 'Switch', 'Modal', 'BrandHeader', 'PageHeader', 'PrimaryButton', 'Field', 'ShieldCheck', 'LockKeyhole', 'KeyRound', 'SettingsRow', 'WalletManagementScreen'];
  const globals = {
    React, ...hooks, ...Object.fromEntries(names.map((value) => [value, value])),
    useI18n: () => ({ t, language: 'en' }), useWalletContext: () => app.context,
    styles: new Proxy({}, { get: (_, key) => key }), colors: {}, Platform: { OS: 'android' },
    Keyboard: { dismiss() { app.calls.dismissed += 1; } },
    Alert: { alert(...args) { app.calls.alerts.push(args); } }, BackHandler: { addEventListener(_event, callback) { app.calls.backHandler = callback; return { remove() {} }; } },
    waitForPaint: async () => undefined, DEFAULT_NETWORKS: [], saveTransaction() {},
    WalletManager: { fromSerialized(value) { assert.equal(value, 'public collection fixture'); return app.manager; } },
    restoreWallet: async (value) => { assert.equal(value, 'public legacy vault fixture'); return app.core; },
  };
  const code = ts.transpileModule(`${declaration.getText(parsed)}\nexports.screen = ${name};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React } }).outputText;
  const module = { exports: {} }; vm.runInNewContext(code, { module, exports: module.exports, ...globals }, { filename: `App.tsx:${name}` });
  const render = () => { cursor = 0; tree = module.exports.screen({ navigation: app.navigation, ...props }); while (effects.length) effects.shift()(); return tree; };
  const node = (type, predicate = () => true) => { const result = flatten(tree).find((value) => value?.type === type && predicate(value.props)); assert.ok(result, `${name} must render ${type}`); return result; };
  const settle = async () => { await tick(); render(); await tick(); render(); };
  render(); return { render, node, settle, get tree() { return tree; }, unmount() { for (const slot of slots) slot?.cleanup?.(); } };
}

async function welcomePresenceAndFirstWallet() {
  for (const existing of [{ vaultExists: true }, { collectionExists: true }]) {
    const app = fixture(existing); const screen = mount('WelcomeScreen', app); await screen.settle();
    assert.equal(app.calls.navigation[0]?.name, 'Unlock');
    assert.equal(app.calls.navigation[0]?.method, 'replace');
    assert.deepEqual(app.calls.loaded, [], 'Locked welcome must only check presence; never read secrets');
    assert.equal(screen.node('PrimaryButton', (p) => p.title === 'createNewWallet').props.disabled, true);
    assert.ok(flatten(screen.tree).some((value) => value?.type === 'Pressable' && text(value).includes('unlockExistingWallet')), 'Existing wallet should expose the unlock shortcut');
    screen.unmount();
  }
  const app = fixture({ configured: false, biometricAvailable: false }); const screen = mount('WelcomeScreen', app); await screen.settle();
  assert.equal(screen.node('PrimaryButton', (p) => p.title === 'createNewWallet').props.disabled, false);
  assert.equal(flatten(screen.tree).some((value) => value?.type === 'Pressable' && text(value).includes('unlockExistingWallet')), false, 'A fresh install must hide the unlock-existing-wallet shortcut');
  screen.node('PrimaryButton', (p) => p.title === 'createNewWallet').props.onPress(); await screen.settle();
  assert.equal(app.calls.navigation[0].name, 'WalletSetup'); assert.equal(app.calls.navigation[0].params.next, 'Create');
  screen.node('PrimaryButton', (p) => p.title === 'importWallet').props.onPress(); await screen.settle();
  assert.equal(app.calls.navigation[1].name, 'WalletSetup'); assert.equal(app.calls.navigation[1].params.next, 'Import');
  assert.deepEqual(app.calls.loaded, []);
  const protectedApp = fixture({ configured: true, biometricAvailable: false }); const protectedScreen = mount('WelcomeScreen', protectedApp); await protectedScreen.settle();
  protectedScreen.node('PrimaryButton', (p) => p.title === 'createNewWallet').props.onPress(); await protectedScreen.settle();
  assert.equal(protectedApp.calls.navigation[0].name, 'Create', 'A configured password is sufficient on a no-biometric device');
}

async function welcomeRecoveryAndPreparation() {
  const failed = fixture(); let presenceAttempts = 0;
  failed.context.storage.hasWallet = async () => { if (presenceAttempts++ === 0) throw new Error('Public storage discovery failure'); return false; };
  const recover = mount('WelcomeScreen', failed); await recover.settle();
  assert.equal(recover.node('PrimaryButton', (p) => p.title === 'createNewWallet').props.disabled, true, 'Discovery failure cannot enable wallet creation');
  recover.node('PrimaryButton', (p) => p.title === 'Try Again').props.onPress(); await recover.settle();
  assert.equal(presenceAttempts, 2, 'Retry repeats only the presence check');
  assert.equal(recover.node('PrimaryButton', (p) => p.title === 'createNewWallet').props.disabled, false, 'Successful retry restores onboarding');
  assert.deepEqual(failed.calls.loaded, [], 'Presence retry never reads wallet secrets'); recover.unmount();

  const app = fixture(); const capability = deferred();
  app.context.biometric.isAvailable = () => capability.promise;
  const screen = mount('WelcomeScreen', app); await screen.settle();
  const create = screen.node('PrimaryButton', (p) => p.title === 'createNewWallet').props.onPress;
  const importWallet = screen.node('PrimaryButton', (p) => p.title === 'importWallet').props.onPress;
  create(); importWallet(); screen.render();
  assert.equal(screen.node('PrimaryButton', (p) => p.title === 'createNewWallet').props.loading, true, 'Auth preparation has visible feedback');
  assert.equal(screen.node('PrimaryButton', (p) => p.title === 'importWallet').props.disabled, true, 'Competing onboarding actions wait for preparation');
  capability.resolve(true); await screen.settle();
  assert.equal(app.calls.navigation.length, 1, 'Rapid taps navigate only once');
  assert.equal(app.calls.navigation[0].name, 'Create'); screen.unmount();
}

async function unlockChoicesAndMigration() {
  const app = fixture(); const screen = mount('UnlockScreen', app);
  assert.equal(screen.node('PrimaryButton').props.loading, true, 'Discovery initially disables unlock');
  await screen.settle(); assert.equal(screen.node('PrimaryButton').props.loading, false, 'Promise.all/finally must release ready after native discovery resolves');
  screen.node('Pressable', (p) => text({ props: p }) === 'usePassword').props.onPress(); screen.render();
  screen.node('TextInput').props.onChangeText('wrong password'); screen.render();
  screen.node('PrimaryButton').props.onPress(); await screen.settle();
  assert.deepEqual(app.calls.loaded, [], 'Wrong passwords cannot load wallets'); assert.deepEqual(app.calls.biometric, []);
  assert.equal(screen.node('PrimaryButton').props.loading, false, 'Rejected password releases the busy guard');
  screen.node('TextInput').props.onChangeText(publicPassword); screen.render();
  screen.node('PrimaryButton').props.onPress(); await screen.settle();
  assert.deepEqual(app.calls.biometric, [], 'Selecting password must never invoke the biometric adapter');
  assert.deepEqual(app.calls.loaded, ['manager']); assert.equal(app.calls.managerPersist, 1); assert.equal(app.calls.vaultPersist, 1, 'Authenticated legacy entries must be resaved');
  assert.equal(app.calls.cores[0], app.core); assert.equal(app.calls.navigation.at(-1).value.routes[0].name, 'Main');
  assert.equal(screen.node('TextInput').props.value, '');
  const noBio = fixture({ biometricAvailable: false }); const passwordScreen = mount('UnlockScreen', noBio); await passwordScreen.settle();
  assert.ok(passwordScreen.node('TextInput')); assert.equal(passwordScreen.node('PrimaryButton').props.title, 'unlockWallet');
  assert.equal(flatten(passwordScreen.tree).some((value) => value?.type === 'Pressable' && text(value).includes('usePassword')), false);
  const bio = fixture(); const bioScreen = mount('UnlockScreen', bio); await bioScreen.settle(); bioScreen.node('PrimaryButton').props.onPress(); await bioScreen.settle();
  assert.deepEqual(bio.calls.biometric, ['unlockWallet']); assert.deepEqual(bio.calls.verified, []);

  const legacy = fixture({ serializedManager: null }); legacy.context.manager = { ...legacy.manager, list: () => [], getSelectedCore: () => null };
  // A public legacy fixture checks that the fallback is authenticated before both reads.
  const legacyScreen = mount('UnlockScreen', legacy); await legacyScreen.settle(); legacyScreen.node('PrimaryButton').props.onPress(); await legacyScreen.settle();
  assert.deepEqual(legacy.calls.biometric, ['unlockWallet']); assert.deepEqual(legacy.calls.loaded, ['manager', 'vault']);
  assert.equal(legacy.calls.managerPersist, 1); assert.equal(legacy.calls.vaultPersist, 1);
}

async function discoveryReadyAndFailure() {
  const app = fixture(); const discovery = deferred(); app.context.biometric.isAvailable = () => discovery.promise;
  const screen = mount('UnlockScreen', app); await screen.settle();
  assert.equal(screen.node('PrimaryButton').props.loading, true, 'Ready must wait until native discovery finishes');
  discovery.resolve(true); await screen.settle(); assert.equal(screen.node('PrimaryButton').props.loading, false);
  const failed = fixture(); failed.context.biometric.isAvailable = async () => { throw new Error('public native fixture failure'); };
  const failedScreen = mount('UnlockScreen', failed); await failedScreen.settle();
  assert.equal(failedScreen.node('PrimaryButton').props.loading, false, 'Native discovery rejection must not leave the spinner pending');
  assert.ok(failedScreen.node('TextInput'), 'A failed biometric capability query still exposes the configured password');
  failedScreen.node('TextInput').props.onChangeText(publicPassword); failedScreen.render();
  failedScreen.node('PrimaryButton').props.onPress(); await failedScreen.settle();
  assert.deepEqual(failed.calls.verified, [publicPassword]); assert.deepEqual(failed.calls.loaded, ['manager']);
  assert.deepEqual(failed.calls.biometric, [], 'Password recovery does not depend on a successful biometric capability query');
  const unavailable = fixture({ configured: false }); unavailable.context.biometric.isAvailable = async () => { throw new Error('public capability failure'); };
  const noPassword = mount('UnlockScreen', unavailable); await noPassword.settle();
  assert.equal(flatten(noPassword.tree).some((node) => node?.type === 'TextInput'), false, 'Capability failures never invent a password for biometric-only wallets');
  assert.ok(text(noPassword.tree).includes('biometricUnavailable'));
}

async function failedBiometricsOfferPassword() {
  for (const outcome of ['declined', 'native-error']) {
    const app = fixture();
    app.context.biometric.authenticate = async (reason) => {
      app.calls.biometric.push(reason);
      if (outcome === 'native-error') throw new Error('public biometric cancellation/lockout fixture');
      return false;
    };
    const screen = mount('UnlockScreen', app); await screen.settle();
    assert.equal(flatten(screen.tree).some((node) => node?.type === 'TextInput'), false, 'Biometrics remain the first choice');
    const initialUnlock = screen.node('PrimaryButton').props.onPress;
    initialUnlock(); initialUnlock(); await screen.settle();
    assert.deepEqual(app.calls.biometric, ['unlockWallet'], 'Repeated taps open only one biometric prompt');
    assert.deepEqual(app.calls.loaded, [], 'Failed or canceled biometrics cannot read wallet secrets');
    assert.equal(screen.node('TextInput').props.value, '');
    assert.ok(text(screen.tree).includes('biometricFailedUsePassword'));
    assert.equal(screen.node('PrimaryButton').props.disabled, true, 'An empty fallback password cannot unlock');
    screen.node('TextInput').props.onChangeText('public wrong password'); screen.render();
    screen.node('PrimaryButton').props.onPress(); await screen.settle();
    assert.deepEqual(app.calls.loaded, []); assert.equal(app.calls.navigation.length, 0);
    screen.node('TextInput').props.onChangeText(publicPassword); screen.render();
    screen.node('TextInput').props.onSubmitEditing(); await screen.settle();
    assert.deepEqual(app.calls.biometric, ['unlockWallet'], 'Fallback password submission never reopens biometrics');
    assert.deepEqual(app.calls.verified, ['public wrong password', publicPassword]);
    assert.deepEqual(app.calls.loaded, ['manager']);
    assert.equal(app.calls.navigation.at(-1).value.routes[0].name, 'Main');
    screen.unmount();

    const legacy = fixture({ configured: false }); legacy.context.biometric.authenticate = app.context.biometric.authenticate;
    const biometricOnly = mount('UnlockScreen', legacy); await biometricOnly.settle();
    biometricOnly.node('PrimaryButton').props.onPress(); await biometricOnly.settle();
    assert.equal(flatten(biometricOnly.tree).some((node) => node?.type === 'TextInput'), false, 'No password fallback is offered before a password is configured');
    assert.deepEqual(legacy.calls.loaded, []); assert.equal(legacy.calls.navigation.length, 0);
    assert.equal(biometricOnly.node('PrimaryButton').props.loading, false);
    biometricOnly.unmount();
  }
}

async function noBiometricSecurityAndPassword() {
  const app = fixture({ biometricAvailable: false }); const security = mount('SecuritySettingsScreen', app); await security.settle();
  assert.equal(security.node('Switch').props.value, false); assert.equal(security.node('Switch').props.disabled, true);
  security.node('Switch').props.onValueChange(true); await security.settle();
  assert.ok(text(security.tree).includes('biometricUnavailable')); assert.deepEqual(app.calls.biometric, []); assert.deepEqual(app.calls.preference, []);

  const password = mount('PasswordSettingsScreen', app); await password.settle();
  password.node('Field', (p) => p.label === 'currentPassword').props.onChangeText(publicPassword); password.render();
  password.node('PrimaryButton', (p) => p.title === 'disablePassword').props.onPress();
  const buttons = app.calls.alerts.at(-1)[2]; buttons.find((value) => value.text === 'confirm').onPress(); await password.settle();
  assert.ok(text(password.tree).includes('passwordNeedsBiometrics')); assert.equal(app.options.configured, true, 'No-biometric users cannot remove their last authentication method');
  assert.deepEqual(app.calls.biometric, []); assert.deepEqual(app.calls.preference, []);

  const first = fixture({ configured: false, biometricAvailable: false }); const setup = mount('WalletSetupScreen', first, { route: { params: { next: 'Import' } } });
  setup.node('Field', (p) => p.label === 'walletPassword').props.onChangeText(publicPassword); setup.node('Field', (p) => p.label === 'confirmPassword').props.onChangeText(publicPassword); setup.render();
  setup.node('Field', (p) => p.label === 'confirmPassword').props.onSubmitEditing();
  setup.node('PrimaryButton').props.onPress(); await setup.settle();
  assert.deepEqual(first.calls.preference, [['password', publicPassword], ['passwordMode', true], ['biometric', false]]);
  assert.equal(first.calls.navigation.length, 1, 'Keyboard submission and a rapid button press share one guarded save');
  assert.equal(first.calls.navigation.at(-1).name, 'Import'); assert.deepEqual(first.calls.loaded, []);
}

async function securitySettingsBusyNavigation() {
  const app = fixture({ biometricEnabled: false }); const decision = deferred();
  app.context.biometric.authenticate = () => decision.promise;
  const screen = mount('SecuritySettingsScreen', app); await screen.settle();
  const back = screen.node('PageHeader').props.onBack;
  const passwordRoute = screen.node('SettingsRow').props.onPress;
  const toggle = screen.node('Switch').props.onValueChange;
  toggle(true); toggle(true); screen.render();
  assert.equal(screen.node('PageHeader').props.disabled, true, 'Saving visibly disables the back button');
  assert.equal(app.calls.gestures.at(-1), false, 'Saving disables the iOS back gesture');
  assert.equal(app.calls.backHandler(), true, 'Saving blocks Android hardware back');
  back(); passwordRoute(); assert.deepEqual(app.calls.navigation, [], 'Stale navigation handlers cannot leave during authentication');
  assert.equal(app.calls.dismissed, 1, 'Authentication dismisses the keyboard before the native prompt');
  decision.resolve(false); await screen.settle();
  assert.equal(screen.node('PageHeader').props.disabled, false); assert.equal(app.calls.backHandler(), false);
  assert.equal(app.calls.gestures.at(-1), true, 'Canceled authentication restores the back gesture');
  screen.node('PageHeader').props.onBack(); assert.equal(app.calls.navigation[0].method, 'back'); screen.unmount();
}

async function walletManagementAuthentication() {
  const app = fixture(); const screen = mount('AccountsScreen', app); await screen.settle();
  const management = screen.node('WalletManagementScreen').props;
  assert.equal(management.authenticationMode, 'both');
  assert.equal(await management.onAuthenticate('incorrect fixture password'), false, 'A wrong password cannot authorize a sensitive wallet action');
  assert.equal(await management.onAuthenticate(publicPassword), true);
  assert.deepEqual(app.calls.verified, ['incorrect fixture password', publicPassword]);
  assert.deepEqual(app.calls.biometric, [], 'Password authentication does not silently fall back to biometrics');
  assert.equal(await management.onAuthenticate(), true);
  assert.deepEqual(app.calls.biometric, ['authenticateToAccess'], 'A shared prompt applies to deletion and exports');
  assert.deepEqual(app.calls.saved, [], 'Authentication itself cannot mutate wallets');
  screen.unmount();

  const disabled = fixture({ biometricEnabled: false }); const passwordOnly = mount('AccountsScreen', disabled); await passwordOnly.settle();
  const passwordManagement = passwordOnly.node('WalletManagementScreen').props;
  assert.equal(passwordManagement.authenticationMode, 'password');
  assert.equal(await passwordManagement.onAuthenticate(), false, 'Disabled biometrics cannot authorize deletion');
  assert.deepEqual(disabled.calls.biometric, []);
  assert.equal(await passwordManagement.onAuthenticate(publicPassword), true);
  passwordOnly.unmount();

  const unavailable = fixture({ biometricAvailable: false }); const noBiometric = mount('AccountsScreen', unavailable); await noBiometric.settle();
  assert.equal(noBiometric.node('WalletManagementScreen').props.authenticationMode, 'password');
  assert.equal(await noBiometric.node('WalletManagementScreen').props.onAuthenticate(), false);
  noBiometric.unmount();

  for (const query of ['isAvailable', 'isBiometricEnabled']) {
    const failed = fixture();
    const adapter = query === 'isAvailable' ? failed.context.biometric : failed.context.passwordVerifier;
    adapter[query] = async () => { throw new Error('public native discovery failure'); };
    const fallback = mount('AccountsScreen', failed); await fallback.settle();
    const authentication = fallback.node('WalletManagementScreen').props;
    assert.equal(authentication.authenticationMode, 'password', 'Biometric discovery failure leaves configured password authentication available');
    assert.equal(await authentication.onAuthenticate(publicPassword), true);
    assert.deepEqual(failed.calls.biometric, []); fallback.unmount();
  }

  const noPassword = fixture({ configured: false }); const biometricOnly = mount('AccountsScreen', noPassword); await biometricOnly.settle();
  assert.equal(biometricOnly.node('WalletManagementScreen').props.authenticationMode, 'biometric');
  assert.equal(await biometricOnly.node('WalletManagementScreen').props.onAuthenticate(publicPassword), false, 'An unconfigured password cannot authorize deletion');
  assert.deepEqual(noPassword.calls.verified, []);
  assert.equal(await biometricOnly.node('WalletManagementScreen').props.onAuthenticate(), true);
  biometricOnly.unmount();
}

async function passwordEnrollmentRequiresExistingOwner() {
  for (const accepted of [false, true]) {
    const app = fixture({ configured: false, biometricEnabled: true, biometricAvailable: true, vaultExists: true });
    app.context.biometric.authenticate = async (reason) => { app.calls.biometric.push(reason); return accepted; };
    const screen = mount('PasswordSettingsScreen', app); await screen.settle();
    screen.node('Field', (p) => p.label === 'walletPassword').props.onChangeText(publicPassword);
    screen.node('Field', (p) => p.label === 'confirmPassword').props.onChangeText(publicPassword); screen.render();
    screen.node('Field', (p) => p.label === 'confirmPassword').props.onSubmitEditing(); await screen.settle();
    assert.deepEqual(app.calls.biometric, ['walletPassword'], 'An existing biometric-only wallet must authenticate before enrolling a password');
    assert.equal(app.options.configured, accepted, 'Canceled biometric enrollment cannot create an export password');
    screen.unmount();
  }
}

async function expiredAuthenticationCannotUnlockOrExport() {
  const app = fixture(); const auth = deferred();
  app.context.biometric.authenticate = () => auth.promise;
  const screen = mount('UnlockScreen', app); await screen.settle();
  screen.node('PrimaryButton').props.onPress(); await tick();
  app.context.session.invalidate(); app.context.session.setForeground(false);
  auth.resolve(true); await screen.settle();
  assert.deepEqual(app.calls.loaded, [], 'An authentication completing after backgrounding must not read wallet storage');
  assert.deepEqual(app.calls.cores, [], 'A late authentication cannot recreate an unlocked session');
  screen.unmount();
  const sensitive = fixture(); const decision = deferred(); sensitive.context.biometric.authenticate = () => decision.promise;
  const accounts = mount('AccountsScreen', sensitive); await accounts.settle();
  const pending = accounts.node('WalletManagementScreen').props.onAuthenticate(); await tick();
  sensitive.context.session.invalidate(); decision.resolve(true);
  assert.equal(await pending, false, 'A late authentication cannot authorize deletion or secret export');
  accounts.unmount();
  const restoring = fixture(); const storage = deferred(); let forgotten = 0;
  restoring.manager.persist = () => storage.promise;
  restoring.manager.dispose = () => { forgotten += 1; };
  const restore = mount('UnlockScreen', restoring); await restore.settle();
  restore.node('PrimaryButton').props.onPress(); await tick();
  restoring.context.session.invalidate();
  assert.equal(forgotten, 1, 'Restored local wallet collections are forgotten synchronously even while persistence is pending');
  storage.resolve(); await restore.settle();
  assert.deepEqual(restoring.calls.cores, [], 'An expired collection restoration cannot activate a wallet');
  restore.unmount();
}

async function watchSelectionDoesNotRetainLegacyKeys() {
  const app = fixture();
  app.core.isWatchOnly = () => true;
  const unlock = mount('UnlockScreen', app); await unlock.settle();
  unlock.node('PrimaryButton').props.onPress(); await unlock.settle();
  assert.deepEqual(app.calls.cleared, ['vault'], 'Restoring an observed account clears the legacy secret copy');
  assert.equal(app.calls.vaultPersist, 0);
  unlock.unmount();
  app.context.manager.selectAndPersist = async () => {};
  app.context.manager.getCore = () => app.core;
  const accounts = mount('AccountsScreen', app); await accounts.settle();
  await accounts.node('WalletManagementScreen').props.onSelect({ id: 'observed-fixture' });
  assert.deepEqual(app.calls.cleared, ['vault', 'vault'], 'Selecting an observed account clears previously selected controlled wallet secrets');
  accounts.unmount();
}

(async () => {
  await welcomePresenceAndFirstWallet(); await welcomeRecoveryAndPreparation(); await unlockChoicesAndMigration(); await discoveryReadyAndFailure(); await failedBiometricsOfferPassword(); await noBiometricSecurityAndPassword(); await securitySettingsBusyNavigation(); await walletManagementAuthentication(); await passwordEnrollmentRequiresExistingOwner(); await expiredAuthenticationCannotUnlockOrExport(); await watchSelectionDoesNotRetainLegacyKeys();
  console.log('Authentication flow verification passed: welcome routing, first-wallet protection, automatic password fallback after declined/canceled/failed biometrics, authentication-before-secret-load, migration persistence, discovery readiness, no-biometric settings and wallet management authentication. Public fixtures only; no native user storage or RPC.');
})().catch((error) => { console.error(error); process.exitCode = 1; });
