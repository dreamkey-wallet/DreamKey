/* Offline discovery checks: no wallet data, public network calls or broadcasts. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'wallet-rpc-catalog-'));
for (const relative of ['config/rpc', 'core/types', 'core/networks', 'core/rpc-endpoints', 'core/rpc-catalog']) {
  const input = fs.readFileSync(path.join(__dirname, '..', 'src', `${relative}.ts`), 'utf8');
  const destination = path.join(output, `${relative}.js`);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, ts.transpileModule(input, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText);
}
const { DEFAULT_NETWORKS } = require(path.join(output, 'core/networks.js'));
const { RPC_CATALOG_URL, RPC_CATALOG_FALLBACK_URL, getRpcCatalogUrl, RPC_CATALOG_CACHE_MAX_AGE_MS } = require(path.join(output, 'config/rpc.js'));
const { trustedRpcCandidate, selectIndependentRpcUrls, parseRpcEndpointSnapshot, applyRpcEndpointSnapshot, getRpcEndpointUrls, getRpcEndpointChoices, getPreferredRpcEndpoint, setPreferredRpcEndpoint, clearPreferredRpcEndpoint, supportsRpcEndpointPreference } = require(path.join(output, 'core/rpc-endpoints.js'));
const { collectRpcCandidates, parseTokenPocketDirectory, parseChainlistDirectory, refreshRpcCatalog } = require(path.join(output, 'core/rpc-catalog.js'));
const now = Date.now();
const hex = (value) => `0x${value.toString(16)}`;
const directory = DEFAULT_NETWORKS.map((network) => ({ chainId: network.chainId, rpc: [network.rpcUrl, ...network.rpcFallbackUrls].map((url) => ({ url })) }));
const bsc = DEFAULT_NETWORKS.find((network) => network.chainId === 56);
const eth = DEFAULT_NETWORKS.find((network) => network.chainId === 1);

// Manual endpoint selection is restricted to the exact trusted allowlist and
// pins requests to that node while keeping the picker in its catalog order.
clearPreferredRpcEndpoint(56);
assert.equal(getPreferredRpcEndpoint(56), undefined);
assert.equal(setPreferredRpcEndpoint(56, 'https://evil.example/rpc'), false);
assert.equal(setPreferredRpcEndpoint(56, bsc.rpcFallbackUrls[0]), true);
assert.equal(getPreferredRpcEndpoint(56), bsc.rpcFallbackUrls[0]);
assert.deepEqual(getRpcEndpointUrls(bsc), [bsc.rpcFallbackUrls[0]]);
assert.ok(getRpcEndpointChoices(56).includes(bsc.rpcFallbackUrls[0]));
assert.equal(supportsRpcEndpointPreference(bsc), true);
assert.equal(supportsRpcEndpointPreference({ ...bsc, rpcUrl: 'https://bsc-rpc.publicnode.com', rpcFallbackUrls: ['https://bsc-dataseed.bnbchain.org'], id: 'custom-bsc' }), false);
clearPreferredRpcEndpoint(56);
assert.equal(getPreferredRpcEndpoint(56), undefined);
assert.ok(getRpcEndpointUrls(bsc).length >= 3, 'Automatic restores independent recovery nodes');
const valid = { version: 1, updatedAt: now, chains: { '56': [bsc.rpcFallbackUrls[0], bsc.rpcUrl] } };
const response = (value, url) => ({ ok: true, status: 200, url, text: async () => JSON.stringify(value) });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fixture(change = () => ({})) {
  const calls = [];
  let active = 0;
  let maximum = 0;
  return {
    calls,
    get maximum() { return maximum; },
    fetch: async (url, init) => {
      if (url.startsWith(`${RPC_CATALOG_URL}?`)) {
        const parsed = new URL(url);
        assert.equal(parsed.searchParams.get('ns'), 'ethereum');
        const chainId = Number(parsed.searchParams.get('chain_id'));
        return response({ result: 0, message: 'success', data: directory.filter((entry) => entry.chainId === chainId).flatMap((entry) => entry.rpc.map((rpc) => ({ chain_id: String(chainId), url: rpc.url, status: 0 }))) }, url);
      }
      const payload = JSON.parse(init.body);
      calls.push({ url, ...payload });
      assert.equal(init.credentials, 'omit');
      assert.equal(init.redirect, 'error');
      assert.deepEqual(payload.params, payload.method === 'eth_getBlockByNumber' ? ['latest', false] : []);
      active++;
      maximum = Math.max(maximum, active);
      await sleep(1);
      active--;
      const chainId = DEFAULT_NETWORKS.find((network) => [network.rpcUrl, ...network.rpcFallbackUrls].includes(url)).chainId;
      const changes = change({ chainId, url, payload });
      if (changes.error) throw new Error(changes.error);
      const result = payload.method === 'eth_chainId' ? hex(changes.chainId ?? chainId) : payload.method === 'eth_blockNumber' ? hex(changes.height ?? 1000) : { number: hex(changes.height ?? 1000), timestamp: hex(changes.timestamp ?? Math.floor(now / 1000) - 2) };
      return response({ jsonrpc: '2.0', id: payload.id, result }, url);
    },
  };
}

async function verify() {
  assert.equal(getRpcCatalogUrl(1), `${RPC_CATALOG_URL}?ns=ethereum&chain_id=1`);
  assert.throws(() => getRpcCatalogUrl(0), /chain id/);
  assert.deepEqual(parseTokenPocketDirectory({ result: 0, message: 'success', data: [{ chain_id: '1', url: eth.rpcUrl, status: 0 }, { chain_id: '1', url: 'https://disabled.example', status: 1 }] }, 1), [{ chainId: 1, rpc: [{ url: eth.rpcUrl }] }]);
  assert.deepEqual(parseChainlistDirectory([{ chainId: '1', rpc: [eth.rpcUrl, { url: 'https://invalid.example' }] }, { chainId: 999, rpc: ['https://evil.example'] }]), [{ chainId: 1, rpc: [{ url: eth.rpcUrl }, { url: 'https://invalid.example' }] }]);
  for (const network of DEFAULT_NETWORKS) {
    assert.equal(selectIndependentRpcUrls(network.chainId, [network.rpcUrl, ...network.rpcFallbackUrls]).length, 4, 'four independent bundled operators');
  }
  for (const value of ['http://bsc-rpc.publicnode.com', 'wss://bsc-rpc.publicnode.com', 'https://user:pass@bsc-rpc.publicnode.com', 'https://bsc-rpc.publicnode.com?key=abc', 'https://bsc-rpc.publicnode.com#secret', 'https://bsc-rpc.publicnode.com/${KEY}', 'https://bsc-rpc.publicnode.com.evil.example', 'https://bsc-rpc.publicnode.com/private', 'https://localhost', 'https://127.0.0.1', 'https://192.168.1.1', 'https://[::1]', 'https://10.0.0.1', 'https://169.254.169.254']) {
    assert.equal(trustedRpcCandidate(56, value), null, value);
  }
  assert.equal(trustedRpcCandidate(1, bsc.rpcUrl), null, 'endpoint is allowlisted per chain');
  assert.equal(selectIndependentRpcUrls(8453, ['https://mainnet.base.org', 'https://developer-access-mainnet.base.org']).length, 1, 'same operator contributes once');
  assert.ok(parseRpcEndpointSnapshot(valid, now));
  for (const bad of [null, { ...valid, version: 2 }, { ...valid, updatedAt: now + 400_000 }, { ...valid, updatedAt: now - RPC_CATALOG_CACHE_MAX_AGE_MS - 1 }, { ...valid, chains: {} }, { ...valid, chains: { 999: [bsc.rpcUrl] } }, { ...valid, chains: { 56: [bsc.rpcUrl, bsc.rpcUrl] } }, { ...valid, chains: { 56: [] } }]) {
    assert.equal(parseRpcEndpointSnapshot(bad, now), null);
  }
  const custom = { chainId: 56, rpcUrl: 'https://custom.example', rpcFallbackUrls: ['https://custom-backup.example'] };
  assert.ok(applyRpcEndpointSnapshot(valid));
  assert.equal(getRpcEndpointUrls(bsc)[0], bsc.rpcUrl);
  assert.deepEqual(getRpcEndpointUrls(custom), [custom.rpcUrl, ...custom.rpcFallbackUrls], 'custom transport identity remains isolated');
  const sharedPrimaryCustom = { chainId: 56, rpcUrl: bsc.rpcUrl, rpcFallbackUrls: ['https://custom-backup.example'] };
  assert.deepEqual(getRpcEndpointUrls(sharedPrimaryCustom), [bsc.rpcUrl, 'https://custom-backup.example'], 'custom backup policy remains isolated even when a built-in primary is reused');
  valid.chains['56'].reverse();
  assert.equal(getRpcEndpointUrls(bsc)[0], bsc.rpcUrl, 'caller mutation cannot change registry');
  assert.equal(applyRpcEndpointSnapshot({ version: 1, updatedAt: now - 1000, chains: { 56: [bsc.rpcUrl] } }), false, 'stale asynchronous refresh cannot replace newer registry');
  const healthyOnly = [bsc.rpcFallbackUrls[0], ...bsc.rpcFallbackUrls.slice(1)];
  assert.ok(applyRpcEndpointSnapshot({ version: 1, updatedAt: now, chains: { 56: healthyOnly } }));
  assert.deepEqual(getRpcEndpointUrls(bsc), [bsc.rpcUrl, ...healthyOnly.slice(0, 3)], 'TokenPocket remains the automatic primary while healthy fallbacks stay available');
  const aged = { version: 1, updatedAt: now, chains: { '56': [bsc.rpcUrl], '1': [eth.rpcUrl] }, chainUpdatedAt: { 56: now - RPC_CATALOG_CACHE_MAX_AGE_MS - 1, 1: now } };
  assert.equal(parseRpcEndpointSnapshot(aged, now).chains['56'], undefined, 'individual chain expiry cannot be renewed by another chain');

  const poisonedDirectory = [...directory, { chainId: 999, rpc: [{ url: 'https://arbitrary.example' }] }, { chainId: 56, rpc: [{ url: 'http://localhost' }, { url: 'https://evil.example' }, { url: 'https://public.1rpc.io/bnb' }] }];
  const candidates = collectRpcCandidates(poisonedDirectory, null, now);
  assert.ok([...candidates.values()].reduce((sum, urls) => sum + urls.length, 0) <= 25);
  assert.equal(candidates.has(999), false);
  assert.ok([...candidates].every(([chainId, urls]) => urls.length <= 5 && urls.every((url) => trustedRpcCandidate(chainId, url))));

  const healthy = fixture();
  const selected = await refreshRpcCatalog(null, { fetch: healthy.fetch, now: () => now });
  assert.equal(Object.keys(selected.chains).length, 5);
  assert.equal(healthy.maximum, 3, 'only three concurrent requests/probes');
  assert.equal(healthy.calls.length, 60, 'three public health methods for four bundled endpoints on five chains');
  assert.ok(healthy.calls.every((call) => ['eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber'].includes(call.method)), 'discovery sends no wallet data');
  assert.ok(parseRpcEndpointSnapshot(selected, now));

  // TokenPocket is primary; when it returns no usable records, Chainlist is
  // queried once as a discovery fallback and the same health/allowlist checks apply.
  const fallbackCalls = [];
  const fallbackHealthy = fixture();
  const fallbackFetch = async (url, init) => {
    if (url.startsWith(`${RPC_CATALOG_URL}?`)) {
      fallbackCalls.push(url);
      return response({ result: 0, message: 'success', data: [] }, url);
    }
    if (url === RPC_CATALOG_FALLBACK_URL) {
      fallbackCalls.push(url);
      return response(directory, url);
    }
    return fallbackHealthy.fetch(url, init);
  };
  const fallbackSelected = await refreshRpcCatalog(null, { fetch: fallbackFetch, now: () => now });
  assert.equal(fallbackCalls.includes(RPC_CATALOG_FALLBACK_URL), true, 'Chainlist is queried only after primary has no usable records');
  assert.equal(Object.keys(fallbackSelected.chains).length, 5, 'fallback directory still produces healthy chains');

  const unhealthy = fixture(({ url }) => url === bsc.rpcUrl ? { chainId: 1 } : url === eth.rpcUrl ? { timestamp: Math.floor(now / 1000) - 1000 } : {});
  const filtered = await refreshRpcCatalog(null, { fetch: unhealthy.fetch, now: () => now });
  assert.equal(filtered.chains['56'].includes(bsc.rpcUrl), false, 'wrong chain excluded');
  assert.equal(filtered.chains['1'].includes(eth.rpcUrl), false, 'stale block excluded');
  assert.equal(unhealthy.calls.filter((call) => call.url === bsc.rpcUrl).length, 1, 'wrong chain receives no further probe calls');
  const lagging = fixture(({ url }) => url === eth.rpcUrl ? { height: 100 } : {});
  const synchronized = await refreshRpcCatalog(null, { fetch: lagging.fetch, now: () => now });
  assert.equal(synchronized.chains['1'].includes(eth.rpcUrl), false, 'relative height lag excluded');

  const partial = fixture(({ chainId }) => chainId === 56 ? { error: 'offline' } : {});
  const preserved = await refreshRpcCatalog(selected, { fetch: partial.fetch, now: () => now });
  assert.deepEqual(preserved.chains['56'], selected.chains['56'], 'chain outage retains its prior list');
  const earlier = { ...selected, updatedAt: now - 1000, chainUpdatedAt: Object.fromEntries(Object.keys(selected.chains).map((key) => [key, now - 1000])) };
  const untouched = await refreshRpcCatalog(earlier, { fetch: partial.fetch, now: () => now });
  assert.equal(untouched.chainUpdatedAt['56'], now - 1000, 'failed chain keeps its health check time');
  assert.equal(untouched.chainUpdatedAt['1'], now, 'healthy chain receives a fresh check time');
  const offline = fixture(() => ({ error: 'offline' }));
  await assert.rejects(refreshRpcCatalog(selected, { fetch: offline.fetch, now: () => now }), /No healthy/);
  await assert.rejects(refreshRpcCatalog(selected, { fetch: async () => { throw new Error('directory offline'); } }), /directory offline/);
  await assert.rejects(refreshRpcCatalog(null, { fetch: async () => response({}, getRpcCatalogUrl(1)) }), /No healthy|Invalid RPC directory|redirect/);
  await assert.rejects(refreshRpcCatalog(null, { fetch: async () => response(directory, 'https://evil.example/rpcs.json') }), /No healthy|Invalid RPC directory|redirect/);
  await assert.rejects(refreshRpcCatalog(null, { fetch: async () => ({ ok: true, status: 200, headers: { get: () => '99999999' }, text: async () => { throw new Error('must not read'); } }) }), /No healthy|too large/);
  const started = Date.now();
  await assert.rejects(refreshRpcCatalog(null, { timeoutMs: 20, fetch: async () => new Promise(() => {}) }), /timed out/);
  assert.ok(Date.now() - started < 500, 'deadline covers hanging download');
  const canceled = new AbortController();
  canceled.abort();
  await assert.rejects(refreshRpcCatalog(null, { signal: canceled.signal, fetch: healthy.fetch }), /canceled/);
  const bodyHang = async (url) => url.startsWith(`${RPC_CATALOG_URL}?`) ? response({ result: 0, message: 'success', data: [] }, url) : { ok: true, status: 200, text: () => new Promise(() => {}) };
  await assert.rejects(refreshRpcCatalog(null, { fetch: bodyHang, timeoutMs: 300, probeTimeoutMs: 3 }), /No healthy|does not contain|timed out/);
  console.log('RPC catalog verification passed');
}
verify().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => fs.rmSync(output, { recursive: true, force: true }));
