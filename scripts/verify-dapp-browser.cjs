/*
 * Regression checks for the actual DApp browser component.
 *
 * This is deliberately a small React/native harness rather than a second
 * implementation of the browser. It mounts the transpiled component, invokes
 * the callbacks passed to the real WebView, and inspects the resulting tree.
 * No network, native device, wallet secret, or signing operation is used.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};

function createHarness() {
  const slots = [];
  let index = 0;
  let dirty = false;
  let mounted = false;
  let component;
  let props;
  let output;
  let rerenders = 0;

  const sameDeps = (a, b) => !!a && !!b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const react = {
    useState(initial) {
      const position = index++;
      if (!slots[position]) slots[position] = { kind: 'state', value: typeof initial === 'function' ? initial() : initial };
      const cell = slots[position];
      return [cell.value, (next) => {
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
    useMemo(factory, deps) {
      const position = index++;
      if (!slots[position] || !sameDeps(slots[position].deps, deps)) slots[position] = { kind: 'memo', value: factory(), deps };
      return slots[position].value;
    },
    useEffect(effect, deps) {
      const position = index++;
      const previous = slots[position];
      if (!previous || !sameDeps(previous.deps, deps)) {
        slots[position] = { kind: 'effect', deps, effect, cleanup: previous?.cleanup, pending: true };
      }
    },
    useImperativeHandle(ref, create, deps) {
      const position = index++;
      if (!slots[position] || !sameDeps(slots[position].deps, deps)) {
        slots[position] = { kind: 'imperative', deps };
        ref.current = create();
      }
    },
    forwardRef(render) {
      return (nextProps, ref) => render(nextProps, ref);
    },
    createElement(type, config, ...children) {
      const next = { ...(config || {}) };
      if (children.length === 1) next.children = children[0];
      else if (children.length > 1) next.children = children;
      // A real React renderer assigns the WebView ref. Do that in the mock so
      // provider responses and reloads exercise the component's ref path.
      if (type === native.WebView && next.ref && typeof next.ref === 'object') next.ref.current = fakeWebView;
      delete next.ref;
      if (typeof type === 'function' && !Object.values(native).includes(type)) return type(next);
      return { type, props: next };
    },
  };

  const native = {
    View: function View() {},
    Text: function Text() {},
    Pressable: function Pressable() {},
    ScrollView: function ScrollView() {},
    ActivityIndicator: function ActivityIndicator() {},
    WebView: function WebView() {},
    StyleSheet: { create: (value) => value, hairlineWidth: 1, absoluteFillObject: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 } },
  };
  const fakeWebView = {
    injected: [],
    reloads: 0,
    backCalls: 0,
    forwardCalls: 0,
    goBack() { this.backCalls += 1; },
    goForward() { this.forwardCalls += 1; },
    reload() { this.reloads += 1; },
    injectJavaScript(code) { this.injected.push(String(code)); },
  };

  function render() {
    dirty = false;
    index = 0;
    output = component(props, {});
    rerenders += 1;
    const pending = slots.filter((slot) => slot.kind === 'effect' && slot.pending);
    pending.forEach((slot) => { slot.pending = false; slot.cleanup?.(); });
    pending.forEach((slot) => { slot.cleanup = slot.effect(); });
  }
  return {
    react, native, fakeWebView,
    mount(fn, nextProps) { component = fn; props = nextProps; mounted = true; render(); },
    update(nextProps) { assert.equal(mounted, true); props = nextProps; render(); },
    get tree() { return output; },
    get ref() { return this._ref; },
    set ref(value) { this._ref = value; },
    async settle() {
      for (let pass = 0; pass < 20; pass += 1) {
        await tick();
        if (!dirty) continue;
        if (mounted) render();
      }
    },
    unmount() {
      slots.filter((slot) => slot.kind === 'effect').forEach((slot) => slot.cleanup?.());
      mounted = false;
    },
    get rerenders() { return rerenders; },
  };
}

function compile(relative, dependencies, globals = {}) {
  const source = fs.readFileSync(path.join(root, relative), 'utf8');
  const code = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.React,
      esModuleInterop: true,
    },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module,
    exports: module.exports,
    require: (name) => Object.prototype.hasOwnProperty.call(dependencies, name) ? dependencies[name] : require(name),
    URL,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    console,
    ...globals,
  }, { filename: relative });
  return module.exports;
}

function textContent(node) {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textContent).join('');
  if (node && node.props) return textContent(node.props.children);
  return '';
}

function findAll(node, type, result = []) {
  if (!node) return result;
  if (Array.isArray(node)) { node.forEach((child) => findAll(child, type, result)); return result; }
  if (node.type === type) result.push(node);
  if (node.props) findAll(node.props.children, type, result);
  return result;
}

function nativeNavigation(url, overrides = {}) {
  return { url, title: 'Fixture', loading: false, canGoBack: false, canGoForward: false, ...overrides };
}

function syntheticError(url, code, description, navigation = {}) {
  let prevented = false;
  return {
    nativeEvent: { ...nativeNavigation(url, navigation), code, description },
    persist() {},
    preventDefault() { prevented = true; },
    isDefaultPrevented() { return prevented; },
  };
}

function syntheticHttp(url, statusCode, description = '') {
  return { nativeEvent: { ...nativeNavigation(url), statusCode, description } };
}

function loadBrowser(harness) {
  const providerBridge = compile('src/dapp/providerBridge.ts', {}, { window: {} });
  const urlPolicy = compile('src/dapp/urlPolicy.ts', {});
  const svg = { default: 'Svg', Circle: 'Circle', Line: 'Line', Path: 'Path', Rect: 'Rect' };
  svg.__esModule = true;
  const errorPage = compile('src/dapp/DappErrorPage.tsx', {
    react: harness.react,
    'react-native': harness.native,
    'react-native-svg': svg,
  });
  const module = compile('src/dapp/DappBrowser.tsx', {
    react: harness.react,
    'react-native': harness.native,
    'react-native-webview': { WebView: harness.native.WebView },
    './providerBridge.js': providerBridge,
    './urlPolicy.js': urlPolicy,
    './DappErrorPage.js': errorPage,
    '../ui/icons.js': new Proxy({}, { get: (_target, name) => function Icon() { return { type: `icon:${String(name)}`, props: {} }; } }),
  });
  return module.DappBrowser;
}

function loadToolbar(harness) {
  const icons = new Proxy({}, { get: (_target, name) => function Icon() { return { type: `icon:${String(name)}`, props: {} }; } });
  const module = compile('src/ui/DappBrowserToolbar.tsx', {
    react: harness.react,
    'react-native': harness.native,
    '../i18n.js': { useI18n: () => ({ t: (key) => ({ browserBack: '网页后退', browserForward: '网页前进', browserReload: '刷新网页', browserClose: '关闭网页', loading: '加载中' }[key] || key) }) },
    './icons.js': icons,
    './theme.js': { walletColors: { ink: '#fff', textSecondary: '#aaa', primary: '#7b61ff', surface: '#19233d', surfaceMuted: '#202d4d', border: '#2d3a5b' } },
  });
  return module;
}

function toolbarLayoutAndCloseButton() {
  const harness = createHarness();
  const toolbar = loadToolbar(harness);
  const navigation = { url: 'https://example.invalid/', title: '', loading: false, canGoBack: true, canGoForward: false };
  const calls = { back: 0, forward: 0, reload: 0, close: 0 };
  const tree = toolbar.DappBrowserToolbar({ navigation, onGoBack: () => { calls.back += 1; }, onGoForward: () => { calls.forward += 1; }, onReload: () => { calls.reload += 1; } });
  const toolbarView = tree;
  assert.equal(toolbarView.props.style.borderTopWidth, harness.native.StyleSheet.hairlineWidth, 'history toolbar belongs below the page');
  const toolbarButtons = findAll(toolbarView, harness.native.Pressable);
  assert.equal(toolbarButtons.length, 3, 'bottom toolbar only contains back, forward, and reload');
  assert.equal(toolbarButtons[0].props.disabled, false, 'back is available when native history allows it');
  assert.equal(toolbarButtons[1].props.disabled, true, 'forward is disabled without native forward history');
  toolbarButtons[0].props.onPress();
  toolbarButtons[2].props.onPress();
  assert.deepEqual(calls, { back: 1, forward: 0, reload: 1, close: 0 });
  const loadingTree = toolbar.DappBrowserToolbar({ navigation: { ...navigation, loading: true, canGoForward: true }, onGoBack: () => {}, onGoForward: () => { calls.forward += 1; }, onReload: () => {} });
  const forwardButton = findAll(loadingTree, harness.native.Pressable)[1];
  assert.equal(forwardButton.props.disabled, false, 'forward updates from native history state');
  forwardButton.props.onPress();
  assert.equal(calls.forward, 1);
  assert.equal(findAll(loadingTree, harness.native.ActivityIndicator).length, 1, 'toolbar preserves load progress feedback');
  const close = toolbar.DappBrowserCloseButton({ onClose: () => { calls.close += 1; } });
  assert.equal(close.type, harness.native.Pressable, 'close control is a separate top bar button');
  assert.equal(close.props.accessibilityLabel, '关闭网页');
  close.props.onPress();
  assert.equal(calls.close, 1);
}

function commonProps(overrides = {}) {
  return {
    initialUrl: 'https://example-a.invalid/',
    language: 'zh',
    onBack() {},
    onEditUrl() {},
    onLoadError() {},
    onPageLoaded() {},
    ...overrides,
  };
}

async function errorViewIsFriendly() {
  const harness = createHarness();
  const DappBrowser = loadBrowser(harness);
  harness.mount(DappBrowser, commonProps());
  let webviews = findAll(harness.tree, harness.native.WebView);
  assert.equal(webviews.length, 1);
  assert.equal(typeof webviews[0].props.renderError, 'function', 'native default error renderer must be overridden');
  const nativeFallback = webviews[0].props.renderError(undefined, -6, 'net::ERR_CONNECTION_CLOSED');
  const fallbackText = textContent(nativeFallback);
  assert.match(fallbackText, /暂时无法|网站|重新加载/, 'fallback must be friendly Chinese copy');
  assert.doesNotMatch(fallbackText, /Error loading page|Domain: undefined|net::ERR_CONNECTION_CLOSED/);

  webviews[0].props.onError(syntheticError('https://example-a.invalid/', -6, 'net::ERR_CONNECTION_CLOSED'));
  await harness.settle();
  assert.match(textContent(harness.tree), /网页暂时打不开|网站暂时不可用|重新加载/);
  assert.doesNotMatch(textContent(harness.tree), /Domain: undefined|Error loading page/);

  // HTTP errors are followed by onLoad/onLoadingFinish on Android/iOS. They
  // must stay visible until the user explicitly starts a new navigation.
  harness.update(commonProps({ initialUrl: 'https://http-fixture.invalid/' }));
  await harness.settle();
  webviews = findAll(harness.tree, harness.native.WebView);
  const failedWebView = webviews[0];
  failedWebView.props.onHttpError(syntheticHttp('https://http-fixture.invalid/', 503, 'Service Unavailable'));
  await harness.settle();
  failedWebView.props.onLoad({ nativeEvent: { url: 'https://http-fixture.invalid/' } });
  await harness.settle();
  assert.match(textContent(harness.tree), /503|无法响应|暂时/, 'HTTP error must survive onLoad');
  harness.unmount();
}

async function failedRedirectRetryAndSwitch() {
  const harness = createHarness();
  const DappBrowser = loadBrowser(harness);
  const ref = {};
  harness.mount((props) => DappBrowser(props, ref), commonProps());
  let webview = findAll(harness.tree, harness.native.WebView)[0];
  const b = 'https://example-b.invalid/app';
  webview.props.onNavigationStateChange(nativeNavigation(b));
  webview.props.onError(syntheticError(b, -2, 'net::ERR_NAME_NOT_RESOLVED'));
  await harness.settle();
  assert.doesNotMatch(textContent(harness.tree), /Domain: undefined|Error loading page/);
  const retry = findAll(harness.tree, harness.native.Pressable).find((node) => textContent(node).includes('重新加载'));
  assert.ok(retry, 'error page exposes an explicit retry action');
  const previousKey = webview.props.key;
  retry.props.onPress();
  await harness.settle();
  webview = findAll(harness.tree, harness.native.WebView)[0];
  assert.ok(webview, 'retry keeps a native WebView');
  assert.equal(webview.props.key, previousKey, 'retry preserves the native history instance');
  assert.equal(harness.fakeWebView.reloads, 1, 'retry reloads the actual failed redirect rather than the original source');

  // An initialUrl switch must clear stale error state and use the new source.
  const c = 'https://example-c.invalid/';
  harness.update(commonProps({ initialUrl: c }));
  await harness.settle();
  webview = findAll(harness.tree, harness.native.WebView)[0];
  assert.ok(webview, 'switching initialUrl restores a WebView');
  assert.equal(webview.props.source.uri, c);
  assert.doesNotMatch(textContent(harness.tree), /无法打开|无法响应|重新加载/);

  // Both imperative paths are useful when the browser address bar submits the
  // same URL after a failure; they must not be no-ops while the error page is up.
  webview.props.onError(syntheticError(c, -6, 'net::ERR_CONNECTION_CLOSED'));
  await harness.settle();
  assert.ok(ref.current, 'imperative browser ref is installed');
  ref.current.reload();
  await harness.settle();
  assert.ok(findAll(harness.tree, harness.native.WebView)[0], 'ref.reload recovers from error state');
  findAll(harness.tree, harness.native.WebView)[0].props.onLoadStart({ nativeEvent: nativeNavigation(c, { loading: true }) });
  findAll(harness.tree, harness.native.WebView)[0].props.onError(syntheticError(c, -6, 'net::ERR_CONNECTION_CLOSED'));
  await harness.settle();
  assert.equal(ref.current.navigate(c), true, 'same-url navigate remains accepted after failure');
  await harness.settle();
  assert.ok(findAll(harness.tree, harness.native.WebView)[0], 'same-url navigate recovers from error state');
  harness.unmount();
}

async function nativeHistoryControlsAndErrorRecovery() {
  const harness = createHarness();
  const DappBrowser = loadBrowser(harness);
  const ref = {};
  const states = [];
  const received = [];
  const a = 'https://example-a.invalid/';
  const b = 'https://example-b.invalid/app';
  harness.mount((props) => DappBrowser(props, ref), commonProps({ onNavigationStateChange: (value) => states.push(value), onProviderRequest: async (request) => { received.push(request); return '0x38'; } }));
  let webview = findAll(harness.tree, harness.native.WebView)[0];
  ref.current.goBack();
  ref.current.goForward();
  assert.equal(harness.fakeWebView.backCalls + harness.fakeWebView.forwardCalls, 0, 'history actions are no-ops when unavailable');
  webview.props.onNavigationStateChange(nativeNavigation(a));
  assert.equal(ref.current.navigate(b), true);
  assert.match(harness.fakeWebView.injected[0], /window.location.href/);
  await harness.settle();
  webview = findAll(harness.tree, harness.native.WebView)[0];
  webview.props.onLoadStart({ nativeEvent: nativeNavigation(b, { loading: true, canGoBack: true }) });
  webview.props.onNavigationStateChange(nativeNavigation(b, { canGoBack: true }));
  const key = webview.props.key;
  webview.props.onError(syntheticError(b, -6, 'net::ERR_CONNECTION_CLOSED', { canGoBack: true }));
  await harness.settle();
  assert.equal(findAll(harness.tree, harness.native.WebView).length, 1, 'friendly failure overlays the existing native WebView');
  assert.equal(findAll(harness.tree, harness.native.WebView)[0].props.key, key);
  assert.equal(states.at(-1).canGoBack, true, 'native error retains previous page history');
  assert.equal(states.at(-1).loading, false);
  ref.current.goBack();
  assert.equal(harness.fakeWebView.backCalls, 1);
  await harness.settle();
  webview = findAll(harness.tree, harness.native.WebView)[0];
  // Same-document history changes need not dispatch a WebView onLoadStart.
  webview.props.onNavigationStateChange(nativeNavigation(a, { canGoForward: true }));
  await harness.settle();
  assert.doesNotMatch(textContent(harness.tree), /网页暂时打不开/);
  assert.equal(states.at(-1).url, a);
  assert.equal(states.at(-1).canGoForward, true);
  assert.equal(states.at(-1).loading, false);
  ref.current.goForward();
  assert.equal(harness.fakeWebView.forwardCalls, 1);
  await harness.settle();
  webview = findAll(harness.tree, harness.native.WebView)[0];
  webview.props.onNavigationStateChange(nativeNavigation(b, { canGoBack: true }));
  const request = JSON.stringify({ type: 'wallet:provider-request', id: 'history-doc', request: { method: 'eth_chainId', params: [] } });
  webview.props.onMessage({ nativeEvent: { data: request, url: b } });
  await harness.settle();
  assert.equal(received.length, 1, 'provider works after history navigation without load-start');
  assert.equal(ref.current.navigate(`${b}#swap`), true);
  await harness.settle();
  webview = findAll(harness.tree, harness.native.WebView)[0];
  webview.props.onNavigationStateChange(nativeNavigation(`${b}#swap`, { canGoBack: true }));
  assert.equal(states.at(-1).loading, false, 'hash navigation completes without a load-start');
  webview.props.onMessage({ nativeEvent: { data: request, url: `${b}#swap` } });
  await harness.settle();
  assert.equal(received.length, 2, 'provider works after address-bar hash navigation');

  webview.props.onError(syntheticError(`${b}#swap`, -2, 'net::ERR_NAME_NOT_RESOLVED', { canGoBack: true }));
  await harness.settle();
  const reloadsBefore = harness.fakeWebView.reloads;
  assert.equal(ref.current.navigate(a), true);
  await harness.settle();
  webview = findAll(harness.tree, harness.native.WebView)[0];
  assert.equal(webview.props.source.uri, a, 'correcting a failure to the original address opens that requested address');
  assert.notEqual(webview.props.key, key, 'corrected address starts a fresh native document when the failed page cannot execute JS');
  assert.equal(harness.fakeWebView.reloads, reloadsBefore, 'corrected address must not reload the failed redirect');
  assert.equal(states.at(-1).canGoBack, false, 'a new instance resets its native history flags');
  harness.unmount();
}

async function oldDocumentProviderPromiseIsIgnored() {
  const harness = createHarness();
  const DappBrowser = loadBrowser(harness);
  const ref = {};
  const pending = deferred();
  const provider = async () => pending.promise;
  harness.mount((props) => DappBrowser(props, ref), commonProps({ onProviderRequest: provider }));
  let webview = findAll(harness.tree, harness.native.WebView)[0];
  const request = JSON.stringify({ type: 'wallet:provider-request', id: 'old-doc', request: { method: 'eth_chainId', params: [] } });
  webview.props.onMessage({ nativeEvent: { data: request, url: 'https://example-a.invalid/' } });
  await tick();
  webview.props.onLoadStart({ nativeEvent: { url: 'https://example-a.invalid/next' } });
  await harness.settle();
  pending.resolve('0x38');
  await harness.settle();
  assert.equal(harness.fakeWebView.injected.filter((entry) => entry.includes('wallet:provider-response')).length, 0, 'old document response must not be injected into a new page');
  harness.unmount();
}

function createBridgePage(script, postMessage) {
  const messages = [];
  const timers = new Map();
  let timerId = 0;
  const listeners = new Map();
  const window = {
    location: { href: 'https://example-a.invalid/' },
    ReactNativeWebView: { postMessage(raw) { messages.push(JSON.parse(raw)); postMessage(raw); } },
    addEventListener(name, callback) {
      const callbacks = listeners.get(name) || [];
      callbacks.push(callback);
      listeners.set(name, callbacks);
    },
    dispatchEvent(event) { (listeners.get(event.type) || []).slice().forEach((callback) => callback(event)); },
  };
  class Event {
    constructor(type, options = {}) { this.type = type; Object.assign(this, options); }
  }
  const context = vm.createContext({
    window, Event, CustomEvent: Event,
    setTimeout(callback) { const id = ++timerId; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  return {
    window, messages,
    install() { vm.runInContext(script, context); },
    run(code) { vm.runInContext(code, context); },
  };
}

function connectBridgePage(harness, webview, nativeUrl) {
  const page = createBridgePage(webview.props.injectedJavaScriptBeforeContentLoaded, (data) => {
    findAll(harness.tree, harness.native.WebView)[0].props.onMessage({ nativeEvent: { data, url: nativeUrl } });
  });
  harness.fakeWebView.injectJavaScript = function (code) {
    this.injected.push(String(code));
    page.run(code);
  };
  return page;
}

async function bridgeHandshakeWaitsForNativeNavigation() {
  const harness = createHarness();
  const DappBrowser = loadBrowser(harness);
  const ref = {};
  const requests = [];
  const url = 'https://example-a.invalid/';
  harness.mount((props) => DappBrowser(props, ref), commonProps({ onProviderRequest: async (request) => {
    requests.push(request.method);
    if (request.method === 'eth_chainId') return '0x38';
    if (request.method === 'eth_accounts') return [];
    return 'fixture-signature';
  } }));
  ref.current.reload();
  const webview = findAll(harness.tree, harness.native.WebView)[0];
  const page = connectBridgePage(harness, webview, url);
  page.install();
  let signatureResult;
  page.window.ethereum.request({ method: 'personal_sign', params: ['0x66697874757265', '0xfixture'] }).then((value) => { signatureResult = value; });
  await harness.settle();
  assert.equal(requests.length, 0, 'early user requests stay in the page until native load-start catches up');
  assert.equal(harness.fakeWebView.injected.length, 0, 'host must not acknowledge a bridge during old-document navigation');
  assert.ok(page.messages.some((message) => message.type === 'wallet:provider-ready'));
  webview.props.onLoadStart({ nativeEvent: nativeNavigation(url, { loading: true }) });
  // The real after-load fallback resumes the same bridge; its retried ready
  // handshake must drain the original queue rather than replacing the provider.
  const provider = page.window.ethereum;
  page.install();
  await harness.settle();
  assert.equal(signatureResult, 'fixture-signature');
  assert.equal(page.window.ethereum, provider);
  assert.equal(page.window.ethereum._initialized, true, 'read-only initialization recovers after an early dropped handshake');
  assert.equal(requests.filter((method) => method === 'personal_sign').length, 1, 'queued signing request is handed to native exactly once');
  page.install();
  await harness.settle();
  assert.equal(requests.filter((method) => method === 'personal_sign').length, 1, 'duplicate injection never replays a completed signature');
  harness.unmount();
}

async function taggedFirstLoadAndSameDocumentResponsesSurvive() {
  const harness = createHarness();
  const DappBrowser = loadBrowser(harness);
  const ref = {};
  const chain = deferred();
  const signature = deferred();
  const url = 'https://example-a.invalid/';
  harness.mount((props) => DappBrowser(props, ref), commonProps({ onProviderRequest: async (request) => {
    if (request.method === 'eth_chainId') return chain.promise;
    if (request.method === 'eth_accounts') return [];
    return signature.promise;
  } }));
  const webview = findAll(harness.tree, harness.native.WebView)[0];
  const page = connectBridgePage(harness, webview, url);
  page.install();
  await tick();
  webview.props.onLoadStart({ nativeEvent: nativeNavigation(url, { loading: true }) });
  chain.resolve('0x38');
  await harness.settle();
  assert.equal(page.window.ethereum._initialized, true, 'same-URL delayed initial load-start must not strand bootstrap responses');
  const result = page.window.ethereum.request({ method: 'personal_sign', params: ['0x66697874757265', '0xfixture'] });
  await tick();
  webview.props.onLoadStart({ nativeEvent: nativeNavigation(`${url}#swap`, { loading: true }) });
  webview.props.onNavigationStateChange(nativeNavigation(`${url}#swap`, { canGoBack: true }));
  // Address-bar hash changes temporarily await a native event even though the
  // actual JS document is unchanged. A tagged reply can safely reach that page.
  ref.current.navigate(`${url}#details`);
  signature.resolve('same-document-signature');
  await harness.settle();
  let resolved;
  result.then((value) => { resolved = value; });
  await tick();
  assert.equal(resolved, 'same-document-signature', 'hash/History API transitions retain a pending signature response');
  webview.props.onNavigationStateChange(nativeNavigation(`${url}#details`, { canGoBack: true }));
  harness.unmount();
}

async function bridgeUsesNativeOriginAndPolicy() {
  const harness = createHarness();
  const DappBrowser = loadBrowser(harness);
  const received = [];
  harness.mount(DappBrowser, commonProps({ allowedHosts: ['example-a.invalid', 'another.allowed.invalid'], onProviderRequest: async (request, context) => {
    received.push({ method: request.method, context });
    return '0x38';
  } }));
  const webview = findAll(harness.tree, harness.native.WebView)[0];
  const ready = { type: 'wallet:provider-ready', documentId: 'native-policy-document', url: 'https://example-a.invalid/' };
  const request = { type: 'wallet:provider-request', documentId: ready.documentId, id: 'native-policy-request', request: { method: 'eth_chainId' }, url: 'https://example-a.invalid/' };
  webview.props.onMessage({ nativeEvent: { data: JSON.stringify(ready), url: 'https://blocked.invalid/' } });
  webview.props.onMessage({ nativeEvent: { data: JSON.stringify(request), url: 'https://blocked.invalid/' } });
  await harness.settle();
  assert.equal(harness.fakeWebView.injected.length, 0, 'a page-supplied allowed URL cannot authorize a blocked native origin handshake');
  assert.equal(received.length, 0, 'blocked native origin requests never reach the wallet');
  webview.props.onMessage({ nativeEvent: { data: JSON.stringify(request), url: 'https://another.allowed.invalid/' } });
  await harness.settle();
  assert.equal(received.length, 0, 'a cross-origin frame is not the active top-level DApp');
  webview.props.onMessage({ nativeEvent: { data: JSON.stringify({ ...ready, url: 'https://forged.invalid/' }), url: 'https://example-a.invalid/native-path' } });
  webview.props.onMessage({ nativeEvent: { data: JSON.stringify({ ...request, url: 'https://forged.invalid/' }), url: 'https://example-a.invalid/native-path' } });
  await harness.settle();
  assert.equal(received.length, 1);
  assert.equal(received[0].context.origin, 'https://example-a.invalid');
  assert.equal(received[0].context.url, 'https://example-a.invalid/native-path');
  assert.ok(harness.fakeWebView.injected.some((code) => code.includes('wallet:provider-ready')));
  harness.unmount();
}

async function crossOriginFrameAndStaleTaggedRepliesAreBlocked() {
  const harness = createHarness();
  const DappBrowser = loadBrowser(harness);
  const pending = deferred();
  const requests = [];
  const firstUrl = 'https://example-a.invalid/';
  const secondUrl = 'https://example-b.invalid/';
  harness.mount(DappBrowser, commonProps({ onProviderRequest: (request, context) => {
    requests.push({ request, context });
    return pending.promise;
  } }));
  const webview = findAll(harness.tree, harness.native.WebView)[0];
  const message = JSON.stringify({ type: 'wallet:provider-request', id: 'fixture', documentId: 'public-document-id', request: { method: 'personal_sign', params: ['hello', '0xfixture'] } });
  // No host allowlist is configured here: the frame check itself must enforce
  // the active origin even when browsing arbitrary public websites.
  webview.props.onMessage({ nativeEvent: { data: message, url: secondUrl } });
  await harness.settle();
  assert.equal(requests.length, 0, 'an allowed cross-origin frame cannot request a top-level signature');
  webview.props.onMessage({ nativeEvent: { data: message, url: firstUrl } });
  await tick();
  assert.equal(requests.length, 1);
  webview.props.onLoadStart({ nativeEvent: nativeNavigation(secondUrl, { loading: true }) });
  webview.props.onNavigationStateChange(nativeNavigation(secondUrl));
  pending.resolve('fixture-signature');
  await harness.settle();
  assert.equal(harness.fakeWebView.injected.filter((code) => code.includes('wallet:provider-response')).length, 0, 'a public document token cannot transfer a signature reply to another origin');
  harness.unmount();
}

async function newDocumentRejectsOldTaggedResponse() {
  const bridge = compile('src/dapp/providerBridge.ts', {});
  const page = createBridgePage(bridge.EIP1193_INJECTED_SCRIPT, () => {});
  page.install();
  const ready = page.messages.find((message) => message.type === 'wallet:provider-ready');
  assert.equal(page.window.__WALLET_PROVIDER_DOCUMENT_ID__, ready.documentId);
  const descriptor = Object.getOwnPropertyDescriptor(page.window, '__WALLET_PROVIDER_DOCUMENT_ID__');
  assert.equal(descriptor.writable, false, 'a website cannot rewrite the installed document identity');
  assert.equal(descriptor.configurable, false, 'a website cannot delete the installed document identity');
  page.run("window.__WALLET_PROVIDER_DOCUMENT_ID__ = 'previous-document'; delete window.__WALLET_PROVIDER_DOCUMENT_ID__;");
  assert.equal(page.window.__WALLET_PROVIDER_DOCUMENT_ID__, ready.documentId);
  page.run(bridge.createProviderReadyScript(ready.documentId));
  let resolved;
  page.window.ethereum.request({ method: 'personal_sign', params: ['0x66697874757265', '0xfixture'] }).then((value) => { resolved = value; });
  const request = page.messages.find((message) => message.type === 'wallet:provider-request' && message.request.method === 'personal_sign');
  page.run(bridge.createProviderResponseScript({ type: 'wallet:provider-response', id: request.id, documentId: `${ready.documentId}-previous`, ok: true, result: 'wrong-document' }));
  await tick();
  assert.equal(resolved, undefined, 'even a matching request id cannot receive a previous JS document response');
  page.run(bridge.createProviderResponseScript({ type: 'wallet:provider-response', id: request.id, documentId: ready.documentId, ok: true, result: 'current-document' }));
  await tick();
  assert.equal(resolved, 'current-document');
  // A replacement website owns its JS globals. It must not be able to collect
  // an old approved signature simply by replacing the injected receive hook.
  let intercepted = 0;
  const replacementWindow = {
    __WALLET_PROVIDER_DOCUMENT_ID__: 'replacement-document',
    __walletHandleProviderResponse() { intercepted += 1; },
  };
  vm.runInNewContext(bridge.createProviderResponseScript({ type: 'wallet:provider-response', id: request.id, documentId: ready.documentId, ok: true, result: 'old-signature' }), { window: replacementWindow });
  assert.equal(intercepted, 0, 'token mismatch is checked before invoking a website-controlled response hook');
}

async function taggedRepliesRespectAttemptErrorAndUnmount() {
  for (const transition of ['attempt', 'error', 'unmount']) {
    const harness = createHarness();
    const DappBrowser = loadBrowser(harness);
    const pending = deferred();
    const url = 'https://example-a.invalid/';
    harness.mount(DappBrowser, commonProps({ onProviderRequest: () => pending.promise }));
    const webview = findAll(harness.tree, harness.native.WebView)[0];
    webview.props.onMessage({ nativeEvent: { url, data: JSON.stringify({ type: 'wallet:provider-request', id: `${transition}-request`, documentId: `${transition}-document`, request: { method: 'personal_sign', params: ['0x66697874757265', '0xfixture'] } }) } });
    await tick();
    if (transition === 'attempt') {
      harness.update(commonProps({ initialUrl: 'https://example-b.invalid/', onProviderRequest: () => pending.promise }));
      await harness.settle();
    } else if (transition === 'error') {
      webview.props.onError(syntheticError(url, -6, 'net::ERR_CONNECTION_CLOSED'));
      await harness.settle();
    } else harness.unmount();
    pending.resolve('fixture-signature');
    await harness.settle();
    assert.equal(harness.fakeWebView.injected.filter((code) => code.includes('wallet:provider-response')).length, 0, `${transition} suppresses a stale tagged confirmation reply`);
    if (transition !== 'unmount') harness.unmount();
  }
}

async function pageMetadataKeepsDeclaredFaviconQuery() {
  const harness = createHarness();
  const DappBrowser = loadBrowser(harness);
  const metadata = [];
  const url = 'https://example.com/';
  harness.mount(DappBrowser, commonProps({ initialUrl: url, onPageMetadata: (value) => metadata.push(value) }));
  const webview = findAll(harness.tree, harness.native.WebView)[0];
  webview.props.onLoad({ nativeEvent: nativeNavigation(url) });
  assert.ok(harness.fakeWebView.injected.some((code) => code.includes('wallet:page-metadata')), 'loaded documents are asked for their declared icon');
  const report = (value, nativeUrl = url) => webview.props.onMessage({ nativeEvent: { url: nativeUrl, data: JSON.stringify({ type: 'wallet:page-metadata', url, ...value }) } });
  report({ title: 'Dream Farmer', faviconUrl: './favicon.ico?v=1' });
  assert.equal(metadata.length, 1);
  assert.equal(metadata[0].url, url, 'the native URL remains authoritative');
  assert.equal(metadata[0].faviconUrl, 'https://example.com/favicon.ico?v=1', 'relative icons retain cache-busting query strings');
  report({ url: 'https://previous.invalid/', faviconUrl: 'https://previous.invalid/favicon.ico' });
  assert.equal(metadata.length, 1, 'late old-document metadata is ignored');
  report({ faviconUrl: 'javascript:alert(1)' });
  assert.equal(metadata.at(-1).faviconUrl, undefined, 'executable icon URLs use the safe origin fallback');
  harness.unmount();
}

async function main() {
  toolbarLayoutAndCloseButton();
  await errorViewIsFriendly();
  await failedRedirectRetryAndSwitch();
  await nativeHistoryControlsAndErrorRecovery();
  await oldDocumentProviderPromiseIsIgnored();
  await bridgeHandshakeWaitsForNativeNavigation();
  await taggedFirstLoadAndSameDocumentResponsesSurvive();
  await bridgeUsesNativeOriginAndPolicy();
  await crossOriginFrameAndStaleTaggedRepliesAreBlocked();
  await newDocumentRejectsOldTaggedResponse();
  await taggedRepliesRespectAttemptErrorAndUnmount();
  await pageMetadataKeepsDeclaredFaviconQuery();
  console.log('DApp browser verification passed: friendly errors, native history, first-load bridge handshake, queued signing without replay, native-origin authorization, and document/attempt-isolated responses.');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });

