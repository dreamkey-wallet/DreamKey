/* Offline RPC transport checks. No user keys, real nodes or broadcasts. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');
const { keccak256, Wallet, Transaction } = require('ethers');
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'wallet-rpc-'));
for (const name of ['rpc-provider', 'rpc-broadcast']) {
  const input = fs.readFileSync(path.join(__dirname, '..', `src/core/${name}.ts`), 'utf8');
  const compiled = ts.transpileModule(input, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
  fs.writeFileSync(path.join(output, `${name}.js`), compiled.replace(/require\("ethers"\)/g, `require(${JSON.stringify(require.resolve('ethers'))})`));
}
// Catalog discovery has its own checks. This replaceable fixture proves an
// existing pool sees new catalog snapshots without replacing its identity.
fs.writeFileSync(path.join(output, 'rpc-endpoints.js'), `exports.urls = null; exports.getRpcEndpointUrls = (n) => exports.urls ?? [n.rpcUrl, ...(n.rpcFallbackUrls ?? [])];`);
const catalog = require(path.join(output, 'rpc-endpoints.js'));
const { VerifiedRpcProvider, createVerifiedRpcTransport } = require(path.join(output, 'rpc-provider.js'));
const { getUncertainBroadcastHash } = require(path.join(output, 'rpc-broadcast.js'));
const primary = 'https://primary.invalid';
const backup = 'https://backup.invalid';
const network = { rpcUrl: primary, rpcFallbackUrls: [backup], chainId: 56, name: 'Fixture' };
const raw = '0x010203040506';
const rawHash = keccak256(raw);
let nextId = 1;
function envelope(payload, result) { return { jsonrpc: '2.0', id: payload.id, result }; }
function errorEnvelope(payload, error) { return { jsonrpc: '2.0', id: payload.id, error }; }
function response(body) { return { ok: true, status: 200, json: async () => body }; }
function fetchFixture(behavior) {
  const calls = [];
  const fetch = async (url, init) => { const payload = JSON.parse(init.body); calls.push({ url, ...payload }); return behavior(url, payload, init); };
  return { fetch, calls };
}
function abortableDelay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted fixture'));
    const onAbort = () => { clearTimeout(timer); reject(new Error('aborted fixture')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, milliseconds);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
async function request(transport, method, params = []) {
  const payload = { jsonrpc: '2.0', id: nextId++, method, params };
  const reply = await transport(primary, { method: 'POST', headers: {}, body: JSON.stringify(payload) });
  const body = await reply.json();
  assert.equal(body.id, payload.id, 'RPC request ids are preserved');
  return body;
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function verify() {
  // Slow reads race one backup; canceling the loser does not poison its health.
  let now = 1000;
  let backupFails = false;
  const fast = fetchFixture(async (url, payload, init) => {
    if (payload.method === 'eth_chainId') return response(envelope(payload, '0x38'));
    if (url === backup && backupFails) throw new Error('fixture offline');
    if (url === primary) await abortableDelay(20, init.signal);
    return response(envelope(payload, url === backup ? '0x42' : '0x41'));
  });
  const transport = createVerifiedRpcTransport(network, { fetch: fast.fetch, timeoutMs: 100, hedgeDelayMs: 2, now: () => now });
  assert.equal((await request(transport, 'eth_getBalance')).result, '0x42');
  assert.deepEqual(fast.calls.filter((call) => call.method === 'eth_getBalance').map((call) => call.url), [primary, backup]);
  await tick();

  // Transaction lookups treat a null result as a soft miss. A history indexer
  // can expose a hash before the currently preferred RPC has propagated it;
  // the backup must still be queried for both the transaction and its receipt.
  const lookupHash = `0x${'1'.repeat(64)}`;
  const lookup = fetchFixture(async (url, payload) => {
    if (payload.method === 'eth_chainId') return response(envelope(payload, '0x38'));
    if (url === primary && (payload.method === 'eth_getTransactionByHash' || payload.method === 'eth_getTransactionReceipt')) {
      return response(envelope(payload, null));
    }
    if (payload.method === 'eth_getTransactionByHash') return response(envelope(payload, { hash: lookupHash }));
    if (payload.method === 'eth_getTransactionReceipt') return response(envelope(payload, { transactionHash: lookupHash, status: '0x1' }));
    return response(envelope(payload, null));
  });
  const lookupTransport = createVerifiedRpcTransport(network, { fetch: lookup.fetch, hedgeDelayMs: 1 });
  assert.deepEqual((await request(lookupTransport, 'eth_getTransactionByHash', [lookupHash])).result, { hash: lookupHash });
  assert.deepEqual((await request(lookupTransport, 'eth_getTransactionReceipt', [lookupHash])).result, { transactionHash: lookupHash, status: '0x1' });
  assert.ok(lookup.calls.some((call) => call.url === primary && call.method === 'eth_getTransactionByHash'));
  assert.ok(lookup.calls.some((call) => call.url === backup && call.method === 'eth_getTransactionByHash'));
  const receiptLookup = fetchFixture(async (url, payload) => {
    if (payload.method === 'eth_chainId') return response(envelope(payload, '0x38'));
    if (url === primary && payload.method === 'eth_getTransactionReceipt') return response(envelope(payload, null));
    if (payload.method === 'eth_getTransactionReceipt') return response(envelope(payload, { transactionHash: lookupHash, status: '0x1' }));
    return response(envelope(payload, null));
  });
  const receiptTransport = createVerifiedRpcTransport(network, { fetch: receiptLookup.fetch, hedgeDelayMs: 1 });
  assert.deepEqual((await request(receiptTransport, 'eth_getTransactionReceipt', [lookupHash])).result, { transactionHash: lookupHash, status: '0x1' });
  assert.ok(receiptLookup.calls.some((call) => call.url === primary && call.method === 'eth_getTransactionReceipt'));
  assert.ok(receiptLookup.calls.some((call) => call.url === backup && call.method === 'eth_getTransactionReceipt'));
  const missingLookup = fetchFixture(async (_url, payload) => payload.method === 'eth_chainId'
    ? response(envelope(payload, '0x38')) : response(envelope(payload, null)));
  assert.equal((await request(createVerifiedRpcTransport(network, { fetch: missingLookup.fetch, hedgeDelayMs: 1 }), 'eth_getTransactionByHash', [lookupHash])).result, null,
    'all transaction nodes missing the hash still return a genuine null');
  const definiteLookupError = { code: -32000, message: 'execution reverted' };
  const errorLookup = fetchFixture(async (_url, payload) => payload.method === 'eth_chainId'
    ? response(envelope(payload, '0x38')) : response(errorEnvelope(payload, definiteLookupError)));
  assert.deepEqual((await request(createVerifiedRpcTransport(network, { fetch: errorLookup.fetch }), 'eth_getTransactionReceipt', [lookupHash])).error, definiteLookupError,
    'definitive transaction lookup errors are preserved');
  assert.equal(errorLookup.calls.filter((call) => call.method === 'eth_getTransactionReceipt').length, 1,
    'definitive lookup errors do not fan out to another endpoint');

  // Canceling a loser during chain validation aborts its native request too,
  // without imposing a failure cooldown. Another live waiter keeps a shared
  // verification alive until it has finished (the parallel-read case below).
  let backupOffline = false;
  const canceledValidation = fetchFixture(async (url, payload, init) => {
    if (url === backup && backupOffline) throw new Error('backup offline');
    if (url === primary && payload.method === 'eth_chainId') await abortableDelay(12, init.signal);
    return response(envelope(payload, payload.method === 'eth_chainId' ? '0x38' : '0x9'));
  });
  const canceledTransport = createVerifiedRpcTransport(network, { fetch: canceledValidation.fetch, timeoutMs: 40, hedgeDelayMs: 1 });
  await request(canceledTransport, 'eth_getBalance');
  await tick();
  backupOffline = true;
  canceledValidation.calls.length = 0;
  assert.equal((await request(canceledTransport, 'eth_blockNumber')).result, '0x9');
  assert.ok(canceledValidation.calls.some((call) => call.url === primary && call.method === 'eth_chainId'), 'a canceled chain check is retried instead of cooling down');
  fast.calls.length = 0;
  assert.equal((await request(transport, 'eth_blockNumber')).result, '0x42');
  assert.equal(fast.calls[0].url, backup, 'healthy winner is preferred');
  assert.equal(fast.calls.length, 1, 'recent chain validation is reused for reads');
  backupFails = true;
  fast.calls.length = 0;
  assert.equal((await request(transport, 'eth_blockNumber')).result, '0x41', 'canceled former loser remains eligible');
  assert.deepEqual(fast.calls.filter((call) => call.method === 'eth_blockNumber').map((call) => call.url), [backup, primary]);

  // A five-node pool never opens more than two competing fetches, even while
  // both initial nodes hang during chain validation, then proceeds to backups.
  const manyUrls = [primary, backup, 'https://third.invalid', 'https://fourth.invalid', 'https://fifth.invalid'];
  let inFlight = 0;
  let maximum = 0;
  const concurrent = fetchFixture(async (url, payload, init) => {
    inFlight += 1;
    maximum = Math.max(maximum, inFlight);
    try {
      if (url === primary || url === backup) await abortableDelay(100, init.signal);
      if (payload.method === 'eth_chainId') return response(envelope(payload, '0x38'));
      return response(envelope(payload, '0x7'));
    } finally { inFlight -= 1; }
  });
  const capped = createVerifiedRpcTransport({ ...network, rpcFallbackUrls: manyUrls.slice(1) }, { fetch: concurrent.fetch, timeoutMs: 20, hedgeDelayMs: 1 });
  assert.equal((await request(capped, 'eth_blockNumber')).result, '0x7');
  assert.ok(maximum <= 2, `only two requests may race; observed ${maximum}`);
  assert.ok(concurrent.calls.some((call) => call.url === manyUrls[2]));
  await tick();

  // Parallel wallet/Dapp reads coalesce chain verification per endpoint.
  const shared = fetchFixture(async (_url, payload) => {
    if (payload.method === 'eth_chainId') await new Promise((resolve) => setTimeout(resolve, 3));
    return response(envelope(payload, payload.method === 'eth_chainId' ? '0x38' : '0x0'));
  });
  const sharedTransport = createVerifiedRpcTransport({ ...network, rpcFallbackUrls: [] }, { fetch: shared.fetch });
  await Promise.all(Array.from({ length: 6 }, () => request(sharedTransport, 'eth_getBalance')));
  assert.equal(shared.calls.filter((call) => call.method === 'eth_chainId').length, 1);
  shared.calls.length = 0;
  await request(sharedTransport, 'eth_chainId');
  assert.equal(shared.calls.length, 1, 'direct chain requests validate their own response');

  // Consecutive failures back off 30s, 60s, up to the configured ceiling.
  now = 1000;
  const failed = fetchFixture(async () => { throw new Error('fixture offline'); });
  const cooling = createVerifiedRpcTransport({ ...network, rpcFallbackUrls: [] }, { fetch: failed.fetch, now: () => now, cooldownMs: 30, maxCooldownMs: 60 });
  await assert.rejects(request(cooling, 'eth_chainId'), /connection failed/);
  // A completely cooled pool permits one shared recovery probe immediately,
  // then throttles probes until the recovery window expires.
  await assert.rejects(request(cooling, 'eth_chainId'), /connection failed/);
  await assert.rejects(request(cooling, 'eth_chainId'), /temporarily unavailable/);
  assert.equal(failed.calls.length, 2);
  now += 30;
  await assert.rejects(request(cooling, 'eth_chainId'), /connection failed/);
  now += 30;
  await assert.rejects(request(cooling, 'eth_chainId'), /connection failed/);
  now += 30;
  await assert.rejects(request(cooling, 'eth_chainId'), /connection failed/);
  now += 60;
  await assert.rejects(request(cooling, 'eth_chainId'), /connection failed/);
  assert.equal(failed.calls.length, 6, 'cooldown backoff and bounded recovery probes respect the ceiling');

  // Wrong-chain nodes are isolated for subsequent requests, and are never
  // trusted with balances or signed transaction bytes.
  const wrong = fetchFixture(async (url, payload) => response(envelope(payload, payload.method === 'eth_chainId' ? (url === primary ? '0x1' : '0x38') : '0x88')));
  const wrongTransport = createVerifiedRpcTransport(network, { fetch: wrong.fetch, hedgeDelayMs: 1 });
  assert.equal((await request(wrongTransport, 'eth_getBalance')).result, '0x88');
  assert.equal(wrong.calls.some((call) => call.url === primary && call.method === 'eth_getBalance'), false);
  wrong.calls.length = 0;
  await request(wrongTransport, 'eth_blockNumber');
  assert.equal(wrong.calls.some((call) => call.url === primary), false, 'wrong-chain quarantine survives later reads');
  for (const chain of [56, '56', '0xzz', '0x1']) {
    const fixture = fetchFixture(async (_url, payload) => response(envelope(payload, chain)));
    const guarded = createVerifiedRpcTransport({ ...network, rpcFallbackUrls: [] }, { fetch: fixture.fetch });
    await assert.rejects(request(guarded, 'eth_sendRawTransaction', [raw]), (error) => /RPC chain/.test(error.message) && !getUncertainBroadcastHash(error));
    assert.equal(fixture.calls.length, 1);
    assert.equal(fixture.calls.some((call) => call.method === 'eth_sendRawTransaction'), false);
  }
  const malformed = createVerifiedRpcTransport({ ...network, rpcFallbackUrls: [] }, { fetch: async (_url, init) => response({ ...envelope(JSON.parse(init.body), '0x38'), id: 999999 }) });
  await assert.rejects(request(malformed, 'eth_chainId'), /invalid response/);

  // Even an unending response.json is bounded by the complete post timeout.
  const hanging = fetchFixture(async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) }));
  const bounded = createVerifiedRpcTransport(network, { fetch: hanging.fetch, timeoutMs: 15, hedgeDelayMs: 1 });
  await assert.rejects(request(bounded, 'eth_chainId'), /timed out/);
  assert.equal(hanging.calls.length, 2);

  // Availability envelopes enter cooldown and fall back. Definite errors,
  // including reverts with data, preserve the exact server error and node.
  const serviceErrors = [
    { code: -32046, message: 'Cannot fulfill request' },
    { code: -32603, message: 'Internal error' },
  ];
  for (const serviceError of serviceErrors) {
    const service = fetchFixture(async (url, payload) => response(payload.method === 'eth_chainId' ? envelope(payload, '0x38') : url === primary ? errorEnvelope(payload, serviceError) : envelope(payload, '0x99')));
    const serviceTransport = createVerifiedRpcTransport(network, { fetch: service.fetch, hedgeDelayMs: 100 });
    assert.equal((await request(serviceTransport, 'eth_getBalance')).result, '0x99');
    service.calls.length = 0;
    await request(serviceTransport, 'eth_blockNumber');
    assert.equal(service.calls.some((call) => call.url === primary), false);
    const allService = fetchFixture(async (_url, payload) => response(payload.method === 'eth_chainId' ? envelope(payload, '0x38') : errorEnvelope(payload, serviceError)));
    assert.deepEqual((await request(createVerifiedRpcTransport(network, { fetch: allService.fetch }), 'eth_blockNumber')).error, serviceError);
  }
  // Public RPCs also report rate limits, overloads and upstream timeouts with
  // provider-specific codes/messages. These are endpoint failures and should
  // enter cooldown so a healthy independent node can answer the same read.
  const transientErrors = [
    { code: -32005, message: 'limit exceeded' },
    { code: -32000, message: 'rate limit exceeded' },
    { code: -32000, message: 'temporarily unavailable' },
    { code: -32603, message: 'upstream timeout' },
  ];
  for (const transientError of transientErrors) {
    const transient = fetchFixture(async (url, payload) => response(payload.method === 'eth_chainId'
      ? envelope(payload, '0x38')
      : url === primary ? errorEnvelope(payload, transientError) : envelope(payload, '0x99')));
    const transientTransport = createVerifiedRpcTransport(network, { fetch: transient.fetch, hedgeDelayMs: 100 });
    assert.equal((await request(transientTransport, 'eth_getBalance')).result, '0x99', transientError.message);
    transient.calls.length = 0;
    await request(transientTransport, 'eth_blockNumber');
    assert.equal(transient.calls.some((call) => call.url === primary), false, `cooldown after ${transientError.message}`);
  }
  for (const definiteError of [
    { code: -32000, message: 'execution reverted' }, { code: 3, message: 'execution reverted', data: '0xfixture' },
    { ...serviceErrors[0], data: '0xfixture' }, { ...serviceErrors[1], data: null },
    { code: -32603, message: 'execution reverted' }, { code: -32046, message: 'Cannot fulfill request: execution reverted' },
    { code: -32000, message: 'rate limit exceeded', data: '0xfixture' },
  ]) {
    const definite = fetchFixture(async (_url, payload) => response(payload.method === 'eth_chainId' ? envelope(payload, '0x38') : errorEnvelope(payload, definiteError)));
    const definiteTransport = createVerifiedRpcTransport(network, { fetch: definite.fetch, hedgeDelayMs: 100 });
    assert.deepEqual((await request(definiteTransport, 'eth_call')).error, definiteError);
    assert.deepEqual((await request(definiteTransport, 'eth_estimateGas')).error, definiteError, 'a revert does not cool down its responsive node');
    assert.equal(definite.calls.some((call) => call.url === backup), false);
  }

  // Writes revalidate freshly, never race, and return only the locally derived
  // hash. The preflight may safely select a backup before any broadcast occurs.
  let chain = '0x38';
  const writes = fetchFixture(async (_url, payload) => response(envelope(payload, payload.method === 'eth_chainId' ? chain : payload.method === 'eth_sendRawTransaction' ? rawHash.toUpperCase().replace('0X', '0x') : '0x1')));
  const writeTransport = createVerifiedRpcTransport({ ...network, rpcFallbackUrls: [] }, { fetch: writes.fetch });
  await request(writeTransport, 'eth_getBalance');
  assert.equal((await request(writeTransport, 'eth_sendRawTransaction', [raw])).result, rawHash);
  assert.equal(writes.calls.filter((call) => call.method === 'eth_chainId').length, 2);
  chain = '0x1';
  await assert.rejects(request(writeTransport, 'eth_sendRawTransaction', [raw]), (error) => /RPC chain/.test(error.message) && !getUncertainBroadcastHash(error));
  assert.equal(writes.calls.filter((call) => call.method === 'eth_sendRawTransaction').length, 1);
  const beforeSendFailover = fetchFixture(async (url, payload) => {
    if (url === primary) throw new Error('fixture offline');
    return response(envelope(payload, payload.method === 'eth_chainId' ? '0x38' : rawHash));
  });
  assert.equal((await request(createVerifiedRpcTransport(network, { fetch: beforeSendFailover.fetch }), 'eth_sendRawTransaction', [raw])).result, rawHash);
  assert.equal(beforeSendFailover.calls.filter((call) => call.method === 'eth_sendRawTransaction').length, 1);
  assert.equal(beforeSendFailover.calls.find((call) => call.method === 'eth_sendRawTransaction').url, backup);

  // Definite send errors remain original errors; stateful/unknown operations
  // do not get retried, even when their single node fails.
  const insufficient = { code: -32000, message: 'insufficient funds for gas * price + value' };
  const rejected = fetchFixture(async (_url, payload) => response(payload.method === 'eth_chainId' ? envelope(payload, '0x38') : errorEnvelope(payload, insufficient)));
  const rejectedTransport = createVerifiedRpcTransport(network, { fetch: rejected.fetch });
  assert.deepEqual((await request(rejectedTransport, 'eth_sendRawTransaction', [raw])).error, insufficient);
  assert.equal(rejected.calls.some((call) => /getTransaction/.test(call.method)), false);
  for (const method of ['eth_newFilter', 'custom_read']) {
    const stateful = fetchFixture(async (_url, payload) => payload.method === 'eth_chainId' ? response(envelope(payload, '0x38')) : { ok: false, status: 503, json: async () => ({}) });
    const statefulTransport = createVerifiedRpcTransport(network, { fetch: stateful.fetch });
    await assert.rejects(request(statefulTransport, method), /503/);
    assert.equal(stateful.calls.filter((call) => call.method === method).length, 1);
    assert.equal(stateful.calls.some((call) => call.url === backup), false);
  }
  await assert.rejects(rejectedTransport('https://untrusted.invalid', { body: '{}', headers: {}, method: 'POST' }), /not configured/);

  // An ambiguous send only queries its local hash; no fallback ever receives
  // eth_sendRawTransaction. Both pending tx and mined receipt can confirm it.
  for (const scenario of ['timeout-found', 'disconnect-receipt', 'http-found', 'already-known', 'mismatched-return']) {
    const reconcile = fetchFixture(async (url, payload) => {
      if (payload.method === 'eth_chainId') return response(envelope(payload, '0x38'));
      if (payload.method === 'eth_sendRawTransaction') {
        if (scenario === 'timeout-found') return new Promise(() => {});
        if (scenario === 'disconnect-receipt') throw new Error('fixture disconnect');
        if (scenario === 'http-found') return { ok: false, status: 503, json: async () => ({}) };
        if (scenario === 'already-known') return response(errorEnvelope(payload, { code: -32000, message: 'already known' }));
        return response(envelope(payload, `0x${'f'.repeat(64)}`));
      }
      assert.equal(payload.params[0], rawHash, 'status queries use keccak256 of raw bytes');
      const result = url === backup ? scenario === 'disconnect-receipt' && payload.method === 'eth_getTransactionReceipt' ? { transactionHash: rawHash } : scenario !== 'disconnect-receipt' && payload.method === 'eth_getTransactionByHash' ? { hash: rawHash } : null : null;
      return response(envelope(payload, result));
    });
    const recovered = createVerifiedRpcTransport(network, { fetch: reconcile.fetch, timeoutMs: 12, hedgeDelayMs: 1 });
    assert.equal((await request(recovered, 'eth_sendRawTransaction', [raw])).result, rawHash, scenario);
    assert.equal(reconcile.calls.filter((call) => call.method === 'eth_sendRawTransaction').length, 1);
    assert.equal(reconcile.calls.some((call) => call.url === backup && call.method === 'eth_sendRawTransaction'), false);
  }
  for (const result of [null, {}, { hash: `0x${'e'.repeat(64)}`, transactionHash: `0x${'e'.repeat(64)}` }]) {
    const uncertain = fetchFixture(async (_url, payload) => {
      if (payload.method === 'eth_chainId') return response(envelope(payload, '0x38'));
      if (payload.method === 'eth_sendRawTransaction') throw new Error('fixture disconnect');
      return response(envelope(payload, result));
    });
    await assert.rejects(request(createVerifiedRpcTransport(network, { fetch: uncertain.fetch }), 'eth_sendRawTransaction', [raw]), (error) => error.code === 'RPC_BROADCAST_UNCERTAIN' && getUncertainBroadcastHash(error) === rawHash);
    assert.equal(uncertain.calls.filter((call) => call.method === 'eth_sendRawTransaction').length, 1);
  }
  const invalidRaw = fetchFixture(async (_url, payload) => response(envelope(payload, '0x38')));
  await assert.rejects(request(createVerifiedRpcTransport(network, { fetch: invalidRaw.fetch }), 'eth_sendRawTransaction', ['fixture-only']), /Invalid signed transaction/);
  assert.equal(invalidRaw.calls.length, 0, 'bad raw bytes never reach a node');

  // Reconciliation has one overall deadline instead of serially spending a
  // complete timeout on two lookups across every configured endpoint.
  const stalled = fetchFixture(async (_url, payload, init) => {
    if (payload.method === 'eth_chainId') return response(envelope(payload, '0x38'));
    if (payload.method === 'eth_sendRawTransaction') throw new Error('fixture disconnect');
    await abortableDelay(500, init.signal);
    return response(envelope(payload, null));
  });
  const deadlineTransport = createVerifiedRpcTransport({ ...network, rpcFallbackUrls: manyUrls.slice(1) }, { fetch: stalled.fetch, timeoutMs: 15, hedgeDelayMs: 1 });
  const deadlineStarted = Date.now();
  await assert.rejects(request(deadlineTransport, 'eth_sendRawTransaction', [raw]), (error) => getUncertainBroadcastHash(error) === rawHash);
  assert.ok(Date.now() - deadlineStarted < 160, 'overall reconciliation deadline bounds a five-node outage');
  assert.equal(stalled.calls.filter((call) => call.method === 'eth_sendRawTransaction').length, 1);
  await tick();

  // Refreshing a catalog changes the next request's URL snapshot while the
  // configured transport URL remains the same and existing health survives.
  const dynamic = fetchFixture(async (_url, payload) => response(envelope(payload, payload.method === 'eth_chainId' ? '0x38' : '0x8')));
  const dynamicTransport = createVerifiedRpcTransport(network, { fetch: dynamic.fetch });
  await request(dynamicTransport, 'eth_blockNumber');
  catalog.urls = ['https://new.invalid'];
  dynamic.calls.length = 0;
  await request(dynamicTransport, 'eth_blockNumber');
  assert.ok(dynamic.calls.every((call) => call.url === 'https://new.invalid'));
  catalog.urls = [primary, ...manyUrls.slice(1), 'https://sixth.invalid'];
  dynamic.calls.length = 0;
  await request(dynamicTransport, 'eth_blockNumber');
  assert.equal(dynamic.calls[0].url, primary);
  assert.equal(dynamic.calls.length, 1, 'existing endpoint chain validation survives catalog change');
  const snapshotCap = fetchFixture(async () => { throw new Error('fixture unavailable'); });
  const snapshotCapped = createVerifiedRpcTransport(network, { fetch: snapshotCap.fetch, timeoutMs: 15, hedgeDelayMs: 1 });
  await assert.rejects(request(snapshotCapped, 'eth_chainId'));
  assert.equal(snapshotCap.calls.length, 5, 'a catalog snapshot uses at most five nodes');
  assert.equal(snapshotCap.calls.some((call) => call.url === 'https://sixth.invalid'), false);
  catalog.urls = null;

  // The real endpoint registry verifies that manual mode supplies one node.
  // Exercise that single-node snapshot through the production pool: failures,
  // slow reads, soft transaction misses and ambiguous sends must stay pinned.
  catalog.urls = [primary];
  let pinnedFails = true;
  const pinned = fetchFixture(async (url, payload, init) => {
    if (pinnedFails && url === primary) throw new Error('Selected node is unavailable');
    if (payload.method === 'eth_chainId') return response(envelope(payload, '0x38'));
    if (payload.method === 'eth_getBalance') await abortableDelay(12, init.signal);
    if (payload.method === 'eth_getTransactionByHash' || payload.method === 'eth_getTransactionReceipt') return response(envelope(payload, null));
    if (payload.method === 'eth_sendRawTransaction') throw new Error('Selected node lost broadcast response');
    return response(envelope(payload, url === primary ? '0x11' : '0x22'));
  });
  const pinnedTransport = createVerifiedRpcTransport(network, { fetch: pinned.fetch, timeoutMs: 40, hedgeDelayMs: 1 });
  await assert.rejects(request(pinnedTransport, 'eth_getBalance'));
  assert.ok(pinned.calls.every((call) => call.url === primary), 'An unavailable manual route never falls back');
  assert.deepEqual(catalog.urls, [primary], 'A failed read does not rewrite the selected route');
  pinnedFails = false;
  assert.equal((await request(pinnedTransport, 'eth_blockNumber')).result, '0x11', 'The selected node can recover without changing the selection');
  const slowPinned = createVerifiedRpcTransport(network, { fetch: pinned.fetch, timeoutMs: 40, hedgeDelayMs: 1 });
  assert.equal((await request(slowPinned, 'eth_getBalance')).result, '0x11');
  assert.equal((await request(slowPinned, 'eth_getTransactionByHash', [lookupHash])).result, null, 'Manual transaction misses do not fan out');
  await assert.rejects(request(slowPinned, 'eth_sendRawTransaction', [raw]), (error) => getUncertainBroadcastHash(error) === rawHash);
  assert.ok(pinned.calls.every((call) => call.url === primary), 'Slow reads and ambiguous broadcast reconciliation stay on the manual route');
  assert.equal(pinned.calls.filter((call) => call.method === 'eth_sendRawTransaction').length, 1);
  const manualWrongChain = fetchFixture(async (_url, payload) => response(envelope(payload, '0x1')));
  const manualWrongTransport = createVerifiedRpcTransport(network, { fetch: manualWrongChain.fetch, timeoutMs: 40, hedgeDelayMs: 1 });
  await assert.rejects(request(manualWrongTransport, 'eth_sendRawTransaction', [raw]), /chain does not match/);
  assert.ok(manualWrongChain.calls.every((call) => call.url === primary && call.method === 'eth_chainId'), 'A manual wrong-chain node cannot broadcast or redirect to another node');
  catalog.urls = [primary, backup];
  pinnedFails = true;
  const automaticAgain = createVerifiedRpcTransport(network, { fetch: pinned.fetch, timeoutMs: 40, hedgeDelayMs: 1 });
  assert.equal((await request(automaticAgain, 'eth_blockNumber')).result, '0x22', 'Returning to automatic restores fallback');
  assert.ok(pinned.calls.some((call) => call.url === backup));

  // Equal reads may share work only within the same route snapshot. Switching
  // while an old node is still replying starts a new query at the new node.
  let releaseOld;
  const oldGate = new Promise((resolve) => { releaseOld = resolve; });
  const switching = fetchFixture(async (url, payload) => {
    if (payload.method === 'eth_chainId') return response(envelope(payload, '0x38'));
    if (url === primary) { await oldGate; return response(envelope(payload, '0x31')); }
    return response(envelope(payload, '0x32'));
  });
  catalog.urls = [primary];
  const switchingTransport = createVerifiedRpcTransport(network, { fetch: switching.fetch, timeoutMs: 100, hedgeDelayMs: 1 });
  const beforeSwitch = request(switchingTransport, 'eth_blockNumber');
  await tick();
  catalog.urls = [backup];
  const afterSwitch = await request(switchingTransport, 'eth_blockNumber');
  assert.equal(afterSwitch.result, '0x32', 'A new manual node cannot reuse a previous node pending result');
  releaseOld();
  assert.equal((await beforeSwitch).result, '0x31', 'An already dispatched request finishes for its original caller');
  assert.deepEqual(switching.calls.filter((call) => call.method === 'eth_blockNumber').map((call) => call.url), [primary, backup]);

  const noCachedRoute = fetchFixture(async (url, payload) => response(envelope(payload, payload.method === 'eth_chainId' ? '0x38' : url === primary ? '0x41' : '0x42')));
  catalog.urls = [primary];
  const routeProvider = new VerifiedRpcProvider(network, { fetch: noCachedRoute.fetch });
  assert.equal(await routeProvider.getBlockNumber(), 65);
  catalog.urls = [backup];
  assert.equal(await routeProvider.getBlockNumber(), 66, 'Ethers cannot reuse a previous route result within its short cache interval');
  routeProvider.destroy();
  catalog.urls = null;

  // Exercise ethers itself; its dispatcher preserves a transport-thrown
  // marker, and the shared pool supplies wallet and Dapp reads.
  const ethersFixture = fetchFixture(async (_url, payload) => response(envelope(payload, payload.method === 'eth_chainId' ? '0x38' : '0x2a')));
  const provider = new VerifiedRpcProvider(network, { fetch: ethersFixture.fetch });
  assert.equal(await provider.getBalance(`0x${'1'.repeat(40)}`), 42n);
  assert.equal((await request(provider.getRpcTransport(), 'eth_getBalance')).result, '0x2a');
  assert.equal(ethersFixture.calls.filter((call) => call.method === 'eth_chainId').length, 1);
  provider.destroy();
  const dispatch = fetchFixture(async (_url, payload) => {
    if (payload.method === 'eth_chainId') return response(envelope(payload, '0x38'));
    if (payload.method === 'eth_sendRawTransaction') throw new Error('fixture disconnect');
    return response(envelope(payload, null));
  });
  const dispatchProvider = new VerifiedRpcProvider(network, { fetch: dispatch.fetch, timeoutMs: 20, hedgeDelayMs: 1 });
  await assert.rejects(dispatchProvider.send('eth_sendRawTransaction', [raw]), (error) => getUncertainBroadcastHash(error) === rawHash);
  assert.equal(dispatch.calls.filter((call) => call.method === 'eth_sendRawTransaction').length, 1);
  dispatchProvider.destroy();

  // The actual ethers broadcast API must not let its ancillary block-number
  // fetch fail after a send has already left the device. This is a public test
  // key fixture, generated/signed only in memory and never sent to real nodes.
  const testSigner = new Wallet(`0x${'1'.repeat(64)}`);
  const signedTx = await testSigner.signTransaction({ type: 0, chainId: 56, nonce: 7, gasPrice: 1n, gasLimit: 21000n, to: `0x${'2'.repeat(40)}`, value: 1n });
  const signedHash = keccak256(signedTx);
  const blockFailure = fetchFixture(async (_url, payload) => {
    if (payload.method === 'eth_chainId') return response(envelope(payload, '0x38'));
    if (payload.method === 'eth_blockNumber') throw new Error('block read unavailable');
    return response(envelope(payload, signedHash));
  });
  const blockFailureProvider = new VerifiedRpcProvider(network, { fetch: blockFailure.fetch, timeoutMs: 20, hedgeDelayMs: 1 });
  await assert.rejects(blockFailureProvider.broadcastTransaction(signedTx));
  assert.equal(blockFailure.calls.some((call) => call.method === 'eth_sendRawTransaction'), false, 'failed preliminary read prevents any broadcast');
  blockFailureProvider.destroy();
  for (const mode of ['success', 'uncertain']) {
    const broadcastApi = fetchFixture(async (_url, payload) => {
      if (payload.method === 'eth_chainId') return response(envelope(payload, '0x38'));
      if (payload.method === 'eth_blockNumber') {
        assert.equal(broadcastApi.calls.some((call) => call.method === 'eth_sendRawTransaction'), false, 'block-number read finishes before send');
        return response(envelope(payload, '0x10'));
      }
      if (payload.method === 'eth_sendRawTransaction') {
        if (mode === 'uncertain') throw new Error('fixture disconnect');
        return response(envelope(payload, signedHash));
      }
      return response(envelope(payload, null));
    });
    const broadcastProvider = new VerifiedRpcProvider(network, { fetch: broadcastApi.fetch, timeoutMs: 20, hedgeDelayMs: 1 });
    if (mode === 'uncertain') await assert.rejects(broadcastProvider.broadcastTransaction(signedTx), (error) => getUncertainBroadcastHash(error) === signedHash);
    else {
      const transactionResponse = await broadcastProvider.broadcastTransaction(signedTx);
      const decoded = Transaction.from(signedTx);
      assert.equal(transactionResponse.hash, signedHash);
      assert.equal(transactionResponse.nonce, decoded.nonce);
      assert.equal(transactionResponse.from, decoded.from);
      assert.equal(transactionResponse.chainId, 56n);
      assert.equal(transactionResponse.gasLimit, 21000n);
      assert.equal(typeof transactionResponse.wait, 'function', 'ethers replacement/wait behavior remains available');
    }
    assert.equal(broadcastApi.calls.filter((call) => call.method === 'eth_sendRawTransaction').length, 1);
    broadcastProvider.destroy();
  }
  console.log('RPC verification passed: automatic failover/two-node cap, strict manual routes, route-isolated pending reads and ethers cache, chain validation, cooldown/recovery, safe errors, and single-send status reconciliation. Offline fixtures only.');
}
verify().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => fs.rmSync(output, { recursive: true, force: true }));
