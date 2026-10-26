const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const vm = require('node:vm');
const ts = require('typescript');

function compile(relative, dependencies, globals = {}) {
  const source = fs.readFileSync(path.resolve(__dirname, '..', relative), 'utf8');
  const javascript = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true },
  }).outputText;
  const entry = { exports: {} };
  vm.runInNewContext(javascript, {
    module: entry, exports: entry.exports, setTimeout, clearTimeout,
    require(specifier) {
      assert.ok(Object.hasOwn(dependencies, specifier), `Unexpected poster dependency: ${specifier}`);
      return dependencies[specifier];
    },
    ...globals,
  }, { filename: relative });
  return entry.exports;
}

function findAll(node, type, result = []) {
  if (!node) return result;
  if (Array.isArray(node)) { node.forEach(child => findAll(child, type, result)); return result; }
  if (node.type === type) result.push(node);
  if (node.props) findAll(node.props.children, type, result);
  return result;
}

function textContent(node) {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textContent).join('');
  return textContent(node.props?.children);
}

async function verifyPoster() {
  let id = 0;
  const react = {
    useId: () => `:fixture:${++id}:`, forwardRef: fn => fn,
    createElement: (type, props, ...children) => typeof type === 'function'
      ? type({ ...props, children }) : { type, props: { ...props, children } },
  };
  const svg = { __esModule: true, default: 'Svg', ...Object.fromEntries(
    ['Circle', 'ClipPath', 'Defs', 'G', 'LinearGradient', 'Path', 'RadialGradient', 'Rect', 'Stop', 'Text', 'Image'].map(name => [name, name]),
  ) };
  const { DreamKeyLogo, DreamKeyLogoMark } = compile('src/ui/DreamKeyLogo.tsx', {
    react, 'react-native-svg': svg, 'react-native': { StyleSheet: { create: value => value } },
  });
  const logoIds = new Set();
  for (const size of [42, 54, 72, 42]) {
    const tree = DreamKeyLogo({ size });
    assert.equal(tree.type, 'Svg');
    assert.equal(tree.props.width, size);
    assert.equal(tree.props.height, size);
    assert.equal(tree.props.accessibilityLabel, 'DreamKey');
    assert.equal(tree.props.style[0].flexShrink, 0, 'The brand mark cannot collapse beside long titles');
    assert.equal(findAll(tree, 'Image').length, 0, 'Screen logos must work without Metro/APK/OTA bitmap resources');
    assert.equal(findAll(tree, 'Path').filter(path => ['#51e0ff', '#976fff', '#1faadb', '#6841e0'].includes(path.props.fill)).length, 4);
    for (const defs of findAll(tree, 'Defs')) {
      for (const gradient of defs.props.children) {
        assert.ok(!logoIds.has(gradient.props.id), 'Mounted screen and poster logos use independent gradient IDs');
        logoIds.add(gradient.props.id);
      }
    }
  }
  const { InvitePoster } = compile('src/ui/invite/InvitePoster.tsx', {
    react, 'react-native-svg': svg, 'react-native-qrcode-svg': 'QRCode', '../DreamKeyLogo.js': { DreamKeyLogoMark },
  });
  for (const language of ['zh', 'en']) {
    const onLayout = () => {};
    const tree = InvitePoster({ downloadUrl: 'https://example.com/dreamkey', language, width: 360, onLayout });
    assert.equal(tree.props.onLayout, onLayout, 'Sharing waits for the SVG itself to be laid out');
    assert.equal(findAll(tree, 'Image').length, 0, 'No asynchronous bitmap can disappear from the exported poster');
    const paths = findAll(tree, 'Path');
    for (const color of ['#51e0ff', '#976fff', '#1faadb', '#6841e0', '#ffd366']) {
      assert.ok(paths.some(path => path.props.fill === color), `The exported logo contains its ${color} brand facet`);
    }
    assert.ok(findAll(tree, 'Circle').some(circle => circle.props.cx === 512 && circle.props.r === 45 && circle.props.fill === '#f5faff'),
      'The DreamKey keyhole is part of the SVG export');
    assert.equal(findAll(tree, 'QRCode').length, 1);
    assert.ok(textContent(tree).includes('DreamKey'));
  }

  const slots = [], effects = [], frames = new Map(), shares = [];
  let cursor = 0, dirty = false, tree, nextFrame = 0, captures = 0, rejectImage = false;
  let dimensions = { width: 400, fontScale: 1 }, language = 'zh';
  const same = (left, right) => left && right && left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
  const screenReact = {
    createElement(type, props, ...children) {
      if (type === 'InvitePoster') props.ref.current = { toDataURL(callback) { captures++; callback('iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB'); } };
      return { type, props: { ...props, children } };
    },
    useState(initial) {
      const index = cursor++;
      if (!slots[index]) slots[index] = { value: initial };
      return [slots[index].value, next => { slots[index].value = typeof next === 'function' ? next(slots[index].value) : next; dirty = true; }];
    },
    useRef(initial) { const index = cursor++; if (!slots[index]) slots[index] = { current: initial }; return slots[index]; },
    useCallback(callback, deps) { const index = cursor++; if (!slots[index] || !same(slots[index].deps, deps)) slots[index] = { value: callback, deps }; return slots[index].value; },
    useEffect(effect, deps) {
      const index = cursor++;
      if (!slots[index] || !same(slots[index].deps, deps)) {
        const previous = slots[index];
        const slot = slots[index] = { deps, cleanup: previous?.cleanup };
        effects.push(() => { slot.cleanup?.(); slot.cleanup = effect(); });
      }
    },
  };
  const { InviteFriendsScreen } = compile('src/ui/invite/InviteFriendsScreen.tsx', {
    react: screenReact,
    'react-native': {
      ...Object.fromEntries(['ActivityIndicator', 'Image', 'Pressable', 'ScrollView', 'Text', 'View'].map(name => [name, name])),
      StyleSheet: { create: value => value }, useWindowDimensions: () => dimensions, Share: { share: async () => {} },
    },
    'react-native-safe-area-context': { SafeAreaView: 'SafeAreaView' },
    '@react-native-clipboard/clipboard': { setString() {} },
    '../../config/app-links.js': { APP_DOWNLOAD_URL: 'https://example.com/dreamkey', APP_DOWNLOAD_LINK_IS_PLACEHOLDER: true },
    '../../i18n.js': { useI18n: () => ({ language, t: value => value }) },
    '../../native/invite-share.js': { async shareInviteImage(options) { if (rejectImage) throw new Error('No sharing target'); shares.push(options); } },
    '../icons.js': {}, '../theme.js': { walletColors: {} }, './InvitePoster.js': { InvitePoster: 'InvitePoster' },
  }, {
    requestAnimationFrame(callback) { const frame = ++nextFrame; frames.set(frame, callback); return frame; },
    cancelAnimationFrame(frame) { frames.delete(frame); },
  });
  function render() { cursor = 0; dirty = false; tree = InviteFriendsScreen({ onBack() {} }); while (effects.length) effects.shift()(); }
  async function settle() { for (let pass = 0; pass < 5; pass++) { await new Promise(resolve => setImmediate(resolve)); if (dirty) render(); } }
  const button = () => findAll(tree, 'Pressable').at(-1);
  render();
  assert.equal(findAll(tree, 'Image').length, 0, 'A hidden bitmap cannot incorrectly mark the SVG as ready');
  assert.equal(button().props.disabled, true);
  button().props.onPress(); await settle();
  assert.equal(captures, 0);
  findAll(tree, 'InvitePoster')[0].props.onLayout();
  assert.equal(button().props.disabled, true, 'A native frame completes after layout before capture');
  for (const [frame, callback] of frames) { frames.delete(frame); callback(); }
  await settle();
  assert.equal(button().props.disabled, false);
  button().props.onPress(); button().props.onPress(); await settle();
  assert.equal(captures, 1, 'Rapid taps export the complete vector poster once');
  assert.equal(shares.length, 1);
  assert.equal(shares[0].pngBase64, 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB');
  const actionContainer = () => findAll(tree, 'View').find(node => findAll(node, 'Pressable').length === 2 && textContent(node).includes(language === 'en' ? 'Share Poster' : '分享海报'));
  const direction = node => node.props.style.flat().filter(Boolean).at(-1).flexDirection;
  assert.equal(direction(actionContainer()), 'row', 'Regular screens keep the two sharing actions side by side');
  language = 'en'; dimensions = { width: 320, fontScale: 1 }; render();
  assert.equal(direction(actionContainer()), 'column', 'English sharing actions stack on a narrow phone');
  assert.ok(findAll(tree, 'InvitePoster')[0].props.width <= 320 - 40, 'Poster stays within the narrow screen padding');
  dimensions = { width: 400, fontScale: 1.5 }; render();
  assert.equal(direction(actionContainer()), 'column', 'Large accessibility text receives the same usable stacked actions');
  rejectImage = true;
  button().props.onPress(); await settle();
  assert.equal(findAll(tree, 'Text').filter(node => node.props.accessibilityRole === 'alert').length, 1, 'A failed export/share gives visible retry guidance');
  assert.equal(findAll(findAll(tree, 'ScrollView')[0], 'Text').filter(node => node.props.accessibilityRole === 'alert').length, 0, 'Share errors stay beside the actions even while the poster is scrolled');
  assert.equal(button().props.disabled, false, 'Failure releases the busy state and allows another attempt');
  for (const slot of slots) slot.cleanup?.();
}

const filename = path.resolve(__dirname, '../src/native/invite-share.ts');
const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

function loadAdapter(nativeModules) {
  const entry = new Module(filename, module);
  entry.filename = filename;
  entry.require = (specifier) => {
    assert.equal(specifier, 'react-native');
    return { NativeModules: nativeModules };
  };
  entry._compile(output, filename);
  return entry.exports;
}

(async () => {
  await verifyPoster();
  const calls = [];
  const nativeModules = { DreamKeyInviteShare: {
    async shareImage(...args) { calls.push(args); },
  } };
  const { shareInviteImage } = loadAdapter(nativeModules);
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB';
  const message = 'Try DreamKey: https://download.example.com/';
  await shareInviteImage({ pngBase64: `data:image/png;base64,${png}`, message, title: 'Invite a friend' });
  assert.deepEqual(calls, [[png, message, 'Invite a friend']], 'The generated image and public invitation reach the native sheet');
  await shareInviteImage({ pngBase64: png, message });
  assert.equal(calls[1][2], 'DreamKey');

  const beforeInvalid = calls.length;
  for (const pngBase64 of ['', 'file:///private/wallet.png', 'data:image/jpeg;base64,AAAA', '%%%']) {
    await assert.rejects(shareInviteImage({ pngBase64, message }), /Invalid invitation image/);
  }
  await assert.rejects(shareInviteImage({ pngBase64: 'A'.repeat(16 * 1024 * 1024 + 1), message }), /Invalid invitation image/);
  assert.equal(calls.length, beforeInvalid, 'Invalid sources cannot invoke the native share sheet');

  const unavailable = loadAdapter({});
  await assert.rejects(unavailable.shareInviteImage({ pngBase64: png, message }), /unavailable/);
  const failure = new Error('No active screen for sharing');
  nativeModules.DreamKeyInviteShare.shareImage = async () => { throw failure; };
  await assert.rejects(shareInviteImage({ pngBase64: png, message }), (error) => error === failure);
  nativeModules.DreamKeyInviteShare.shareImage = async () => undefined;
  assert.equal(await shareInviteImage({ pngBase64: png, message }), undefined, 'A cancelled system sheet is an ordinary no-op');
  console.log('Invitation vector poster, layout readiness, image export and share adapter verified (no system share sheet opened).');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
