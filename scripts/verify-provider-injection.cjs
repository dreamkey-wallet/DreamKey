/*
 * Executes the real injected provider in an isolated page with controllable
 * browser timers and the React Native message bridge. Fixtures contain no
 * wallet secret, live RPC, or actual signing operation.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const source = ts.transpileModule(fs.readFileSync(path.join(root, 'src/dapp/providerBridge.ts'), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const moduleContext = { exports: {} };
vm.runInNewContext(source, moduleContext, { filename: 'providerBridge.js' });
const { EIP1193_INJECTED_SCRIPT, createProviderResponseScript, createProviderReadyScript, createProviderEventScript } = moduleContext.exports;
const fixtureAccount = `0x${'1'.repeat(40)}`;
const fixtureSignature = 'fixture-signature';
const tick = () => new Promise((resolve) => setImmediate(resolve));

function createPage() {
  const eventListeners = new Map();
  const events = [];
  const posted = [];
  const timers = new Map();
  let now = 0;
  let timerSequence = 0;
  let autoRespondToSignature = true;
  let hostReady = true;
  const readFailures = new Map();
  const droppedReads = new Set();
  const heldReads = new Map();

  class PageEvent {
    constructor(type, options = {}) { this.type = type; Object.assign(this, options); }
  }
  const window = {
    addEventListener(type, callback) {
      if (!eventListeners.has(type)) eventListeners.set(type, []);
      eventListeners.get(type).push(callback);
    },
    removeEventListener(type, callback) {
      eventListeners.set(type, (eventListeners.get(type) || []).filter((entry) => entry !== callback));
    },
    dispatchEvent(event) {
      events.push(event);
      for (const callback of (eventListeners.get(event.type) || []).slice()) callback(event);
      return true;
    },
  };
  const context = vm.createContext({
    window,
    Event: PageEvent,
    CustomEvent: PageEvent,
    setTimeout(callback, delay = 0) {
      const id = ++timerSequence;
      timers.set(id, { callback, at: now + Math.max(0, Number(delay) || 0) });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    console,
  });

  function respond(message, result, error, documentId = message.documentId) {
    vm.runInContext(createProviderResponseScript({
      type: 'wallet:provider-response', id: message.id, documentId, ok: !error,
      ...(error ? { error } : { result }),
    }), context);
  }

  function attachBridge() {
    window.ReactNativeWebView = {
      postMessage(raw) {
        const message = JSON.parse(raw);
        posted.push(message);
        if (message.type === 'wallet:provider-ready') {
          if (hostReady) vm.runInContext(createProviderReadyScript(message.documentId), context);
          return;
        }
        if (message.type !== 'wallet:provider-request') return;
        const method = message.request.method;
        if (droppedReads.delete(method)) return;
        if (heldReads.has(method) && heldReads.get(method) === undefined) {
          heldReads.set(method, message);
          return;
        }
        if (readFailures.has(method)) {
          const error = readFailures.get(method);
          readFailures.delete(method);
          respond(message, undefined, error);
          return;
        }
        if (method === 'eth_chainId') respond(message, '0x38');
        if (method === 'eth_accounts') respond(message, []);
        if (method === 'personal_sign' && autoRespondToSignature) respond(message, fixtureSignature);
      },
    };
  }

  async function advance(duration = 0) {
    const until = now + duration;
    let count = 0;
    await tick();
    while (true) {
      const next = [...timers.entries()].filter(([, timer]) => timer.at <= until)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      assert.ok(++count <= 1000, 'provider timer loop must be bounded');
      now = next[1].at;
      timers.delete(next[0]);
      next[1].callback();
      await tick();
    }
    now = until;
    await tick();
  }

  return {
    window, events, posted, attachBridge, advance, respond,
    install() { vm.runInContext(EIP1193_INJECTED_SCRIPT, context, { filename: 'injected-provider.js' }); },
    holdSignatures() { autoRespondToSignature = false; },
    holdHostReady() { hostReady = false; },
    allowHostReady() { hostReady = true; },
    acknowledge(documentId) { vm.runInContext(createProviderReadyScript(documentId), context); },
    event(type, params) { vm.runInContext(createProviderEventScript(type, params), context); },
    failNextRead(method) { readFailures.set(method, { code: -32603, message: 'Fixture temporary read failure' }); },
    dropNextRead(method) { droppedReads.add(method); },
    holdNextRead(method) { heldReads.set(method, undefined); },
    respondHeldRead(method, result, error) {
      const message = heldReads.get(method);
      assert.ok(message, `expected held ${method} fixture request`);
      heldReads.delete(method);
      respond(message, result, error);
    },
    requests(method) { return posted.filter((message) => message.type === 'wallet:provider-request' && message.request.method === method); },
    announce() { window.dispatchEvent(new PageEvent('eip6963:requestProvider')); },
  };
}

function observe(promise) {
  const state = { status: 'pending' };
  promise.then((value) => { state.status = 'fulfilled'; state.value = value; }, (error) => { state.status = 'rejected'; state.error = error; });
  return state;
}

function assertInitialized(page, connectEvents, initializedEvents) {
  assert.equal(page.window.ethereum._initialized, true, 'provider initializes after the native bridge becomes ready');
  assert.equal(page.window.ethereum._state.initialized, true);
  assert.equal(page.window.ethereum.chainId, '0x38');
  assert.equal(page.window.ethereum.networkVersion, '56');
  assert.equal(page.window.ethereum.selectedAddress, null, 'initialization does not request account permission');
  assert.deepEqual(Array.from(page.window.ethereum._state.accounts), []);
  assert.equal(page.window.ethereum.isConnected(), true);
  assert.equal(connectEvents.length, 1, 'connection is announced exactly once');
  assert.equal(connectEvents[0].chainId, '0x38');
  assert.equal(initializedEvents.length, 1, 'provider initialization is announced exactly once');
  assert.equal(page.events.filter((event) => event.type === 'ethereum#initialized').length, 1);
  assert.equal(page.requests('eth_requestAccounts').length, 0, 'bootstrap is read-only');
}

async function verifyReadyBridgeAndDiscovery() {
  const page = createPage();
  page.attachBridge();
  page.install();
  const provider = page.window.ethereum;
  const connectEvents = [];
  const initializedEvents = [];
  provider.on('connect', (value) => connectEvents.push(value));
  provider.on('_initialized', () => initializedEvents.push(true));
  await page.advance(500);
  assertInitialized(page, connectEvents, initializedEvents);
  page.install();
  page.install();
  await page.advance(500);
  assert.equal(page.window.ethereum, provider, 'fallback installation retains the provider identity');
  assert.equal(page.window.web3.currentProvider, provider);
  assert.equal(page.requests('eth_chainId').length, 1, 'successful bootstrap is not replayed by fallback injection');
  assert.equal(page.requests('eth_accounts').length, 1);
  page.announce();
  const announcements = page.events.filter((event) => event.type === 'eip6963:announceProvider');
  assert.ok(announcements.length >= 2, 'wallet can be discovered initially and by later EIP-6963 requests');
  assert.ok(announcements.every((event) => event.detail.provider === provider && event.detail.info.name === 'DreamKey'));
  assert.equal(new Set(announcements.map((event) => event.detail.info.uuid)).size, 1, 'fallback preserves the announced wallet identity');
}

async function verifyLateBridgeWithFallback() {
  const page = createPage();
  page.install();
  const provider = page.window.ethereum;
  const connectEvents = [];
  const initializedEvents = [];
  provider.on('connect', (value) => connectEvents.push(value));
  provider.on('_initialized', () => initializedEvents.push(true));
  const firstSignature = observe(provider.request({ method: 'personal_sign', params: ['0x68656c6c6f', fixtureAccount] }));
  await page.advance(50);
  assert.equal(firstSignature.status, 'pending', 'first personal_sign must wait for the bridge instead of rejecting during injection');
  assert.equal(page.requests('personal_sign').length, 0);
  page.attachBridge();
  page.install();
  page.install();
  await page.advance(500);
  assert.equal(page.window.ethereum, provider);
  assertInitialized(page, connectEvents, initializedEvents);
  assert.equal(firstSignature.status, 'fulfilled');
  assert.equal(firstSignature.value, fixtureSignature);
  assert.equal(page.requests('personal_sign').length, 1, 'fallback sends the queued signature request once');
}

async function verifyLateBridgeWithoutFallback() {
  const page = createPage();
  page.install();
  const request = observe(page.window.ethereum.request({ method: 'personal_sign', params: ['0x68656c6c6f', fixtureAccount] }));
  await page.advance(50);
  page.attachBridge();
  await page.advance(1000);
  assert.equal(request.status, 'fulfilled', 'bridge readiness recovers even before the after-load fallback runs');
  assert.equal(page.requests('personal_sign').length, 1);
  assert.equal(page.window.ethereum._initialized, true);
}

async function verifyNativeReadinessBeforeRequests() {
  const page = createPage();
  page.holdHostReady();
  page.attachBridge();
  page.install();
  const signature = observe(page.window.ethereum.request({ method: 'personal_sign', params: ['0x68656c6c6f', fixtureAccount] }));
  await page.advance(350);
  assert.equal(signature.status, 'pending', 'existence of the JavaScript bridge alone is not native document readiness');
  assert.equal(page.posted.filter((message) => message.type === 'wallet:provider-request').length, 0, 'requests wait until the current native document acknowledges readiness');
  assert.ok(page.posted.some((message) => message.type === 'wallet:provider-ready'));
  const hello = page.posted.find((message) => message.type === 'wallet:provider-ready');
  page.acknowledge(`${hello.documentId}-previous-document`);
  await page.advance(0);
  assert.equal(page.posted.filter((message) => message.type === 'wallet:provider-request').length, 0, 'readiness acknowledgement must match the current document');
  page.allowHostReady();
  await page.advance(500);
  assert.equal(signature.status, 'fulfilled');
  assert.equal(page.requests('personal_sign').length, 1);
  const sent = page.requests('personal_sign')[0];
  assert.equal(typeof sent.documentId, 'string');
  assert.ok(sent.documentId.length > 0, 'request carries a per-document identity');
  assert.ok(page.posted.filter((message) => message.type === 'wallet:provider-ready').every((message) => message.documentId === sent.documentId));
  const helloCount = page.posted.filter((message) => message.type === 'wallet:provider-ready').length;
  await page.advance(1000);
  assert.equal(page.posted.filter((message) => message.type === 'wallet:provider-ready').length, helloCount, 'readiness polling stops after acknowledgement');
}

async function verifyBootstrapReadRecovery() {
  const page = createPage();
  page.failNextRead('eth_chainId');
  page.attachBridge();
  page.install();
  const connectEvents = [];
  const initializedEvents = [];
  page.window.ethereum.on('connect', (value) => connectEvents.push(value));
  page.window.ethereum.on('_initialized', () => initializedEvents.push(true));
  await page.advance(10000);
  assertInitialized(page, connectEvents, initializedEvents);
  assert.ok(page.requests('eth_chainId').length >= 2, 'failed bootstrap read can retry safely');
  assert.equal(page.requests('personal_sign').length, 0);
}

async function verifyLostBootstrapReadRecovery() {
  const page = createPage();
  page.dropNextRead('eth_accounts');
  page.attachBridge();
  page.install();
  const signature = observe(page.window.ethereum.request({ method: 'personal_sign', params: ['0x68656c6c6f', fixtureAccount] }));
  await page.advance(20000);
  assert.equal(page.window.ethereum._initialized, true, 'a lost read-only bootstrap response does not permanently block initialization');
  assert.ok(page.requests('eth_accounts').length >= 2, 'read-only bootstrap can recover after timeout');
  assert.equal(signature.status, 'fulfilled');
  assert.equal(page.requests('personal_sign').length, 1, 'bootstrap timeout never replays signing');
}

async function verifyFailedBootstrapPairDoesNotOverlap() {
  const page = createPage();
  page.failNextRead('eth_chainId');
  page.holdNextRead('eth_accounts');
  page.attachBridge();
  page.install();
  await page.advance(500);
  assert.equal(page.requests('eth_chainId').length, 1, 'failed bootstrap waits for its sibling read instead of starting overlapping attempts');
  assert.equal(page.requests('eth_accounts').length, 1);
  assert.equal(page.window.ethereum._initialized, false);
  page.respondHeldRead('eth_accounts', [fixtureAccount]);
  await page.advance(0);
  assert.equal(page.window.ethereum.selectedAddress, null, 'a failed bootstrap pair does not commit the successful sibling snapshot');
  await page.advance(1000);
  assert.equal(page.window.ethereum._initialized, true);
  assert.equal(page.requests('eth_chainId').length, 2);
  assert.equal(page.requests('eth_accounts').length, 2);
  assert.equal(page.window.ethereum.selectedAddress, null, 'retry state wins over the failed attempt snapshot');
}

async function verifyBootstrapSnapshotCannotOverwriteEvents() {
  const page = createPage();
  page.holdNextRead('eth_chainId');
  page.holdNextRead('eth_accounts');
  page.attachBridge();
  page.install();
  await page.advance(0);
  const latestAccount = `0x${'2'.repeat(40)}`;
  page.event('chainChanged', '0x1');
  page.event('accountsChanged', [latestAccount]);
  page.respondHeldRead('eth_chainId', '0x38');
  page.respondHeldRead('eth_accounts', [fixtureAccount]);
  await page.advance(0);
  assert.equal(page.window.ethereum._initialized, true);
  assert.equal(page.window.ethereum.chainId, '0x1', 'a later chainChanged event wins over the bootstrap snapshot');
  assert.equal(page.window.ethereum.selectedAddress, latestAccount, 'a later accountsChanged event wins over the bootstrap snapshot');
}

async function verifyBootstrapSnapshotCannotOverwriteUserReads() {
  const page = createPage();
  page.holdNextRead('eth_chainId');
  page.holdNextRead('eth_accounts');
  page.attachBridge();
  page.install();
  await page.advance(0);
  const latestAccount = `0x${'2'.repeat(40)}`;
  const accounts = observe(page.window.ethereum.request({ method: 'eth_requestAccounts' }));
  const chain = observe(page.window.ethereum.request({ method: 'eth_chainId' }));
  page.respond(page.requests('eth_requestAccounts')[0], [latestAccount]);
  await page.advance(0);
  assert.equal(accounts.status, 'fulfilled');
  assert.equal(chain.status, 'fulfilled');
  page.respondHeldRead('eth_chainId', '0x1');
  page.respondHeldRead('eth_accounts', [fixtureAccount]);
  await page.advance(0);
  assert.equal(page.window.ethereum._initialized, true);
  assert.equal(page.window.ethereum.chainId, '0x38', 'the later user chain read wins over the older bootstrap snapshot');
  assert.equal(page.window.ethereum.selectedAddress, latestAccount, 'the permission-approved account wins over the older bootstrap snapshot');
}

async function verifySynchronousDiscoveryRequest() {
  const page = createPage();
  let signature;
  page.window.addEventListener('eip6963:announceProvider', (event) => {
    if (!signature) signature = observe(event.detail.provider.request({ method: 'personal_sign', params: ['0x68656c6c6f', fixtureAccount] }));
  });
  page.install();
  await page.advance(50);
  assert.equal(signature.status, 'pending', 'a request triggered synchronously during discovery waits for readiness');
  page.attachBridge();
  await page.advance(500);
  assert.equal(signature.status, 'fulfilled');
  assert.equal(page.requests('personal_sign').length, 1);
}

async function verifyDocumentResponseIsolation() {
  const page = createPage();
  page.holdSignatures();
  page.attachBridge();
  page.install();
  await page.advance(500);
  const signature = observe(page.window.ethereum.request({ method: 'personal_sign', params: ['0x68656c6c6f', fixtureAccount] }));
  await page.advance(0);
  const sent = page.requests('personal_sign')[0];
  page.respond(sent, 'wrong-document', undefined, `${sent.documentId}-previous-document`);
  await page.advance(0);
  assert.equal(signature.status, 'pending', 'a response for another document cannot settle the pending signature');
  page.respond(sent, fixtureSignature);
  await page.advance(0);
  assert.equal(signature.status, 'fulfilled');
  assert.equal(signature.value, fixtureSignature);
}

async function verifyPendingSignatureSurvivesFallback() {
  const page = createPage();
  page.holdSignatures();
  page.attachBridge();
  page.install();
  await page.advance(500);
  const signature = observe(page.window.ethereum.request({ method: 'personal_sign', params: ['0x68656c6c6f', fixtureAccount] }));
  page.install();
  page.install();
  page.acknowledge(page.requests('personal_sign')[0].documentId);
  await page.advance(1500);
  assert.equal(signature.status, 'pending', 'native approval can remain pending across fallback injection');
  assert.equal(page.requests('personal_sign').length, 1, 'an already-sent signing request is never automatically replayed');
  page.respond(page.requests('personal_sign')[0], undefined, { code: 4001, message: 'Fixture rejection' });
  await page.advance(500);
  assert.equal(signature.status, 'rejected');
  assert.equal(signature.error.code, 4001);
  assert.equal(page.requests('personal_sign').length, 1, 'user rejection does not retry signing');
}

async function verifyTransactionIsSentOnce() {
  const page = createPage();
  page.holdHostReady();
  page.attachBridge();
  page.install();
  const transaction = observe(page.window.ethereum.request({
    method: 'eth_sendTransaction', params: [{ from: fixtureAccount, to: fixtureAccount, value: '0x0' }],
  }));
  await page.advance(250);
  assert.equal(page.requests('eth_sendTransaction').length, 0, 'transactions wait for native document readiness');
  page.allowHostReady();
  await page.advance(500);
  assert.equal(transaction.status, 'pending');
  assert.equal(page.requests('eth_sendTransaction').length, 1);
  page.install();
  await page.advance(20000);
  assert.equal(transaction.status, 'pending', 'a user decision may take longer than bootstrap read timeouts');
  assert.equal(page.requests('eth_sendTransaction').length, 1, 'transaction requests are never automatically replayed');
  page.respond(page.requests('eth_sendTransaction')[0], undefined, { code: 4001, message: 'Fixture rejection' });
  await page.advance(0);
  assert.equal(transaction.status, 'rejected');
  assert.equal(transaction.error.code, 4001);
}

async function verify() {
  for (const test of [verifyReadyBridgeAndDiscovery, verifyLateBridgeWithFallback, verifyLateBridgeWithoutFallback, verifyNativeReadinessBeforeRequests, verifyBootstrapReadRecovery, verifyLostBootstrapReadRecovery, verifyFailedBootstrapPairDoesNotOverlap, verifyBootstrapSnapshotCannotOverwriteEvents, verifyBootstrapSnapshotCannotOverwriteUserReads, verifySynchronousDiscoveryRequest, verifyDocumentResponseIsolation, verifyPendingSignatureSurvivesFallback, verifyTransactionIsSentOnce]) {
    await test();
  }
  console.log('Provider injection verification passed: late bridge/native readiness, first-request queue, bootstrap error/timeout recovery, discovery, document isolation, and no signature/transaction replay.');
}

verify().catch((error) => { console.error(error); process.exitCode = 1; });
