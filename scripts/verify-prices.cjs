/* Offline verification of the independent public price service and exact valuation. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');

const output = fs.mkdtempSync(path.join(os.tmpdir(), 'wallet-prices-'));
const source = fs.readFileSync(path.join(__dirname, '../src/core/asset-prices.ts'), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
}).outputText;
fs.writeFileSync(path.join(output, 'prices.js'), compiled);
const prices = require(path.join(output, 'prices.js'));

const now = 1_800_000_000_000;
const tsNow = Math.floor(now / 1000);
const response = (coins, ok = true) => ({ ok, json: async () => ({ coins }) });
const native = { price: 600.123456789, timestamp: tsNow, confidence: 0.99 };
const token = { price: 1.25, timestamp: tsNow, confidence: 0.99 };
let calls = [];
const fetcher = async (url) => {
  calls.push(url);
  const keys = url.slice(url.indexOf('/current/') + 9, url.indexOf('?')).split(',');
  const coins = {};
  for (const key of keys) coins[key] = key.startsWith('coingecko:') ? native : token;
  return response(coins);
};
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const tick = () => new Promise((done) => setImmediate(done));

async function run() {
  const service = new prices.AssetPriceService({ fetch: fetcher, now: () => now, cacheTtlMs: 60_000 });
  const address = '0x' + 'a'.repeat(40);
  const first = await service.getQuotes(56, [address]);
  assert.equal(first.native.priceUsd, '600.123456789');
  assert.equal(first.tokens[address].priceUsd, '1.25');
  assert.equal(calls.length, 1, 'native and token share one bounded request');
  await service.getQuotes(56, [address]);
  assert.equal(calls.length, 1, 'fresh cache avoids HTTP');
  await service.getQuotes(56, [address], true);
  assert.equal(calls.length, 2, 'force refresh bypasses cache');

  const valuation = prices.valueWalletAssets([
    { id: 'native', balance: '2.5' },
    { id: 'token', balance: '1000000000000000000', token: { address } },
    { id: 'zero', balance: '0', token: { address: '0x' + 'b'.repeat(40) } },
    { id: 'missing', balance: '5', token: { address: '0x' + 'c'.repeat(40) } },
  ], first);
  assert.equal(valuation.assets.native.valueUsd, '1500.3086419725');
  assert.equal(valuation.assets.token.valueUsd, '1250000000000000000');
  assert.equal(valuation.assets.zero.valueUsd, '0');
  assert.equal(valuation.assets.missing.valueUsd, null);
  assert.equal(valuation.totalUsd, '1250000000000001500.3086419725');
  assert.equal(valuation.missingCount, 1, 'zero balance without a quote is not missing');
  assert.equal(valuation.complete, false);
  assert.equal(prices.formatUsd(valuation.totalUsd), '$1,250,000,000,000,001,500.31', 'large holdings retain exact cents');
  assert.equal(prices.formatUsd('1501.5586419725'), '$1,501.56');
  assert.equal(prices.formatUsd('1.005'), '$1.01');
  assert.equal(prices.formatUsd('999.999'), '$1,000.00');
  assert.equal(prices.formatUsd('0.000000009', 'price'), '<$0.00000001');
  assert.equal(prices.formatUsd('0.000000004', 'price'), '<$0.00000001');
  assert.equal(prices.formatUsd('0.0005'), '<$0.01');
  assert.equal(prices.formatUsd('0.0005', 'price'), '$0.0005');
  assert.equal(prices.formatUsd(null), '—');
  assert.equal(prices.formatUsd('0'), '$0.00');
  assert.equal(prices.formatUsd('NaN'), '—');

  const precise = prices.valueWalletAssets([
    { id: 'native', balance: '0.000000000000000001' },
    { id: 'token', balance: '0.123456789123456789', token: { address } },
  ], { ...first, native: { priceUsd: '1000000000000000000.123', timestamp: tsNow } });
  assert.equal(precise.assets.native.valueUsd, '1.000000000000000000123');
  assert.equal(precise.assets.token.valueUsd, '0.15432098640432098625');
  assert.equal(precise.totalUsd, '1.154320986404320986373');
  assert.equal(precise.complete, true);
  const unknownBalances = prices.valueWalletAssets([
    { id: 'native', balance: null },
    { id: 'bad', balance: 'invalid', token: { address } },
    { id: 'rpc-failed', balance: '8', error: 'unavailable', token: { address } },
  ], first);
  assert.equal(unknownBalances.totalUsd, null, 'unknown balances never become zero');
  assert.equal(unknownBalances.missingCount, 3);
  assert.equal(prices.valueWalletAssets([], first).totalUsd, null);
  assert.equal(prices.valueWalletAssets([{ id: 'native', balance: '2', loading: true }], first).complete, false, 'retained loading balance remains an estimate');
  assert.equal(prices.valueWalletAssets([{ id: 'native', balance: '2' }], { ...first, error: true }).complete, false);

  // Only exact requested chain + contract keys are read, never a returned ticker.
  const namespaces = { 1: 'ethereum', 56: 'bsc', 137: 'polygon', 42161: 'arbitrum', 8453: 'base' };
  const identityUrls = [];
  const identity = new prices.AssetPriceService({ now: () => now, fetch: async (url) => {
    identityUrls.push(url);
    return response({
      'coingecko:ethereum': { ...native, symbol: 'DIFFERENT' },
      'coingecko:binancecoin': native,
      'coingecko:polygon-ecosystem-token': native,
      [`ethereum:${address}`]: { ...token, symbol: 'USDC' },
      [`base:0x${'b'.repeat(40)}`]: { ...token, symbol: 'USDC' },
    });
  } });
  for (const [chainId, namespace] of Object.entries(namespaces)) {
    const result = await identity.getQuotes(Number(chainId), [address.toUpperCase().replace('0X', '0x'), 'USDC', 'not-a-contract']);
    assert.equal(result.native.priceUsd, native.price.toString());
    assert.match(identityUrls.at(-1), new RegExp(`${namespace}:${address}`));
    assert.equal(result.tokens[address] !== undefined, Number(chainId) === 1, 'same ticker/address on another chain cannot leak');
    assert.ok(!identityUrls.at(-1).includes('USDC'), 'no ticker request');
  }
  assert.match(identityUrls[2], /coingecko:polygon-ecosystem-token/);
  const beforeUnsupported = identityUrls.length;
  assert.equal((await identity.getQuotes(999, [address])).native, null);
  assert.equal(identityUrls.length, beforeUnsupported, 'unsupported network causes no request');

  // Missing prices are cached briefly, while duplicate/force requests share in-flight work.
  let missingCalls = 0;
  const missingService = new prices.AssetPriceService({ now: () => now, fetch: async () => {
    missingCalls += 1;
    return response({});
  } });
  assert.equal((await missingService.getQuotes(56, [address])).native, null);
  await missingService.getQuotes(56, [address]);
  assert.equal(missingCalls, 2, 'one primary plus one missing-native backup are shared briefly');
  await missingService.getQuotes(56, [address], true);
  assert.equal(missingCalls, 4, 'force retries both sources for a missing native quote');

  // Exact CoinGecko identities are requested only when the primary quote is stale;
  // a fresh direct quote clears the stale/error state without using a ticker alias.
  let directCalls = [];
  const directService = new prices.AssetPriceService({ now: () => now, fetch: async (url) => {
    directCalls.push(url);
    if (url.includes('/simple/price')) {
      assert.match(url, /ids=binance-bridged-usdc-bnb-smart-chain/);
      assert.ok(!url.includes('usd-coin,'), 'bridged USDC never falls back to the native USDC identity');
      return { ok: true, json: async () => ({ 'binance-bridged-usdc-bnb-smart-chain': { usd: 0.999, last_updated_at: tsNow } }) };
    }
    const key = `bsc:${address}`;
    return response({ 'coingecko:binancecoin': native, [key]: { ...token, timestamp: tsNow - 301 }, 'coingecko:binance-bridged-usdc-bnb-smart-chain': { ...token, timestamp: tsNow - 301 } });
  } });
  const direct = await directService.getQuotes(56, [address]);
  // This arbitrary address has no catalog mapping; the direct endpoint must not be called.
  assert.equal(direct.tokens[address].stale, true);
  assert.equal(directCalls.length, 1);
  const knownAddress = '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d';
  const known = await directService.getQuotes(56, [knownAddress]);
  assert.equal(known.tokens[knownAddress].priceUsd, '0.999');
  assert.equal(known.tokens[knownAddress].stale, false);
  assert.equal(known.error, false, 'direct fresh quote recovers a stale primary response');
  assert.equal(directCalls.length, 3, 'primary and one exact-ID direct fallback are bounded');

  const fetchGate = deferred();
  let sharedCalls = 0;
  const sharedService = new prices.AssetPriceService({ now: () => now, fetch: async () => {
    sharedCalls += 1;
    return fetchGate.promise;
  } });
  const sharedA = sharedService.getQuotes(56, [address]);
  const sharedB = sharedService.getQuotes(56, [address.toUpperCase().replace('0X', '0x')], true);
  fetchGate.resolve(response({ 'coingecko:binancecoin': native, [`bsc:${address}`]: token }));
  await Promise.all([sharedA, sharedB]);
  assert.equal(sharedCalls, 1, 'force does not duplicate an active network request');

  // A failed refresh may show recent cached quotes only as explicit stale estimates.
  let currentTime = now;
  let failed = false;
  let recoverableCalls = 0;
  const recoverable = new prices.AssetPriceService({ now: () => currentTime, fetch: async () => {
    recoverableCalls += 1;
    if (failed) throw new Error('offline');
    return response({ 'coingecko:binancecoin': native });
  } });
  await recoverable.getQuotes(56, []);
  failed = true;
  currentTime += 60_001;
  const fallback = await recoverable.getQuotes(56, []);
  assert.equal(fallback.native.stale, true);
  assert.equal(fallback.error, true);
  const fallbackTotal = prices.valueWalletAssets([{ id: 'native', balance: '1' }], fallback);
  assert.equal(fallbackTotal.complete, false);
  assert.equal(fallbackTotal.stale, true);
  const cachedFailure = await recoverable.getQuotes(56, []);
  assert.equal(cachedFailure.native.stale, true, 'another screen cannot label a failed cached refresh as fresh');
  assert.equal(cachedFailure.error, true);
  assert.equal(recoverableCalls, 3, 'sequential screens share the primary/backup failure cache briefly');
  failed = false;
  const recovered = await recoverable.getQuotes(56, [], true);
  assert.equal(recovered.native.stale, false, 'success with the same valid market timestamp clears an outage stale marker');
  assert.equal(recovered.error, false);
  failed = true;
  currentTime = now + 15 * 60_000 + 1;
  assert.equal((await recoverable.getQuotes(56, [], true)).native, null, 'hard stale cutoff excludes cached quotes');

  // A successful HTTP response may still omit, regress or invalidate a quote.
  // It must retain the previous better value as stale, without resetting its timestamp.
  for (const badReplacement of [null, { ...token, confidence: 0.4 }, { ...token, timestamp: tsNow - 20, price: 999 }]) {
    let replacement = false;
    const guarded = new prices.AssetPriceService({ now: () => now, fetch: async () => response({
      'coingecko:binancecoin': native,
      ...(replacement ? badReplacement ? { [`bsc:${address}`]: badReplacement } : {} : { [`bsc:${address}`]: token }),
    }) });
    await guarded.getQuotes(56, [address]);
    replacement = true;
    const held = await guarded.getQuotes(56, [address], true);
    assert.equal(held.tokens[address].priceUsd, '1.25');
    assert.equal(held.tokens[address].timestamp, tsNow);
    assert.equal(held.tokens[address].stale, true);
    assert.equal(held.error, true, 'retaining a cache after a degraded response is an explicit estimate');
  }

  const exactBase = '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca';
  const exactBaseKey = `base:${exactBase}`;
  let backupRequests = [];
  const slowContract = { ...token, timestamp: tsNow - 16 * 60 };
  const cadence = new prices.AssetPriceService({ now: () => now, fetch: async (url) => {
    backupRequests.push(url);
    if (url.includes('/simple/price')) return { ok: true, json: async () => ({ 'bridged-usd-coin-base': { usd: 0.997, last_updated_at: tsNow - 12 } }) };
    return response({ 'coingecko:ethereum': native, [exactBaseKey]: slowContract, 'coingecko:bridged-usd-coin-base': slowContract });
  } });
  const repriced = await cadence.getQuotes(8453, [exactBase]);
  assert.equal(repriced.tokens[exactBase].priceUsd, '0.997', 'real 16-minute contract update cadence triggers fresh exact-identity backup');
  assert.equal(repriced.tokens[exactBase].timestamp, tsNow - 12);
  assert.equal(repriced.tokens[exactBase].stale, false);
  assert.equal(repriced.error, false);
  assert.equal(backupRequests.length, 2);

  // A complete primary outage can recover through one native + token backup batch.
  let outageCalls = [];
  const rescued = new prices.AssetPriceService({ now: () => now, fetch: async (url) => {
    outageCalls.push(url);
    if (url.includes('/current/')) throw new Error('primary offline');
    assert.ok(url.includes('ethereum') && url.includes('bridged-usd-coin-base'));
    return { ok: true, json: async () => ({ ethereum: { usd: 2000, last_updated_at: tsNow }, 'bridged-usd-coin-base': { usd: 0.995, last_updated_at: tsNow } }) };
  } });
  const rescuedSnapshot = await rescued.getQuotes(8453, [exactBase]);
  assert.equal(rescuedSnapshot.native.priceUsd, '2000');
  assert.equal(rescuedSnapshot.tokens[exactBase].priceUsd, '0.995');
  assert.equal(rescuedSnapshot.error, false, 'primary outage does not poison successful direct prices');
  assert.equal(outageCalls.length, 2);

  // Aliases are not permission to accept another asset or relax market timestamps.
  for (const invalidDirect of [
    { usd: 0 }, { usd: Infinity, last_updated_at: tsNow }, { usd: 1, last_updated_at: tsNow + 61 },
    { usd: 1, last_updated_at: tsNow - 901 }, { usd: 1, last_updated_at: 'not-a-timestamp' },
  ]) {
    const safe = new prices.AssetPriceService({ now: () => now, fetch: async (url) => url.includes('/current/')
      ? response({ 'coingecko:ethereum': native })
      : { ok: true, json: async () => ({ 'bridged-usd-coin-base': invalidDirect, 'usd-coin': { usd: 42, last_updated_at: tsNow } }) },
    });
    assert.equal((await safe.getQuotes(8453, [exactBase])).tokens[exactBase], undefined, 'invalid exact identity cannot use a different returned key');
  }

  let aliasCalls = 0;
  const alias = new prices.AssetPriceService({ now: () => now, fetch: async (url) => {
    aliasCalls += 1;
    assert.ok(!url.includes('/simple/price'), 'fresh exact-ID primary avoids extra API calls');
    return response({ 'coingecko:ethereum': native, [exactBaseKey]: { ...token, timestamp: tsNow - 301 }, 'coingecko:bridged-usd-coin-base': { ...token, price: 0.994 } });
  } });
  const aliased = await alias.getQuotes(8453, [exactBase]);
  assert.equal(aliased.tokens[exactBase].priceUsd, '0.994');
  assert.equal(aliased.tokens[exactBase].stale, false);
  assert.equal(aliasCalls, 1);

  for (const bad of [
    { ...native, price: -1 }, { ...native, price: 0 }, { ...native, price: Infinity },
    { ...native, price: NaN }, { ...native, confidence: 0.7 }, { ...native, confidence: 2 },
    { ...native, confidence: undefined }, { ...native, timestamp: tsNow + 61 },
    { ...native, timestamp: tsNow - 901 }, { ...native, timestamp: tsNow + 0.5 },
  ]) {
    const invalid = new prices.AssetPriceService({ now: () => now, fetch: async () => response({ 'coingecko:ethereum': bad }) });
    assert.equal((await invalid.getQuotes(1, [])).native, null);
  }
  const oldMarket = new prices.AssetPriceService({ now: () => now, fetch: async () => response({ 'coingecko:ethereum': { ...native, timestamp: tsNow - 301 } }) });
  assert.equal((await oldMarket.getQuotes(1, [])).native.stale, true, 'old successful response is explicitly stale');
  const tinyMarket = new prices.AssetPriceService({ now: () => now, fetch: async () => response({ 'coingecko:ethereum': { ...native, price: 1.2e-10 } }) });
  assert.equal((await tinyMarket.getQuotes(1, [])).native.priceUsd, '0.00000000012', 'JSON exponent becomes plain exact decimal');

  // The timeout covers both fetching and reading the body, including non-abortable clients.
  for (const fetchFailure of [
    async () => response({}, false),
    async () => ({ ok: true, json: async () => ({ unexpected: 'shape' }) }),
    async () => ({ ok: true, json: async () => { throw new Error('bad JSON'); } }),
    async () => new Promise(() => {}),
    async () => ({ ok: true, json: async () => new Promise(() => {}) }),
  ]) {
    const timeoutService = new prices.AssetPriceService({ now: () => now, fetch: fetchFailure, timeoutMs: 15 });
    const failedSnapshot = await timeoutService.getQuotes(1, []);
    assert.equal(failedSnapshot.error, true);
    assert.equal(failedSnapshot.native, null);
  }

  const timeoutStarted = Date.now();
  const boundedTimeout = new prices.AssetPriceService({ now: () => now, timeoutMs: 20, fetch: async () => new Promise(() => {}) });
  const timeoutSnapshot = await boundedTimeout.getQuotes(8453, [exactBase]);
  assert.equal(timeoutSnapshot.error, true);
  assert.ok(Date.now() - timeoutStarted < 250, 'the primary and fallback share a bounded two-timeout deadline');

  const knownBsc = [
    '0x55d398326f99059ff775485246999027b3197955', '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d',
    '0x1af3f329e8be154074d8769d1ffa4ee058b1dbc3', '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',
    '0x2170ed0880ac9a755fd29b2688956bd959f933f8', '0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c',
    '0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82',
  ];
  let aliasActive = 0, aliasPeak = 0, aliasBatches = 0;
  const aliasBound = new prices.AssetPriceService({ now: () => now, chunkSize: 3, fetch: async (url) => {
    assert.ok(!url.includes('/simple/price'));
    const keys = url.slice(url.indexOf('/current/') + 9, url.indexOf('?')).split(',');
    assert.ok(keys.length <= 3, 'exact-ID aliases remain in bounded primary batches');
    aliasBatches += 1; aliasActive += 1; aliasPeak = Math.max(aliasPeak, aliasActive);
    await tick(); aliasActive -= 1;
    return response(Object.fromEntries(keys.map((key) => [key, token])));
  } });
  const boundedAliases = await aliasBound.getQuotes(56, knownBsc);
  assert.equal(Object.keys(boundedAliases.tokens).length, knownBsc.length);
  assert.ok(aliasBatches > 3);
  assert.ok(aliasPeak <= 3, 'at most three primary/backup requests run even with aliases');

  // Contract batches and concurrency remain bounded for a large manually imported list.
  let active = 0;
  let peak = 0;
  const chunkGates = [];
  const bounded = new prices.AssetPriceService({ now: () => now, chunkSize: 5, fetch: async (url) => {
    active += 1;
    peak = Math.max(peak, active);
    const keys = url.slice(url.indexOf('/current/') + 9, url.indexOf('?')).split(',');
    assert.ok(keys.length <= 5);
    const gate = deferred();
    chunkGates.push(gate);
    await gate.promise;
    active -= 1;
    return response(Object.fromEntries(keys.map((key) => [key, token])));
  } });
  const manyAddresses = Array.from({ length: 40 }, (_, index) => '0x' + index.toString(16).padStart(40, '0'));
  const manyPromise = bounded.getQuotes(56, manyAddresses);
  await tick();
  assert.equal(chunkGates.length, 3);
  let settled = 0;
  while (settled < 9) {
    const round = chunkGates.slice(settled);
    round.forEach((gate) => gate.resolve());
    settled += round.length;
    await tick();
  }
  const many = await manyPromise;
  assert.equal(Object.keys(many.tokens).length, 40);
  assert.ok(peak <= 3);

  const staleService = new prices.AssetPriceService({
    now: () => now + 20 * 60_000,
    fetch: async () => { throw new Error('offline'); },
  });
  const stale = await staleService.getQuotes(1, []);
  assert.equal(stale.native, null, 'without a prior cache, failed fetch has no quote');
  assert.equal(stale.error, true);
  const unknown = await service.getQuotes(999, [address]);
  assert.equal(unknown.native, null);
  assert.deepEqual(unknown.tokens, {});
  console.log('Price verification passed: exact totals, chain+contract/bridge identity, slow upstream cadence recovery, timestamped batched fallback, failed/missing/invalid refresh recovery, strict freshness/confidence, shared cache, bounded aliases/concurrency/deadline. No live wallet addresses, symbols or secrets.');
}

run().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => fs.rmSync(output, { recursive: true, force: true }));
