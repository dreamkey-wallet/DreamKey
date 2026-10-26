/** Public market prices are hints for display, never a transaction amount or balance source. */
export interface PriceQuote {
  priceUsd: string;
  /** The market data timestamp in seconds. */
  timestamp: number;
  stale?: boolean;
}

export interface AssetPriceSnapshot {
  native: PriceQuote | null;
  /** Keys are exact, lowercase token contracts on the requested chain. */
  tokens: Record<string, PriceQuote>;
  error: boolean;
  errorMessage?: string;
  /** Local retrieval timestamp in milliseconds. */
  fetchedAt: number;
}

export interface ValuedAsset {
  priceUsd: string | null;
  valueUsd: string | null;
  stale: boolean;
}

export interface WalletAssetValuation {
  assets: Record<string, ValuedAsset>;
  /** Sum of available holdings; complete explains whether this is a partial estimate. */
  totalUsd: string | null;
  missingCount: number;
  complete: boolean;
  stale: boolean;
}

export interface PricedWalletAsset {
  id: string;
  balance: string | null;
  loading?: boolean;
  error?: string;
  token?: { address: string };
}

const PRICE_API = 'https://coins.llama.fi/prices/current/';
const COINGECKO_API = 'https://api.coingecko.com/api/v3/simple/price';
const CHAIN_PRICES: Readonly<Record<number, { namespace: string; native: string }>> = {
  1: { namespace: 'ethereum', native: 'coingecko:ethereum' },
  56: { namespace: 'bsc', native: 'coingecko:binancecoin' },
  137: { namespace: 'polygon', native: 'coingecko:polygon-ecosystem-token' },
  42161: { namespace: 'arbitrum', native: 'coingecko:ethereum' },
  8453: { namespace: 'base', native: 'coingecko:ethereum' },
};
const ADDRESS = /^0x[0-9a-f]{40}$/;
const MAX_CACHE_KEYS = 2048;

/** Verified CoinGecko platform + contract identities, never inferred from a symbol.
 * Bridged coins deliberately have their own IDs rather than the underlying asset.
 * Evidence: docs/asset-prices-verification.json; update with verify-prices-live.cjs.
 */
const TOKEN_PRICE_IDS: Readonly<Record<string, string>> = {
  'ethereum:0xdac17f958d2ee523a2206206994597c13d831ec7': 'tether',
  'ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 'usd-coin',
  'ethereum:0x6b175474e89094c44da98b954eedeac495271d0f': 'dai',
  'ethereum:0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': 'weth',
  'ethereum:0x2260fac5e5542a773aa44fbcfedf7c193bc2c599': 'wrapped-bitcoin',
  'ethereum:0x1f9840a85d5af5bf1d1762f925bdaddc4201f984': 'uniswap',
  'ethereum:0x514910771af9ca656af840dff83e8264ecf986ca': 'chainlink',
  'bsc:0x55d398326f99059ff775485246999027b3197955': 'binance-bridged-usdt-bnb-smart-chain',
  'bsc:0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d': 'binance-bridged-usdc-bnb-smart-chain',
  'bsc:0x1af3f329e8be154074d8769d1ffa4ee058b1dbc3': 'binance-peg-dai',
  'bsc:0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c': 'wbnb',
  'bsc:0x2170ed0880ac9a755fd29b2688956bd959f933f8': 'binance-peg-weth',
  'bsc:0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c': 'binance-bitcoin',
  'bsc:0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82': 'pancakeswap-token',
  'polygon:0xc2132d05d31c914a87c6611c10748aeb04b58e8f': 'usdt0',
  'polygon:0x3c499c542cef5e3811e1192ce70d8cc03d5c3359': 'usd-coin',
  'polygon:0x2791bca1f2de4661ed88a30c99a7a9449aa84174': 'bridged-usdc-polygon-pos-bridge',
  'polygon:0x8f3cf7ad23cd3cadbd9735aff958023239c6a063': 'polygon-pos-bridged-dai-polygon-pos',
  'polygon:0x7ceb23fd6bc0add59e62ac25578270cff1b9f619': 'polygon-pos-bridged-weth-polygon-pos',
  'polygon:0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6': 'polygon-bridged-wbtc-polygon-pos',
  'polygon:0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270': 'wmatic',
  'base:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': 'usd-coin',
  'base:0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca': 'bridged-usd-coin-base',
  'base:0x50c5725949a6f0c72e6c4a641f24049a917db0cb': 'l2-standard-bridged-dai-base',
  'base:0x4200000000000000000000000000000000000006': 'l2-standard-bridged-weth-base',
  'base:0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf': 'coinbase-wrapped-btc',
  'base:0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22': 'coinbase-wrapped-staked-eth',
  'base:0x940181a94a35a4569e4529a3cdfb74e38fd98631': 'aerodrome-finance',
  'arbitrum:0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9': 'usdt0',
  'arbitrum:0xaf88d065e77c8cc2239327c5edb3a432268e5831': 'usd-coin',
  'arbitrum:0xff970a61a04b1ca14834a43f5de4533ebddb5cc8': 'usd-coin-ethereum-bridged',
  'arbitrum:0xda10009cbd5d07dd0cecc66161fc93d7c9000da1': 'makerdao-arbitrum-bridged-dai-arbitrum-one',
  'arbitrum:0x82af49447d8a07e3bd95bd0d56f35241523fbab1': 'arbitrum-bridged-weth-arbitrum-one',
  'arbitrum:0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f': 'arbitrum-bridged-wbtc-arbitrum-one',
  'arbitrum:0x912ce59144191c1204e64559fe8253a0e49e6548': 'arbitrum',
};
const NATIVE_PRICE_IDS: Readonly<Record<string, string>> = {
  'coingecko:ethereum': 'ethereum',
  'coingecko:binancecoin': 'binancecoin',
  'coingecko:polygon-ecosystem-token': 'polygon-ecosystem-token',
};

