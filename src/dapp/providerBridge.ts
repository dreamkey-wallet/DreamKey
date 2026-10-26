import type { Eip1193RequestArguments } from './types.js';

export interface ProviderRequestMessage {
  type: 'wallet:provider-request';
  id: string;
  documentId?: string;
  request: Eip1193RequestArguments;
}

export interface ProviderReadyMessage {
  type: 'wallet:provider-ready';
  documentId: string;
}

export interface PageMetadataMessage {
  type: 'wallet:page-metadata';
  url: string;
  title?: string;
  faviconUrl?: string;
}

export interface ProviderResponseMessage {
  type: 'wallet:provider-response';
  id: string;
  documentId?: string;
  ok: boolean;
  result?: unknown;
  error?: { code?: number; message: string; data?: unknown };
}

export interface ProviderEventMessage {
  type: 'wallet:provider-event';
  event: string;
  params: unknown;
}

export type DappBridgeMessage = ProviderRequestMessage | ProviderResponseMessage | ProviderEventMessage | ProviderReadyMessage | PageMetadataMessage;

const REQUEST_METHOD = 'wallet:provider-request';

/** Idempotent document-start installation with an after-load fallback. */
export const EIP1193_INJECTED_SCRIPT = `
(function () {
  if (window.__WALLET_DAPP_BRIDGE__) {
    if (window.__walletResumeProviderBridge) window.__walletResumeProviderBridge();
    return true;
  }
  var documentId = String(Date.now()) + '-' + Math.random().toString(36).slice(2);
  Object.defineProperty(window, '__WALLET_PROVIDER_DOCUMENT_ID__', { value: documentId });
  var pending = Object.create(null);
  var outbound = [];
  var sequence = 0;
  var listeners = Object.create(null);
  var bridgeReady = false;
  var readyTimer = null;
  var bootstrapTimer = null;
  var bootstrapping = false;
  var connected = false;
  var initialized = false;
  var chainId = null;
  var selectedAddress = null;
  var chainRevision = 0;
  var accountsRevision = 0;
  function emit(event, params) {
    var callbacks = listeners[event] || [];
    callbacks.slice().forEach(function (callback) {
      try { callback(params); } catch (_) {}
    });
  }
  function setChainId(value) {
    if (typeof value !== 'string') return;
    chainId = value;
    chainRevision += 1;
    ethereum.chainId = value;
    ethereum.networkVersion = String(parseInt(value, 16));
  }
  function setAccounts(value) {
    if (!Array.isArray(value)) return;
    accountsRevision += 1;
    selectedAddress = value.length && typeof value[0] === 'string' ? value[0] : null;
    ethereum.selectedAddress = selectedAddress;
    ethereum._state.accounts = value.slice();
  }
  function setConnected(value) {
    connected = value;
    ethereum._state.isConnected = value;
  }
  function initialize() {
    if (initialized) return;
    initialized = true;
    ethereum._initialized = true;
    ethereum._state.initialized = true;
    var wasConnected = connected;
    setConnected(true);
    if (!wasConnected) emit('connect', { chainId: chainId });
    emit('_initialized');
    try { window.dispatchEvent(new Event('ethereum#initialized')); } catch (_) {}
  }
  function receive(message) {
    if (!message || typeof message !== 'object') return;
    if (message.documentId && message.documentId !== documentId) return;
    if (message.type === 'wallet:provider-ready') {
      if (message.documentId !== documentId) return;
      bridgeReady = true;
      clearTimeout(readyTimer);
      readyTimer = null;
      flush();
      bootstrap();
      return;
    }
    if (message.type === 'wallet:provider-response' && pending[message.id]) {
      var item = pending[message.id];
      delete pending[message.id];
      clearTimeout(item.timer);
      if (message.ok) item.resolve(message.result);
      else {
        var error = message.error || {};
        var rejection = new Error(error.message || 'Provider request failed');
        if (typeof error.code === 'number') rejection.code = error.code;
        if (error.data !== undefined) rejection.data = error.data;
        item.reject(rejection);
      }
    } else if (message.type === 'wallet:provider-event') {
      if (message.event === 'chainChanged') setChainId(message.params);
      if (message.event === 'accountsChanged') setAccounts(message.params);
      if (message.event === 'connect') {
        setConnected(true);
        if (message.params && typeof message.params.chainId === 'string') setChainId(message.params.chainId);
      }
      if (message.event === 'disconnect') setConnected(false);
      emit(message.event, message.params);
    }
  }
  Object.defineProperty(window, '__walletHandleProviderResponse', { value: receive });
  var ethereum = window.ethereum || {};
  // These properties are intentionally injected for compatibility with the
  // de-facto provider shape used by MetaMask-aware dApps. They do not change
  // the wallet's product branding.
  ethereum.isMetaMask = true;
  ethereum.isWalletBrowser = true;
  ethereum._initialized = false;
  ethereum._state = { accounts: [], initialized: false, isConnected: false };
  ethereum._metamask = ethereum._metamask || {
    isUnlocked: function () { return Promise.resolve(true); }
  };
  ethereum.isConnected = function () { return connected; };
  ethereum.chainId = null;
  ethereum.networkVersion = null;
  ethereum.selectedAddress = null;
  function bridge() {
    return window.ReactNativeWebView && typeof window.ReactNativeWebView.postMessage === 'function'
      ? window.ReactNativeWebView : null;
  }
  function resume() {
    if (bridgeReady) { flush(); bootstrap(); return; }
    clearTimeout(readyTimer);
    readyTimer = setTimeout(resume, 100);
    var transport = bridge();
    if (transport) {
      try { transport.postMessage(JSON.stringify({ type: 'wallet:provider-ready', documentId: documentId })); } catch (_) {}
    }
  }
  function flush() {
    if (!bridgeReady) return;
    var transport = bridge();
    if (!transport) { bridgeReady = false; resume(); return; }
    var queue = outbound;
    outbound = [];
    queue.forEach(function (message) {
      var item = pending[message.id];
      if (!item) return;
      // Once handed to native, a signing/transaction request is never replayed.
      try { transport.postMessage(message.body); }
      catch (_) {
        delete pending[message.id];
        clearTimeout(item.timer);
        var error = new Error('Wallet connection unavailable. Please try again.');
        error.code = 4900;
        item.reject(error);
      }
    });
  }
  function request(args, timeout, updateState) {
    if (!args || typeof args.method !== 'string') {
      return Promise.reject(new Error('EIP-1193 request requires a method'));
    }
    var id = documentId + '-' + String(++sequence);
    var body;
    try { body = JSON.stringify({ type: '${REQUEST_METHOD}', id: id, documentId: documentId, request: args }); }
    catch (error) { return Promise.reject(error); }
    return new Promise(function (resolve, reject) {
      pending[id] = { resolve: resolve, reject: reject };
      // Only internal read-only bootstrap requests have a response timeout.
      // User confirmations may legitimately take as long as the user needs.
      if (timeout) pending[id].timer = setTimeout(function () {
        var item = pending[id];
        if (!item) return;
        delete pending[id];
        var error = new Error('Wallet initialization timed out');
        error.code = 4900;
        item.reject(error);
      }, timeout);
      outbound.push({ id: id, body: body });
      if (bridgeReady) flush(); else resume();
    }).then(function (result) {
      // Keep the legacy provider properties useful for libraries that read
      // them after request() rather than subscribing to events.
      if (updateState !== false && args.method === 'eth_chainId' && typeof result === 'string') {
        setChainId(result);
      }
      if (updateState !== false && (args.method === 'eth_accounts' || args.method === 'eth_requestAccounts') && Array.isArray(result)) {
        setAccounts(result);
      }
      return result;
    });
  }
  ethereum.request = function (args) { return request(args); };
  function bootstrap() {
    if (initialized || bootstrapping || !bridgeReady) return;
    bootstrapping = true;
    clearTimeout(bootstrapTimer);
    var startingChainRevision = chainRevision;
    var startingAccountsRevision = accountsRevision;
    function read(method) {
      return request({ method: method }, 5000, false).then(function (value) {
        return { ok: true, value: value };
      }, function () { return { ok: false }; });
    }
    // Wait for both reads to settle before retrying. A slow sibling from a
    // failed attempt must not overwrite the next attempt's wallet state.
    Promise.all([
      read('eth_chainId'), read('eth_accounts')
    ]).then(function (results) {
      if (!results[0].ok || !results[1].ok || typeof results[0].value !== 'string' || !Array.isArray(results[1].value)) {
        throw new Error('Wallet initialization unavailable');
      }
      // Permission/network changes made while bootstrapping take precedence
      // over the older read snapshots.
      if (chainRevision === startingChainRevision) setChainId(results[0].value);
      if (accountsRevision === startingAccountsRevision) setAccounts(results[1].value);
      bootstrapping = false;
      initialize();
    }).catch(function () {
      bootstrapping = false;
      bootstrapTimer = setTimeout(bootstrap, 250);
    });
  }
  // Legacy aliases still used by a number of dApps and web3 libraries.
  ethereum.enable = function () { return ethereum.request({ method: 'eth_requestAccounts' }); };
  ethereum.sendAsync = function (payload, callback) {
    var requests = Array.isArray(payload) ? payload : [payload];
    var jobs = requests.map(function (item) {
      var request = item || {};
      return ethereum.request({ method: request.method, params: request.params || [] }).then(function (result) {
        return { jsonrpc: '2.0', id: request.id, result: result };
      }, function (error) {
        return { jsonrpc: '2.0', id: request.id, error: { code: error && error.code || -32603, message: error && error.message || 'Provider request failed', data: error && error.data } };
      });
    });
    Promise.all(jobs).then(function (responses) {
      if (typeof callback === 'function') callback(null, Array.isArray(payload) ? responses : responses[0]);
    });
  };
  ethereum.send = function (payload, callback) {
    if (typeof payload === 'string') {
      return ethereum.request({ method: payload, params: Array.isArray(callback) ? callback : [] });
    }
    if (typeof callback === 'function') return ethereum.sendAsync(payload, callback);
    return ethereum.request({ method: payload && payload.method, params: payload && payload.params || [] }).then(function (result) {
      return { jsonrpc: '2.0', id: payload && payload.id, result: result };
    });
  };
  ethereum.on = function (event, callback) {
    if (typeof callback !== 'function') return ethereum;
    (listeners[event] || (listeners[event] = [])).push(callback);
    return ethereum;
  };
  ethereum.addListener = ethereum.on;
  ethereum.removeListener = function (event, callback) {
    var callbacks = listeners[event] || [];
    listeners[event] = callbacks.filter(function (item) { return item !== callback; });
    return ethereum;
  };
  ethereum.off = ethereum.removeListener;
  ethereum.once = function (event, callback) {
    function once(params) { ethereum.removeListener(event, once); callback(params); }
    return ethereum.on(event, once);
  };
  ethereum.removeAllListeners = function (event) {
    if (event) delete listeners[event]; else listeners = Object.create(null);
    return ethereum;
  };
  ethereum.providers = ethereum.providers || [ethereum];
  window.ethereum = ethereum;
  // Mark installation complete before dispatching discovery events. A page
  // listener may synchronously call back into this provider during discovery.
  window.__WALLET_DAPP_BRIDGE__ = true;
  window.__walletResumeProviderBridge = resume;
  // A number of older libraries still read window.web3.currentProvider.
  window.web3 = window.web3 || {};
  window.web3.currentProvider = ethereum;
  // EIP-6963 discovery lets libraries that prefer multi-provider discovery
  // find this wallet even when they do not read window.ethereum directly.
  try {
    var providerInfo = {
      uuid: 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (character) {
        var random = Math.floor(Math.random() * 16);
        return (character === 'x' ? random : (random & 3) | 8).toString(16);
      }),
      name: 'DreamKey',
      icon: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="#10183d"/><path d="M32 9 53 30 32 55 11 30Z" fill="#6ddff6"/><path d="m32 9 21 21-21 0Z" fill="#9970ff"/><path d="m32 30 21 0-21 25Z" fill="#653fe1"/><circle cx="32" cy="28" r="6" fill="#10183d"/><path d="M28.5 32h7L38 45h-12Z" fill="#10183d"/></svg>'),
      rdns: 'com.dreamkey.wallet'
    };
    window.addEventListener('eip6963:requestProvider', function () {
      window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { info: providerInfo, provider: ethereum } }));
    });
    window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { info: providerInfo, provider: ethereum } }));
  } catch (_) {}
  // Populate the legacy fields without requesting permission. eth_accounts
  // is intentionally used here; the host can return [] until the dApp calls
  // eth_requestAccounts and the user approves access.
  resume();
  true;
})();
true;
`;

