/* Offline RPC recovery checks. No real nodes, user addresses, keys or broadcasts. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');

const output = fs.mkdtempSync(path.join(os.tmpdir(), 'wallet-rpc-recovery-'));
for (const name of ['rpc-provider', 'rpc-broadcast', 'asset-history']) {
  const source = fs.readFileSync(path.join(__dirname, '..', `src/core/${name}.ts`), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  fs.writeFileSync(path.join(output, `${name}.js`), compiled.replace(/require\("ethers"\)/g, `require(${JSON.stringify(require.resolve('ethers'))})`));
}
fs.writeFileSync(path.join(output, 'rpc-endpoints.js'), 'exports.getRpcEndpointUrls = (network) => [network.rpcUrl, ...(network.rpcFallbackUrls ?? [])];');
const { createVerifiedRpcTransport } = require(path.join(output, 'rpc-provider.js'));
const { listAssetTransactions } = require(path.join(output, 'asset-history.js'));
const primary = 'https://primary.invalid';
const backup = 'https://backup.invalid';
const network = { rpcUrl: primary, rpcFallbackUrls: [backup], chainId: 56, name: 'Recovery fixture' };
const logParams = [{ fromBlock: '0x1', toBlock: '0x100', topics: [] }];
let nextId = 1;

function response(payload, value, error = false) {
  return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: payload.id, [error ? 'error' : 'result']: value }) };
}
function fixture(behavior, policy = {}, fixtureNetwork = network) {
  const calls = [];
  const transport = createVerifiedRpcTransport(fixtureNetwork, {
    // Frozen time proves recovery is immediate, without waiting for cooldown.
    now: () => 1000, hedgeDelayMs: 1, timeoutMs: 100, ...policy,
    fetch: async (url, init) => {
      const payload = JSON.parse(init.body);
      assert.ok(Number.isInteger(payload.id) && payload.id > 0 && payload.id <= 0x7fffffff, 'public RPC gateways require positive signed-32-bit request IDs, including internal validation and recovery probes');
      calls.push({ url, ...payload });
      if (payload.method === 'eth_chainId') return response(payload, '0x38');
      return behavior(url, payload);
    },
  });
  return { calls, transport };
}
async function request(transport, method, params = []) {
  const payload = { jsonrpc: '2.0', id: nextId++, method, params };
  const reply = await transport(primary, { method: 'POST', headers: {}, body: JSON.stringify(payload) });
  const body = await reply.json();
  assert.equal(body.id, payload.id, 'response must preserve the request id');
  return body;
}

async function historicalFailuresDoNotDisableWalletReads() {
  const errors = [
    { code: -32000, message: 'missing trie node' },
    { code: -32000, message: 'header not found' },
    { code: -32000, message: 'historical state has been pruned' },
    { code: -32000, message: 'state unavailable' },
    { code: -32005, message: 'limit exceeded' },
    { code: -32005, message: 'block range limit exceeded' },
  ];
  const failures = [];
  for (const rpcError of errors) {
    const { calls, transport } = fixture((_url, payload) => payload.method === 'eth_getLogs'
      ? response(payload, rpcError, true)
      : response(payload, payload.method === 'eth_blockNumber' ? '0x200' : '0x9'));
    assert.equal((await request(transport, 'eth_getBalance', ['0x0000000000000000000000000000000000000001', 'latest'])).result, '0x9');
    const history = await request(transport, 'eth_getLogs', logParams);
    assert.deepEqual(history.error, rpcError, 'all-node history failure must preserve the actionable RPC error');
    assert.deepEqual(new Set(calls.filter((call) => call.method === 'eth_getLogs').map((call) => call.url)), new Set([primary, backup]), 'history can try both endpoints');
    try {
      assert.equal((await request(transport, 'eth_getBalance', ['0x0000000000000000000000000000000000000001', 'latest'])).result, '0x9');
      assert.equal((await request(transport, 'eth_blockNumber')).result, '0x200');
    } catch (error) { failures.push(`${rpcError.message}: ${error.message}`); }
  }
  assert.deepEqual(failures, [], 'history/archive/range failures must not cool down the entire shared RPC pool');
}

async function unsupportedReadsFallBackWithoutDisablingOtherMethods() {
  const unsupported = { code: -32601, message: 'the method eth_getLogs does not exist/is not available' };
  const { calls, transport } = fixture((url, payload) => payload.method === 'eth_getLogs'
    ? response(payload, url === primary ? unsupported : [], url === primary)
    : response(payload, '0x7'));
  assert.deepEqual((await request(transport, 'eth_getLogs', logParams)).result, [], 'an unsupported read must fall back to another verified node');
  assert.ok(calls.some((call) => call.url === primary && call.method === 'eth_getLogs'));
  assert.ok(calls.some((call) => call.url === backup && call.method === 'eth_getLogs'));
  assert.equal((await request(transport, 'eth_getBalance')).result, '0x7');

  const allUnsupported = fixture((_url, payload) => payload.method === 'eth_getLogs'
    ? response(payload, unsupported, true) : response(payload, '0x8'));
  assert.deepEqual((await request(allUnsupported.transport, 'eth_getLogs', logParams)).error, unsupported);
  assert.equal((await request(allUnsupported.transport, 'eth_blockNumber')).result, '0x8');
}

async function concurrentHistoryFallbackDoesNotExtendGlobalCooldown() {
  const archiveError = { code: -32000, message: 'missing trie node' };
  const { calls, transport } = fixture((_url, payload) => payload.method === 'eth_getLogs'
    ? response(payload, archiveError, true) : response(payload, '0x77'));
  assert.equal((await request(transport, 'eth_getBalance')).result, '0x77');
  // The history fallback requests incoming and outgoing logs in two block
  // ranges concurrently. Four restricted archive queries must not disable
  // ordinary wallet reads or exponentially extend endpoint-wide cooldowns.
  const history = await Promise.all(Array.from({ length: 4 }, (_, index) => request(transport, 'eth_getLogs', [{
    ...logParams[0], fromBlock: `0x${(index * 1024).toString(16)}`,
    toBlock: `0x${(index * 1024 + 1023).toString(16)}`,
  }])));
  history.forEach((reply) => assert.deepEqual(reply.error, archiveError));
  const before = calls.length;
  const [balance, latest] = await Promise.all([
    request(transport, 'eth_getBalance'), request(transport, 'eth_blockNumber'),
  ]);
  assert.equal(balance.result, '0x77');
  assert.equal(latest.result, '0x77');
  assert.ok(calls.length > before, 'ordinary reads actually reach a verified endpoint without waiting for cooldown');
}

async function coolingPoolRecoversWithOneSharedReadProbe() {
  let stage = 'healthy';
  let releaseProbe;
  const probeGate = new Promise((resolve) => { releaseProbe = resolve; });
  const { calls, transport } = fixture(async (_url, payload) => {
    if (stage === 'offline') return { ok: false, status: 429, json: async () => ({}) };
    if (stage === 'recovering') await probeGate;
    return response(payload, '0x51');
  });
  assert.equal((await request(transport, 'eth_getBalance')).result, '0x51');
  stage = 'offline';
  await assert.rejects(request(transport, 'eth_getBalance'), /429/);
  stage = 'recovering';
  const before = calls.length;
  // Six UI consumers ask for the same cached balance while the pool cools.
  // Only one node is allowed a recovery probe; its exact read is shared.
  const pending = Array.from({ length: 6 }, () => request(transport, 'eth_getBalance'));
  const otherRead = request(transport, 'eth_gasPrice');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls.length - before, 2, 'all-cooling recovery starts one chain check and one pending lightweight probe for identical concurrent reads');
  releaseProbe();
  const replies = await Promise.all(pending);
  replies.forEach((reply) => assert.equal(reply.result, '0x51'));
  assert.equal((await otherRead).result, '0x51', 'a different read waits for and shares the same pool recovery probe');
  assert.equal(calls.slice(before).filter((call) => call.method === 'eth_chainId').length, 1, 'recovery verifies its selected node chain freshly');
  assert.equal(calls.slice(before).filter((call) => call.method === 'eth_blockNumber').length, 1, 'one lightweight block probe establishes recovery');
  assert.equal(calls.slice(before).filter((call) => call.method === 'eth_getBalance').length, 1, 'identical actual reads share their in-flight request');
  assert.equal(calls.slice(before).filter((call) => call.method === 'eth_gasPrice').length, 1);
  assert.equal((await request(transport, 'eth_blockNumber')).result, '0x51', 'a successful recovery probe restores normal reads immediately');
}

async function realRateLimitsRemainBoundedDuringRecovery() {
  let now = 1000;
  let limited = false;
  const { calls, transport } = fixture((_url, payload) => limited
    ? { ok: false, status: 429, json: async () => ({}) }
    : response(payload, '0x52'), { now: () => now });
  assert.equal((await request(transport, 'eth_getBalance')).result, '0x52');
  limited = true;
  await assert.rejects(request(transport, 'eth_getBalance'), /429/);
  const beforeProbe = calls.length;
  await assert.rejects(request(transport, 'eth_getBalance'), /429/);
  assert.equal(calls.length - beforeProbe, 2, 'only one cooling endpoint may receive a fresh chain check and rate-limited block probe');
  const afterProbe = calls.length;
  for (let index = 0; index < 4; index += 1) {
    await assert.rejects(request(transport, index % 2 ? 'eth_blockNumber' : 'eth_getBalance'), /temporarily unavailable/);
  }
  now += 4999;
  await assert.rejects(request(transport, 'eth_blockNumber'), /temporarily unavailable/);
  assert.equal(calls.length, afterProbe, 'real rate limits suppress repeated probes throughout the pool recovery window');
  limited = false;
  now += 1;
  assert.equal((await request(transport, 'eth_blockNumber')).result, '0x52', 'recovered transport is retried after the bounded probe window, before the full cooldown');
  const recoveryCalls = calls.slice(afterProbe);
  assert.equal(recoveryCalls.filter((call) => call.method === 'eth_chainId').length, 1);
  assert.equal(recoveryCalls.filter((call) => call.method === 'eth_blockNumber').length, 2, 'recovery block probe precedes the original block request');
}

async function actualHistoryCapsRpcConcurrency() {
  let active = 0;
  let maximum = 0;
  let logs = 0;
  let receipts = 0;
  const account = `0x${'1'.repeat(40)}`;
  const peer = `0x${'2'.repeat(40)}`;
  const token = `0x${'3'.repeat(40)}`;
  const localRecords = Array.from({ length: 20 }, (_, index) => ({
    id: `pending:${index}`, hash: `0x${(index + 1).toString(16).padStart(64, '0')}`,
    chainId: 56, accountAddress: account, tokenAddress: token, symbol: 'FIX',
    decimals: 6, rawValue: '1', from: account, to: peer, direction: 'out',
    state: 'pending', source: 'local',
  }));
  const result = await listAssetTransactions({
    network, accountAddress: account, tokenAddress: token, tokenDecimals: 6, symbol: 'FIX', localRecords,
    fetch: async () => { throw new Error('fixture history indexer offline'); },
    rpc: async (method) => {
      active += 1;
      maximum = Math.max(maximum, active);
      try {
        await new Promise((resolve) => setTimeout(resolve, 1));
        if (method === 'eth_getTransactionReceipt') { receipts += 1; return null; }
        if (method === 'eth_getLogs') { logs += 1; return []; }
        if (method === 'eth_blockNumber') return '0x2000';
        throw new Error(`Unexpected history method ${method}`);
      } finally { active -= 1; }
    },
  });
  assert.equal(receipts, 0, 'opening the history list must not look up pending transaction receipts');
  assert.equal(logs, 4, 'token fallback still checks incoming and outgoing logs in both block ranges');
  assert.ok(maximum <= 2, `one history query must cap block and log RPCs at two; observed ${maximum}`);
  assert.equal(result.records.length, 20, 'local transactions remain visible when indexers are unavailable');
  assert.ok(result.records.every((record) => record.state === 'pending'), 'the list preserves local states until a detail lookup or indexer supplies an update');
}

async function inFlightReadsPreserveDistinctArgumentsAndRequestIds() {
  const { calls, transport } = fixture(async (_url, payload) => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    return response(payload, payload.params[0] === 'account-a' ? '0xa' : '0xb');
  });
  const requests = [
    request(transport, 'eth_getBalance', ['account-a', 'latest']),
    request(transport, 'eth_getBalance', ['account-a', 'latest']),
    request(transport, 'eth_getBalance', ['account-b', 'latest']),
    request(transport, 'eth_getBalance', ['account-b', 'latest']),
  ];
  assert.deepEqual((await Promise.all(requests)).map((reply) => reply.result), ['0xa', '0xa', '0xb', '0xb']);
  const balanceCalls = calls.filter((call) => call.method === 'eth_getBalance');
  // Hedging may send one backup per distinct read, while identical consumers
  // share the same read. Different wallet addresses must never share a result.
  assert.ok(balanceCalls.filter((call) => call.params[0] === 'account-a').length <= 2);
  assert.ok(balanceCalls.filter((call) => call.params[0] === 'account-b').length <= 2);
}

async function recoveryRotatesPastAnOfflinePrimary() {
  let now = 1000;
  let stage = 'healthy';
  const { calls, transport } = fixture((url, payload) => stage === 'offline' || (stage === 'backup-restored' && url === primary)
    ? { ok: false, status: 503, json: async () => ({}) } : response(payload, '0x61'), { now: () => now });
  assert.equal((await request(transport, 'eth_getBalance')).result, '0x61');
  stage = 'offline';
  await assert.rejects(request(transport, 'eth_getBalance'), /503/);
  stage = 'backup-restored';
  const beforeFirstProbe = calls.length;
  await assert.rejects(request(transport, 'eth_getBalance'), /503/);
  assert.deepEqual(calls.slice(beforeFirstProbe).filter((call) => call.method === 'eth_blockNumber').map((call) => call.url), [primary]);
  now += 5000;
  const beforeSecondProbe = calls.length;
  assert.equal((await request(transport, 'eth_getBalance')).result, '0x61', 'the next recovery window rotates to an unprobed backup before the 30-second cooldown ends');
  const recovered = calls.slice(beforeSecondProbe);
  assert.deepEqual(recovered.filter((call) => call.method === 'eth_blockNumber').map((call) => call.url), [backup]);
  assert.deepEqual(recovered.filter((call) => call.method === 'eth_getBalance').map((call) => call.url), [backup]);
}

async function concurrentFailuresShareOneCooldownWindow() {
  let now = 1000;
  let failing = false;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { calls, transport } = fixture(async (_url, payload) => {
    if (failing) { await gate; return { ok: false, status: 503, json: async () => ({}) }; }
    return response(payload, '0x62');
  }, { now: () => now }, { ...network, rpcFallbackUrls: [] });
  await request(transport, 'eth_getBalance');
  failing = true;
  const pending = Promise.allSettled(Array.from({ length: 20 }, (_, index) => request(transport, 'eth_getBalance', [`account-${index}`, 'latest'])));
  await new Promise((resolve) => setTimeout(resolve, 0));
  release();
  const failed = await pending;
  assert.equal(failed.filter((reply) => reply.status === 'rejected').length, 20);
  now += 30000;
  failing = false;
  const before = calls.length;
  assert.equal((await request(transport, 'eth_blockNumber')).result, '0x62');
  assert.equal(calls.slice(before).filter((call) => call.method === 'eth_blockNumber').length, 1, '20 simultaneous failures expire as one 30-second outage, without needing a half-open recovery read');
}

async function olderFailureDoesNotOverrideNewerSuccess() {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { calls, transport } = fixture(async (_url, payload) => {
    if (payload.method === 'eth_getBalance' && payload.params[0] === 'old-request') {
      await gate;
      return { ok: false, status: 503, json: async () => ({}) };
    }
    return response(payload, '0x63');
  }, {}, { ...network, rpcFallbackUrls: [] });
  await request(transport, 'eth_getBalance');
  const oldFailure = assert.rejects(request(transport, 'eth_getBalance', ['old-request', 'latest']), /503/);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal((await request(transport, 'eth_gasPrice')).result, '0x63');
  release();
  await oldFailure;
  const before = calls.length;
  assert.equal((await request(transport, 'eth_blockNumber')).result, '0x63');
  assert.equal(calls.length - before, 1, 'a stale failure after newer success must not cool the endpoint or trigger recovery chain/block probes');
}

async function positiveIdGatewaysSupportRepeatedReads() {
  let now = 1000;
  let negativeIds = 0;
  let chainChecks = 0;
  const transport = createVerifiedRpcTransport({ ...network, rpcFallbackUrls: [] }, {
    now: () => now, timeoutMs: 100,
    fetch: async (_url, init) => {
      const payload = JSON.parse(init.body);
      // Some BNB public gateways reject otherwise valid JSON-RPC envelopes
      // when the ID is negative. Emulate that server without live requests.
      if (!Number.isInteger(payload.id) || payload.id <= 0 || payload.id > 0x7fffffff) {
        negativeIds += 1;
        return { ok: false, status: 400, json: async () => ({}) };
      }
      if (payload.method === 'eth_chainId') { chainChecks += 1; return response(payload, '0x38'); }
      return response(payload, '0x64');
    },
  });
  for (let round = 0; round < 2; round += 1) {
    assert.equal((await request(transport, 'eth_getBalance', ['fixture-account', 'latest'])).result, '0x64');
    assert.equal((await request(transport, 'eth_blockNumber')).result, '0x64');
    now += 30001;
  }
  assert.equal(chainChecks, 2, 'each round verifies its chain after the previous validation expires');
  assert.equal(negativeIds, 0, 'all internal requests use positive IDs accepted by strict public gateways');
}

async function verify() {
  const results = await Promise.allSettled([
    historicalFailuresDoNotDisableWalletReads(),
    unsupportedReadsFallBackWithoutDisablingOtherMethods(),
    concurrentHistoryFallbackDoesNotExtendGlobalCooldown(),
    coolingPoolRecoversWithOneSharedReadProbe(),
    realRateLimitsRemainBoundedDuringRecovery(),
    actualHistoryCapsRpcConcurrency(),
    inFlightReadsPreserveDistinctArgumentsAndRequestIds(),
    recoveryRotatesPastAnOfflinePrimary(),
    concurrentFailuresShareOneCooldownWindow(),
    olderFailureDoesNotOverrideNewerSuccess(),
    positiveIdGatewaysSupportRepeatedReads(),
  ]);
  const failures = results.filter((result) => result.status === 'rejected').map((result) => result.reason);
  for (const failure of failures) console.error(failure.message);
  assert.equal(failures.length, 0, 'RPC recovery regressions failed');
  console.log('RPC recovery checks passed: history/archive/range failures stay isolated, unsupported reads fall back, wallet reads recover immediately.');
}

verify().finally(() => fs.rmSync(output, { recursive: true, force: true })).catch((error) => { console.error(error); process.exitCode = 1; });
