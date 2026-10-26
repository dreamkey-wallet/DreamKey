/* Read-only market checks: only public network IDs and contracts; no wallet data. */
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const compiled = ts.transpileModule(fs.readFileSync(path.join(root, 'src/core/common-tokens.ts'), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const entry = { exports: {} };
new Function('module', 'exports', compiled)(entry, entry.exports);
const { getCommonTokens, getKnownTokens } = entry.exports;
const chains = {
  1: { namespace: 'ethereum', platform: 'ethereum' },
  56: { namespace: 'bsc', platform: 'binance-smart-chain' },
  137: { namespace: 'polygon', platform: 'polygon-pos' },
  42161: { namespace: 'arbitrum', platform: 'arbitrum-one' },
  8453: { namespace: 'base', platform: 'base' },
};
const report = {
  checkedAt: new Date().toISOString(),
  scope: 'Read-only public market API checks for built-in ERC-20 contracts; no wallet address or transaction data.',
  identitySource: 'https://api.coingecko.com/api/v3/coins/list?include_platform=true',
  results: [], errors: [],
};
const serviceOnly = process.argv.includes('--service-only');
async function json(url) {
  const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}
function llamaQuote(input) {
  if (!input || typeof input.price !== 'number' || input.price <= 0 || !Number.isFinite(input.price)
    || !Number.isSafeInteger(input.timestamp) || input.timestamp <= 0 || input.timestamp * 1000 > Date.now() + 60_000
    || typeof input.confidence !== 'number' || !Number.isFinite(input.confidence) || input.confidence < 0.8 || input.confidence > 1) return null;
  return { priceUsd: String(input.price), marketTimestamp: input.timestamp, confidence: input.confidence,
    ageSeconds: Math.max(0, Math.round(Date.now() / 1000 - input.timestamp)) };
}
function coinGeckoQuote(input) {
  if (!input || typeof input.usd !== 'number' || input.usd <= 0 || !Number.isFinite(input.usd)
    || !Number.isSafeInteger(input.last_updated_at) || input.last_updated_at <= 0 || input.last_updated_at * 1000 > Date.now() + 60_000) return null;
  return { priceUsd: String(input.usd), marketTimestamp: input.last_updated_at,
    ageSeconds: Math.max(0, Math.round(Date.now() / 1000 - input.last_updated_at)) };
}
async function verify() {
  const catalog = await json(report.identitySource);
  if (!Array.isArray(catalog)) throw new Error('Invalid CoinGecko contract catalog');
  for (const [chainId, identity] of Object.entries(chains)) {
    for (const token of getKnownTokens(Number(chainId))) {
      const address = token.address.toLowerCase();
      const coinIds = catalog.filter((coin) => String(coin.platforms?.[identity.platform] ?? '').toLowerCase() === address).map((coin) => coin.id);
      report.results.push({ chainId: Number(chainId), address, symbol: token.symbol, platform: identity.platform,
        contractKey: `${identity.namespace}:${address}`, coinGeckoId: coinIds.length === 1 ? coinIds[0] : null,
        identityStatus: coinIds.length === 1 ? 'exact-platform-contract' : 'unresolved' });
    }
  }
  const keys = [...new Set(report.results.flatMap((row) => [row.contractKey, ...(row.coinGeckoId ? [`coingecko:${row.coinGeckoId}`] : [])]))];
  const llama = {};
  // Three bounded batches, sequential to avoid bursting at the public service.
  for (let start = 0; start < keys.length; start += 25) {
    try {
      const response = await json(`https://coins.llama.fi/prices/current/${keys.slice(start, start + 25).join(',')}?searchWidth=4h`);
      if (!response.coins || typeof response.coins !== 'object') throw new Error('Invalid DefiLlama response');
      Object.assign(llama, response.coins);
    } catch (error) { report.errors.push({ source: 'defillama', message: error.message }); }
  }
  for (const row of report.results) {
    row.contractQuote = llamaQuote(llama[row.contractKey]);
    row.exactIdentityQuote = row.coinGeckoId ? llamaQuote(llama[`coingecko:${row.coinGeckoId}`]) : null;
  }
  const fallbackIds = [...new Set(report.results.filter((row) => Math.min(row.contractQuote?.ageSeconds ?? Infinity, row.exactIdentityQuote?.ageSeconds ?? Infinity) > 300)
    .map((row) => row.coinGeckoId).filter(Boolean))];
  let direct = {};
  if (fallbackIds.length) {
    try { direct = await json(`https://api.coingecko.com/api/v3/simple/price?ids=${fallbackIds.join(',')}&vs_currencies=usd&include_last_updated_at=true`); }
    catch (error) { report.errors.push({ source: 'coingecko', message: error.message }); }
  }
  for (const row of report.results) {
    row.directQuote = row.coinGeckoId ? coinGeckoQuote(direct[row.coinGeckoId]) : null;
    const options = [{ source: 'defillama-contract', quote: row.contractQuote },
      { source: 'defillama-exact-identity', quote: row.exactIdentityQuote },
      { source: 'coingecko-exact-identity', quote: row.directQuote }].filter(({ quote }) => quote);
    options.sort((a, b) => b.quote.marketTimestamp - a.quote.marketTimestamp);
    row.freshestSource = options[0]?.source ?? null;
    row.freshestAgeSeconds = options[0]?.quote.ageSeconds ?? null;
    row.status = row.freshestAgeSeconds === null ? 'unavailable' : row.freshestAgeSeconds <= 300 ? 'fresh' : 'delayed';
    console.log(`${row.chainId} ${row.symbol}: ${row.status}; contract ${row.contractQuote?.ageSeconds ?? 'missing'} s; freshest ${row.freshestAgeSeconds ?? 'missing'} s (${row.freshestSource ?? 'none'})`);
  }
  report.summary = { total: report.results.length, exactIdentities: report.results.filter((row) => row.identityStatus === 'exact-platform-contract').length,
    contractFresh: report.results.filter((row) => row.contractQuote && row.contractQuote.ageSeconds <= 300).length,
    combinedFresh: report.results.filter((row) => row.status === 'fresh').length, directFallbackIds: fallbackIds.length };
  fs.writeFileSync(path.join(root, 'docs', 'asset-prices-verification.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`Live common-token prices: ${report.summary.combinedFresh}/${report.summary.total} fresh, ${report.summary.exactIdentities} exact identities.`);
  if (report.summary.exactIdentities !== report.summary.total || report.summary.combinedFresh !== report.summary.total) process.exitCode = 1;
}
async function verifyDefaultService() {
  // Load the actual source entry and local TS dependencies without replacing fetch,
  // the clock, quote-age policies, cache settings, request limits or timeouts.
  const modules = new Map();
  function load(relative) {
    const filename = path.resolve(root, relative);
    if (modules.has(filename)) return modules.get(filename).exports;
    const module = { exports: {} };
    modules.set(filename, module);
    const body = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    }).outputText;
    const localRequire = (specifier) => {
      if (!specifier.startsWith('.')) return require(specifier);
      const resolved = path.resolve(path.dirname(filename), specifier.replace(/\.js$/, '.ts'));
      return load(path.relative(root, resolved));
    };
    new Function('module', 'exports', 'require', body)(module, module.exports, localRequire);
    return module.exports;
  }
  const { AssetPriceService } = load('src/core/asset-prices.ts');
  const service = new AssetPriceService();
  const actual = { checkedAt: new Date().toISOString(),
    scope: 'Actual default AssetPriceService.getQuotes across all built-in networks, using unchanged public fetch and freshness policies.',
    networks: [], results: [] };
  for (const chainId of Object.keys(chains).map(Number)) {
    const tokens = getCommonTokens(chainId);
    const startedAt = Date.now();
    const snapshot = await service.getQuotes(chainId, tokens.map((token) => token.address), true);
    actual.networks.push({ chainId, requestDurationMs: Date.now() - startedAt, error: snapshot.error,
      fetchedAt: snapshot.fetchedAt, native: snapshot.native ?? null });
    for (const token of tokens) {
      const quote = snapshot.tokens[token.address.toLowerCase()] ?? null;
      const ageSeconds = quote ? Math.round(Date.now() / 1000 - quote.timestamp) : null;
      const row = { chainId, address: token.address.toLowerCase(), symbol: token.symbol, quote,
        ageSeconds, status: !quote ? 'unavailable' : quote.stale || ageSeconds > 300 || ageSeconds < -60 ? 'delayed-or-cached' : 'fresh' };
      actual.results.push(row);
      console.log(`Default service ${chainId} ${token.symbol}: ${row.status}, ${row.ageSeconds ?? 'missing'} s`);
    }
  }
  actual.summary = { total: actual.results.length, fresh: actual.results.filter((row) => row.status === 'fresh').length,
    stale: actual.results.filter((row) => row.status === 'delayed-or-cached').length,
    unavailable: actual.results.filter((row) => row.status === 'unavailable').length,
    networkErrors: actual.networks.filter((network) => network.error).length,
    nativeFresh: actual.networks.filter((network) => network.native && !network.native.stale
      && Date.now() / 1000 - network.native.timestamp <= 300 && network.native.timestamp <= Date.now() / 1000 + 60).length };
  fs.writeFileSync(path.join(root, 'docs', 'asset-prices-service-verification.json'), JSON.stringify(actual, null, 2) + '\n');
  console.log(`Actual default service: ${actual.summary.fresh}/${actual.summary.total} fresh, ${actual.summary.stale} delayed/cached, ${actual.summary.unavailable} unavailable.`);
  if (actual.summary.fresh !== actual.summary.total || actual.summary.networkErrors || actual.summary.nativeFresh !== actual.networks.length) process.exitCode = 1;
}
(async () => {
  if (!serviceOnly) await verify();
  await verifyDefaultService();
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
