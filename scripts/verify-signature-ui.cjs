/* Exercise the actual approval screen and App route offline, without keys or signing. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const ethers = require('ethers');

const root = path.resolve(__dirname, '..');
const account = '0x1111111111111111111111111111111111111111';
const recipient = '0x2222222222222222222222222222222222222222';
const tick = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function compileSource(source, filename, dependencies = {}, globals = {}) {
  const code = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module, exports: module.exports, console, setTimeout, clearTimeout,
    // Fixtures and parsed JSON use one realm so the production plain-object
    // validation is exercised instead of failing only because of the VM.
    Object, JSON,
    require(name) {
      if (Object.prototype.hasOwnProperty.call(dependencies, name)) return dependencies[name];
      if (name === 'ethers') return ethers;
      throw new Error(`Unexpected signature UI test dependency: ${name}`);
    },
    ...globals,
  }, { filename });
  return module.exports;
}

function compile(relative, dependencies = {}, globals = {}) {
  return compileSource(fs.readFileSync(path.join(root, relative), 'utf8'), relative, dependencies, globals);
}

function createHarness() {
  const slots = [];
  const paints = [];
  const clipboard = [];
  let index = 0, dirty = false, component, props, tree;
  const sameDeps = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const react = {
    Fragment: 'Fragment',
    createContext: () => ({ Provider: 'ContextProvider' }),
    useState(initial) {
      const position = index++;
      if (!slots[position]) slots[position] = { value: typeof initial === 'function' ? initial() : initial };
      const cell = slots[position];
      return [cell.value, (next) => {
        const value = typeof next === 'function' ? next(cell.value) : next;
        if (!Object.is(value, cell.value)) { cell.value = value; dirty = true; }
      }];
    },
    useMemo(factory, deps) {
      const position = index++;
      if (!slots[position] || !sameDeps(slots[position].deps, deps)) slots[position] = { value: factory(), deps };
      return slots[position].value;
    },
    useRef(initial) {
      const position = index++;
      if (!slots[position]) slots[position] = { current: initial };
      return slots[position];
    },
    useEffect(effect, deps) {
      const position = index++;
      if (!slots[position] || !sameDeps(slots[position].deps, deps)) slots[position] = { effect, deps, pending: true };
    },
    createElement(type, config, ...children) {
      const next = { ...(config || {}) };
      if (children.length === 1) next.children = children[0];
      else if (children.length > 1) next.children = children;
      return typeof type === 'function' ? type(next) : { type, props: next };
    },
  };
  const native = {
    ...Object.fromEntries(['ActivityIndicator', 'Pressable', 'ScrollView', 'Text', 'TextInput', 'View'].map((name) => [name, name])),
    StyleSheet: { create: (value) => value, hairlineWidth: 1 },
    Alert: { alert() { throw new Error('Unexpected native alert'); } },
    Linking: { openURL() { throw new Error('This verification must stay offline'); } },
  };
  function render() {
    index = 0; dirty = false; tree = component(props);
    const pending = slots.filter((slot) => slot.pending);
    pending.forEach((slot) => { slot.pending = false; slot.effect(); });
  }
  return {
    react, native, clipboard,
    paints,
    feedback: { waitForPaint() { const paint = deferred(); paints.push(paint); return paint.promise; } },
    mount(fn, nextProps) { component = fn; props = nextProps; render(); },
    rerender() { render(); },
    get tree() { return tree; },
    async settle() { for (let pass = 0; pass < 5; pass += 1) { await tick(); if (dirty) render(); } },
    async paint() { const pending = paints.splice(0); pending.forEach((paint) => paint.resolve()); await this.settle(); },
  };
}

function textContent(node) {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textContent).join('');
  return node.props ? textContent(node.props.children) : '';
}

function findAll(node, type, result = []) {
  if (!node) return result;
  if (Array.isArray(node)) { node.forEach((child) => findAll(child, type, result)); return result; }
  if (node.type === type) result.push(node);
  if (node.props) findAll(node.props.children, type, result);
  return result;
}

function visibleText(harness, value) {
  const found = findAll(harness.tree, 'Text').find((node) => textContent(node) === value);
  assert.ok(found, `Expected exact visible text: ${value.slice(0, 80)}`);
  return found;
}

function button(harness, title) {
  const found = findAll(harness.tree, 'Pressable').find((node) => textContent(node) === title);
  assert.ok(found, `Expected visible button: ${title}`);
  return found;
}

function flattenStyle(style) {
  return Object.assign({}, ...(Array.isArray(style) ? style.flat(Infinity) : [style]).filter(Boolean));
}

function loadScreen(harness, language = 'zh') {
  const i18n = compile('src/i18n.tsx', { react: harness.react });
  const useI18n = () => ({ language, t: (key, params) => i18n.translate(language, key, params) });
  const theme = compile('src/ui/theme.ts');
  const icons = new Proxy({}, { get: (_target, name) => (props) => ({ type: `icon:${String(name)}`, props }) });
  const primitives = compile('src/ui/primitives.tsx', {
    react: harness.react, 'react-native': harness.native,
    'react-native-safe-area-context': { SafeAreaView: 'SafeAreaView' },
    './theme.js': theme, './icons.js': icons,
    '../i18n.js': { useI18n },
  });
  const screens = compile('src/ui/screens.tsx', {
    react: harness.react, 'react-native': harness.native,
    '@react-native-clipboard/clipboard': { setString(value) { harness.clipboard.push(value); } },
    '../dapp/DappBrowser.js': { DappBrowser: 'DappBrowser' },
    './DappBrowserToolbar.js': { DappBrowserToolbar: 'DappBrowserToolbar', DappBrowserCloseButton: 'DappBrowserCloseButton' },
    '../i18n.js': { useI18n }, './primitives.js': primitives, './theme.js': theme, './icons.js': icons,
    './feedback.js': harness.feedback,
  });
  return { screen: screens.SignRequestScreen, screens, useI18n };
}

const errors = compile('src/provider/errors.ts');
const { getSignaturePreview } = compile('src/provider/signing-payload.ts', { './errors.js': errors });

function routeFixture(method, params, language = 'zh', parser = getSignaturePreview) {
  const harness = createHarness();
  const { screen, useI18n } = loadScreen(harness, language);
  const source = fs.readFileSync(path.join(root, 'App.tsx'), 'utf8');
  const parsed = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const routeNode = parsed.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'SignRequestRouteScreen');
  assert.ok(routeNode, 'Test must use the actual App approval route');
  const calls = { resolutions: [], cleared: 0, back: 0, listeners: {} };
  const pending = { method, params, origin: 'https://login.fixture.invalid', resolve: (value) => calls.resolutions.push(value) };
  let routeProps;
  const route = compileSource(`${routeNode.getText(parsed)}\nexports.route = SignRequestRouteScreen;`, 'App.tsx:SignRequestRouteScreen', {}, {
    React: harness.react, useMemo: harness.react.useMemo, useState: harness.react.useState, useEffect: harness.react.useEffect, useRef: harness.react.useRef,
    useI18n, getSignaturePreview: parser,
    useWalletContext: () => ({ pendingApproval: pending, setPendingApproval(value) { assert.equal(value, null); calls.cleared += 1; } }),
    SignRequestScreen: (props) => { routeProps = props; return screen(props); },
    LoadingScreen: () => ({ type: 'LoadingScreen', props: {} }),
  }).route;
  harness.mount(route, { navigation: {
    addListener(event, callback) { calls.listeners[event] = callback; return () => {}; },
    goBack() { calls.back += 1; },
  } });
  return { harness, calls, get routeProps() { return routeProps; } };
}

async function transientParserFailuresRecoverForTheSameRequest() {
  const message = 'A transient module failure must not permanently block this request.';
  const params = [ethers.hexlify(ethers.toUtf8Bytes(message)), account];
  const transientParser = () => {
    let calls = 0;
    return (method, pendingParams) => {
      calls += 1;
      assert.equal(pendingParams, params, 'Recovery must retain the exact same pending request');
      if (calls === 1) throw new TypeError('getSignaturePreview is not a function');
      return getSignaturePreview(method, pendingParams);
    };
  };
  const rerendered = routeFixture('personal_sign', params, 'zh', transientParser());
  assert.equal(rerendered.routeProps.canApprove, false, 'A failed parser must never allow approval');
  assert.equal(Boolean(button(rerendered.harness, '拒绝').props.disabled), false);
  rerendered.harness.rerender();
  assert.equal(rerendered.routeProps.canApprove, true, 'An earlier parser exception cannot be memoized for the lifetime of the pending request');
  visibleText(rerendered.harness, message);
  assert.equal(Boolean(button(rerendered.harness, '签名').props.disabled), false);
  assert.deepEqual(rerendered.calls.resolutions, [], 'Reparsing only restores the preview; it never approves a request');
  assert.equal(rerendered.calls.cleared, 0); assert.equal(rerendered.calls.back, 0);

  const retried = routeFixture('personal_sign', params, 'zh', transientParser());
  assert.equal(retried.routeProps.canApprove, false);
  const retry = button(retried.harness, '重新解析');
  assert.equal(Boolean(retry.props.disabled), false, 'A transient parser failure exposes an actionable retry');
  await retry.props.onPress(); await retried.harness.settle();
  visibleText(retried.harness, message);
  assert.equal(retried.routeProps.canApprove, true, 'Retry parses the same request again after the parser recovers');
  assert.equal(Boolean(button(retried.harness, '签名').props.disabled), false);
  assert.deepEqual(retried.calls.resolutions, [], 'Retry never signs or resolves the approval automatically');
  assert.equal(retried.calls.cleared, 0); assert.equal(retried.calls.back, 0);
}

async function messageRequestsUseActualPayload() {
  const siwe = `login.fixture.invalid wants you to sign in with your Ethereum account:\n${account}\n\n登录 DreamKey，确认此消息。\nURI: https://login.fixture.invalid\nVersion: 1\nChain ID: 1\nNonce: offline-fixture\nIssued At: 2026-10-13T00:00:00Z`;
  for (const [method, params] of [
    ['personal_sign', [ethers.hexlify(ethers.toUtf8Bytes(siwe)), account]],
    ['personal_sign', [siwe, account]],
    ['eth_sign', [account, ethers.hexlify(ethers.toUtf8Bytes(siwe))]],
  ]) {
    const f = routeFixture(method, params);
    assert.equal(f.routeProps.signature.account, account, 'The signer is separate from the message');
    assert.equal(f.routeProps.signature.message, siwe, 'The route passes the actual decoded signing payload');
    assert.equal(visibleText(f.harness, siwe).props.selectable, true);
    visibleText(f.harness, account);
    assert.equal(Boolean(button(f.harness, '签名').props.disabled), false);
    assert.equal(Boolean(button(f.harness, '拒绝').props.disabled), false);
    if (f.routeProps.signature.rawMessage) {
      const disclosure = button(f.harness, '展开原始数据');
      assert.equal(disclosure.props.accessibilityState.expanded, false);
      disclosure.props.onPress(); await f.harness.settle();
      visibleText(f.harness, params[method === 'personal_sign' ? 0 : 1]);
      assert.equal(button(f.harness, '收起原始数据').props.accessibilityState.expanded, true);
    }
    const operation = button(f.harness, '签名').props.onPress();
    await f.harness.paint(); await operation;
    assert.deepEqual(f.calls.resolutions, [true]);
    assert.equal(f.calls.cleared, 1); assert.equal(f.calls.back, 1);
  }
}

async function typedDataIsStructuredAndComplete() {
  const typedData = {
    domain: { name: 'DreamKey fixture', version: '1', chainId: 1, verifyingContract: recipient },
    primaryType: 'Permit',
    types: {
      EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }],
      Permit: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }],
    },
    message: { owner: account, spender: recipient, value: '12345678901234567890', nonce: 1, deadline: '1791849600' },
  };
  for (const method of ['eth_signTypedData', 'eth_signTypedData_v3', 'eth_signTypedData_v4']) {
    for (const payload of [typedData, JSON.stringify(typedData)]) {
      const f = routeFixture(method, [account, payload]);
      assert.equal(f.routeProps.signature.kind, 'typedData');
      visibleText(f.harness, '签名域'); visibleText(f.harness, '消息内容'); visibleText(f.harness, '数据类型');
      visibleText(f.harness, 'Permit');
      assert.equal(visibleText(f.harness, JSON.stringify(typedData.domain, null, 2)).props.selectable, true);
      assert.equal(visibleText(f.harness, JSON.stringify(typedData.message, null, 2)).props.selectable, true);
      assert.doesNotMatch(textContent(f.harness.tree), /\[object Object\]/);
      assert.equal(Boolean(button(f.harness, '签名').props.disabled), false);
      const disclosure = button(f.harness, '展开数据结构');
      assert.equal(disclosure.props.accessibilityState.expanded, false);
      disclosure.props.onPress(); await f.harness.settle();
      visibleText(f.harness, JSON.stringify({ Permit: typedData.types.Permit }, null, 2));
      assert.equal(button(f.harness, '收起数据结构').props.accessibilityState.expanded, true);
    }
  }
}

function longEmptyAndBinaryMessages() {
  const longMessage = Array.from({ length: 80 }, (_value, i) => `第 ${i + 1} 行：必须完整展示的签名内容`).join('\n');
  const f = routeFixture('personal_sign', [ethers.hexlify(ethers.toUtf8Bytes(longMessage)), account]);
  const message = visibleText(f.harness, longMessage);
  assert.equal(message.props.numberOfLines, undefined, 'Long signing text cannot be truncated to a fixed line count');
  assert.equal(flattenStyle(message.props.style).maxHeight, undefined, 'Long signing text cannot be clipped at 180px');
  assert.equal(flattenStyle(message.props.style).overflow, undefined);
  assert.equal(findAll(f.harness.tree, 'ScrollView').length, 1, 'The complete approval can be scrolled');
  const scrollContent = textContent(findAll(f.harness.tree, 'ScrollView')[0]);
  assert.ok(scrollContent.includes(longMessage), 'The full message remains in the scroll area');
  assert.equal(findAll(findAll(f.harness.tree, 'ScrollView')[0], 'Pressable').some((node) => textContent(node) === '签名'), false, 'Sign and reject actions stay in the fixed footer rather than below long message text');
  for (const value of ['', '0x']) {
    const empty = routeFixture('personal_sign', [value, account]);
    visibleText(empty.harness, '此请求的消息内容为空。');
    assert.equal(empty.routeProps.canApprove, true, 'An intentional empty message is distinct from malformed data');
  }
  const binary = routeFixture('personal_sign', ['0xff0080', account]);
  visibleText(binary.harness, '此消息无法解码为可读文本，请核对下方的原始十六进制数据。');
  visibleText(binary.harness, '0xff0080');
  assert.doesNotMatch(textContent(binary.harness.tree), /\ufffd/, 'Binary bytes never become a misleading replacement-character message');
}

async function malformedApprovalIsBlockedButRejectWorks() {
  for (const [method, params] of [
    ['personal_sign', ['0x1', account]],
    ['personal_sign', [42, account]],
    ['eth_signTypedData_v4', [account, '{bad json']],
    ['eth_signTypedData_v4', [account, { domain: {}, types: {}, message: {} }]],
  ]) {
    const f = routeFixture(method, params);
    assert.equal(f.routeProps.canApprove, false);
    visibleText(f.harness, '无法解析签名请求，无法核对内容，因此不能签名。');
    assert.equal(Boolean(button(f.harness, '签名').props.disabled), true);
    assert.equal(Boolean(button(f.harness, '拒绝').props.disabled), false, 'Malformed content must not trap the user');
    // Bypass Pressable's disabled UI, as a stale or programmatic event could.
    f.routeProps.onApprove();
    assert.deepEqual(f.calls.resolutions, [], 'The route independently guards unavailable approvals');
    assert.equal(f.calls.cleared, 0); assert.equal(f.calls.back, 0);
    await button(f.harness, '拒绝').props.onPress();
    assert.deepEqual(f.calls.resolutions, [false]);
    assert.equal(f.calls.cleared, 1); assert.equal(f.calls.back, 1);
  }
  const f = routeFixture('personal_sign', ['Cancel fixture', account]);
  f.calls.listeners.beforeRemove();
  assert.deepEqual(f.calls.resolutions, [false], 'Native back navigation still rejects a pending request');
}

async function transactionFlowAndEnglishRemainAvailable() {
  const tx = { from: account, to: recipient, value: '0x123', gas: '0x5208', maxFeePerGas: '0x3b9aca00' };
  const f = routeFixture('eth_sendTransaction', [tx]);
  assert.equal(f.routeProps.signature, undefined);
  assert.equal(f.routeProps.transaction, tx, 'Transaction requests retain their original object and fields');
  assert.equal(f.routeProps.account, account); assert.equal(f.routeProps.canApprove, true);
  visibleText(f.harness, '确认交易'); visibleText(f.harness, '0.000000000000000291 ETH'); visibleText(f.harness, '21000');
  visibleText(f.harness, recipient); visibleText(f.harness, '1.0 Gwei');
  assert.equal(Boolean(button(f.harness, '确认').props.disabled), false);
  const operation = button(f.harness, '确认').props.onPress();
  await f.harness.paint(); await operation;
  assert.deepEqual(f.calls.resolutions, [true]);
  const en = routeFixture('personal_sign', ['English message', account], 'en');
  visibleText(en.harness, 'Signature Request'); visibleText(en.harness, 'Message'); visibleText(en.harness, 'English message');
  assert.equal(Boolean(button(en.harness, 'Reject').props.disabled), false);
  assert.equal(Boolean(button(en.harness, 'Sign').props.disabled), false);
}

async function contractApprovalDetailsAreVisible() {
  const abi = new ethers.Interface(['function approve(address spender,uint256 amount)']);
  const data = abi.encodeFunctionData('approve', [recipient, ethers.MaxUint256]);
  const f = routeFixture('eth_sendTransaction', [{ from: account, to: recipient, value: '0x0', data, gasPrice: '0x3b9aca00', nonce: '0x3' }]);
  assert.equal(visibleText(f.harness, data).props.selectable, true, 'Complete signing bytes remain inspectable');
  visibleText(f.harness, recipient);
  assert.ok(textContent(f.harness.tree).includes('无限授权'));
  assert.ok(textContent(f.harness.tree).includes(recipient));
  const unknown = routeFixture('eth_sendTransaction', [{ from: account, to: recipient, data: '0xdeadbeef' }]);
  visibleText(unknown.harness, '0xdeadbeef');
  assert.ok(textContent(unknown.harness.tree).includes('未知合约调用'));
}

async function approvalFeedbackPrecedesWorkAndGuardsRapidPresses() {
  for (const isTransaction of [false, true]) {
    const harness = createHarness();
    const { screen } = loadScreen(harness);
    const calls = { approvals: 0, rejections: 0 };
    const completion = deferred();
    harness.mount(screen, {
      origin: 'https://login.fixture.invalid', account,
      method: isTransaction ? 'eth_sendTransaction' : 'personal_sign',
      signature: isTransaction ? undefined : getSignaturePreview('personal_sign', ['Busy feedback fixture', account]),
      transaction: isTransaction ? { from: account, to: recipient, value: '0x123' } : undefined,
      onApprove() { calls.approvals += 1; return completion.promise; },
      onReject() { calls.rejections += 1; },
    });
    const initialApprove = button(harness, isTransaction ? '确认' : '签名').props.onPress;
    const initialReject = button(harness, '拒绝').props.onPress;
    const operation = initialApprove();
    initialApprove(); initialReject();
    await harness.settle();
    const busyButton = button(harness, isTransaction ? '提交中…' : '正在签名…');
    assert.equal(Boolean(busyButton.props.disabled), true);
    assert.equal(findAll(busyButton, 'ActivityIndicator').length, 1, 'Approve visibly shows progress before work begins');
    assert.equal(Boolean(button(harness, '拒绝').props.disabled), true);
    assert.equal(calls.approvals, 0, 'Signing/submitting cannot begin before native loading feedback paints');
    assert.equal(calls.rejections, 0, 'A stale reject handler cannot reject an approval already in progress');
    assert.equal(harness.paints.length, 1, 'Rapid presses cannot schedule more than one approval');
    await harness.paint();
    assert.equal(calls.approvals, 1);
    assert.equal(Boolean(button(harness, isTransaction ? '提交中…' : '正在签名…').props.disabled), true, 'Busy feedback remains until the host operation completes');
    initialApprove(); initialReject();
    assert.equal(calls.approvals, 1); assert.equal(calls.rejections, 0);
    completion.resolve(); await operation; await harness.settle();
    assert.equal(Boolean(button(harness, isTransaction ? '确认' : '签名').props.disabled), false);
    assert.equal(findAll(harness.tree, 'ActivityIndicator').length, 0);
    await initialReject(); await harness.settle();
    assert.equal(calls.rejections, 1, 'Completion releases the in-flight guard for future explicit actions');
    assert.equal(harness.paints.length, 0, 'Reject remains immediate and never waits for crypto paint');
  }
}

async function nativeBackDuringPaintCannotApproveLater() {
  const cancelled = routeFixture('personal_sign', ['Deferred approval cancellation fixture', account]);
  const operation = button(cancelled.harness, '签名').props.onPress();
  await cancelled.harness.settle();
  assert.equal(cancelled.harness.paints.length, 1);
  assert.deepEqual(cancelled.calls.resolutions, [], 'Approval waits for the loading frame');
  cancelled.calls.listeners.beforeRemove();
  assert.deepEqual(cancelled.calls.resolutions, [false]);
  assert.equal(cancelled.calls.cleared, 1);
  await cancelled.harness.paint(); await operation;
  assert.deepEqual(cancelled.calls.resolutions, [false], 'A delayed approve handler cannot override native-back rejection');
  assert.equal(cancelled.calls.cleared, 1, 'Cancellation clears the pending request exactly once');
  assert.equal(cancelled.calls.back, 0, 'The delayed handler must not pop another route after native back');
  cancelled.routeProps.onApprove(); cancelled.routeProps.onReject(); cancelled.calls.listeners.beforeRemove();
  assert.deepEqual(cancelled.calls.resolutions, [false], 'Stale callbacks cannot decide an already-cancelled request again');
  assert.equal(cancelled.calls.cleared, 1); assert.equal(cancelled.calls.back, 0);

  const approved = routeFixture('personal_sign', ['Exactly one decision fixture', account]);
  const staleApprove = approved.routeProps.onApprove;
  staleApprove(); staleApprove();
  approved.routeProps.onReject(); approved.calls.listeners.beforeRemove();
  assert.deepEqual(approved.calls.resolutions, [true], 'The route independently guards duplicate approve and subsequent reject callbacks');
  assert.equal(approved.calls.cleared, 1); assert.equal(approved.calls.back, 1);
}

async function approvalFailuresRecoverWithoutLeakingErrors() {
  const harness = createHarness();
  const { screen } = loadScreen(harness, 'en');
  let calls = 0;
  const failure = deferred();
  const secretBearingFixtureError = 'fixture rejected input must never be shown';
  harness.mount(screen, {
    origin: 'https://login.fixture.invalid', account,
    method: 'personal_sign', signature: getSignaturePreview('personal_sign', ['Recovery fixture', account]),
    onApprove() { calls += 1; return calls === 1 ? failure.promise : undefined; },
    onReject() {},
  });
  const firstOperation = button(harness, 'Sign').props.onPress();
  await harness.settle();
  assert.equal(Boolean(button(harness, 'Signing…').props.disabled), true);
  await harness.paint();
  assert.equal(calls, 1);
  failure.reject(new Error(secretBearingFixtureError));
  await firstOperation; await harness.settle();
  visibleText(harness, 'Unable to complete this request. Please try again.');
  assert.equal(textContent(harness.tree).includes(secretBearingFixtureError), false, 'Raw signing errors cannot leak rejected message or secret content');
  assert.equal(Boolean(button(harness, 'Sign').props.disabled), false);
  assert.equal(Boolean(button(harness, 'Reject').props.disabled), false);
  const secondOperation = button(harness, 'Sign').props.onPress();
  await harness.settle();
  assert.equal(textContent(harness.tree).includes('Unable to complete this request. Please try again.'), false, 'An explicit retry clears the prior failure');
  assert.equal(calls, 1, 'Retry also yields before the host operation');
  await harness.paint(); await secondOperation; await harness.settle();
  assert.equal(calls, 2, 'An operation failure releases the duplicate-submit guard');
  assert.equal(Boolean(button(harness, 'Sign').props.disabled), false);
}

async function main() {
  await messageRequestsUseActualPayload();
  await typedDataIsStructuredAndComplete();
  longEmptyAndBinaryMessages();
  await malformedApprovalIsBlockedButRejectWorks();
  await transientParserFailuresRecoverForTheSameRequest();
  await transactionFlowAndEnglishRemainAvailable();
  await contractApprovalDetailsAreVisible();
  await approvalFeedbackPrecedesWorkAndGuardsRapidPresses();
  await nativeBackDuringPaintCannotApproveLater();
  await approvalFailuresRecoverWithoutLeakingErrors();
  await transactionAndConnectionDetailsRemainReviewable();
  console.log('Signature UI verification passed: actual App route and native screen display decoded personal/eth_sign messages, complete structured typed data, long/empty/binary messages, raw/type disclosures, independent invalid-approval guards, same-request parser recovery, rejection/back navigation, English labels, transaction approvals, loading feedback before work, rapid/stale press guards, and recovery from host failures. Offline fixtures only; no wallet keys, RPC or signature operation.');
}

async function transactionAndConnectionDetailsRemainReviewable() {
  for (const state of ['pending', 'confirmed', 'failed', 'not-found']) {
    const harness = createHarness();
    const { screens } = loadScreen(harness, 'en');
    harness.mount(screens.TransactionDetailScreen, {
      network: { name: 'Fixture Network' }, status: { hash: `0x${'ab'.repeat(32)}`, state },
      from: account, to: recipient, amount: '12345678901234567890.123456789012345678 TOKEN', onBack() {},
    });
    for (const [label, value] of [['From', account], ['To', recipient], ['Transaction Hash', `0x${'ab'.repeat(32)}`]]) {
      assert.equal(visibleText(harness, `${value.slice(0, 14)}…${value.slice(-12)}`).props.selectable, true);
      const copy = findAll(harness.tree, 'Pressable').find((node) => node.props.accessibilityLabel === `Copy ${label}`);
      assert.ok(copy, `${label} has an explicit copy action`);
      copy.props.onPress();
      assert.equal(harness.clipboard.at(-1), value, `${label} copies the full value, including hidden characters`);
      await harness.settle();
    }
    if (state === 'pending') assert.match(textContent(harness.tree), /Do not send this transaction again/);
    if (state === 'failed') assert.match(textContent(harness.tree), /Network fees may still apply/);
    if (state === 'not-found') assert.match(textContent(harness.tree), /may still be propagating/);
  }
  const harness = createHarness();
  const { screens } = loadScreen(harness, 'en');
  const completion = deferred();
  const calls = [];
  harness.mount(screens.PermissionPrompt, {
    origin: 'https://a-very-long-requesting-application.fixture.invalid',
    requestedAccounts: [account, recipient, account], existingAccounts: [recipient, '0x9999999999999999999999999999999999999999'],
    onApprove(selected) { calls.push([...selected]); return completion.promise; }, onReject() {},
  });
  assert.equal(findAll(harness.tree, 'Pressable').filter((node) => node.props.accessibilityRole === 'checkbox').length, 2, 'Duplicate requested accounts are listed once');
  visibleText(harness, account); visibleText(harness, recipient);
  const connect = button(harness, 'Connect (1)');
  connect.props.onPress(); connect.props.onPress();
  await harness.settle();
  assert.deepEqual(calls, [[recipient]], 'Only visibly selected requested accounts are approved, exactly once');
  assert.equal(Boolean(button(harness, 'Connect (1)').props.disabled), true);
  completion.resolve(); await harness.settle();
  const selectedCheckbox = findAll(harness.tree, 'Pressable').find((node) => node.props.accessibilityRole === 'checkbox' && node.props.accessibilityState.checked);
  selectedCheckbox.props.onPress(); await harness.settle();
  assert.equal(Boolean(button(harness, 'Connect (0)').props.disabled), true, 'An empty selection cannot be connected');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
