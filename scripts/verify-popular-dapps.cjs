/* Offline regressions for the production popular DApps and favicon component. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

function compile(relative, dependencies, globals = {}) {
  const filename = path.join(root, relative);
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module, exports: module.exports, URL, AbortController, TextDecoder, Uint8Array, ArrayBuffer, DataView,
    setTimeout, clearTimeout, encodeURIComponent, decodeURIComponent,
    require(name) {
      if (Object.prototype.hasOwnProperty.call(dependencies, name)) return dependencies[name];
      if (name.endsWith('.png')) return path.resolve(path.dirname(filename), name);
      throw new Error(`Unexpected popular DApp dependency: ${name}`);
    },
    ...globals,
  }, { filename });
  return module.exports;
}

function harness() {
  const slots = [];
  let index = 0, dirty = false, mounted = false, component, props, tree, updatesAfterUnmount = 0;
  const sameDeps = (a, b) => !!a && !!b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const scrolls = [];
  const react = {
    memo: (value) => value,
    useState(initial) {
      const position = index++;
      if (!slots[position]) slots[position] = { kind: 'state', value: typeof initial === 'function' ? initial() : initial };
      const cell = slots[position];
      return [cell.value, (next) => {
        if (!mounted) updatesAfterUnmount += 1;
        const value = typeof next === 'function' ? next(cell.value) : next;
        if (!Object.is(value, cell.value)) { cell.value = value; dirty = true; }
      }];
    },
    useRef(initial) {
      const position = index++;
      if (!slots[position]) slots[position] = { kind: 'ref', value: { current: initial } };
      return slots[position].value;
    },
    useCallback(callback, deps) {
      const position = index++;
      if (!slots[position] || !sameDeps(slots[position].deps, deps)) slots[position] = { kind: 'callback', value: callback, deps };
      return slots[position].value;
    },
    useEffect(effect, deps) {
      const position = index++;
      const previous = slots[position];
      if (!previous || !sameDeps(previous.deps, deps)) slots[position] = { kind: 'effect', deps, effect, cleanup: previous?.cleanup, pending: true };
    },
    createElement(type, config, ...children) {
      const next = { ...(config || {}) };
      if (children.length === 1) next.children = children[0];
      else if (children.length > 1) next.children = children;
      if (type === 'FlatList' && next.ref) next.ref.current = { scrollToIndex: (input) => scrolls.push(input) };
      if (typeof type === 'function') return type(next);
      return { type, props: next };
    },
  };
  const native = {
    ...Object.fromEntries(['Image', 'View', 'Text', 'Pressable', 'FlatList'].map((name) => [name, name])),
    StyleSheet: { create: (value) => value },
  };
  function effects() {
    const pending = slots.filter((slot) => slot.kind === 'effect' && slot.pending);
    pending.forEach((slot) => { slot.pending = false; slot.cleanup?.(); });
    pending.forEach((slot) => { slot.cleanup = slot.effect(); });
  }
  function render() { dirty = false; index = 0; tree = component(props); }
  return {
    react, native, scrolls,
    mount(fn, nextProps) { component = fn; props = nextProps; mounted = true; render(); },
    update(nextProps) { props = { ...props, ...nextProps }; render(); effects(); },
    get tree() { return tree; },
    get updatesAfterUnmount() { return updatesAfterUnmount; },
    async settle() {
      effects();
      for (let pass = 0; pass < 8; pass += 1) { await tick(); if (mounted && dirty) { render(); effects(); } }
    },
    unmount() { slots.filter((slot) => slot.kind === 'effect').forEach((slot) => slot.cleanup?.()); mounted = false; },
  };
}

function findAll(node, type, result = []) {
  if (!node) return result;
  if (Array.isArray(node)) { node.forEach((child) => findAll(child, type, result)); return result; }
  if (node.type === type) result.push(node);
  if (node.props) findAll(node.props.children, type, result);
  return result;
}
function textContent(node) {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textContent).join('');
  return node.props ? textContent(node.props.children) : '';
}

const { POPULAR_DAPPS } = compile('src/ui/dapp/popular-dapps.ts', {});
const { POPULAR_DAPP_LOGOS } = compile('src/ui/dapp/popular-dapp-logos.ts', {});
const expectedIds = ['uniswap', 'pancakeswap', 'aave', 'curve', '1inch', 'compound', 'lido', 'defillama', 'opensea', 'blur', 'ens', 'polymarket', 'sushi', 'gmx', 'yearn', 'pendle', 'morpho', 'cowswap', 'aerodrome', 'velodrome', 'stargate', 'across', 'quickswap', 'dodo', 'kyberswap', 'jumper', 'zerion', 'beefy'];

function bundledAssets() {
  assert.deepEqual(Array.from(POPULAR_DAPPS, (item) => item.id), expectedIds);
  assert.equal(POPULAR_DAPPS[0].url, 'https://app.uniswap.org/');
  assert.equal(POPULAR_DAPPS[1].url, 'https://pancakeswap.finance/');
  assert.deepEqual(Object.keys(POPULAR_DAPP_LOGOS).sort(), [...expectedIds].sort(), 'Every curated shortcut has one bundled logo');
  let bytes = 0;
  for (const item of POPULAR_DAPPS) {
    const filename = POPULAR_DAPP_LOGOS[item.id];
    assert.ok(filename.startsWith(path.join(root, 'src/ui/dapp/logos') + path.sep));
    const png = fs.readFileSync(filename);
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `${item.id}: use a real local PNG`);
    assert.equal(png.readUInt32BE(16), 96, `${item.id}: retain sufficient pixel density for the 32dp icon`);
    assert.equal(png.readUInt32BE(20), 96);
    assert.ok(png.length > 200 && png.length < 30_000, `${item.id}: reasonably sized image`);
    bytes += png.length;
  }
  assert.ok(bytes < 220_000, 'Bundled shortcut icons stay below 220 KB in total');
}

async function shortcutsAndPagination() {
  for (const language of ['zh', 'en']) {
    const h = harness();
    const opened = [];
    const { PopularDappsSection } = compile('src/ui/dapp/PopularDappsSection.tsx', {
      react: h.react, 'react-native': h.native,
      '../../dapp/DappFavicon.js': { DappFavicon: 'DappFavicon' },
      // Curated shortcuts use bundled artwork so opening the DApp tab never
      // starts favicon cache work. Keep the dependency stub for older fixture
      // paths, but assert the rendered native Image below.
      '../../i18n.js': { useI18n: () => ({ language }) },
      './popular-dapps.js': { POPULAR_DAPPS }, './popular-dapp-logos.js': { POPULAR_DAPP_LOGOS },
    });
    h.mount(PopularDappsSection, { onOpen: (url) => opened.push(url) });
    assert.ok(textContent(h.tree).includes(language === 'zh' ? '热门 DApp' : 'Popular DApps'));
    assert.equal(findAll(h.tree, 'FlatList').length, 0);
    const firstButtons = findAll(h.tree, 'Pressable').filter((node) => node.props.accessibilityHint);
    assert.equal(firstButtons.length, 10, 'The first frame already has ten usable shortcuts, before onLayout');
    const rows = findAll(h.tree, 'View').filter((node) => node.props.style?.flexDirection === 'row');
    assert.equal(rows.length, 3, 'Two shortcut rows and the pagination row');
    for (const row of rows.slice(0, 2)) assert.equal(findAll(row, 'Pressable').length, 5, 'Five tappable columns per row');
    firstButtons.forEach((button, index) => {
      assert.equal(button.props.accessibilityLabel, `${language === 'zh' ? '打开' : 'Open'} ${POPULAR_DAPPS[index].name}`);
      button.props.onPress();
    });
    assert.deepEqual(opened, Array.from(POPULAR_DAPPS.slice(0, 10), (item) => item.url));
    const firstIcons = findAll(h.tree, 'Image');
    assert.equal(firstIcons.length, 10);
    firstIcons.forEach((node, index) => {
      assert.equal(node.props.source, POPULAR_DAPP_LOGOS[POPULAR_DAPPS[index].id], 'Popular shortcuts use bundled logos');
      assert.equal(node.props.fadeDuration, 0, 'Bundled shortcut logos render without a fade');
    });
    const layout = findAll(h.tree, 'View').find((node) => node.props.onLayout);
    layout.props.onLayout({ nativeEvent: { layout: { width: 320 } } });
    await h.settle();
    let list = findAll(h.tree, 'FlatList')[0];
    assert.equal(list.props.horizontal, true);
    assert.equal(list.props.pagingEnabled, true);
    assert.equal(list.props.data.length, 3);
    assert.deepEqual(JSON.parse(JSON.stringify(list.props.getItemLayout(null, 2))), { length: 320, offset: 640, index: 2 });
    const allPageUrls = [];
    for (const page of list.props.data) {
      const tree = list.props.renderItem({ item: page });
      assert.equal(findAll(tree, 'Image').length, page.length);
      findAll(tree, 'Pressable').forEach((button) => allPageUrls.push(button.props.accessibilityHint));
    }
    assert.deepEqual(allPageUrls, Array.from(POPULAR_DAPPS, (item) => item.url), 'Paging preserves every shortcut and curated ordering');
    const pageLabel = (number) => language === 'zh' ? `第 ${number} 页，共 3 页` : `Page ${number} of 3`;
    const thirdPage = findAll(h.tree, 'Pressable').find((node) => node.props.accessibilityLabel === pageLabel(3));
    thirdPage.props.onPress();
    await h.settle();
    assert.deepEqual(JSON.parse(JSON.stringify(h.scrolls)), [{ index: 2, animated: true }]);
    assert.equal(findAll(h.tree, 'Pressable').find((node) => node.props.accessibilityLabel === pageLabel(3)).props.accessibilityState.selected, true);
    list = findAll(h.tree, 'FlatList')[0];
    list.props.onMomentumScrollEnd({ nativeEvent: { contentOffset: { x: 320 }, layoutMeasurement: { width: 320 } } });
    await h.settle();
    assert.equal(findAll(h.tree, 'Pressable').find((node) => node.props.accessibilityLabel === pageLabel(2)).props.accessibilityState.selected, true, 'Swiping updates the accessible page selection');
    h.unmount();
  }
}

// Load the real native-storage adapter, cache, and favicon component in one module graph.
function faviconFixture(options = {}) {
  const h = harness();
  const disk = options.disk ?? new Map();
  const calls = [], reads = [];
  const modules = new Map();
  let fetchImpl = () => { throw new Error('Unexpected background icon download'); };
  const native = {
    ...h.native,
    NativeModules: { DreamKeyFaviconCache: {
      async read(origin) { reads.push(origin); return options.read ? options.read(origin) : disk.get(origin) ?? null; },
      async write(origin, raw) { disk.set(origin, raw); return true; },
    } },
    Image: Object.assign(function Image() { return { type: 'Image', props: arguments[0] }; }, {
      getSize(_uri, success) { success(96, 96); },
    }),
  };
  function load(relative) {
    relative = path.normalize(relative);
    if (modules.has(relative)) return modules.get(relative);
    const dependencies = {
      react: h.react, 'react-native': native,
      'react-native-svg': { SvgXml: 'SvgXml' },
      '../ui/icons.js': { Globe: 'Globe' },
      '../ui/theme.js': { walletColors: { textSecondary: '#aaa' } },
    };
    const imports = fs.readFileSync(path.join(root, relative), 'utf8').matchAll(/from ['"]([^'"]+)['"]/g);
    for (const match of imports) if (match[1].startsWith('.') && !(match[1] in dependencies)) {
      dependencies[match[1]] = load(path.relative(root, path.resolve(root, path.dirname(relative), match[1].replace(/\.js$/, '.ts'))));
    }
    const result = compile(relative, dependencies, {
      async fetch(url, init) { calls.push({ url, init }); return fetchImpl(url, init); },
      // Cache scheduling itself is exercised with a deterministic frame clock
      // in verify-favicon-cache; advance its frame delay in this hook fixture.
      setTimeout(callback, delay) { return delay === 16 ? { frame: setImmediate(callback) } : { timer: setTimeout(callback, delay) }; },
      clearTimeout(handle) { if (handle.frame) clearImmediate(handle.frame); else clearTimeout(handle.timer); },
    });
    modules.set(relative, result);
    return result;
  }
  return { h, disk, calls, reads, cache: load('src/dapp/favicon-cache.ts'), Component: load('src/dapp/DappFavicon.tsx').DappFavicon,
    setFetch(value) { fetchImpl = value; } };
}
const originA = 'https://example.com';
const originB = 'https://other.example';
const savedImage = { uri: 'data:image/png;base64,iVBORw0KGgo=' };
function record(origin, image = savedImage) { return JSON.stringify({ version: 1, origin, iconUrl: `${origin}/favicon.ico`, image }); }
function visibleImage(h) { return findAll(h.tree, 'Image')[0]?.props.source; }

async function cacheOnlyIcons() {
  const fallbackSource = POPULAR_DAPP_LOGOS.uniswap;
  const empty = faviconFixture();
  empty.h.mount(empty.Component, { pageUrl: `${originA}/app`, fallbackSource, cacheOnly: true });
  assert.equal(visibleImage(empty.h), fallbackSource, 'First paint uses the bundled logo before disk or effects');
  await empty.h.settle();
  assert.equal(visibleImage(empty.h), fallbackSource);
  assert.equal(empty.calls.length, 0, 'A cache miss in the actual cacheOnly component remains offline');
  assert.equal(empty.reads.length, 1);

  const restored = faviconFixture({ disk: new Map([[originA, record(originA)]]) });
  restored.h.mount(restored.Component, { pageUrl: `${originA}/app`, fallbackSource, cacheOnly: true });
  assert.equal(visibleImage(restored.h), fallbackSource, 'Disk restoration does not delay the bundled first paint');
  await restored.h.settle();
  assert.equal(visibleImage(restored.h).uri, savedImage.uri, 'Persisted visit bytes replace the bundled default');
  assert.equal(restored.calls.length, 0);

  const warm = faviconFixture({ disk: new Map([[originA, record(originA)]]) });
  await warm.cache.loadCachedDappFavicon(originA);
  warm.h.mount(warm.Component, { pageUrl: `${originA}/another`, fallbackSource, cacheOnly: true });
  assert.equal(visibleImage(warm.h).uri, savedImage.uri, 'A warm visited icon is available on the first frame');
  await warm.h.settle();
  assert.equal(visibleImage(warm.h).uri, savedImage.uri, 'A memory-cached visited icon replaces the fallback without networking');
  assert.equal(warm.calls.length, 0);

  const bytes = fs.readFileSync(POPULAR_DAPP_LOGOS.uniswap);
  empty.setFetch((url) => ({ ok: true, url, headers: { get: () => String(bytes.length) }, async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); } }));
  const refreshed = await empty.cache.refreshDappFavicon(`${originA}/visited`, `${originA}/updated.png`);
  await empty.h.settle();
  assert.equal(empty.calls.length, 1, 'Only an explicit visit refresh starts a download');
  assert.equal(empty.cache.getCachedDappFavicon(`${originA}/visited`).uri, refreshed.uri, 'An actual visit updates the shared favicon cache');
  assert.equal(empty.calls[0].init.headers['Cache-Control'], 'no-cache');
  const refreshedComponent = faviconFixture({ disk: empty.disk });
  refreshedComponent.h.mount(refreshedComponent.Component, { pageUrl: `${originA}/after-refresh`, fallbackSource, cacheOnly: true });
  await refreshedComponent.h.settle();
  assert.equal(visibleImage(refreshedComponent.h).uri, refreshed.uri, 'A later cache-only consumer uses the visited icon without networking');
  const restoredImage = findAll(refreshedComponent.h.tree, 'Image')[0];
  assert.equal(typeof restoredImage.props.onError, 'function');
  restoredImage.props.onError();
  await refreshedComponent.h.settle();
  assert.equal(visibleImage(refreshedComponent.h), fallbackSource, 'An image rendering error falls back to the bundled brand icon');
  empty.h.unmount();
  refreshedComponent.h.unmount();
  await empty.cache.refreshDappFavicon(originA, `${originA}/after-unmount.png`);
  await empty.h.settle();
  assert.equal(empty.h.updatesAfterUnmount, 0, 'Visit subscriptions detach on unmount');

  const broken = faviconFixture({ disk: new Map([[originA, '{corrupted cache']]) });
  broken.h.mount(broken.Component, { pageUrl: originA, fallbackSource, cacheOnly: true });
  await broken.h.settle();
  assert.equal(visibleImage(broken.h), fallbackSource);
  assert.equal(broken.calls.length, 0, 'A corrupt disk entry must not cause background downloads');

  const pendingUnmount = deferred();
  const detached = faviconFixture({ read: () => pendingUnmount.promise });
  detached.h.mount(detached.Component, { pageUrl: originA, fallbackSource, cacheOnly: true });
  await detached.h.settle();
  detached.h.unmount();
  pendingUnmount.resolve(record(originA));
  await detached.h.settle();
  assert.equal(detached.h.updatesAfterUnmount, 0, 'A delayed disk read cannot update an unmounted favicon');

  const pendingA = deferred();
  const changed = faviconFixture({ read: (origin) => origin === originA ? pendingA.promise : record(originB) });
  changed.h.mount(changed.Component, { pageUrl: originA, fallbackSource, cacheOnly: true });
  await changed.h.settle();
  changed.h.update({ pageUrl: originB });
  await changed.h.settle();
  assert.equal(visibleImage(changed.h).uri, savedImage.uri);
  const oldImage = { uri: 'data:image/png;base64,iVBORw0KGgoBAA==' };
  pendingA.resolve(record(originA, oldImage));
  await changed.h.settle();
  assert.equal(visibleImage(changed.h).uri, savedImage.uri, 'An old page disk request cannot replace the new page icon');
  assert.equal(changed.calls.length, 0);
  for (const item of [restored, warm, broken, changed]) item.h.unmount();
}

async function main() {
  bundledAssets();
  await shortcutsAndPagination();
  await cacheOnlyIcons();
  console.log(`Popular DApp regressions passed: ${POPULAR_DAPPS.length} bundled PNGs, immediate 2x5 shortcuts, localized paging, offline cache-only icons, visit refresh and lifecycle isolation.`);
}
main().catch((error) => { console.error(error); process.exitCode = 1; });

