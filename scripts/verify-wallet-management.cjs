/* Verify wallet management interactions with the production component. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const source = fs.readFileSync(path.resolve(__dirname, '../src/ui/screens/WalletManagementScreen.tsx'), 'utf8');
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function flatten(node) { return node == null || typeof node === 'boolean' ? [] : Array.isArray(node) ? node.flatMap(flatten) : [node, ...(node.props ? flatten(node.props.children) : [])]; }
function text(node) { return flatten(node).filter((entry) => typeof entry === 'string').join(''); }

function fixture(overrides = {}) {
  let cursor = 0, tree; const slots = [];
  const calls = { selections: [], removals: [], changed: 0, back: 0, keyboardDismiss: 0, removedListeners: 0, clipboard: '', timers: [] }; let selection = deferred(); const removal = deferred();
  const wallets = [{ id: 'fixture-one', label: 'Fixture wallet', address: '0x1111111111111111111111111111111111111111', kind: 'privateKey', watchOnly: false, ...overrides.wallet }];
  const react = {
    createElement(type, props, ...children) { const next = { ...(props || {}), children: children.length === 1 ? children[0] : children }; return typeof type === 'function' ? type(next) : { type, props: next }; },
    useState(initial) { const index = cursor++; if (!slots[index]) slots[index] = { value: typeof initial === 'function' ? initial() : initial }; return [slots[index].value, (value) => { slots[index].value = typeof value === 'function' ? value(slots[index].value) : value; }]; },
    useRef(initial) { const index = cursor++; if (!slots[index]) slots[index] = { current: initial }; return slots[index]; },
    useEffect(effect, dependencies) { const index = cursor++; if (slots[index] && dependencies?.every((value, at) => Object.is(value, slots[index].dependencies?.[at]))) return; slots[index]?.cleanup?.(); slots[index] = { dependencies, cleanup: effect() }; },
  };
  const native = {
    ...Object.fromEntries(['ActivityIndicator', 'KeyboardAvoidingView', 'Modal', 'Pressable', 'ScrollView', 'Text', 'TextInput', 'View'].map((name) => [name, name])),
    StyleSheet: { create: (styles) => styles, absoluteFillObject: {}, hairlineWidth: 1 }, Platform: { OS: 'android' }, Keyboard: { dismiss() { calls.keyboardDismiss += 1; } },
    BackHandler: { addEventListener(event, handler) { assert.equal(event, 'hardwareBackPress'); calls.backHandler = handler; return { remove() { calls.removedListeners += 1; } }; } },
  };
  const moduleValue = { exports: {} };
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true } }).outputText;
  vm.runInNewContext(code, {
    module: moduleValue, exports: moduleValue.exports,
    require(name) {
      if (name === 'react') return react; if (name === 'react-native') return native;
      if (name.endsWith('SecureModal.js')) return { SecureModal: 'Modal' };
      if (name === '@react-native-clipboard/clipboard') return { setString(value) { calls.clipboard = value; }, async getString() { return calls.clipboard; } };
      if (name === 'react-native-safe-area-context') return { useSafeAreaInsets: () => ({ bottom: 0 }) };
      if (name.endsWith('icons.js')) return new Proxy({}, { get: (_target, key) => key });
      if (name.endsWith('i18n.js')) return { useI18n: () => ({ language: overrides.language ?? 'zh' }) };
      if (name.endsWith('primitives.js')) return { PageHeader: 'PageHeader', PrimaryButton: 'PrimaryButton', SecondaryButton: 'SecondaryButton' };
      if (name.endsWith('theme.js')) return { walletColors: {}, walletRadii: {}, walletSpacing: { lg: 16, sm: 8, xl: 24, xxl: 32 }, walletTypography: {} };
      return {};
    },
    requestAnimationFrame(callback) { callback(); },
    setTimeout(callback, delay) { assert.equal(delay, 30000); const timer = { callback }; calls.timers.push(timer); return timer; },
    clearTimeout(timer) { timer.canceled = true; },
  }, { filename: 'WalletManagementScreen.tsx' });
  const props = { manager: { list: () => wallets, getSelectedId: () => wallets[0]?.id ?? null, async removeAndPersist(id) { calls.removals.push(id); await removal.promise; wallets.splice(wallets.findIndex((wallet) => wallet.id === id), 1); } }, onSelect(wallet) { calls.selections.push(wallet.id); return selection.promise; }, onBack() { calls.back += 1; }, onChanged() { calls.changed += 1; }, ...overrides.props };
  const render = () => { cursor = 0; tree = moduleValue.exports.WalletManagementScreen(props); };
  const node = (type, predicate = () => true) => { const value = flatten(tree).find((entry) => entry?.type === type && predicate(entry.props)); assert.ok(value, `Expected ${type}`); return value; };
  const walletRow = () => node('Pressable', (props) => props.key === wallets[0].id);
  render();
  return { calls, render, node, walletRow, get tree() { return tree; }, openRemove() { node('Pressable', (props) => props.accessibilityLabel === '钱包操作').props.onPress({ stopPropagation() {} }); render(); node('Pressable', (props) => text(props.children).startsWith('删除钱包')).props.onPress(); render(); }, async resolveRemoval() { removal.resolve(); await tick(); render(); }, async reject() { selection.reject(new Error('Fixture selection save failed')); await tick(); render(); }, async resolve() { selection.resolve(); await tick(); render(); }, freshSelection() { selection = deferred(); }, unmount() { for (const slot of slots) slot?.cleanup?.(); } };
}

(async () => {
  const app = fixture(); const staleTap = app.walletRow().props.onPress; const staleBack = app.node('PageHeader').props.onBack;
  staleTap(); staleTap(); app.render();
  assert.deepEqual(app.calls.selections, ['fixture-one'], 'Old tap handlers cannot start a second selection');
  assert.equal(app.walletRow().props.accessibilityState.busy, true, 'The selected row announces pending switching');
  assert.ok(app.node('ActivityIndicator'), 'Switching has visible progress feedback');
  assert.equal(app.walletRow().props.disabled, true, 'Rows wait for the onSelect promise'); assert.equal(app.node('PrimaryButton').props.disabled, true);
  assert.equal(app.calls.backHandler(), true, 'Hardware back is blocked while selection is pending'); staleBack(); app.node('PageHeader').props.onBack(); assert.equal(app.calls.back, 0, 'Both old and current header handlers block back while busy');
  await app.reject(); assert.ok(text(app.tree).includes('操作失败，请重试。')); assert.equal(app.walletRow().props.disabled, false); assert.equal(app.node('PrimaryButton').props.disabled, false); assert.equal(app.calls.backHandler(), false);
  app.freshSelection(); staleTap(); staleTap(); app.render(); assert.equal(app.calls.selections.length, 2, 'A failed selection releases the guard for one explicit retry'); assert.equal(text(app.tree).includes('操作失败，请重试。'), false); assert.equal(app.walletRow().props.disabled, true);
  await app.resolve(); assert.equal(app.walletRow().props.disabled, false); assert.equal(app.node('PrimaryButton').props.disabled, false); assert.equal(app.calls.backHandler(), false, 'Success releases the busy guard');
  app.node('PageHeader').props.onBack(); assert.equal(app.calls.back, 1); app.unmount(); assert.equal(app.calls.removedListeners, 1, 'The native back listener is removed on unmount');

  for (const language of ['zh', 'en']) {
    for (const kind of ['privateKey', 'mnemonic', 'watch']) {
      const wallet = fixture({ language, wallet: { kind, watchOnly: kind === 'watch' }, props: {
        onAuthenticate: async () => true,
        onExportPrivateKey: () => 'public-fixture-key',
        onExportMnemonic: () => 'public fixture phrase',
      } });
      const zh = language === 'zh';
      const privateKeyTitle = zh ? '导出私钥' : 'Export Private Key';
      const mnemonicTitle = zh ? '导出助记词' : 'Export Recovery Phrase';
      if (kind === 'privateKey') assert.ok(text(wallet.tree).includes(zh ? '私钥钱包' : 'Private Key Wallet'));
      wallet.node('Pressable', (p) => p.accessibilityLabel === (zh ? '钱包操作' : 'Wallet Actions')).props.onPress({ stopPropagation() {} }); wallet.render();
      const hasAction = (title) => flatten(wallet.tree).some((entry) => entry?.type === 'Pressable' && text(entry.props.children).startsWith(title));
      assert.equal(hasAction(privateKeyTitle), kind !== 'watch', `${kind}/${language}: only controlled wallets export a private key`);
      assert.equal(hasAction(mnemonicTitle), kind === 'mnemonic', `${kind}/${language}: only recovery-phrase wallets export a phrase`);
      if (kind === 'privateKey') {
        assert.ok(text(wallet.tree).includes(zh ? '没有助记词' : 'has no recovery phrase'));
        wallet.node('Pressable', (p) => text(p.children).startsWith(zh ? '删除钱包' : 'Remove Wallet')).props.onPress(); wallet.render();
        assert.ok(text(wallet.tree).includes(zh ? '请确认已备份私钥' : 'back up its private key first'), 'Removal requires backing up the actual credential type');
      }
      wallet.unmount();
    }
  }

  const destination = deferred(); let openings = 0;
  const navigation = fixture({ props: { onCreateMnemonic() { openings += 1; return destination.promise; } } });
  navigation.node('PrimaryButton', (p) => p.title === '创建钱包').props.onPress(); navigation.render();
  const createFromSheet = navigation.node('Pressable', (p) => text(p.children).startsWith('创建助记词钱包')).props.onPress;
  createFromSheet(); createFromSheet(); navigation.render();
  assert.equal(openings, 1, 'Rapid sheet actions open the destination once');
  assert.equal(navigation.node('PrimaryButton', (p) => p.title === '创建钱包').props.disabled, true, 'Pending navigation disables other wallet actions');
  assert.equal(navigation.calls.backHandler(), true, 'Pending navigation blocks hardware back');
  navigation.node('PageHeader').props.onBack(); assert.equal(navigation.calls.back, 0);
  destination.resolve(); await tick(); navigation.render();
  assert.equal(navigation.node('PrimaryButton', (p) => p.title === '创建钱包').props.disabled, false, 'Destination completion releases the operation guard');
  assert.equal(navigation.calls.backHandler(), false); navigation.unmount();

  const unavailable = fixture(); unavailable.openRemove();
  assert.ok(text(unavailable.tree).includes('操作前需要身份验证。'));
  assert.equal(flatten(unavailable.tree).some((entry) => entry?.type === 'PrimaryButton' && entry.props.title === '验证并删除'), false, 'Missing authentication never opens a removal confirmation');
  assert.deepEqual(unavailable.calls.removals, []); unavailable.unmount();

  const passwordCalls = []; let passwordAccepted = false;
  const password = fixture({ props: { authenticationMode: 'password', onAuthenticate: async (value) => { passwordCalls.push(value); return passwordAccepted; } } });
  password.openRemove(); const emptyPasswordButton = password.node('PrimaryButton', (props) => props.title === '验证并删除');
  assert.equal(emptyPasswordButton.props.disabled, true); emptyPasswordButton.props.onPress(); await tick(); password.render();
  assert.deepEqual(passwordCalls, []); assert.deepEqual(password.calls.removals, [], 'An empty password cannot delete through a stale handler');
  password.node('TextInput', (props) => props.secureTextEntry).props.onChangeText('public-fixture-wrong-password'); password.render();
  password.node('PrimaryButton', (props) => props.title === '验证并删除').props.onPress(); await tick(); password.render();
  assert.deepEqual(passwordCalls, ['public-fixture-wrong-password']); assert.deepEqual(password.calls.removals, []);
  assert.ok(text(password.tree).includes('验证失败，请重试。'), 'A wrong password leaves the wallet and confirmation intact');
  passwordAccepted = true; password.node('TextInput', (props) => props.secureTextEntry).props.onChangeText('public-fixture-password'); password.render();
  const retryPasswordDelete = password.node('PrimaryButton', (props) => props.title === '验证并删除').props.onPress; retryPasswordDelete(); retryPasswordDelete(); await tick(); password.render();
  assert.equal(passwordCalls.length, 2, 'Repeated taps authenticate once'); assert.deepEqual(password.calls.removals, ['fixture-one']);
  assert.equal(password.calls.changed, 0, 'The host updates only after deletion persists'); assert.equal(password.calls.backHandler(), true);
  await password.resolveRemoval(); assert.equal(password.calls.changed, 1); assert.equal(password.node('Modal').props.visible, false); assert.equal(password.calls.backHandler(), false); password.unmount();

  const rejected = fixture({ props: { onAuthenticate: async () => { throw new Error('biometric prompt failed'); } } });
  rejected.openRemove(); rejected.node('PrimaryButton', (props) => props.title === '验证并删除').props.onPress(); await tick(); rejected.render();
  assert.deepEqual(rejected.calls.removals, []); assert.ok(text(rejected.tree).includes('验证失败，请重试。'), 'A rejected authentication prompt cannot delete'); rejected.unmount();

  const biometricCalls = []; let biometricResult = deferred();
  const biometric = fixture({ wallet: { kind: 'watch', watchOnly: true }, props: { authenticationMode: 'both', onAuthenticate(value) { biometricCalls.push(value); return biometricResult.promise; } } });
  biometric.openRemove(); assert.ok(text(biometric.tree).includes('仅移除此设备上的观察地址，链上资产不受影响。'));
  const biometricDelete = biometric.node('PrimaryButton', (props) => props.title === '验证并删除').props.onPress; biometricDelete(); biometricDelete(); biometric.render();
  assert.deepEqual(biometricCalls, [undefined], 'The default method requests fresh biometrics even for watch-only records'); assert.deepEqual(biometric.calls.removals, []);
  biometricResult.resolve(false); await tick(); biometric.render(); assert.deepEqual(biometric.calls.removals, []); assert.equal(biometric.node('Modal').props.visible, true);
  assert.ok(text(biometric.tree).includes('生物识别未完成，请使用钱包密码验证。'), 'Canceled biometrics explain the password fallback');
  assert.equal(biometric.node('Pressable', (props) => props.accessibilityRole === 'radio' && text(props.children) === '钱包密码').props.accessibilityState.selected, true, 'Canceled biometrics automatically select password authentication');
  assert.equal(biometric.node('TextInput', (props) => props.secureTextEntry).props.value, '', 'Biometric fallback starts with an empty password');
  biometric.node('Pressable', (props) => props.accessibilityRole === 'radio' && text(props.children) === '生物识别').props.onPress(); biometric.render();
  biometricResult = deferred(); biometric.node('PrimaryButton', (props) => props.title === '验证并删除').props.onPress(); biometricResult.resolve(true); await tick(); biometric.render();
  assert.deepEqual(biometric.calls.removals, ['fixture-one']); await biometric.resolveRemoval(); assert.equal(biometric.calls.changed, 1); biometric.unmount();

  for (const action of ['remove', 'privateKey', 'mnemonic']) {
    for (const biometricFailure of ['denied', 'throws']) {
      const authCalls = []; const exportCalls = []; const biometricPending = deferred();
      const fallback = fixture({ wallet: { kind: 'mnemonic' }, props: {
        authenticationMode: 'both',
        onAuthenticate(value) { authCalls.push(value); return value === undefined ? biometricPending.promise : Promise.resolve(value === 'public-fixture-password'); },
        onExportPrivateKey(wallet) { exportCalls.push(['privateKey', wallet.id]); return 'public-fixture-private-key'; },
        onExportMnemonic(wallet) { exportCalls.push(['mnemonic', wallet.id]); return 'public fixture recovery phrase'; },
      } });
      if (action === 'remove') fallback.openRemove();
      else {
        fallback.node('Pressable', (props) => props.accessibilityLabel === '钱包操作').props.onPress({ stopPropagation() {} }); fallback.render();
        fallback.node('Pressable', (props) => text(props.children).startsWith(action === 'privateKey' ? '导出私钥' : '导出助记词')).props.onPress(); fallback.render();
      }
      const title = action === 'remove' ? '验证并删除' : '验证并导出';
      const biometricTap = fallback.node('PrimaryButton', (props) => props.title === title).props.onPress;
      biometricTap(); biometricTap(); fallback.render();
      assert.deepEqual(authCalls, [undefined], `${action}: duplicate taps cannot launch another biometric prompt`);
      assert.equal(fallback.calls.backHandler(), true, `${action}: the biometric prompt keeps the operation busy`);
      if (biometricFailure === 'throws') biometricPending.reject(new Error('Public fixture biometric cancellation or hardware error'));
      else biometricPending.resolve(false);
      await tick(); fallback.render();
      assert.ok(text(fallback.tree).includes('生物识别未完成，请使用钱包密码验证。'), `${action}/${biometricFailure}: explain fallback`);
      assert.equal(fallback.node('TextInput', (props) => props.secureTextEntry).props.value, '');
      assert.equal(fallback.node('PrimaryButton', (props) => props.title === title).props.disabled, true, 'An empty fallback password cannot authorize');
      assert.equal(fallback.calls.backHandler(), false, 'The failure releases busy state for password retry');
      assert.deepEqual(fallback.calls.removals, []); assert.deepEqual(exportCalls, [], 'Biometric failure never exports a secret');
      fallback.node('TextInput', (props) => props.secureTextEntry).props.onChangeText('public-fixture-wrong-password'); fallback.render();
      fallback.node('PrimaryButton', (props) => props.title === title).props.onPress(); await tick(); fallback.render();
      assert.ok(text(fallback.tree).includes('验证失败，请重试。')); assert.deepEqual(fallback.calls.removals, []); assert.deepEqual(exportCalls, []);
      assert.equal(fallback.node('TextInput', (props) => props.secureTextEntry).props.value, '', 'A rejected password is cleared before retry');
      fallback.node('TextInput', (props) => props.secureTextEntry).props.onChangeText('public-fixture-password'); fallback.render();
      const passwordTap = fallback.node('PrimaryButton', (props) => props.title === title).props.onPress;
      passwordTap(); passwordTap(); await tick(); fallback.render();
      assert.deepEqual(authCalls, [undefined, 'public-fixture-wrong-password', 'public-fixture-password'], 'Only explicit password retries authenticate');
      if (action === 'remove') { assert.deepEqual(fallback.calls.removals, ['fixture-one']); await fallback.resolveRemoval(); assert.equal(fallback.calls.changed, 1); }
      else { assert.deepEqual(exportCalls, [[action, 'fixture-one']]); assert.equal(fallback.node('Modal', (props) => props.animationType === 'fade').props.visible, true); }
      assert.equal(fallback.calls.backHandler(), false); fallback.unmount();
    }
  }

  for (const action of ['remove', 'privateKey']) {
    const biometricOnly = fixture({ props: { onAuthenticate: async () => false, onExportPrivateKey: () => { throw new Error('Unverified export must not run'); } } });
    if (action === 'remove') biometricOnly.openRemove();
    else {
      biometricOnly.node('Pressable', (props) => props.accessibilityLabel === '钱包操作').props.onPress({ stopPropagation() {} }); biometricOnly.render();
      biometricOnly.node('Pressable', (props) => text(props.children).startsWith('导出私钥')).props.onPress(); biometricOnly.render();
    }
    biometricOnly.node('PrimaryButton', (props) => props.title === (action === 'remove' ? '验证并删除' : '验证并导出')).props.onPress(); await tick(); biometricOnly.render();
    assert.ok(text(biometricOnly.tree).includes('验证失败，请重试。'));
    assert.equal(flatten(biometricOnly.tree).some((entry) => entry?.type === 'TextInput' && entry.props.secureTextEntry), false, 'No configured password means no password fallback');
    assert.deepEqual(biometricOnly.calls.removals, []); biometricOnly.unmount();
  }

  const englishFallback = fixture({ language: 'en', props: { authenticationMode: 'both', onAuthenticate: async () => { throw new Error('Public fixture biometric error'); }, onExportPrivateKey: () => 'public-fixture-private-key' } });
  englishFallback.node('Pressable', (props) => props.accessibilityLabel === 'Wallet Actions').props.onPress({ stopPropagation() {} }); englishFallback.render();
  englishFallback.node('Pressable', (props) => text(props.children).startsWith('Export Private Key')).props.onPress(); englishFallback.render();
  englishFallback.node('PrimaryButton', (props) => props.title === 'Verify and Export').props.onPress(); await tick(); englishFallback.render();
  assert.ok(text(englishFallback.tree).includes('Biometric verification was not completed. Use your wallet password to continue.')); englishFallback.unmount();
  const secret = 'public-fixture-private-key';
  const exported = fixture({ props: { onAuthenticate: async () => true, onExportPrivateKey: () => secret } });
  exported.node('Pressable', (p) => p.accessibilityLabel === '钱包操作').props.onPress({ stopPropagation() {} }); exported.render();
  exported.node('Pressable', (p) => text(p.children).startsWith('导出私钥')).props.onPress(); exported.render();
  exported.node('PrimaryButton', (p) => p.title === '验证并导出').props.onPress(); await tick(); exported.render();
  assert.equal(text(exported.tree).includes(secret), false, 'Exported secrets stay hidden until an explicit reveal');
  exported.node('Pressable', (p) => p.accessibilityLabel === '显示敏感信息').props.onPress(); exported.render();
  assert.equal(text(exported.tree).includes(secret), true, 'The labeled reveal control shows the verified secret');
  exported.node('Pressable', (p) => p.accessibilityLabel === '隐藏敏感信息').props.onPress(); exported.render();
  assert.equal(text(exported.tree).includes(secret), false, 'The labeled hide control conceals the secret again');
  exported.node('SecondaryButton', (p) => p.title === '复制').props.onPress(); exported.render();
  assert.equal(exported.calls.clipboard, secret);
  exported.calls.timers.at(-1).callback(); await tick(); exported.render();
  assert.equal(exported.calls.clipboard, '', 'A copied export secret must expire after thirty seconds');
  exported.node('SecondaryButton', (p) => p.title === '复制').props.onPress(); exported.render();
  exported.calls.clipboard = 'public normal clipboard content';
  exported.node('Modal', (p) => p.visible && p.animationType === 'fade').props.onRequestClose(); await tick(); exported.render();
  assert.equal(exported.calls.clipboard, 'public normal clipboard content', 'Closing an export must preserve newer clipboard content');
  exported.unmount();
  const phrase = 'public fixture recovery phrase for numbered wallet export layout example words only';
  const mnemonic = fixture({ wallet: { kind: 'mnemonic' }, props: { onAuthenticate: async () => true, onExportMnemonic: () => phrase } });
  mnemonic.node('Pressable', (p) => p.accessibilityLabel === '钱包操作').props.onPress({ stopPropagation() {} }); mnemonic.render();
  mnemonic.node('Pressable', (p) => text(p.children).startsWith('导出助记词')).props.onPress(); mnemonic.render();
  mnemonic.node('PrimaryButton', (p) => p.title === '验证并导出').props.onPress(); await tick(); mnemonic.render();
  assert.equal(text(mnemonic.tree).includes('public'), false, 'The phrase is absent before reveal');
  mnemonic.node('Pressable', (p) => p.accessibilityLabel === '显示敏感信息').props.onPress(); mnemonic.render();
  const shownWords = flatten(mnemonic.tree).filter((entry) => entry?.type === 'Text' && entry.props.selectable).map(text);
  assert.deepEqual(shownWords, phrase.split(' '), 'Numbered phrase display preserves every word and its order');
  mnemonic.node('PrimaryButton', (p) => p.title === '完成').props.onPress(); mnemonic.render();
  assert.equal(mnemonic.node('Modal', (p) => p.animationType === 'fade').props.visible, false, 'Done closes the secret view');
  assert.equal(text(mnemonic.tree).includes('public'), false, 'Closing removes the exported phrase from the rendered tree');
  mnemonic.unmount();
  console.log('Wallet management verification passed: selection feedback; password and biometric removal/export gates; biometric failure/cancellation/error password fallback; password retries; watch-only protection; duplicate taps; persisted deletion and busy cleanup. Public fixtures only.');
})().catch((error) => { console.error(error); process.exitCode = 1; });