function exactPriceId(key: string): string | undefined {
  return TOKEN_PRICE_IDS[key] ?? NATIVE_PRICE_IDS[key];
}

export interface AssetPriceServiceOptions {
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  cacheTtlMs?: number;
  /** Quotes older than this are explicitly marked stale. */
  maxQuoteAgeMs?: number;
  /** No quote older than this can be used, including a network failure fallback. */
  maxStaleAgeMs?: number;
  chunkSize?: number;
}

interface CachedPrice { quote: PriceQuote | null; fetchedAt: number; error: boolean }
interface KeyPrice { quote: PriceQuote | null; error: boolean }

/** Fixed chain + contract identity prevents ticker collisions and sends no wallet address. */
export class AssetPriceService {
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly cacheTtlMs: number;
  private readonly maxQuoteAgeMs: number;
  private readonly maxStaleAgeMs: number;
  private readonly chunkSize: number;
  private readonly cache = new Map<string, CachedPrice>();
  private readonly inFlight = new Map<string, Promise<KeyPrice>>();
  private readonly queue: Array<() => void> = [];
  private activeRequests = 0;

  constructor(options: AssetPriceServiceOptions = {}) {
    this.fetcher = options.fetch ?? ((...args) => fetch(...args));
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? 8000;
    this.cacheTtlMs = options.cacheTtlMs ?? 60_000;
    this.maxQuoteAgeMs = options.maxQuoteAgeMs ?? 5 * 60_000;
    this.maxStaleAgeMs = options.maxStaleAgeMs ?? 15 * 60_000;
    this.chunkSize = Math.min(25, Math.max(1, Math.floor(options.chunkSize ?? 25)));
  }

