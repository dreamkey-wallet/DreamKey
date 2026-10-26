/* Offline startup/cache/foreground scheduling checks. No user storage or network. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const interval = 6 * 60 * 60 * 1000;
const initialNow = 1_800_000_000_000;
const snapshot = (updatedAt = initialNow) => ({ version: 1, updatedAt, chains: { '56': ['https://bsc-rpc.publicnode.com'] } });
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function compile(file, require, globals = {}) {
  const module = { exports: {} };
  const compiled = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(compiled, { module, exports: module.exports, require, AbortController, ...globals }, { filename: file });
  return module.exports;
}

function fixture(options = {}) {
  let current = initialNow, nextTimer = 1, listener, removed = 0;
  const timers = new Map(), calls = [], applied = [], saved = [];
  const refresh = options.refresh ?? (async () => snapshot(current));
  const storage = {
    async read() { if (options.hangRead) return new Promise(() => {}); if (options.failRead) throw new Error('Public cache fixture failed'); return options.saved ?? null; },
    async write(value) { saved.push(value); if (options.hangWrite) return new Promise(() => {}); },
  };
  const { startRpcCatalogService } = compile('src/native/rpc-catalog-service.ts', (name) => {
    if (name === '../config/rpc.js') return { RPC_CATALOG_REFRESH_MS: interval };
    if (name === '../core/rpc-catalog.js') return { refreshRpcCatalog: refresh };
    if (name === '../core/rpc-endpoints.js') return { applyRpcEndpointSnapshot: () => true };
    if (name === './app-visibility.js') return { subscribeAppVisibility() {} };
    if (name === './rpc-catalog-storage.js') return { rpcCatalogStorage: storage };
    throw new Error(`Unexpected service dependency: ${name}`);
  }, {
    setTimeout(callback, delay) { const id = nextTimer++; timers.set(id, { callback, due: current + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  const stop = startRpcCatalogService({
    storage, now: () => current,
    visibility(callback) { listener = callback; callback('foreground'); return () => { removed++; }; },
    apply(value) { applied.push(value); return true; },
    async refresh(previous, init) { calls.push({ previous, signal: init.signal }); return refresh(previous, init); },
  });
  return {
    calls, applied, saved, stop, timers, get removed() { return removed; },
    visibility(state) { listener(state); },
    async advance(ms) {
      const end = current + ms;
      await flush();
      while (true) {
        const next = [...timers].sort((a, b) => a[1].due - b[1].due).find((entry) => entry[1].due <= end);
        if (!next) break;
        current = next[1].due; timers.delete(next[0]); next[1].callback(); await flush();
      }
      current = end; await flush();
    },
  };
}

async function verifyService() {
  const fresh = fixture({ saved: snapshot() });
  await fresh.advance(3000);
  assert.equal(fresh.calls.length, 0, 'Fresh persisted config avoids a startup directory request');
  assert.equal(fresh.applied.length, 1);
  await fresh.advance(interval);
  assert.equal(fresh.calls.length, 1);
  assert.equal(fresh.saved.length, 1);
  fresh.visibility('background');
  await fresh.advance(interval * 2);
  assert.equal(fresh.calls.length, 1, 'No background directory requests or timers');
  fresh.visibility('foreground'); await fresh.advance(3000);
  assert.equal(fresh.calls.length, 2, 'A due refresh resumes after foreground startup delay');
  fresh.stop(); assert.equal(fresh.removed, 1); assert.equal(fresh.timers.size, 0);

  const cold = fixture({ failRead: true });
  await cold.advance(2999); assert.equal(cold.calls.length, 0);
  await cold.advance(1); assert.equal(cold.calls.length, 1, 'Local cache failure still permits the delayed refresh'); cold.stop();

  const failure = fixture({ saved: snapshot(initialNow - interval * 2), refresh: async () => { throw new Error('Directory unavailable'); } });
  await failure.advance(3000);
  assert.equal(failure.calls.length, 1); assert.equal(failure.applied.length, 1);
  assert.equal(failure.saved.length, 0, 'Directory outage never deletes the last known configuration');
  await failure.advance(15 * 60 * 1000); assert.equal(failure.calls.length, 2, 'Outages use a 15-minute retry backoff'); failure.stop();

  const pending = deferred(); const stopped = fixture({ refresh: () => pending.promise });
  await stopped.advance(3000); stopped.visibility('background');
  assert.equal(stopped.calls[0].signal.aborted, true);
  pending.resolve(snapshot()); await flush();
  assert.equal(stopped.saved.length, 0); assert.equal(stopped.applied.length, 0, 'Late work after backgrounding cannot install configuration');
  stopped.stop(); assert.equal(stopped.timers.size, 0);

  const hanging = fixture({ refresh: () => new Promise(() => {}) });
  await hanging.advance(3000 + 60_000);
  assert.equal(hanging.calls.length, 1); assert.equal(hanging.calls[0].signal.aborted, true);
  await hanging.advance(15 * 60 * 1000);
  assert.equal(hanging.calls.length, 2, 'A transport that ignores AbortSignal cannot hold the refresh service forever'); hanging.stop();

  const hangingRead = fixture({ hangRead: true });
  await hangingRead.advance(6000);
  assert.equal(hangingRead.calls.length, 1, 'A stalled device cache cannot disable online refresh forever'); hangingRead.stop();
  const hangingWrite = fixture({ hangWrite: true });
  await hangingWrite.advance(6000 + interval);
  assert.equal(hangingWrite.calls.length, 2, 'A stalled cache write cannot hold the refresh lock forever'); hangingWrite.stop();
}

async function verifyStorage() {
  const writes = []; let saved = null;
  const expectedService = 'dreamkey.rpc-endpoints.v1';
  const { rpcCatalogStorage } = compile('src/native/rpc-catalog-storage.ts', (name) => {
    if (name === 'react-native-keychain') return {
      ACCESSIBLE: { WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'device' },
      async getGenericPassword(options) { assert.equal(options.service, expectedService); return saved; },
      async setGenericPassword(username, password, options) { writes.push({ username, password, options }); return true; },
    };
    if (name === '../core/rpc-endpoints.js') return { parseRpcEndpointSnapshot(value) { return value?.version === 1 && typeof value.updatedAt === 'number' ? value : null; } };
    throw new Error(`Unexpected storage dependency: ${name}`);
  });
  assert.equal(await rpcCatalogStorage.read(), null);
  saved = { password: '{bad' }; assert.equal(await rpcCatalogStorage.read(), null);
  saved = { password: 'x'.repeat(65 * 1024) }; assert.equal(await rpcCatalogStorage.read(), null);
  saved = { password: JSON.stringify(snapshot()) }; assert.equal((await rpcCatalogStorage.read()).updatedAt, initialNow);
  await rpcCatalogStorage.write(snapshot());
  assert.equal(writes.length, 1); assert.equal(writes[0].options.service, expectedService);
  assert.equal(writes[0].options.accessible, 'device'); assert.equal(writes[0].options.accessControl, undefined, 'Public config writes must not show biometric dialogs');
  await rpcCatalogStorage.write({ version: 2 }); assert.equal(writes.length, 1);
}

(async () => { await verifyService(); await verifyStorage(); console.log('RPC catalog service verification passed: cached startup, foreground refresh, interval/backoff, cancellation/deadline and isolated public config persistence.'); })()
  .catch((error) => { console.error(error); process.exitCode = 1; });
