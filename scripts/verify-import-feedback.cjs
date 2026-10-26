/* Exercise the real import route's asynchronous feedback and submission guard. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'App.tsx'), 'utf8');
const parsed = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const route = parsed.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'ImportScreen');
assert.ok(route, 'Verification must exercise the production import route');
const fixtureSecret = 'public import feedback fixture';
const tick = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function compile(sourceText, globals) {
  const code = ts.transpileModule(sourceText, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, ...globals }, { filename: 'App.tsx:ImportScreen' });
  return module.exports;
}

async function loadingFramePrecedesSynchronousWork() {
  const frames = [], timers = [];
  const feedback = compile(fs.readFileSync(path.join(root, 'src/ui/feedback.ts'), 'utf8'), {
    requestAnimationFrame(callback) { frames.push(callback); return frames.length; },
    setTimeout(callback, delay) { assert.equal(delay, 0); timers.push(callback); return timers.length; },
  });
  let completed = false;
  const operation = feedback.waitForPaint().then(() => { completed = true; });
  await tick();
  assert.equal(frames.length, 1);
  assert.equal(timers.length, 0, 'Work cannot be scheduled until React Native has entered the next frame');
  assert.equal(completed, false);
  frames.shift()(0);
  await tick();
  assert.equal(timers.length, 1);
  assert.equal(completed, false, 'A frame callback alone cannot immediately block the native UI with crypto');
  timers.shift()();
  await operation;
  assert.equal(completed, true, 'The helper resumes work in the following event-loop task');
}

function flatten(node) {
  if (node == null || typeof node === 'boolean') return [];
  if (Array.isArray(node)) return node.flatMap(flatten);
  return [node, ...(node.props ? flatten(node.props.children) : [])];
}

function text(node) {
  return flatten(node).filter((entry) => typeof entry === 'string' || typeof entry === 'number').join('');
}

function fixture({ method = 'mnemonic', accountCount = 1, invalid = false, existing = false, watchExisting = false, existingKind = 'privateKey' } = {}) {
  const slots = [];
  let cursor = 0, tree;
  const calls = { imports: [], paints: [], accounts: 0, metadata: 0, restores: [], saves: 0, savedVaults: [], forgottenImports: 0, resets: [], selected: [], cores: [], gestures: [], back: 0, adds: [], managerSelections: [] };
  const metadata = deferred();
  let storage = deferred();
  let shouldRejectSecret = invalid;
  const vault = { persist() { calls.saves += 1; calls.savedVaults.push('imported'); return storage.promise; }, forget() { calls.forgottenImports += 1; } };
  const imported = {
    vault,
    canDeriveAccounts() { return method === 'mnemonic'; },
    getAccount(index) { assert.equal(index, 0); calls.accounts += 1; return { address: '0x1111111111111111111111111111111111111111' }; },
  };
  const restored = { vault, getAccount: imported.getAccount };
  const existingCore = { getWalletKind: () => existingKind, vault: { persist() { calls.saves += 1; calls.savedVaults.push('existing'); return storage.promise; } } };
  const original = { id: 'fixture-original', address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', watchOnly: false };
  const existingRecord = { id: 'fixture-existing', address: '0x1111111111111111111111111111111111111111', kind: watchExisting ? 'watch' : existingKind, watchOnly: watchExisting };
  const collection = [original, ...(existing || watchExisting ? [existingRecord] : [])];
  let selectedId = original.id;
  let failManagerAdd = false, failManagerSelect = false;
  const manager = {
    list() { return collection.map((record) => ({ ...record })); },
    getCore(id) { if (id === 'fixture-new') return calls.adds.at(-1).core; assert.equal(id, existingRecord.id); return existingCore; },
    async addCoreAndPersist(core, label) {
      calls.adds.push({ core, label });
      if (failManagerAdd) throw new Error('Protected collection fixture failure');
      const record = { id: 'fixture-new', address: '0x1111111111111111111111111111111111111111', watchOnly: false };
      collection.push(record); return record;
    },
    async selectAndPersist(id) {
      calls.managerSelections.push(id);
      if (failManagerSelect) throw new Error('Protected selection fixture failure');
      selectedId = id;
    },
  };
  const react = {
    createElement(type, props, ...children) {
      const next = { ...(props || {}), children: children.length === 1 ? children[0] : children };
      return typeof type === 'function' ? type(next) : { type, props: next };
    },
    useState(initial) {
      const index = cursor++;
      if (!slots[index]) slots[index] = { value: typeof initial === 'function' ? initial() : initial };
      return [slots[index].value, (value) => { slots[index].value = typeof value === 'function' ? value(slots[index].value) : value; }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!slots[index]) slots[index] = { current: initial };
      return slots[index];
    },
    useEffect(effect) { effect(); },
    useCallback(fn) { return fn; },
  };
  const native = Object.fromEntries(['SafeAreaView', 'KeyboardAvoidingView', 'ScrollView', 'View', 'Text', 'TextInput', 'Pressable', 'Image'].map((name) => [name, name]));
  const makeWallet = (kind, secret) => {
    assert.equal(secret, fixtureSecret);
    calls.imports.push(kind);
    if (shouldRejectSecret) throw new Error('Private fixture validation failure');
    return imported;
  };
  const routeModule = compile(`${route.getText(parsed)}\nexports.screen = ImportScreen;`, {
    React: react, ...react, ...native, DreamKeyLogo: 'DreamKeyLogo',
    useFocusEffect(effect) { effect(); },
    BackHandler: { addEventListener(_event, listener) { calls.backListener = listener; return { remove() {} }; } },
    Platform: { OS: 'android' },
    styles: new Proxy({}, { get: (_target, name) => name }),
    colors: {},
    ...Object.fromEntries(['PageHeader', 'FileKey', 'KeyRound', 'EyeOff', 'Eye', 'ShieldCheck'].map((name) => [name, name])),
    PrimaryButton: (props) => ({ type: 'PrimaryButton', props }),
    useI18n: () => ({ t: (key) => key }),
    useWalletContext: () => ({
      storage: {}, biometric: {}, manager,
      session: { capture: () => 0, assertCurrent() {}, isCurrent: () => true },
      setCore(core) { calls.cores.push(core); },
      setCreationCore() {},
      setSelectedAccountIndex(index) { calls.selected.push(index); },
      setRevision(update) { assert.equal(update(0), 1); },
    }),
    DEFAULT_NETWORKS: [], saveTransaction() {},
    waitForPaint() { const paint = deferred(); calls.paints.push(paint); return paint.promise; },
    WalletCore: {
      fromMnemonic: (secret) => makeWallet('mnemonic', secret),
      fromPrivateKey: (secret) => makeWallet('privateKey', secret),
      fromVault(value, options) { assert.equal(value, vault); calls.restores.push(options.accountCount); return restored; },
    },
    loadAccountCount(address) { assert.equal(address, '0x1111111111111111111111111111111111111111'); calls.metadata += 1; return metadata.promise; },
  });
  const navigation = {
    setOptions(options) { calls.gestures.push(options.gestureEnabled); },
    reset(options) { calls.resets.push(options); },
    goBack() { calls.back += 1; },
  };
  const render = () => { cursor = 0; tree = routeModule.screen({ navigation }); };
  const node = (type, predicate = () => true) => {
    const found = flatten(tree).find((entry) => entry?.type === type && predicate(entry.props));
    assert.ok(found, `Expected rendered ${type}`);
    return found;
  };
  render();
  if (method === 'privateKey') { node('Pressable', (props) => props.accessibilityRole === 'tab' && !props.accessibilityState.selected).props.onPress(); render(); }
  node('TextInput').props.onChangeText(fixtureSecret);
  render();
  return {
    calls, imported, restored, existingCore, render, node,
    get tree() { return tree; },
    async releasePaint(index = calls.paints.length - 1) { calls.paints[index].resolve(); await tick(); render(); },
    async releaseMetadata() { metadata.resolve(accountCount); await tick(); render(); },
    async resolveSave() { storage.resolve(); await tick(); render(); },
    async rejectSave() { storage.reject(new Error('Protected storage fixture failure')); await tick(); render(); },
    allowSecret() { shouldRejectSecret = false; },
    freshSave() { storage = deferred(); },
    failAdd(value = true) { failManagerAdd = value; },
    failSelection(value = true) { failManagerSelect = value; },
    collection() { return manager.list(); },
    selectedId() { return selectedId; },
    removeWatchedEntry() { const index = collection.findIndex((record) => record.id === existingRecord.id && record.watchOnly); if (index >= 0) collection.splice(index, 1); },
  };
}

function expectBusy(app) {
  assert.equal(app.node('PrimaryButton').props.loading, true);
  assert.equal(app.node('PrimaryButton').props.disabled, true);
  assert.equal(app.node('PrimaryButton').props.title, 'importingWallet');
  assert.equal(app.node('TextInput').props.editable, false);
  assert.equal(app.calls.backListener(), true, 'Hardware back is blocked while import is in flight');
  for (const tab of flatten(app.tree).filter((node) => node?.props?.accessibilityRole === 'tab')) assert.equal(tab.props.disabled, true);
  assert.ok(text(app.tree).includes('importingWalletHint'));
}

async function successfulImport(method, count) {
  const app = fixture({ method, accountCount: count });
  const initialSubmit = app.node('PrimaryButton').props.onPress;
  initialSubmit(); app.render();
  expectBusy(app);
  assert.equal(app.calls.imports.length, 0, 'Busy feedback must render before key processing begins');
  initialSubmit();
  app.node('TextInput').props.onSubmitEditing();
  assert.equal(app.calls.paints.length, 1, 'Repeated taps and keyboard submit share the same in-flight guard');
  await app.releasePaint();
  expectBusy(app);
  assert.deepEqual(app.calls.imports, [method]);
  if (method === 'mnemonic') {
    assert.equal(app.calls.saves, 0, 'Protected persistence waits for this wallet account metadata');
    await app.releaseMetadata();
    expectBusy(app);
    assert.equal(app.calls.accounts, 2, 'Metadata and collection lookup reuse the imported public address');
    assert.deepEqual(app.calls.restores, count === 1 ? [] : [count]);
  } else {
    assert.equal(app.calls.metadata, 0, 'Private-key imports do not derive or restore mnemonic accounts');
  }
  assert.equal(app.calls.saves, 1);
  assert.equal(app.calls.adds.length, 1, 'New imported wallets are persisted atomically');
  assert.equal(app.calls.adds[0].label, undefined, 'The route delegates sequential default naming to WalletManager instead of overriding it with a fixed translation key');
  assert.deepEqual(app.calls.managerSelections, ['fixture-new']);
  await app.resolveSave();
  assert.equal(app.calls.cores[0], count === 1 ? app.imported : app.restored, 'Single-account imports keep their already-derived public metadata');
  assert.deepEqual(app.calls.selected, [0]);
  assert.equal(app.calls.resets.length, 1);
  assert.equal(app.calls.resets[0].routes[0].name, 'Main');
  assert.equal(app.node('TextInput').props.value, '', 'Secret input is cleared after protected persistence succeeds');
  assert.equal(app.node('PrimaryButton').props.loading, false);
  assert.equal(app.calls.backListener(), false);
}

async function failuresCanBeRetried() {
  const invalid = fixture({ method: 'privateKey', invalid: true });
  invalid.node('PrimaryButton').props.onPress(); invalid.render();
  await invalid.releasePaint();
  assert.equal(invalid.node('PrimaryButton').props.loading, false);
  assert.equal(invalid.node('TextInput').props.editable, true);
  assert.ok(text(invalid.tree).includes('invalidPrivateKey'));
  assert.equal(invalid.calls.saves, 0);
  assert.equal(invalid.calls.cores.length, 0);
  invalid.allowSecret();
  invalid.node('PrimaryButton').props.onPress(); invalid.render();
  expectBusy(invalid);
  await invalid.releasePaint();
  await invalid.resolveSave();
  assert.equal(invalid.calls.resets.length, 1, 'An invalid-secret attempt releases the submission guard');

  const storageError = fixture({ method: 'privateKey' });
  storageError.node('PrimaryButton').props.onPress(); storageError.render();
  await storageError.releasePaint();
  await storageError.rejectSave();
  assert.equal(storageError.node('PrimaryButton').props.loading, false);
  assert.equal(storageError.node('TextInput').props.value, fixtureSecret, 'A failed save retains the input for an explicit retry');
  assert.ok(text(storageError.tree).includes('unableToSaveWallet'));
  assert.equal(storageError.calls.cores.length, 0);
  assert.equal(storageError.calls.resets.length, 0);
  storageError.freshSave();
  storageError.node('PrimaryButton').props.onPress(); storageError.render();
  await storageError.releasePaint();
  await storageError.resolveSave();
  assert.equal(storageError.calls.resets.length, 1, 'A persistence failure releases the submission guard');
}

async function collectionFailuresCannotBecomeSuccess() {
  const addError = fixture({ method: 'privateKey' });
  const before = addError.collection();
  addError.failAdd();
  addError.node('PrimaryButton').props.onPress(); addError.render();
  await addError.releasePaint();
  assert.equal(addError.calls.saves, 0, 'Collection storage failure must not overwrite the legacy vault');
  assert.deepEqual(addError.collection(), before, 'Atomic collection failure keeps the previous wallet list');
  assert.equal(addError.selectedId(), 'fixture-original');
  assert.equal(addError.calls.cores.length, 0);
  assert.equal(addError.calls.resets.length, 0);
  assert.equal(addError.node('PrimaryButton').props.loading, false);
  assert.ok(text(addError.tree).includes('unableToSaveWallet'));
  addError.failAdd(false);
  addError.node('PrimaryButton').props.onPress(); addError.render();
  await addError.releasePaint(); await addError.resolveSave();
  assert.equal(addError.calls.resets.length, 1, 'Collection persistence failure permits explicit retry');

  const selectionError = fixture({ method: 'privateKey', existing: true });
  selectionError.failSelection();
  selectionError.node('PrimaryButton').props.onPress(); selectionError.render();
  await selectionError.releasePaint();
  assert.equal(selectionError.calls.adds.length, 0, 'An existing wallet is not duplicated');
  assert.equal(selectionError.calls.forgottenImports, 1, 'A failed selection releases the duplicate import vault');
  assert.equal(selectionError.calls.saves, 0);
  assert.equal(selectionError.selectedId(), 'fixture-original');
  assert.equal(selectionError.calls.resets.length, 0);
  assert.ok(text(selectionError.tree).includes('unableToSaveWallet'));
}

async function watchedAddressConflictIsActionable(method) {
  const app = fixture({ method, watchExisting: true });
  const before = app.collection();
  app.node('PrimaryButton').props.onPress(); app.render();
  await app.releasePaint();
  if (method === 'mnemonic') await app.releaseMetadata();
  assert.ok(text(app.tree).includes('watchWalletAlreadyExists'), 'An address already watched must explain how to resolve the conflict');
  assert.equal(text(app.tree).includes('unableToSaveWallet'), false, 'A duplicate address is not reported as a storage failure');
  assert.equal(app.calls.adds.length, 0); assert.equal(app.calls.managerSelections.length, 0); assert.equal(app.calls.saves, 0);
  assert.equal(app.calls.forgottenImports, 1, 'A watch-only address conflict releases the newly imported key material');
  assert.equal(app.calls.cores.length, 0); assert.equal(app.calls.resets.length, 0); assert.deepEqual(app.collection(), before); assert.equal(app.selectedId(), 'fixture-original');
  assert.equal(app.node('PrimaryButton').props.loading, false); assert.equal(app.node('TextInput').props.editable, true); assert.equal(app.node('TextInput').props.value, fixtureSecret);
  assert.equal(app.calls.backListener(), false, 'The conflict releases hardware back');
  app.node('PageHeader').props.onBack(); assert.equal(app.calls.back, 1, 'The user can return to remove the watched entry');
  app.removeWatchedEntry();
  app.node('PrimaryButton').props.onPress(); app.render(); expectBusy(app);
  await app.releasePaint(); await app.resolveSave();
  assert.equal(app.calls.adds.length, 1); assert.equal(app.calls.resets.length, 1, 'After removing the observed entry, the import can be retried successfully');
}

async function duplicateImportPreservesBackupMethod(method) {
  const existingKind = method === 'mnemonic' ? 'privateKey' : 'mnemonic';
  const app = fixture({ method, existing: true, existingKind });
  const before = app.collection();
  app.node('PrimaryButton').props.onPress(); app.render();
  await app.releasePaint();
  if (method === 'mnemonic') await app.releaseMetadata();
  assert.equal(app.calls.adds.length, 0, 'Importing an existing address does not replace its managed credentials');
  assert.equal(app.calls.forgottenImports, 1, 'The unused duplicate import drops its key material');
  assert.deepEqual(app.calls.savedVaults, ['existing'], 'Compatibility storage keeps the managed backup method');
  await app.resolveSave();
  assert.equal(app.calls.cores[0], app.existingCore, 'The active wallet agrees with the managed wallet even when a different credential was imported');
  assert.equal(app.calls.cores[0].getWalletKind(), existingKind);
  assert.deepEqual(app.collection(), before, 'The wallet name, backup type and existing credentials are preserved');
  assert.deepEqual(app.calls.managerSelections, ['fixture-existing']);
  assert.equal(app.calls.resets.length, 1);
}

(async () => {
  await loadingFramePrecedesSynchronousWork();
  await successfulImport('mnemonic', 1);
  await successfulImport('mnemonic', 3);
  await successfulImport('privateKey', 1);
  await failuresCanBeRetried();
  await collectionFailuresCannotBecomeSuccess();
  await watchedAddressConflictIsActionable('privateKey');
  await watchedAddressConflictIsActionable('mnemonic');
  await duplicateImportPreservesBackupMethod('privateKey');
  await duplicateImportPreservesBackupMethod('mnemonic');
  console.log('Import feedback verification passed: visible feedback, duplicate guard, import paths, metadata recovery, atomic collection errors, existing wallet preservation and actionable observed-address conflicts. No user secrets or RPC.');
})().catch((error) => { console.error(error); process.exitCode = 1; });
