/* Offline lifecycle and scanner regression checks; public mocks only. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function compile(file, require) {
  const code = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, require }, { filename: file });
  return module.exports;
}

function visibilityFixture({ platform = 'android', native = true, initial = { state: 'foreground', revision: 0 }, current = 'active' } = {}) {
  const snapshot = deferred(); const received = []; let nativeListener, appListener, removed = 0;
  const bridge = { initialState: initial, getState: () => snapshot.promise, addListener() {}, removeListeners() {} };
  const rn = {
    Platform: { OS: platform }, NativeModules: native ? { DreamKeyAppVisibility: bridge } : {},
    NativeEventEmitter: class {
      constructor(module) { assert.equal(module, bridge); }
      addListener(event, listener) { assert.equal(event, 'DreamKeyAppVisibilityChange'); nativeListener = listener; return { remove() { removed += 1; } }; }
    },
    AppState: { currentState: current, addEventListener(event, listener) { assert.equal(event, 'change'); appListener = listener; return { remove() { removed += 1; } }; } },
  };
  const { subscribeAppVisibility } = compile('src/native/app-visibility.ts', (name) => { assert.equal(name, 'react-native'); return rn; });
  const unsubscribe = subscribeAppVisibility((state) => received.push(state));
  return { snapshot, received, unsubscribe, get removed() { return removed; }, emit: (state, revision) => nativeListener?.({ state, revision }), app: (state) => appListener?.(state), get usesAppState() { return !!appListener; } };
}

async function verifyVisibility() {
  const app = visibilityFixture();
  assert.deepEqual(app.received, ['foreground']);
  assert.equal(app.usesAppState, false, 'Android must ignore RN onPause background entirely when native visibility is available');
  for (const overlay of ['camera permission', 'biometric authentication', 'share chooser']) {
    app.app('background');
    app.app('active');
    assert.deepEqual(app.received, ['foreground'], `${overlay} without Activity.onStop must preserve the session`);
  }
  app.emit('background', 2);
  app.snapshot.resolve({ state: 'foreground', revision: 1 }); await tick();
  assert.deepEqual(app.received, ['foreground', 'background'], 'A stale initial snapshot must not undo onStop');
  app.emit('foreground', 3); app.emit('background', 2); app.emit('background', NaN); app.emit('invalid', 4);
  assert.deepEqual(app.received, ['foreground', 'background', 'foreground']);
  // Every genuine stop must be delivered even when RN AppState was already background.
  app.app('background'); app.emit('background', 4); app.emit('foreground', 5); app.emit('background', 6);
  assert.deepEqual(app.received.slice(-3), ['background', 'foreground', 'background']);
  app.unsubscribe(); app.emit('foreground', 7);
  assert.equal(app.removed, 1); assert.equal(app.received.at(-1), 'background');

  const stopped = visibilityFixture({ initial: { state: 'background', revision: 8 } });
  assert.deepEqual(stopped.received, ['background'], 'Subscribing while stopped must lock immediately');
  stopped.snapshot.resolve({ state: 'background', revision: 8 }); await tick();
  assert.equal(stopped.received.length, 1); stopped.unsubscribe();

  const noConstants = visibilityFixture({ initial: null });
  noConstants.snapshot.reject(new Error('public fixture native error')); await tick();
  assert.deepEqual(noConstants.received, ['background'], 'Unknown native visibility must fail closed'); noConstants.unsubscribe();

  for (const options of [{ platform: 'ios' }, { native: false }]) {
    const fallback = visibilityFixture(options);
    assert.equal(fallback.usesAppState, true);
    fallback.app('inactive'); assert.deepEqual(fallback.received, ['foreground']);
    fallback.app('background'); fallback.app('active');
    assert.deepEqual(fallback.received, ['foreground', 'background', 'foreground'], 'iOS and old Android binaries retain the existing background lock');
    fallback.unsubscribe(); fallback.app('background'); assert.equal(fallback.removed, 1);
    assert.equal(fallback.received.at(-1), 'foreground');
  }

  const activity = fs.readFileSync(path.join(root, 'android/app/src/main/java/com/dreamkey/wallet/MainActivity.kt'), 'utf8');
  assert.match(activity, /override fun onResume\(\)[\s\S]*?DreamKeyAppVisibilityModule\.setForeground\(true\)/);
  assert.match(activity, /override fun onStop\(\)[\s\S]*?DreamKeyAppVisibilityModule\.setForeground\(false\)/);
  assert.doesNotMatch(activity, /override fun onPause|isChangingConfigurations|postDelayed/, 'No onPause lock, skipped stop or timed background exemption is allowed');
}

function scannerFixture() {
  const calls = { checks: 0, requests: 0, scans: [], closes: 0 };
  const options = { check: async () => 'granted', request: async () => 'granted' };
  const slots = []; let cursor = 0, tree; const effects = [];
  const equal = (a, b) => a && b && a.length === b.length && a.every((item, index) => Object.is(item, b[index]));
  const hooks = {
    useState(initial) { const index = cursor++; slots[index] ??= { value: typeof initial === 'function' ? initial() : initial }; return [slots[index].value, (next) => { slots[index].value = typeof next === 'function' ? next(slots[index].value) : next; }]; },
    useRef(initial) { const index = cursor++; return slots[index] ??= { current: initial }; },
    useEffect(callback, deps) { const index = cursor++; if (!slots[index] || !equal(slots[index].deps, deps)) effects.push(() => { slots[index]?.cleanup?.(); slots[index] = { deps, cleanup: callback() }; }); },
  };
  const React = { ...hooks, createElement: (type, props, ...children) => ({ type, props: { ...props, children } }) };
  const rn = { Platform: { OS: 'android' }, StyleSheet: { create: (value) => value, absoluteFillObject: {} },
    ...Object.fromEntries(['ActivityIndicator', 'Pressable', 'Text', 'View'].map((name) => [name, name])) };
  const { QrScannerModal } = compile('src/ui/QRScannerModal.tsx', (name) => {
    if (name === 'react') return { ...React, default: React };
    if (name === 'react-native') return rn;
    if (name === './SecureModal.js') return { SecureModal: 'Modal' };
    if (name === 'react-native-safe-area-context') return { SafeAreaView: 'SafeAreaView' };
    if (name === 'react-native-camera-kit') return { Camera: 'Camera', CameraType: { Back: 'back' } };
    if (name === './icons.js') return { QrCode: 'QrCode', X: 'X' };
    if (name === 'react-native-permissions') return {
      PERMISSIONS: { ANDROID: { CAMERA: 'android.camera' } },
      RESULTS: { GRANTED: 'granted', LIMITED: 'limited', DENIED: 'denied', BLOCKED: 'blocked' },
      check(permission) { assert.equal(permission, 'android.camera'); calls.checks++; return options.check(); },
      request(permission) { assert.equal(permission, 'android.camera'); calls.requests++; return options.request(); },
    };
    throw new Error(`Unexpected fixture dependency: ${name}`);
  });
  let visible = false;
  const render = (next = visible) => {
    visible = next; cursor = 0;
    tree = QrScannerModal({ visible, title: 'Scan', hint: 'Hint', closeLabel: 'Close', permissionDeniedLabel: 'Permission denied',
      onClose() { calls.closes++; }, onScanned(value) { calls.scans.push(value); } });
    while (effects.length) effects.shift()();
    return tree;
  };
  const find = (node, type) => { if (node?.type === type) return node; for (const child of node?.props?.children ?? []) { const found = find(child, type); if (found) return found; } };
  const camera = () => find(tree, 'Camera');
  const read = (handler, value = ' https://public.example/ ') => handler({ nativeEvent: { codeStringValue: value } });
  const settle = async () => { await tick(); render(); await tick(); render(); };
  render();
  return { calls, options, render, settle, camera, read, close: () => find(tree, 'Modal').props.onRequestClose(), unmount() { for (const slot of slots) slot?.cleanup?.(); } };
}

async function verifyScanner() {
  const scanner = scannerFixture();
  assert.equal(scanner.calls.checks, 0); assert.equal(scanner.camera(), undefined, 'Hidden scanners must not mount or request the camera');
  scanner.render(true); assert.equal(scanner.camera(), undefined, 'Camera must wait for a successful permission check');
  await scanner.settle(); assert.ok(scanner.camera()); assert.equal(scanner.calls.requests, 0, 'Previously granted permission must not show another prompt');
  const oldHandler = scanner.camera().props.onReadCode;
  scanner.read(oldHandler, '   '); assert.equal(scanner.calls.scans.length, 0);
  scanner.read(oldHandler); scanner.read(oldHandler);
  assert.deepEqual(scanner.calls.scans, ['https://public.example/']); assert.equal(scanner.calls.closes, 1);
  scanner.render(); assert.equal(scanner.camera(), undefined, 'A handled scan immediately releases the camera');
  scanner.render(false); scanner.render(true); await scanner.settle();
  scanner.read(oldHandler); assert.equal(scanner.calls.scans.length, 1, 'An event from a previous scanner session must be ignored after reopening');
  const currentHandler = scanner.camera().props.onReadCode;
  scanner.close(); scanner.read(currentHandler); scanner.render();
  assert.equal(scanner.calls.scans.length, 1); assert.equal(scanner.camera(), undefined, 'Closing suppresses events before the parent rerenders');
  scanner.unmount(); scanner.read(currentHandler); assert.equal(scanner.calls.scans.length, 1);

  const pending = scannerFixture(); const permission = deferred();
  pending.options.check = async () => 'denied'; pending.options.request = () => permission.promise;
  pending.render(true); await pending.settle();
  assert.equal(pending.calls.requests, 1); assert.equal(pending.camera(), undefined, 'Native camera must never race the permission request');
  pending.render(false); pending.render(true); await pending.settle();
  assert.equal(pending.calls.requests, 1, 'Reopening during a pending prompt must share its permission request');
  pending.render(false); permission.resolve('granted'); await pending.settle();
  assert.equal(pending.camera(), undefined, 'A hidden session must ignore a late permission grant');
  pending.options.check = async () => 'granted'; pending.render(true); await pending.settle(); assert.ok(pending.camera());
  const hiddenHandler = pending.camera().props.onReadCode;
  pending.render(false); pending.read(hiddenHandler); assert.equal(pending.calls.scans.length, 0);
  pending.unmount();

  for (const status of ['blocked', 'unavailable']) {
    const denied = scannerFixture(); denied.options.check = async () => status;
    denied.render(true); await denied.settle();
    assert.equal(denied.calls.requests, 0); assert.equal(denied.camera(), undefined, `${status} permission must not mount Camera or repeat the OS prompt`); denied.unmount();
  }
  const failed = scannerFixture(); failed.options.check = async () => { throw new Error('public fixture permission error'); };
  failed.render(true); await failed.settle(); assert.equal(failed.camera(), undefined); failed.unmount();
}

(async () => {
  await verifyVisibility(); await verifyScanner();
  console.log('App visibility/scanner verification passed: only a real Activity stop locks Android; fallback, snapshot ordering, permission-gated camera and stale scan rejection are covered.');
})().catch((error) => { console.error(error); process.exitCode = 1; });
