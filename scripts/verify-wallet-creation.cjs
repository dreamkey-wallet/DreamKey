/* Exercise the production creation routes with a public mnemonic fixture only. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'App.tsx'), 'utf8');
const parsed = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const createRoute = parsed.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'CreateScreen');
const verifyRoute = parsed.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'CreateVerifyScreen');
const creationLayoutStyles = parsed.statements.find((node) => ts.isVariableStatement(node) && node.declarationList.declarations.some((declaration) => declaration.name.getText(parsed) === 'creationLayoutStyles'));
assert.ok(createRoute && verifyRoute, 'Verification must exercise the production creation routes');
assert.ok(creationLayoutStyles, 'Verification must include production phrase layout styles');
const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const ADDRESS = '0x1111111111111111111111111111111111111111';
const tick = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function compile(text, globals) {
  const code = ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React } }).outputText;
  const moduleValue = { exports: {} };
  vm.runInNewContext(code, { module: moduleValue, exports: moduleValue.exports, ...globals }, { filename: 'App.tsx:wallet-creation' });
  return moduleValue.exports;
}

function flatten(node) {
  if (node == null || typeof node === 'boolean') return [];
  if (Array.isArray(node)) return node.flatMap(flatten);
  return [node, ...(node.props ? flatten(node.props.children) : [])];
}
function text(node) { return flatten(node).filter((entry) => typeof entry === 'string' || typeof entry === 'number').join(''); }

function fixture({ route = 'verify', existing = false, phrase = PHRASE, width = 390, fontScale = 1 } = {}) {
  const slots = []; let cursor = 0, tree;
  const cleanup = [];
  const calls = { paints: [], adds: [], selections: [], metadata: [], saves: 0, cores: [], accountIndexes: [], creationDrafts: [], revisions: 0, resets: [], navigations: [], back: 0, gestures: [], removedListeners: 0 };
  const add = deferred(), selection = deferred(), metadata = deferred(), storage = deferred();
  const vault = { persist() { calls.saves += 1; return storage.promise; } };
  const core = { vault, getMnemonic: () => phrase, getAccount(index) { assert.equal(index, 0); return { address: ADDRESS }; }, listAccounts: () => [{ index: 0, address: ADDRESS }] };
  const record = { id: 'fixture-created', address: ADDRESS, watchOnly: false };
  const manager = {
    list() { return existing ? [{ ...record, address: ADDRESS.toUpperCase().replace('0X', '0x') }] : []; },
    addCoreAndPersist(value, label) { calls.adds.push({ core: value, label }); return add.promise; },
    selectAndPersist(id) { calls.selections.push(id); return selection.promise; },
  };
  const dependenciesEqual = (left, right) => left && right && left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
  const react = {
    createElement(type, props, ...children) { const next = { ...(props || {}), children: children.length === 1 ? children[0] : children }; return typeof type === 'function' ? type(next) : { type, props: next }; },
    useState(initial) { const index = cursor++; if (!slots[index]) slots[index] = { value: typeof initial === 'function' ? initial() : initial }; return [slots[index].value, (next) => { slots[index].value = typeof next === 'function' ? next(slots[index].value) : next; }]; },
    useRef(initial) { const index = cursor++; if (!slots[index]) slots[index] = { current: initial }; return slots[index]; },
    useMemo(factory, dependencies) { const index = cursor++; if (!slots[index] || !dependenciesEqual(slots[index].dependencies, dependencies)) slots[index] = { value: factory(), dependencies }; return slots[index].value; },
    useCallback(callback, dependencies) { return react.useMemo(() => callback, dependencies); },
    useEffect(effect, dependencies) { const index = cursor++; if (slots[index] && dependenciesEqual(slots[index].dependencies, dependencies)) return; slots[index]?.dispose?.(); slots[index] = { dependencies, dispose: effect() }; cleanup.push(index); },
  };
  const context = {
    creationCore: core, manager, storage: {}, biometric: {}, passwordVerifier: {}, session: { capture: () => 0, assertCurrent() {}, isCurrent: () => true },
    setCore(value) { calls.cores.push(value); }, setSelectedAccountIndex(index) { calls.accountIndexes.push(index); },
    setCreationCore(value) { calls.creationDrafts.push(value); }, setRevision(update) { assert.equal(update(0), 1); calls.revisions += 1; },
  };
  let randomIndex = 0; const randomValues = [0.02, 0.42, 0.95];
  const math = Object.create(Math); math.random = () => randomValues[randomIndex++ % randomValues.length];
  const native = Object.fromEntries(['SafeAreaView', 'KeyboardAvoidingView', 'ScrollView', 'View', 'Text', 'TextInput', 'Pressable', 'PageHeader', 'BrandHeader', 'Check'].map((name) => [name, name]));
  const screen = compile(`${creationLayoutStyles.getText(parsed)}\n${createRoute.getText(parsed)}\n${verifyRoute.getText(parsed)}\nexports.create = CreateScreen; exports.verify = CreateVerifyScreen;`, {
    React: react, ...react, ...native, Math: math, Platform: { OS: 'ios' }, styles: new Proxy({}, { get: (_target, name) => name }), colors: {},
    PrimaryButton: (props) => ({ type: 'PrimaryButton', props }), useI18n: () => ({ t: (key, params) => key === 'verifyWord' ? `Word ${params.number}` : key }), useWalletContext: () => context,
    useFocusEffect(effect) { const dispose = effect(); if (dispose) cleanup.push(dispose); },
    BackHandler: { addEventListener(name, listener) { assert.equal(name, 'hardwareBackPress'); calls.backListener = listener; return { remove() { calls.removedListeners += 1; } }; } },
    waitForPaint() { const frame = deferred(); calls.paints.push(frame); return frame.promise; },
    WalletCore: { create: () => core }, DEFAULT_NETWORKS: [], saveTransaction() {},
    StyleSheet: { create: (value) => value }, useWindowDimensions: () => ({ width, height: 800, scale: 3, fontScale }),
    saveAccountCount(address, count) { assert.equal(address, ADDRESS); assert.equal(count, 1); calls.metadata.push({ address, count }); return metadata.promise; },
  });
  const navigation = { setOptions(options) { calls.gestures.push(options.gestureEnabled); }, navigate(name) { calls.navigations.push(name); }, reset(state) { calls.resets.push(state); }, goBack() { calls.back += 1; } };
  const render = () => { cursor = 0; tree = screen[route]({ navigation }); };
  const node = (type, predicate = () => true) => { const match = flatten(tree).find((entry) => entry?.type === type && predicate(entry.props)); assert.ok(match, `Expected ${type}`); return match; };
  const requestedSlots = () => flatten(tree).filter((entry) => entry?.type === 'Pressable' && /^Word \d+$/.test(entry.props?.accessibilityLabel || '')).map((entry) => ({ index: Number(entry.props.accessibilityLabel.replace('Word ', '')) - 1, button: entry }));
  const choices = () => flatten(tree).filter((entry) => entry?.type === 'Pressable' && phrase.split(' ').includes(entry.props?.accessibilityLabel));
  const fill = (valid = true) => {
    for (const { index } of requestedSlots()) {
      const expected = phrase.split(' ')[index];
      const choice = choices().find((entry) => valid ? entry.props.accessibilityLabel === expected : entry.props.accessibilityLabel !== expected);
      assert.ok(choice, 'The word bank must provide a valid alternative for the fixture');
      choice.props.onPress(); render();
    }
  };
  const confirmBackup = () => { node('Pressable', (props) => props.accessibilityRole === 'checkbox').props.onPress(); render(); };
  render();
  return {
    calls, core, record, node, render, requestedSlots, choices, fill, confirmBackup,
    get tree() { return tree; },
    async releasePaint() { calls.paints.at(-1).resolve(); await tick(); render(); },
    async resolveAdd() { add.resolve(record); await tick(); render(); },
    async rejectAdd() { add.reject(new Error('Collection fixture failure')); await tick(); render(); },
    async resolveSelection() { selection.resolve(); await tick(); render(); },
    async resolveMetadata() { metadata.resolve(); await tick(); render(); },
    async resolveStorage() { storage.resolve(); await tick(); render(); },
    unmount() { const indexes = new Set(cleanup.filter((entry) => typeof entry === 'number')); for (const index of indexes) slots[index]?.dispose?.(); for (const callback of cleanup.filter((entry) => typeof entry === 'function')) callback(); },
  };
}

function expectBusy(app) {
  assert.equal(app.node('PrimaryButton').props.loading, true); assert.equal(app.node('PrimaryButton').props.disabled, true);
  for (const { button } of app.requestedSlots()) assert.equal(button.props.disabled, true);
  for (const choice of app.choices()) assert.equal(choice.props.disabled, true);
  assert.equal(app.node('Pressable', (props) => props.accessibilityRole === 'checkbox').props.disabled, true);
  assert.equal(app.calls.backListener(), true); assert.equal(app.calls.gestures.at(-1), false);
  app.node('PageHeader').props.onBack(); assert.equal(app.calls.back, 0, 'Header back is guarded while saving');
}

async function wrongWordsDoNotPersist() {
  const app = fixture(); const indexes = app.requestedSlots().map((slot) => slot.index);
  assert.equal(indexes.length, 3); assert.equal(new Set(indexes).size, 3); assert.ok(indexes.every((index) => index >= 0 && index < 12));
  assert.equal(flatten(app.tree).some((entry) => entry?.type === 'TextInput'), false, 'Verification uses selectable words without a keyboard');
  app.fill(false); app.confirmBackup(); app.node('PrimaryButton').props.onPress(); app.render();
  assert.ok(text(app.tree).includes('recoveryPhraseVerificationFailed')); assert.equal(app.calls.paints.length, 0); assert.equal(app.calls.adds.length, 0); assert.equal(app.calls.saves, 0);
  assert.equal(app.calls.backListener(), false); assert.equal(app.node('PrimaryButton').props.loading, false);
  app.unmount(); assert.equal(app.calls.creationDrafts.at(-1), null, 'Unmount clears the creation draft reference');
}

function selectionCanBeChangedAndReset() {
  const app = fixture(); app.fill();
  assert.ok(app.choices().every((choice) => choice.props.disabled), 'The word bank pauses after all requested slots are filled');
  app.requestedSlots()[0].button.props.onPress(); app.render();
  assert.ok(app.choices().every((choice) => !choice.props.disabled), 'Tapping a filled slot enables changing that position');
  const first = app.requestedSlots()[0].index;
  app.choices().find((choice) => choice.props.accessibilityLabel === PHRASE.split(' ')[first]).props.onPress(); app.render();
  app.node('Pressable', (props) => text({ props }).includes('resetRecoverySelection')).props.onPress(); app.render();
  assert.ok(app.requestedSlots().every(({ button }) => text(button).includes('—')), 'Start over clears every selected slot');
  assert.ok(app.choices().every((choice) => !choice.props.disabled));
  assert.equal(app.node('PrimaryButton').props.disabled, true); assert.equal(app.calls.saves, 0);
  app.unmount();
}

async function successfulCreation(existing = false) {
  const app = fixture({ existing }); app.fill(); app.confirmBackup();
  const submit = app.node('PrimaryButton').props.onPress; submit(); submit(); app.render();
  expectBusy(app); assert.equal(app.calls.paints.length, 1); assert.equal(app.calls.adds.length, 0, 'Feedback paints before persistence');
  await app.releasePaint(); expectBusy(app);
  if (!existing) { assert.equal(app.calls.adds.length, 1); assert.equal(app.calls.adds[0].core, app.core); assert.equal(app.calls.selections.length, 0); await app.resolveAdd(); }
  else assert.equal(app.calls.adds.length, 0, 'Retrying an already-added address reuses its record');
  assert.deepEqual(app.calls.selections, [app.record.id]); assert.equal(app.calls.metadata.length, 0, 'Account metadata waits for the selected collection record');
  await app.resolveSelection(); expectBusy(app); assert.equal(app.calls.metadata.length, 1); assert.equal(app.calls.saves, 0);
  await app.resolveMetadata(); expectBusy(app); assert.equal(app.calls.saves, 1); assert.equal(app.calls.cores.length, 0);
  await app.resolveStorage(); assert.equal(app.calls.cores[0], app.core); assert.deepEqual(app.calls.accountIndexes, [0]); assert.equal(app.calls.creationDrafts.at(-1), null); assert.equal(app.calls.revisions, 1); assert.equal(app.calls.resets[0].routes[0].name, 'Main'); assert.equal(app.calls.backListener(), false);
  app.unmount(); assert.equal(app.calls.creationDrafts.at(-1), null);
}

async function collectionFailureStaysOnVerification() {
  const app = fixture(); app.fill(); app.confirmBackup(); app.node('PrimaryButton').props.onPress(); app.render(); await app.releasePaint(); await app.rejectAdd();
  assert.ok(text(app.tree).includes('unableToSaveWallet')); assert.equal(app.calls.selections.length, 0); assert.equal(app.calls.saves, 0); assert.equal(app.calls.cores.length, 0); assert.equal(app.calls.resets.length, 0); assert.equal(app.node('PrimaryButton').props.loading, false); assert.equal(app.calls.backListener(), false);
  app.node('PageHeader').props.onBack(); assert.equal(app.calls.back, 1); assert.equal(app.calls.creationDrafts.at(-1), null); app.unmount();
}

function phraseAndVerificationAreSeparate() {
  const app = fixture({ route: 'create' });
  assert.equal(flatten(app.tree).some((node) => node?.type === 'TextInput'), false, 'The phrase display screen has no verification fields');
  assert.ok(text(app.tree).includes('recoveryPhraseWarning')); app.node('PrimaryButton').props.onPress();
  assert.equal(app.calls.navigations[0], 'CreateVerify'); assert.equal(app.calls.creationDrafts[0], app.core); assert.equal(app.calls.adds.length, 0); assert.equal(app.calls.saves, 0);
}

function longestPhraseWordsRemainReadable() {
  const phrase = 'abstract accident acoustic announce artefact attitude bachelor broccoli business category champion cinnamon';
  for (const scenario of [
    { width: 360, gridWidth: 320, fontScale: 1, expected: undefined },
    { width: 360, gridWidth: 280, fontScale: 1, expected: '48%' },
    { width: 780, gridWidth: 280, fontScale: 1, expected: '48%' },
    { width: 360, gridWidth: 280, fontScale: 1.5, expected: '48%' },
    { width: 390, gridWidth: 350, fontScale: 1.5, expected: '48%' },
    { width: 390, gridWidth: 350, fontScale: 2.5, expected: '100%' },
  ]) {
    const app = fixture({ route: 'create', phrase, ...scenario });
    app.node('View', (props) => props.style === 'phraseGrid').props.onLayout({ nativeEvent: { layout: { width: scenario.gridWidth } } }); app.render();
    const cards = flatten(app.tree).filter((node) => node?.type === 'View' && Array.isArray(node.props.style) && node.props.style[0] === 'word');
    assert.equal(cards.length, 12); assert.ok(cards.every((node) => node.props.style[1]?.width === scenario.expected), 'Actual grid width and font scale determine the phrase columns, including when the window is wider than the container');
    const words = flatten(app.tree).filter((node) => node?.type === 'Text' && node.props.style === 'wordText');
    assert.deepEqual(words.map(text), phrase.split(' '), 'Eight-letter BIP39 words retain their complete text and order');
    assert.ok(words.every((node) => node.props.numberOfLines === undefined && !node.props.adjustsFontSizeToFit), 'Phrase words keep the chosen system font size and may grow instead of truncating');
    app.unmount();
  }
  const resizing = fixture({ route: 'create', phrase, width: 780 });
  const layout = (width) => { resizing.node('View', (props) => props.style === 'phraseGrid').props.onLayout({ nativeEvent: { layout: { width } } }); resizing.render(); };
  const card = () => flatten(resizing.tree).find((node) => node?.type === 'View' && Array.isArray(node.props.style) && node.props.style[0] === 'word');
  layout(280); assert.equal(card().props.style[1]?.width, '48%');
  layout(320); assert.equal(card().props.style[1], undefined, 'Widening the content area restores the compact three-column layout');
  resizing.unmount();
}

function verificationWordsRemainReadable() {
  const phrase = 'abstract accident acoustic announce artefact attitude bachelor broccoli business category champion cinnamon';
  for (const scenario of [
    { width: 360, gridWidth: 320, fontScale: 1, expected: undefined },
    { width: 360, gridWidth: 280, fontScale: 1.5, expected: '48%' },
    { width: 780, gridWidth: 280, fontScale: 1.5, expected: '48%' },
    { width: 390, gridWidth: 350, fontScale: 2.5, expected: '100%' },
  ]) {
    const app = fixture({ phrase, ...scenario });
    app.node('View', (props) => Array.isArray(props.style) && props.style[0] === 'verifySlots').props.onLayout({ nativeEvent: { layout: { width: scenario.gridWidth } } });
    app.node('View', (props) => props.style === 'verifyChoices').props.onLayout({ nativeEvent: { layout: { width: scenario.gridWidth } } }); app.render();
    for (const { button } of app.requestedSlots()) assert.equal(button.props.style[2]?.width, scenario.expected, 'Verification slots respond to their measured grid width');
    for (const choice of app.choices()) assert.equal(choice.props.style({ pressed: false })[1]?.width, scenario.expected, 'Candidate words respond to their measured grid width');
    app.fill();
    const slots = flatten(app.tree).filter((node) => node?.type === 'Text' && Array.isArray(node.props.style) && node.props.style[0] === 'verifySlotWord');
    assert.deepEqual(slots.map(text), app.requestedSlots().map(({ index }) => phrase.split(' ')[index]), 'Selected eight-letter words remain complete and ordered');
    const candidates = flatten(app.tree).filter((node) => node?.type === 'Text' && node.props.style === 'verifyChoiceText');
    assert.ok([...slots, ...candidates].every((node) => node.props.numberOfLines === undefined && !node.props.adjustsFontSizeToFit), 'Selected and candidate words preserve the chosen font size and may wrap without truncation');
    app.unmount();
  }
  const independent = fixture({ phrase, width: 780 });
  independent.node('View', (props) => Array.isArray(props.style) && props.style[0] === 'verifySlots').props.onLayout({ nativeEvent: { layout: { width: 320 } } });
  independent.node('View', (props) => props.style === 'verifyChoices').props.onLayout({ nativeEvent: { layout: { width: 280 } } }); independent.render();
  assert.equal(independent.requestedSlots()[0].button.props.style[2], undefined);
  assert.equal(independent.choices()[0].props.style({ pressed: false })[1]?.width, '48%', 'Slot and choice regions can adapt independently');
  independent.unmount();
}

(async () => {
  phraseAndVerificationAreSeparate(); longestPhraseWordsRemainReadable(); verificationWordsRemainReadable(); selectionCanBeChangedAndReset(); await wrongWordsDoNotPersist(); await successfulCreation(); await successfulCreation(true); await collectionFailureStaysOnVerification();
  console.log('Wallet creation verification passed: separate backup and verification screens, ordered selectable words, editing/reset, atomic collection persistence, busy/back guards, failure handling and draft cleanup. Public fixture only; no RPC.');
})().catch((error) => { console.error(error); process.exitCode = 1; });
