/* Verify automatic pool status and strict manual status with public offline fixtures. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const urls = [
  'https://bsc.mytokenpocket.vip',
  'https://bsc-rpc.publicnode.com',
  'https://bsc-dataseed1.bnbchain.org',
  'https://bsc-dataseed1.defibit.io',
  'https://api.zan.top/bsc-mainnet',
];
const flush = async () => { for (let index = 0; index < 20; index += 1) await Promise.resolve(); };
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
function fixture() {
  const modules = new Map(), calls = [], timers = new Set();
  let clock = 10_000, active = 0, maximum = 0;
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
      fetch(url, init) {
        const gate = deferred();
        active += 1; maximum = Math.max(maximum, active);
        let settled = false;
        const request = {
          url, init,
          respond({ latencyMs = 100, ok = true, result = '0x38' } = {}) {
            assert.equal(settled, false, 'Each fixture response completes once'); settled = true;
            clock += latencyMs; active -= 1;
            gate.resolve({ ok, json: async () => ({ jsonrpc: '2.0', id: 1, result }) });
          },
        };
        calls.push(request);
        return gate.promise;
      },
      require(name) {
        assert.ok(name.startsWith('.'), `Unexpected RPC route-health dependency: ${name}`);
        return load(path.relative(path.resolve(__dirname, '..'), path.resolve(path.dirname(filename), name.replace(/\.js$/, '.ts'))));
      },
    }, { filename });
    return module.exports;
  }
  const endpoints = load('src/core/rpc-endpoints.ts');
  return {
    endpoints, calls, timers,
    get maximum() { return maximum; },
    async seed(url, options = {}) {
      const request = endpoints.probeRpcEndpoint(56, url);
      calls.at(-1).respond(options);
      return request;
    },
  };
}

async function main() {
  const f = fixture(), { endpoints } = f;
  assert.equal(typeof endpoints.getRpcEndpointsHealth, 'function');
  assert.equal(typeof endpoints.probeRpcEndpoints, 'function');
  const unknown = endpoints.getRpcEndpointsHealth(56, urls);
  assert.equal(unknown.status, 'unknown');
  assert.equal(endpoints.getRpcEndpointsHealth(56, urls), unknown, 'Unknown aggregate snapshots remain stable for React subscriptions');
  const unavailable = await f.seed(urls[0], { ok: false });
  assert.equal(endpoints.getRpcEndpointsHealth(56, urls).status, 'unknown', 'One failed primary does not mark untested fallbacks offline');
  const slow = await f.seed(urls[1], { latencyMs: 940 });
  assert.equal(endpoints.getRpcEndpointsHealth(56, urls), slow, 'An available slow fallback makes the automatic route usable/yellow');
  const healthy = await f.seed(urls[2], { latencyMs: 109 });
  assert.equal(endpoints.getRpcEndpointsHealth(56, urls), healthy, 'A healthy backup makes automatic status green despite a red primary');
  assert.equal(endpoints.getRpcEndpointsHealth(56, urls), endpoints.getRpcEndpointsHealth(56, [...urls]), 'Equivalent route snapshots return the same health object');
  const faster = await f.seed(urls[3], { latencyMs: 42 });
  assert.equal(endpoints.getRpcEndpointsHealth(56, urls), faster, 'The fastest healthy measurement supplies the pool status');
  assert.equal(endpoints.getRpcEndpointsHealth(56, [urls[0]]), unavailable, 'Manual status includes only the selected red node even with green backups cached');
  assert.equal(endpoints.getPreferredRpcEndpoint(56), undefined, 'Measuring never changes routing preferences');
  endpoints.setPreferredRpcEndpoint(56, urls[0]);
  assert.equal(endpoints.getRpcEndpointsHealth(56, [urls[0]]).status, 'offline');
  assert.equal(endpoints.getPreferredRpcEndpoint(56), urls[0], 'An offline manual route remains selected');
  endpoints.clearPreferredRpcEndpoint(56);
  assert.equal(endpoints.getRpcEndpointsHealth(56, urls).status, 'ok', 'Returning to Automatic reuses healthy pool state');

  const failed = fixture();
  for (const url of urls) await failed.seed(url, { ok: false });
  assert.equal(failed.endpoints.getRpcEndpointsHealth(56, urls).status, 'offline', 'The pool is red only after every candidate failed');
  assert.equal(failed.endpoints.getRpcEndpointsHealth(56, urls), failed.endpoints.getRpcEndpointsHealth(56, urls));

  const bounded = fixture();
  const pending = bounded.endpoints.probeRpcEndpoints(56, [...urls, urls[0]]);
  await flush();
  assert.equal(bounded.calls.length, 2, 'At most two lightweight probes start together');
  bounded.calls[0].respond({ ok: false }); await flush();
  assert.equal(bounded.calls.length, 3, 'A failed slot advances to the next candidate');
  bounded.calls[1].respond({ latencyMs: 109 });
  const result = await pending;
  assert.equal(result.status, 'ok');
  bounded.calls[2].respond({ ok: false }); await flush();
  assert.equal(bounded.calls.length, 3, 'No further probes start after an available node is found');
  assert.equal(bounded.maximum, 2);
  assert.equal(bounded.calls.filter((call) => call.url === urls[0]).length, 1, 'Duplicate route URLs are measured once');
  assert.equal(bounded.timers.size, 0);
  assert.equal(bounded.endpoints.getPreferredRpcEndpoint(56), undefined);

  const allDown = fixture();
  const noRoute = allDown.endpoints.probeRpcEndpoints(56, [...urls, urls[0], urls[1]]);
  await flush();
  for (let index = 0; index < urls.length; index += 1) {
    assert.ok(allDown.calls[index], `Expected bounded fallback probe ${index}`);
    allDown.calls[index].respond({ ok: false }); await flush();
  }
  assert.equal((await noRoute).status, 'offline');
  assert.equal(allDown.calls.length, urls.length);
  assert.equal(allDown.maximum, 2);

  const manual = fixture();
  const manualProbe = manual.endpoints.probeRpcEndpoints(56, [urls[0]]);
  await flush();
  assert.equal(manual.calls.length, 1);
  manual.calls[0].respond({ ok: false });
  assert.equal((await manualProbe).status, 'offline');
  assert.equal(manual.calls.length, 1, 'Single-node/manual checks never probe a fallback');

  const shared = fixture();
  let notified = 0;
  const stop = shared.endpoints.subscribeRpcEndpointHealth(56, urls[1], () => { notified += 1; });
  const one = shared.endpoints.probeRpcEndpoints(56, urls.slice(0, 2));
  const two = shared.endpoints.probeRpcEndpoints(56, urls.slice(0, 2));
  await flush();
  assert.equal(shared.calls.length, 2, 'Concurrent pool checks share per-node requests');
  shared.calls[0].respond({ ok: false }); shared.calls[1].respond({ latencyMs: 940 });
  assert.equal((await one).status, 'slow'); assert.equal((await two).status, 'slow');
  assert.equal(notified, 1, 'Fallback completion is observable through the shared health subscription');
  assert.equal(shared.timers.size, 0); stop();
  console.log('RPC route-health verification passed: automatic backup availability, red only after all failures, slow usability, stable snapshots, strict manual status, bounded/deduplicated early-stop probes and shared subscriptions. Offline public fixtures only.');
}
const watchdog = setTimeout(() => { console.error('RPC route-health verification stalled'); process.exitCode = 1; }, 10_000);
main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => clearTimeout(watchdog));