function jsLiteral(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

export function createProviderResponseScript(message: ProviderResponseMessage): string {
  const guard = message.documentId === undefined ? '' : `window.__WALLET_PROVIDER_DOCUMENT_ID__ === ${jsLiteral(message.documentId)} && `;
  return `${guard}window.__walletHandleProviderResponse && window.__walletHandleProviderResponse(${jsLiteral(message)}); true;`;
}

export function createProviderReadyScript(documentId: string): string {
  return `window.__WALLET_PROVIDER_DOCUMENT_ID__ === ${jsLiteral(documentId)} && window.__walletHandleProviderResponse && window.__walletHandleProviderResponse(${jsLiteral({ type: 'wallet:provider-ready', documentId })}); true;`;
}

export function createProviderEventScript(event: string, params: unknown): string {
  const message: ProviderEventMessage = { type: 'wallet:provider-event', event, params };
  return `window.__walletHandleProviderResponse && window.__walletHandleProviderResponse(${jsLiteral(message)}); true;`;
}

/** Read the document's declared icon after a page has loaded. The native side
 * remains authoritative for the actual URL and validates the result. */
export function createPageMetadataScript(): string {
  return `(function () {
    try {
      var links = Array.prototype.slice.call(document.querySelectorAll('link[rel]'));
      var icon = links.find(function (entry) {
        var rel = String(entry.getAttribute('rel') || '').toLowerCase().split(/\\s+/);
        return rel.indexOf('icon') >= 0 || rel.indexOf('shortcut') >= 0 || rel.indexOf('apple-touch-icon') >= 0;
      });
      var message = { type: 'wallet:page-metadata', url: String(window.location.href || ''), title: String(document.title || '') };
      if (icon && icon.href) message.faviconUrl = String(icon.href);
      if (window.ReactNativeWebView && typeof window.ReactNativeWebView.postMessage === 'function') {
        window.ReactNativeWebView.postMessage(JSON.stringify(message));
      }
    } catch (_) {}
    true;
  })(); true;`;
}

export function parseBridgeMessage(raw: unknown): DappBridgeMessage | undefined {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    if (raw.length > 262144) return undefined;
    try { value = JSON.parse(raw); } catch { return undefined; }
  }
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Record<string, unknown>;
  if (candidate.type === 'wallet:provider-ready' && typeof candidate.documentId === 'string' && candidate.documentId.length > 0) {
    return { type: 'wallet:provider-ready', documentId: candidate.documentId };
  }
  if (candidate.type === 'wallet:page-metadata' && typeof candidate.url === 'string') {
    return {
      type: 'wallet:page-metadata',
      url: candidate.url,
      title: typeof candidate.title === 'string' ? candidate.title : undefined,
      faviconUrl: typeof candidate.faviconUrl === 'string' ? candidate.faviconUrl : undefined,
    };
  }
  if (candidate.type === REQUEST_METHOD && typeof candidate.id === 'string' && candidate.id.length > 0 && candidate.id.length <= 256 && candidate.request && typeof candidate.request === 'object' && !Array.isArray(candidate.request)) {
    const request = candidate.request as Record<string, unknown>;
    if (typeof request.method !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_]{0,127}$/.test(request.method)) return undefined;
    return { type: 'wallet:provider-request', id: candidate.id, documentId: typeof candidate.documentId === 'string' ? candidate.documentId : undefined, request: request as unknown as Eip1193RequestArguments };
  }
  return undefined;
}

export function providerError(error: unknown): { code?: number; message: string; data?: unknown } {
  if (error && typeof error === 'object') {
    const value = error as Record<string, unknown>;
    return {
      code: typeof value.code === 'number' ? value.code : undefined,
      message: typeof value.message === 'string' ? value.message : 'Provider request failed',
      data: value.data,
    };
  }
  return { message: error instanceof Error ? error.message : String(error) };
}
