/* Exercise the production update provider offline with fake React/native surfaces and clocks. */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const ROOT = path.resolve(__dirname, '..');

function compile(relative, dependencies = {}, globals = {}) {
  const output = ts.transpileModule(fs.readFileSync(path.join(ROOT, relative), 'utf8'), {
    compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true},
  }).outputText;
  const module = {exports: {}};
  vm.runInNewContext(output, {
    module, exports: module.exports, console, Object, JSON, URL, AbortController,
    require(name) {
      assert.ok(Object.hasOwn(dependencies, name), `Unexpected update UI dependency: ${name}`);
      return dependencies[name];
    },
    ...globals,
  }, {filename: relative});
  return module.exports;
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}

function textContent(node) {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textContent).join('');
  return textContent(node.props?.children);
}

function findAll(node, type, result = []) {
  if (!node) return result;
  if (Array.isArray(node)) { node.forEach(child => findAll(child, type, result)); return result; }
  if (node.type === type) result.push(node);
  if (node.props) findAll(node.props.children, type, result);
  return result;
}

const JSON_FIXTURE = Object.freeze({
  appVersion: '1.0.6', bundleVersion: 5, mandatory: false, description: '1. 提升体验\n2. 修复问题',
  downloadAndroidUrlApk: 'https://updates.example.com/app-1.0.6.apk',
  downloadAndroidUrlBundle: 'https://updates.example.com/v5/index.android.bundle.zip',
  downloadIosUrlApk: 'https://apps.apple.com/app/id123456789', downloadIosUrlBundle: '',
});

