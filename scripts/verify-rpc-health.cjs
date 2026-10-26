/* Probe the real endpoint health store with controlled public-only responses. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
function fixture() {
  const modules = new Map(), calls = [], timers = new Set();
  let clock = 10_000, fetchImpl = () => { throw new Error('No response configured'); };
  class TestDate extends Date { static now() { return clock; } }
  function load(relative) {
    const filename = path.resolve(__dirname, '..', relative);
    if (modules.has(filename)) return modules.get(filename).exports;
    const module = { exports: {} }; modules.set(filename, module);
    const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    vm.runInNewContext(code, {
      module, exports: module.exports, URL, AbortController, Date: TestDate,
      setTimeout(callback) { const timer = { callback }; timers.add(timer); return timer; },
      clearTimeout(timer) { timers.delete(timer); },
      fetch(url, init) { calls.push({ url, init }); return fetchImpl(url, init); },
      require(name) { assert.ok(name.startsWith('.')); return load(path.relative(path.resolve(__dirname, '..'), path.resolve(path.dirname(filename), name.replace(/\.js$/, '.ts')))); },
    }, { filename });
    return module.exports;
  }
  return {
    cache: load('src/core/rpc-endpoints.ts'), calls, timers,
    setFetch(callback) { fetchImpl = callback; },
    advance(ms) { clock += ms; },
    expire() { for (const timer of [...timers]) { timers.delete(timer); timer.callback(); } },
  };
}
const url = 'https://bsc.mytokenpocket.vip';
const reply = (result = '0x38', options = {}) => ({ ok: options.ok ?? true, json: async () => options.body ?? ({ jsonrpc: '2.0', id: 1, result }) });
const flush = async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); };

async function main() {
  const f = fixture();
  assert.equal(f.cache.getRpcEndpointHealth(56, url), f.cache.getRpcEndpointHealth(56, url), 'Unknown snapshots have stable identity for React subscriptions');
  let notified = 0, other = 0;
  const unsubscribe = f.cache.subscribeRpcEndpointHealth(56, url, () => { notified += 1; });
  const unsubscribeOther = f.cache.subscribeRpcEndpointHealth(1, url, () => { other += 1; });
  f.setFetch(async () => { f.advance(109); return reply(); });
  const healthy = await f.cache.probeRpcEndpoint(56, url);
  assert.equal(healthy.status, 'ok'); assert.equal(healthy.latencyMs, 109);
  assert.equal(f.cache.getRpcEndpointHealth(56, url), healthy);
  assert.equal(notified, 1); assert.equal(other, 0);
  const payload = JSON.parse(f.calls[0].init.body);
  assert.equal(payload.method, 'eth_chainId'); assert.equal(payload.params.length, 0);
  assert.equal(f.calls[0].init.credentials, 'omit'); assert.equal(f.calls[0].init.redirect, 'error');

  f.setFetch(async () => { f.advance(900); return reply(); });
  const slow = await f.cache.probeRpcEndpoint(56, url);
  assert.equal(slow.status, 'slow'); assert.equal(slow.latencyMs, 900);
  for (const response of [
    reply('0x38', { ok: false }), reply('0x1'),
    reply('0x38', { body: { jsonrpc: '2.0', id: 2, result: '0x38' } }),
    reply('0x38', { body: { id: 1, result: '0x38' } }),
    reply('0x38', { body: { jsonrpc: '2.0', id: 1, result: '0x38', error: { code: -32000, message: 'Unavailable' } } }),
    reply('0x38', { body: [{ jsonrpc: '2.0', id: 1, result: '0x38' }] }),
    { ok: true, json: async () => { throw new Error('Malformed JSON'); } },
  ]) {
    f.setFetch(async () => { f.advance(109); return response; });
    const unavailable = await f.cache.probeRpcEndpoint(56, url);
    assert.equal(unavailable.status, 'offline');
    assert.equal(unavailable.latencyMs, undefined, 'Fast error responses never masquerade as usable latency');
    assert.equal(f.cache.getRpcEndpointHealth(56, url).latencyMs, undefined, 'Failure replaces an older successful measurement');
  }

  const pending = deferred();
  f.setFetch(() => pending.promise);
  const one = f.cache.probeRpcEndpoint(56, url), two = f.cache.probeRpcEndpoint(56, url);
  assert.equal(one, two, 'Home and picker share one in-flight probe');
  pending.resolve(reply()); await one;
  const notifications = notified;
  unsubscribe(); unsubscribeOther();
  await f.cache.probeRpcEndpoint(56, url);
  assert.equal(notified, notifications, 'Unmounted consumers no longer receive measurements');

  const blockedCalls = f.calls.length;
  assert.equal((await f.cache.probeRpcEndpoint(56, 'https://private.invalid')).status, 'offline');
  assert.equal(f.calls.length, blockedCalls);
  assert.equal(f.timers.size, 0);
  const beforeThrow = f.calls.length;
  f.setFetch(() => { throw new Error('Synchronous native fetch failure'); });
  assert.equal((await f.cache.probeRpcEndpoint(56, url)).status, 'offline');
  assert.equal((await f.cache.probeRpcEndpoint(56, url)).status, 'offline');
  assert.equal(f.calls.length, beforeThrow + 2, 'A synchronous throw cannot poison the singleflight slot');

  // Native fetch/body decoding may ignore AbortSignal: the deadline must still
  // settle and a later response must not change the completed offline result.
  for (const hangingBody of [false, true]) {
    const hung = fixture(), gate = deferred();
    hung.setFetch(() => hangingBody ? Promise.resolve({ ok: true, json: () => gate.promise }) : gate.promise);
    const probe = hung.cache.probeRpcEndpoint(56, url);
    await flush(); hung.expire();
    const unavailable = await probe;
    assert.equal(unavailable.status, 'offline'); assert.equal(unavailable.latencyMs, undefined);
    assert.equal(hung.calls[0].init.signal.aborted, true);
    gate.resolve(hangingBody ? { jsonrpc: '2.0', id: 1, result: '0x38' } : reply());
    await flush();
    assert.equal(hung.cache.getRpcEndpointHealth(56, url), unavailable, 'Late timeout results do not republish stale health');
    hung.setFetch(() => Promise.resolve(reply()));
    assert.equal((await hung.cache.probeRpcEndpoint(56, url)).status, 'ok', 'A timeout releases the in-flight slot for a later probe');
  }
  console.log('RPC health verification passed: shared live snapshots, 109ms success, slow usability, invalid/error response rejection, timeout/body deadlines, singleflight and lifecycle isolation. Offline public fixtures only.');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