  async getQuotes(chainId: number, tokenAddresses: string[], force = false): Promise<AssetPriceSnapshot> {
    const identity = CHAIN_PRICES[chainId];
    if (!identity) return { native: null, tokens: {}, error: false, fetchedAt: this.now() };
    const addresses = [...new Set(tokenAddresses.map((address) => address.toLowerCase()).filter((address) => ADDRESS.test(address)))];
    const nativeKey = identity.native;
    const keys = [nativeKey, ...addresses.map((address) => `${identity.namespace}:${address}`)];
    const pending = new Map<string, Promise<KeyPrice>>();
    const newKeys: string[] = [];
    const now = this.now();
    for (const key of keys) {
      const running = this.inFlight.get(key);
      if (running) {
        pending.set(key, running);
        continue;
      }
      const cached = this.cache.get(key);
      if (!force && cached && now - cached.fetchedAt < this.cacheTtlMs) {
        const quote = this.availableQuote(cached.quote, now);
        if (!cached.quote || quote) {
          pending.set(key, Promise.resolve({ quote, error: cached.error }));
          continue;
        }
      }
      newKeys.push(key);
    }
    for (let start = 0; start < newKeys.length; start += this.chunkSize) {
      const chunk = newKeys.slice(start, start + this.chunkSize);
      const resolvers = new Map<string, (result: KeyPrice) => void>();
      for (const key of chunk) {
        const promise = new Promise<KeyPrice>((resolve) => { resolvers.set(key, resolve); });
        this.inFlight.set(key, promise);
        pending.set(key, promise);
      }
      void this.limited(async () => {
        let results: Map<string, KeyPrice>;
        try { results = await this.refreshKeys(chunk); }
        catch {
          results = new Map(chunk.map((key) => [key, {
            quote: this.availableQuote(this.cache.get(key)?.quote ?? null, this.now(), true), error: true,
          }]));
        }
        for (const key of chunk) {
          const result = results.get(key)!;
          this.cache.delete(key);
          this.cache.set(key, { ...result, fetchedAt: this.now() });
          this.inFlight.delete(key);
          resolvers.get(key)!(result);
        }
        while (this.cache.size > MAX_CACHE_KEYS) this.cache.delete(this.cache.keys().next().value!);
      });
    }
    const quotes = await Promise.all(keys.map((key) => pending.get(key)!));
    const error = quotes.some((result) => result.error);
    const tokens: Record<string, PriceQuote> = {};
    addresses.forEach((address, index) => {
      const quote = quotes[index + 1].quote;
      if (quote) tokens[address] = { ...quote };
    });
    return {
      native: quotes[0].quote ? { ...quotes[0].quote } : null,
      tokens,
      error,
      ...(error ? { errorMessage: 'Market prices unavailable' } : {}),
      fetchedAt: this.now(),
    };
  }

  private availableQuote(quote: PriceQuote | null, now: number, failed = false): PriceQuote | null {
    if (!quote || now - quote.timestamp * 1000 > this.maxStaleAgeMs || quote.timestamp * 1000 > now + 60_000) return null;
    return { ...quote, stale: failed || Boolean(quote.stale) || now - quote.timestamp * 1000 > this.maxQuoteAgeMs };
  }

  private readQuote(input: unknown, now: number): PriceQuote | null {
    if (!input || typeof input !== 'object') return null;
    const entry = input as { price?: unknown; timestamp?: unknown; confidence?: unknown };
    if (typeof entry.price !== 'number' || !Number.isFinite(entry.price) || entry.price <= 0
      || typeof entry.timestamp !== 'number' || !Number.isSafeInteger(entry.timestamp) || entry.timestamp <= 0
      || typeof entry.confidence !== 'number' || !Number.isFinite(entry.confidence) || entry.confidence < 0.8 || entry.confidence > 1) return null;
    return this.availableQuote({ priceUsd: numberDecimal(entry.price), timestamp: entry.timestamp }, now);
  }