function harness(options = {}) {
  const slots = [];
  const effects = [];
  const timers = new Map();
  const listeners = new Set();
  const visibilityListeners = new Set();
  let cursor = 0, dirty = false, tree, now = 0, timerSequence = 0, disposed = false;
  let rendering = false, visibility = options.visibility || 'foreground';
  let props = {children: 'Wallet fixture', navigationReady: false, safeToPrompt: true, ...options.props};
  let progressListener;
  const state = {appVersion: '1.0.6', bundleVersion: 0, pendingBundleVersion: 0, highestBundleVersion: 0,
    failedBundleVersion: 0, rollback: false, supported: true, apkReady: false, apkVersion: '', ...options.state};
  const config = {UPDATE_JSON_URL: 'https://updates.example.com/update.json', UPDATE_DOWNLOAD_HOSTS: ['updates.example.com'], UPDATE_IOS_STORE_HOSTS: ['apps.apple.com'], ...options.config};
  const calls = {fetch: 0, state: 0, download: 0, install: 0, stage: 0, confirm: 0, ack: 0, links: [], reload: 0};
  const api = {manifest: {...JSON_FIXTURE, ...options.manifest}, fetchError: null, fetchDeferred: null, bodyDeferred: null, downloadDeferred: null, confirmDeferred: null, stageError: null, installError: null,
    confirmFailures: options.confirmFailures || 0, stageRequiresConfirmation: options.stageRequiresConfirmation || false};
  const same = (left, right) => left && right && left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
  const react = {
    createContext: () => ({Provider: 'UpdateContextProvider'}),
    useState(initial) {
      const index = cursor++;
      if (!slots[index]) slots[index] = {value: typeof initial === 'function' ? initial() : initial};
      const slot = slots[index];
      return [slot.value, next => {
        const value = typeof next === 'function' ? next(slot.value) : next;
        if (!Object.is(value, slot.value)) {
          slot.value = value; dirty = true;
          // Android's legacy renderer commits Promise continuation updates
          // immediately and flushes the prior commit's passive effects before
          // the next update. Batching everything until setImmediate hid races.
          if (options.syncRender && tree && !rendering) render();
        }
      }];
    },
    useRef(initial) { const index = cursor++; if (!slots[index]) slots[index] = {current: initial}; return slots[index]; },
    useMemo(factory, deps) {
      const index = cursor++;
      if (!slots[index] || !same(slots[index].deps, deps)) slots[index] = {value: factory(), deps};
      return slots[index].value;
    },
    useEffect(effect, deps) {
      const index = cursor++;
      if (!slots[index] || !same(slots[index].deps, deps)) {
        const previous = slots[index];
        const slot = slots[index] = {deps, cleanup: previous?.cleanup};
        effects.push(() => { slot.cleanup?.(); slot.cleanup = effect(); });
      }
    },
    createElement: (type, config, ...children) => ({type, props: {...config, children}}),
  };
  react.useCallback = (callback, deps) => react.useMemo(() => callback, deps);
  react.useContext = () => { throw new Error('Unexpected consumer render in provider fixture'); };
  const clock = {
    setTimeout(callback, delay = 0) { const id = ++timerSequence; timers.set(id, {callback, due: now + delay}); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  const appState = {
    currentState: 'active',
    addEventListener(event, callback) { assert.equal(event, 'change'); listeners.add(callback); return {remove: () => listeners.delete(callback)}; },
  };
  const native = {
    async getState() { calls.state++; return {...state}; },
    async downloadApk(url, version) {
      calls.download++; assert.equal(url, api.manifest.downloadAndroidUrlApk); assert.equal(version, api.manifest.appVersion);
      if (api.downloadDeferred) await api.downloadDeferred.promise;
      state.apkReady = true; state.apkVersion = version;
    },
    async installApk() { calls.install++; if (api.installError) throw api.installError; },
    async stageBundle(url, version, patch) {
      calls.stage++; assert.equal(url, api.manifest.downloadAndroidUrlBundle); assert.equal(version, api.manifest.appVersion); assert.equal(patch, api.manifest.bundleVersion);
      if (api.stageError) throw api.stageError;
      if (api.stageRequiresConfirmation && calls.confirm === 0) throw {code: 'E_UPDATE_BUSY'};
      state.pendingBundleVersion = patch; state.highestBundleVersion = patch;
    },
    async markLaunchSuccessful() {
      calls.confirm++;
      if (api.confirmDeferred) await api.confirmDeferred.promise;
      if (api.confirmFailures > 0) { api.confirmFailures--; throw new Error('temporary confirmation failure'); }
    },
    async acknowledgeRollback() { calls.ack++; state.rollback = false; },
    subscribe(callback) { progressListener = callback; return () => { progressListener = undefined; }; },
  };
  const reactNative = {
    ...Object.fromEntries(['ActivityIndicator', 'Pressable', 'ScrollView', 'Text', 'View'].map(name => [name, name])),
    StyleSheet: {create: value => value}, Platform: {OS: options.platform || 'android'}, AppState: appState,
    Linking: {async openURL(url) { calls.links.push(url); }},
    DevSettings: {reload() { calls.reload++; throw new Error('OTA must not reload a running wallet'); }},
  };
  const globals = {
    ...clock,
    Date: class extends Date { static now() { return now; } },
    async fetch(url, request) {
      calls.fetch++;
      assert.equal(new URL(url).origin, 'https://updates.example.com');
      assert.equal(request.method, 'GET');
      if (api.fetchDeferred) await api.fetchDeferred.promise;
      if (api.fetchError) throw api.fetchError;
      return {ok: true, url, headers: {get: () => null}, async text() { if (api.bodyDeferred) await api.bodyDeferred.promise; return JSON.stringify(api.manifest); }};
    },
  };
  const policy = compile('src/updates/update-policy.ts', {}, globals);
  const checker = compile('src/updates/check-update.ts', {'./update-policy.js': policy}, globals);
  const {UpdateProvider} = compile('src/updates/UpdateProvider.tsx', {
    react, 'react-native': reactNative, '../config/app-updates.js': config,
    '../native/app-updates.js': {appUpdates: native}, '../i18n.js': {useI18n: () => ({language: 'zh'})},
    '../native/app-visibility.js': {subscribeAppVisibility(callback) {
      visibilityListeners.add(callback); callback(visibility);
      return () => visibilityListeners.delete(callback);
    }},
    '../ui/SecureModal.js': {SecureModal: 'SecureModal'}, '../ui/icons.js': {ArrowDownLeft: 'ArrowDownLeft', ShieldCheck: 'ShieldCheck'},
    '../ui/appStyles.js': {colors: {}}, './check-update.js': checker, './update-policy.js': policy,
  }, globals);
  function render() {
    assert.equal(disposed, false);
    assert.equal(rendering, false, 'Hook fixture must not recursively render during a commit');
    rendering = true;
    try {
      do {
        cursor = 0; dirty = false; tree = UpdateProvider(props);
        while (effects.length) effects.shift()();
      } while (options.syncRender && dirty);
    } finally { rendering = false; }
  }
  render();
  const result = {
    calls, api, state,
    get timerCount() { return timers.size; },
    get modal() { return findAll(tree, 'SecureModal')[0]; },
    get scrollViews() { return findAll(this.modal, 'ScrollView'); },
    get visible() { return this.modal.props.visible; },
    get text() { return textContent(this.modal); },
    get buttons() { return findAll(this.modal, 'Pressable').map(button => textContent(button)); },
    async settle() {
      for (let pass = 0; pass < 12; pass++) {
        await new Promise(resolve => setImmediate(resolve));
        if (dirty) render();
        if (this.visible && !options.manualModalShow) this.modal.props.onShow?.();
      }
    },
    async showModal() { this.modal.props.onShow?.(); await this.settle(); },
    async check() {
      await findAll(tree, 'UpdateContextProvider')[0].props.value.checkForUpdates(); await this.settle();
    },
    async press(label) {
      const button = findAll(this.modal, 'Pressable').find(item => textContent(item) === label);
      assert.ok(button, `Missing button ${label}. Present: ${this.buttons}`);
      assert.equal(Boolean(button.props.disabled), false, `Disabled button ${label}`);
      button.props.onPress(); await this.settle();
    },
    async close() { this.modal.props.onRequestClose(); await this.settle(); },
    async updateProps(next) { props = {...props, ...next}; render(); await this.settle(); },
    async advance(duration) {
      const target = now + duration;
      for (;;) {
        const entry = [...timers.entries()].filter(([, timer]) => timer.due <= target).sort((a, b) => a[1].due - b[1].due)[0];
        if (!entry) break;
        now = entry[1].due; timers.delete(entry[0]); entry[1].callback(); await this.settle();
      }
      now = target; await this.settle();
    },
    async progress(received, total, kind = 'apk') { progressListener?.({received, total, kind}); await this.settle(); },
    async appState(value) { appState.currentState = value; for (const listener of listeners) listener(value); await this.settle(); },
    async visibility(value) {
      assert.ok(value === 'foreground' || value === 'background');
      visibility = value;
      for (const listener of visibilityListeners) listener(value);
      await this.settle();
    },
    dispose() { disposed = true; for (const slot of slots) slot.cleanup?.(); timers.clear(); },
  };
  return result;
}

(async () => {
  for (const pending of ['fetchDeferred', 'bodyDeferred']) {
    const app = harness({syncRender: true, props: {navigationReady: true}, state: {appVersion: '1.0.0'}});
    const stalled = app.api[pending] = deferred();
    await app.advance(2500); assert.equal(app.calls.fetch, 1);
    await app.advance(15000); assert.equal(app.visible, false, 'A stalled automatic manifest request remains silent');
    app.api[pending] = null;
    await app.advance(15000); assert.equal(app.calls.fetch, 2); assert.equal(app.visible, true, 'Ignored abort or a stalled body cannot hold the checking lock forever');
    stalled.resolve(); await app.settle(); assert.equal(app.calls.fetch, 2);
    app.dispose();
  }
  for (const finishBeforeGet of [false, true]) {
    const app = harness({syncRender: true, props: {navigationReady: true}, state: {appVersion: '1.0.0'}});
    await app.advance(2500);
    const request = app.api.fetchDeferred = deferred();
    await app.visibility('background'); await app.visibility('foreground'); await app.advance(2500);
    app.api.downloadDeferred = deferred(); await app.press('下载更新');
    if (finishBeforeGet) { app.api.downloadDeferred.resolve(); await app.settle(); }
    app.api.manifest.appVersion = '1.0.7'; app.api.manifest.downloadAndroidUrlApk = 'https://updates.example.com/app-1.0.7.apk';
    request.resolve(); await app.settle();
    assert.match(app.text, /1\.0\.6/); assert.doesNotMatch(app.text, /1\.0\.7/, 'Late GET cannot replace the version the user chose to download');
    if (!finishBeforeGet) { app.api.downloadDeferred.resolve(); await app.settle(); }
    assert.equal(app.calls.install, 1); assert.equal(app.state.apkVersion, '1.0.6');
    assert.ok(app.buttons.includes('安装更新')); app.dispose();
  }
  {
    const app = harness({syncRender: true, props: {navigationReady: true}, state: {appVersion: '1.0.0'}});
    await app.advance(2500); app.api.downloadDeferred = deferred();
    await app.press('下载更新'); await app.visibility('background');
    app.api.downloadDeferred.resolve(); await app.settle();
    assert.equal(app.calls.install, 0, 'Finishing a download in the background cannot open the installer');
    await app.visibility('foreground'); assert.ok(app.buttons.includes('安装更新'));
    await app.press('安装更新'); assert.equal(app.calls.install, 1); assert.equal(app.calls.download, 1);
    app.dispose();
  }
  {
    const app = harness({syncRender: true, state: {appVersion: '1.0.0'}});
    await app.check(); app.api.downloadDeferred = deferred(); await app.press('下载更新');
    app.dispose(); app.api.downloadDeferred.resolve(); await app.settle();
    assert.equal(app.calls.install, 0, 'An unmounted provider cannot open the installer');
  }
  {
    const app = harness({syncRender: true, props: {navigationReady: true, safeToPrompt: false}, state: {appVersion: '1.0.0'}, manifest: {mandatory: true}});
    await app.advance(2500); assert.equal(app.visible, false);
    app.api.manifest.appVersion = '1.0.0'; app.api.manifest.bundleVersion = 0;
    await app.visibility('background'); await app.visibility('foreground'); await app.advance(2500);
    await app.updateProps({safeToPrompt: true}); assert.equal(app.visible, false, 'A withdrawn required release clears its deferred offer');
    app.dispose();
  }
  {
    const app = harness({syncRender: true, props: {navigationReady: true}, state: {appVersion: '1.0.0'}, manifest: {mandatory: true}});
    await app.advance(2500); app.api.fetchError = new Error('offline'); await app.check();
    assert.equal(app.visible, true); assert.match(app.text, /1\.0\.6/); assert.ok(!app.buttons.includes('稍后更新'), 'A check error cannot remove a previously discovered required release');
    await app.close(); assert.equal(app.visible, true); app.dispose();
  }
  {
    const app = harness({syncRender: true, state: {pendingBundleVersion: 5, highestBundleVersion: 5}});
    await app.check(); assert.equal(app.visible, true); assert.match(app.text, /补丁已下载/); assert.equal(app.calls.stage, 0);
    app.dispose();
  }
  {
    const app = harness({syncRender: true}); app.api.stageError = {code: 'E_UPDATE_VERIFY'};
    await app.check(); assert.equal(app.visible, true, 'Manual OTA failures report verification errors'); assert.match(app.text, /更新包校验未通过/); app.dispose();
  }
  {
    const app = harness({syncRender: true, props: {navigationReady: true, safeToPrompt: false}, state: {rollback: true, failedBundleVersion: 5, highestBundleVersion: 5}});
    await app.advance(2500); assert.equal(app.calls.ack, 0); assert.equal(app.state.rollback, true);
    await app.updateProps({safeToPrompt: true}); assert.equal(app.visible, true); assert.match(app.text, /已自动恢复/);
    assert.equal(app.calls.ack, 1, 'Only a displayed rollback notice is acknowledged'); app.dispose();
  }
  {
    const app = harness({syncRender: true, manualModalShow: true, props: {navigationReady: true}, state: {rollback: true, failedBundleVersion: 5, highestBundleVersion: 5}});
    await app.advance(2500); assert.equal(app.visible, true); assert.equal(app.calls.ack, 0, 'Rendering a modal does not mean the native window has shown');
    await app.showModal(); assert.equal(app.calls.ack, 1); app.dispose();
  }
  {
    const app = harness({syncRender: true, props: {navigationReady: true, safeToPrompt: false}, state: {appVersion: '1.0.0', rollback: true, failedBundleVersion: 5, highestBundleVersion: 5}, manifest: {mandatory: true}});
    await app.advance(2500); assert.equal(app.visible, false); assert.equal(app.calls.ack, 0);
    app.api.fetchError = new Error('offline');
    await app.visibility('background'); await app.visibility('foreground'); await app.advance(2500);
    await app.updateProps({safeToPrompt: true});
    assert.match(app.text, /1\.0\.6/); assert.match(app.text, /已自动恢复/);
    assert.ok(!app.buttons.includes('稍后更新')); assert.equal(app.calls.ack, 1);
    await app.close(); assert.equal(app.visible, true, 'Rollback information and a failed GET cannot remove a known required APK'); app.dispose();
  }
  {
    const app = harness({syncRender: true, props: {navigationReady: true}, config: {UPDATE_JSON_URL: ''}});
    const confirm = app.api.confirmDeferred = deferred(); await app.advance(5000); assert.equal(app.calls.confirm, 1);
    app.dispose(); confirm.reject(new Error('late confirmation failure')); await app.settle();
    assert.equal(app.timerCount, 0, 'A late failed confirmation cannot restart timers after unmount');
  }
  {
    const app = harness({syncRender: true, props: {navigationReady: true}, state: {appVersion: '1.0.0'}});
    await app.advance(2499); assert.equal(app.calls.fetch, 0, 'Cold-start checks wait for the startup delay');
    await app.advance(1); assert.equal(app.calls.fetch, 1);
    assert.equal(app.visible, true, 'A cold-start APK offer must appear with legacy synchronous Promise commits');
    assert.match(app.text, /1\.0\.6/); assert.equal(app.calls.download, 0, 'An APK requires the user to start its download');
    app.dispose();
  }
  {
    const app = harness({syncRender: true, props: {navigationReady: true, safeToPrompt: false}, state: {appVersion: '1.0.0'}});
    await app.advance(2500); assert.equal(app.calls.fetch, 1); assert.equal(app.visible, false);
    await app.updateProps({safeToPrompt: true});
    assert.equal(app.visible, true, 'An APK offer received during a sensitive flow appears on the next safe screen');
    await app.press('稍后更新'); assert.equal(app.visible, false);
    await app.visibility('background'); await app.visibility('foreground'); await app.advance(2500);
    assert.equal(app.calls.fetch, 2);
    assert.equal(app.visible, true, 'The same APK offer can appear again after dismissal and a new foreground check');
    app.dispose();
  }
  {
    const app = harness({syncRender: true, props: {navigationReady: true}, state: {appVersion: '1.0.0'}});
    await app.advance(1000); await app.visibility('background'); await app.advance(30000);
    assert.equal(app.calls.fetch, 0, 'A true background transition cancels the pending startup check');
    await app.visibility('foreground'); await app.advance(2499); assert.equal(app.calls.fetch, 0);
    await app.advance(1); assert.equal(app.calls.fetch, 1); assert.equal(app.visible, true);
    app.dispose();
  }
  {
    const app = harness({syncRender: true, props: {navigationReady: true}, state: {appVersion: '1.0.0'}});
    app.api.fetchDeferred = deferred();
    await app.advance(2500); assert.equal(app.calls.fetch, 1);
    await app.visibility('background'); app.api.fetchDeferred.resolve(); await app.settle();
    assert.equal(app.visible, false, 'An APK check finishing in the background must not open a dialog');
    await app.visibility('foreground'); await app.advance(2500);
    assert.equal(app.visible, true, 'An APK offer finishing in the background is presented after returning');
    app.dispose();
  }
  {
    const app = harness({syncRender: true, props: {navigationReady: true}, state: {appVersion: '1.0.0'}});
    await app.advance(1000); await app.appState('background'); await app.advance(1500);
    assert.equal(app.calls.fetch, 1, 'An Android system panel pausing RN does not cancel true-foreground checks');
    assert.equal(app.visible, true);
    await app.appState('active'); await app.advance(10000);
    assert.equal(app.calls.fetch, 1, 'Returning from a still-visible system panel does not start another check');
    app.dispose();
  }
  {
    const app = harness({syncRender: true, props: {navigationReady: true}, state: {appVersion: '1.0.0'}});
    app.api.fetchError = new Error('startup network unavailable');
    await app.advance(2500); assert.equal(app.calls.fetch, 1); assert.equal(app.visible, false);
    await app.advance(14999); assert.equal(app.calls.fetch, 1);
    app.api.fetchError = null;
    await app.advance(1); assert.equal(app.calls.fetch, 2);
    assert.equal(app.visible, true, 'Startup network recovery retries the APK check without requiring an app switch');
    await app.advance(120000); assert.equal(app.calls.fetch, 2, 'A successful check cancels startup retries');
    app.dispose();
  }
  {
    const app = harness({syncRender: true, props: {navigationReady: true}, state: {appVersion: '1.0.0'}});
    app.api.fetchError = new Error('offline');
    await app.advance(2500); assert.equal(app.calls.fetch, 1);
    await app.advance(15000); assert.equal(app.calls.fetch, 2);
    await app.advance(30000); assert.equal(app.calls.fetch, 3);
    await app.advance(120000); assert.equal(app.calls.fetch, 3, 'Automatic checks have at most three attempts in one foreground session');
    await app.visibility('background'); await app.visibility('foreground');
    app.api.fetchError = null; await app.advance(2500);
    assert.equal(app.calls.fetch, 4); assert.equal(app.visible, true, 'Returning to the foreground starts a fresh bounded check cycle');
    app.dispose();
  }
  {
    const app = harness({syncRender: true, props: {navigationReady: true}, state: {appVersion: '1.0.0'}});
    app.api.fetchError = new Error('offline');
    await app.advance(2500); await app.visibility('background'); await app.advance(60000);
    assert.equal(app.calls.fetch, 1, 'Background time must not trigger a scheduled failure retry');
    app.api.fetchError = null; await app.visibility('foreground'); await app.advance(2500);
    assert.equal(app.calls.fetch, 2); assert.equal(app.visible, true);
    app.dispose();
  }
  {
    const app = harness({syncRender: true, props: {navigationReady: true}, state: {bundleVersion: 4, highestBundleVersion: 4}, stageRequiresConfirmation: true});
    await app.advance(2500); assert.equal(app.calls.stage, 1); assert.equal(app.calls.confirm, 0);
    assert.equal(app.state.pendingBundleVersion, 0, 'A newer OTA patch cannot stage while the running patch is unconfirmed');
    await app.advance(2500); assert.equal(app.calls.confirm, 1);
    await app.advance(12499); assert.equal(app.calls.stage, 1);
    await app.advance(1); assert.equal(app.calls.stage, 2);
    assert.equal(app.state.pendingBundleVersion, 5, 'A transient OTA busy error retries after the current patch is confirmed');
    assert.equal(app.visible, false, 'OTA retry and staging remain silent');
    await app.advance(120000); assert.equal(app.calls.stage, 2, 'Successful OTA staging cancels further retries');
    app.dispose();
  }
  {
    const app = harness({config: {UPDATE_JSON_URL: ''}});
    await app.check(); assert.equal(app.visible, true); assert.match(app.text, /暂未开放在线更新/); assert.equal(app.calls.fetch, 0);
    await app.press('关闭'); assert.equal(app.visible, false); app.dispose();
  }
  {
    const app = harness({state: {appVersion: '1.0.0'}});
    await app.check(); assert.equal(app.visible, true); assert.match(app.text, /1\.0\.6/); assert.ok(app.buttons.includes('稍后更新'));
    app.api.downloadDeferred = deferred();
    await app.press('下载更新'); assert.equal(app.calls.download, 1); assert.equal(app.calls.install, 0);
    await app.progress(50, 100); assert.match(app.text, /50%/);
    await app.close(); assert.equal(app.visible, true, 'Cannot dismiss during APK download');
    app.api.installError = {code: 'E_INSTALL_PERMISSION'};
    app.api.downloadDeferred.resolve(); await app.settle();
    assert.equal(app.calls.install, 1); assert.ok(app.buttons.includes('安装更新')); assert.match(app.text, /允许安装此来源/);
    app.api.installError = null;
    await app.press('安装更新'); assert.equal(app.calls.install, 2); assert.equal(app.calls.download, 1, 'Unknown-source retry must reuse the verified private APK');
    await app.close(); assert.equal(app.visible, false); app.dispose();
  }
  {
    const description = Array.from({length: 80}, (_, index) => `${index + 1}. Public release note describing an update`).join('\n');
    const app = harness({state: {appVersion: '1.0.0'}, manifest: {mandatory: true, description}});
    await app.check(); assert.equal(app.visible, true); assert.ok(!app.buttons.includes('稍后更新'));
    assert.equal(app.scrollViews.length, 1, 'The entire update card uses one scroll surface instead of nested description scrolling');
    assert.ok(textContent(app.scrollViews[0]).includes(description), 'Long release notes remain inside the scroll surface');
    assert.ok(findAll(app.scrollViews[0], 'Pressable').some(button => textContent(button) === '下载更新'), 'Required update actions remain inside the same reachable scroll surface');
    app.api.downloadDeferred = deferred(); await app.press('下载更新'); await app.progress(50, 100);
    assert.match(textContent(app.scrollViews[0]), /50%/, 'Download progress stays in the scrollable card');
    const downloadingButton = findAll(app.scrollViews[0], 'Pressable').find(button => textContent(button) === '更新中…');
    assert.equal(downloadingButton.props.accessibilityState.busy, true); assert.equal(downloadingButton.props.accessibilityState.disabled, true);
    app.api.installError = {code: 'E_INSTALL_PERMISSION'}; app.api.downloadDeferred.resolve(); await app.settle();
    assert.match(textContent(app.scrollViews[0]), /允许安装此来源/, 'Installation errors remain in the same scrollable card');
    assert.ok(findAll(app.scrollViews[0], 'Pressable').some(button => textContent(button) === '安装更新'), 'The retry action stays available with an error');
    await app.close(); assert.equal(app.visible, true, 'Required update must reject Android back close'); app.dispose();
  }
  {
    const app = harness({manifest: {mandatory: true}});
    await app.check(); assert.equal(app.calls.stage, 1, 'OTA bundles are staged silently');
    assert.equal(app.visible, false, 'Silent OTA must not show an update dialog');
    assert.equal(app.state.pendingBundleVersion, 5);
    assert.equal(app.calls.reload, 0, 'Stage the bundle without reloading a running wallet');
    await app.check(); assert.equal(app.calls.stage, 1, 'Pending patches must not be downloaded again');
    app.dispose();
  }
  {
    const app = harness({props: {navigationReady: true, safeToPrompt: false}});
    await app.advance(2500); assert.equal(app.calls.fetch, 1); assert.equal(app.visible, false, 'Defer automatic update prompt during sensitive wallet activity');
    await app.updateProps({safeToPrompt: true}); assert.equal(app.visible, false, 'Automatic OTA staging stays silent'); app.dispose();
  }
  {
    const app = harness({props: {navigationReady: true, safeToPrompt: false}});
    await app.advance(2500); assert.equal(app.visible, false);
    app.api.fetchError = new Error('offline');
    await app.check(); assert.equal(app.visible, true, 'A manual check must report its own failure');
    await app.press('关闭'); assert.equal(app.visible, false);
    await app.updateProps({safeToPrompt: true}); assert.equal(app.visible, false, 'A stale deferred prompt cannot reopen after a manual failure and dismissal'); app.dispose();
  }
  {
    const app = harness({props: {navigationReady: true, safeToPrompt: false}, state: {rollback: true, failedBundleVersion: 5, highestBundleVersion: 5}});
    app.api.fetchError = new Error('offline');
    await app.advance(2500); assert.equal(app.visible, false, 'Automatic rollback notice must wait for a safe wallet screen');
    await app.updateProps({safeToPrompt: true}); assert.equal(app.visible, true); assert.match(app.text, /已自动恢复到上一可用版本/);
    assert.ok(!app.buttons.includes('下载更新'), 'A rolled-back patch must not be offered again'); app.dispose();
  }
  {
    const app = harness({props: {navigationReady: true}});
    app.api.fetchError = new Error('offline');
    await app.advance(2500); assert.equal(app.calls.fetch, 1); assert.equal(app.visible, false, 'A failed automatic check must not block normal app startup');
    await app.check(); assert.equal(app.visible, true); assert.match(app.text, /检查网络后重试/); app.dispose();
  }
  {
    const app = harness({config: {UPDATE_JSON_URL: ''}, props: {navigationReady: true}});
    await app.advance(4999); assert.equal(app.calls.confirm, 0);
    await app.visibility('background'); await app.advance(20000); assert.equal(app.calls.confirm, 0, 'Background time cannot confirm a patch startup');
    await app.visibility('foreground'); await app.advance(4999); assert.equal(app.calls.confirm, 0);
    await app.advance(1); assert.equal(app.calls.confirm, 1); app.dispose();
  }
  {
    const app = harness({config: {UPDATE_JSON_URL: ''}, props: {navigationReady: true}, confirmFailures: 2});
    await app.advance(5000); assert.equal(app.calls.confirm, 1);
    await app.advance(5000); assert.equal(app.calls.confirm, 2);
    await app.advance(5000); assert.equal(app.calls.confirm, 3, 'A transient launch-confirmation failure is retried');
    await app.advance(30000); assert.equal(app.calls.confirm, 3, 'Successful confirmation cancels further retries'); app.dispose();
  }
  {
    const app = harness({platform: 'ios', state: {appVersion: '1.0.0'}});
    await app.check(); await app.press('前往更新');
    assert.equal(app.calls.links.length, 1); assert.equal(app.calls.links[0], JSON_FIXTURE.downloadIosUrlApk); assert.equal(app.calls.download, 0); app.dispose();
  }
  console.log('Update UI passed: legacy synchronous cold-start APK offers, safe-screen deferral, repeat offers, true visibility, bounded startup retries, provider/GET policy, APK progress/install permission retry, required updates, silent OTA, foreground confirmation and iOS store routing. No network, wallet, APK install or app reload.');
})().catch(error => { console.error(error); process.exitCode = 1; });