  /** A primary batch and one stale-only backup fit within two request timeouts. */
  private async refreshKeys(keys: string[]): Promise<Map<string, KeyPrice>> {
    const deadline = Date.now() + this.timeoutMs * 2;
    const requestKeys = [...new Set(keys.flatMap((key) => {
      const id = exactPriceId(key);
      return id ? [key, `coingecko:${id}`] : [key];
    }))];
    const primary: Record<string, unknown> = {};
    let primaryFailed = false;
    // Aliases cannot turn a bounded batch into an oversized API request.
    for (let start = 0; start < requestKeys.length; start += this.chunkSize) {
      const batch = requestKeys.slice(start, start + this.chunkSize);
      try {
        const body = await this.requestJson(`${PRICE_API}${batch.join(',')}?searchWidth=4h`, deadline);
        const coins = (body as { coins?: unknown }).coins;
        if (!coins || typeof coins !== 'object' || Array.isArray(coins)) throw new Error('Invalid market price response');
        Object.assign(primary, coins);
      } catch { primaryFailed = true; }
    }
    const candidates = new Map<string, PriceQuote | null>();
    const backupIds = new Set<string>();
    for (const key of keys) {
      const id = exactPriceId(key);
      const contractQuote = this.readQuote(primary[key], this.now());
      const mappedQuote = id ? this.readQuote(primary[`coingecko:${id}`], this.now()) : null;
      const quote = this.newerQuote(contractQuote, mappedQuote);
      candidates.set(key, quote);
      if (id && (!quote || quote.stale)) backupIds.add(id);
    }
    let backup: Record<string, unknown> | null = null;
    if (backupIds.size) {
      try {
        backup = await this.requestJson(`${COINGECKO_API}?ids=${[...backupIds].join(',')}&vs_currencies=usd&include_last_updated_at=true`, deadline);
      } catch { /* The timestamp-bounded primary/cache fallback stays available. */ }
    }
    const finishedAt = this.now();
    return new Map(keys.map((key) => {
      const id = exactPriceId(key);
      const entry = id ? backup?.[id] : undefined;
      // CoinGecko's independent response has a real market timestamp, not fetch time.
      const direct = entry && typeof entry === 'object'
        ? this.readQuote({ price: (entry as { usd?: unknown }).usd, timestamp: (entry as { last_updated_at?: unknown }).last_updated_at, confidence: 1 }, finishedAt)
        : null;
      const current = this.newerQuote(this.availableQuote(candidates.get(key) ?? null, finishedAt), direct);
      const cached = this.availableQuote(this.cache.get(key)?.quote ?? null, finishedAt, true);
      // Empty, invalid or older successful responses must not discard a better cache.
      const useCache = cached && (!current || cached.timestamp > current.timestamp);
      const quote = useCache ? cached : current;
      const error = Boolean(useCache) || (!quote && (primaryFailed || (backupIds.has(id ?? '') && backup === null)));
      return [key, { quote, error }];
    }));
  }

  private newerQuote(first: PriceQuote | null, second: PriceQuote | null): PriceQuote | null {
    if (!first) return second;
    if (!second) return first;
    return second.timestamp > first.timestamp ? second : first;
  }

  private async requestJson(url: string, deadline: number): Promise<Record<string, unknown>> {
    const remainingMs = Math.min(this.timeoutMs, deadline - Date.now());
    if (remainingMs <= 0) throw new Error('Market price deadline');
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('Market price timeout')); }, remainingMs);
    });
    try {
      return await Promise.race([
        (async () => {
          const response = await this.fetcher(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
          if (!response.ok) throw new Error('Market price HTTP failure');
          const body: unknown = await response.json();
          if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid market price response');
          return body as Record<string, unknown>;
        })(),
        timeout,
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** At most three HTTP requests run concurrently, even with a large imported asset list. */
  private limited(operation: () => Promise<void>): Promise<void> {
    return new Promise((resolve) => {
      const run = () => {
        this.activeRequests += 1;
        void operation().finally(() => {
          this.activeRequests -= 1;
          resolve();
          this.queue.shift()?.();
        });
      };
      if (this.activeRequests < 3) run();
      else this.queue.push(run);
    });
  }
}

export const assetPriceService = new AssetPriceService();

interface Decimal { coefficient: bigint; scale: number }
function decimal(input: string | null): Decimal | null {
  if (input === null || input.length > 2048 || !/^\d+(?:\.\d+)?$/.test(input)) return null;
  const [whole, fraction = ''] = input.split('.');
  return { coefficient: BigInt(whole + fraction), scale: fraction.length };
}

function decimalText(input: Decimal): string {
  if (input.coefficient === 0n) return '0';
  const digits = input.coefficient.toString().padStart(input.scale + 1, '0');
  if (!input.scale) return digits;
  return `${digits.slice(0, -input.scale)}.${digits.slice(-input.scale)}`.replace(/0+$/, '').replace(/\.$/, '');
}

function add(a: Decimal, b: Decimal): Decimal {
  const scale = Math.max(a.scale, b.scale);
  return { coefficient: a.coefficient * 10n ** BigInt(scale - a.scale) + b.coefficient * 10n ** BigInt(scale - b.scale), scale };
}

/** Convert a finite JSON number to plain decimal before using exact holding arithmetic. */
function numberDecimal(input: number): string {
  const text = String(input);
  if (!/[eE]/.test(text)) return text;
  const [significand, exponentText] = text.toLowerCase().split('e');
  const [whole, fraction = ''] = significand.split('.');
  const digits = whole + fraction;
  const position = whole.length + Number(exponentText);
  if (position <= 0) return `0.${'0'.repeat(-position)}${digits}`;
  if (position >= digits.length) return digits + '0'.repeat(position - digits.length);
  return `${digits.slice(0, position)}.${digits.slice(position)}`;
}

/** Exact decimal multiplication and addition; balances are never converted to Number. */
export function valueWalletAssets(input: readonly PricedWalletAsset[], quotes: AssetPriceSnapshot): WalletAssetValuation {
  const assets: Record<string, ValuedAsset> = {};
  let total: Decimal = { coefficient: 0n, scale: 0 };
  let known = 0;
  let missingCount = 0;
  let stale = false;
  let complete = input.length > 0 && !quotes.error;
  for (const asset of input) {
    const quote = asset.id === 'native' && !asset.token
      ? quotes.native
      : asset.token ? quotes.tokens[asset.token.address.toLowerCase()] ?? null : null;
    const price = decimal(quote?.priceUsd ?? null);
    const usablePrice = price && price.coefficient > 0n ? price : null;
    const balance = asset.error ? null : decimal(asset.balance);
    const old = usablePrice ? Boolean(quote?.stale) : false;
    let value: Decimal | null = null;
    if (balance?.coefficient === 0n) value = { coefficient: 0n, scale: 0 };
    else if (balance && usablePrice) value = { coefficient: balance.coefficient * usablePrice.coefficient, scale: balance.scale + usablePrice.scale };
    if (value) {
      total = add(total, value);
      known += 1;
    } else {
      missingCount += 1;
      complete = false;
    }
    if (asset.loading || old) complete = false;
    stale ||= old;
    assets[asset.id] = { priceUsd: usablePrice ? decimalText(usablePrice) : null, valueUsd: value ? decimalText(value) : null, stale: old };
  }
  return { assets, totalUsd: known ? decimalText(total) : null, missingCount, complete, stale };
}

// Intl only sees a safe integer to obtain locale separators. Actual money remains a string.
const USD_GROUP_SEPARATORS = {
  zh: new Intl.NumberFormat('zh-CN').formatToParts(1000).find((part) => part.type === 'group')?.value ?? ',',
  en: new Intl.NumberFormat('en-US').formatToParts(1000).find((part) => part.type === 'group')?.value ?? ',',
};

export function formatUsd(input: string | null, mode: 'value' | 'price' = 'value', language: 'zh' | 'en' = 'zh'): string {
  const amount = decimal(input);
  if (!amount) return '—';
  const places = mode === 'price' && amount.coefficient < 10n ** BigInt(amount.scale) ? 8 : 2;
  if (amount.coefficient > 0n && amount.coefficient * 10n ** BigInt(places) < 10n ** BigInt(amount.scale)) {
    return places === 2 ? '<$0.01' : '<$0.00000001';
  }
  const scaled = amount.scale <= places
    ? amount.coefficient * 10n ** BigInt(places - amount.scale)
    : (amount.coefficient + 5n * 10n ** BigInt(amount.scale - places - 1)) / 10n ** BigInt(amount.scale - places);
  const unit = 10n ** BigInt(places);
  const whole = (scaled / unit).toString().replace(/\B(?=(\d{3})+(?!\d))/g, USD_GROUP_SEPARATORS[language]);
  let fraction = (scaled % unit).toString().padStart(places, '0');
  if (places > 2) fraction = fraction.replace(/0+$/, '').padEnd(2, '0');
  return `$${whole}.${fraction}`;
}
