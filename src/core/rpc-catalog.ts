import { getRpcCatalogUrl, RPC_CATALOG_FALLBACK_URL, RPC_CATALOG_REFRESH_MS, RPC_CATALOG_TIMEOUT_MS, RPC_PROBE_TIMEOUT_MS } from '../config/rpc.js';
import { DEFAULT_NETWORKS } from './networks.js';
import { parseRpcEndpointSnapshot, selectIndependentRpcUrls, trustedRpcCandidate, type RpcEndpointSnapshot } from './rpc-endpoints.js';

export interface RpcCatalogResponse {
  ok: boolean;
  status: number;
  url?: string;
  headers?: { get(name: string): string | null };
  text(): Promise<string>;
}
export type RpcCatalogFetch = (url: string, init: {
  method: 'GET' | 'POST'; headers: Record<string, string>; body?: string;
  signal: AbortSignal; credentials: 'omit'; redirect: 'error';
}) => Promise<RpcCatalogResponse>;
export interface RpcCatalogOptions {
  fetch?: RpcCatalogFetch;
  now?: () => number;
  signal?: AbortSignal;
  /** Smaller values are useful for deterministic offline checks. */
  timeoutMs?: number;
  probeTimeoutMs?: number;
}
export interface RpcEndpointHealth {
  url: string;
  chainId: number;
  blockNumber: number;
  blockTimestamp: number;
  latencyMs: number;
}

/** Convert TokenPocket's per-chain response into the small directory shape
 * used by the candidate selector. The API is discovery input only; endpoint
 * trust is still enforced by `trustedRpcCandidate` below. */
export function parseTokenPocketDirectory(value: unknown, chainId: number): unknown[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid RPC directory');
  const body = value as Record<string, unknown>;
  if (body.result !== 0 || body.message !== 'success' || !Array.isArray(body.data) || body.data.length > 20_000) {
    throw new Error('Invalid RPC directory');
  }
  return body.data.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const row = entry as Record<string, unknown>;
    const listedChain = typeof row.chain_id === 'string' ? Number(row.chain_id) : row.chain_id;
    if (listedChain !== chainId || typeof row.url !== 'string') return [];
    // Disabled/non-RPC records must not become candidates. Current API uses
    // status=0 for active endpoints; unknown status values are ignored.
    if (row.status !== undefined && row.status !== 0) return [];
    return [{ chainId, rpc: [{ url: row.url }] }];
  });
}

/**
 * Normalize the legacy Chainlist directory into the same shape as the primary
 * TokenPocket source. Chainlist is discovery input only; endpoint allowlisting
 * and health probing still happen in collectRpcCandidates/refreshRpcCatalog.
 */
export function parseChainlistDirectory(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > 20_000) throw new Error('Invalid RPC fallback directory');
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const row = entry as Record<string, unknown>;
    const chainId = typeof row.chainId === 'string' ? Number(row.chainId) : row.chainId;
    if (!Number.isSafeInteger(chainId) || !DEFAULT_NETWORKS.some((network) => network.chainId === chainId)) return [];
    if (!Array.isArray(row.rpc) || row.rpc.length > 256) return [];
    const rpc = row.rpc.flatMap((item) => {
      if (typeof item === 'string') return [{ url: item }];
      if (item && typeof item === 'object' && !Array.isArray(item) && typeof (item as Record<string, unknown>).url === 'string') {
        return [{ url: (item as Record<string, unknown>).url }];
      }
      return [];
    });
    return rpc.length ? [{ chainId, rpc }] : [];
  });
}

const MAX_CATALOG_BYTES = 6 * 1024 * 1024;
const MAX_RPC_BYTES = 128 * 1024;
const MAX_BLOCK_AGE_SECONDS = 180;
const MAX_FUTURE_BLOCK_SECONDS = 60;
const MAX_BLOCK_LAG: Record<number, number> = { 1: 8, 56: 120, 137: 60, 42161: 480, 8453: 60 };

function aborted(): Error { return new Error('RPC discovery canceled'); }

async function withDeadline<T>(run: (signal: AbortSignal) => Promise<T>, timeoutMs: number, parent?: AbortSignal): Promise<T> {
  if (parent?.aborted) throw aborted();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: (() => void) | undefined;
  const interruption = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error('RPC discovery timed out')); }, timeoutMs);
    cancel = () => { controller.abort(); reject(aborted()); };
    parent?.addEventListener('abort', cancel, { once: true });
  });
  try { return await Promise.race([run(controller.signal), interruption]); }
  finally {
    if (timer !== undefined) clearTimeout(timer);
    if (cancel) parent?.removeEventListener('abort', cancel);
  }
}

function checkTiming(value: number, maximum: number): number {
  if (!Number.isFinite(value) || value < 1 || value > maximum) throw new Error('Invalid RPC discovery timing policy');
  return value;
}

async function fetchJson(fetcher: RpcCatalogFetch, url: string, init: Parameters<RpcCatalogFetch>[1], limit: number): Promise<unknown> {
  const response = await fetcher(url, init);
  if (!response.ok) throw new Error(`RPC discovery request failed (${response.status})`);
  // Fetch implementations honoring redirect:error refuse redirects before the
  // second request. React Native may follow them; reject the changed final URL
  // too, so redirected replies never enter the catalog/health result.
  if (response.url && new URL(response.url).href !== new URL(url).href) throw new Error('RPC discovery redirect refused');
  const length = response.headers?.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > limit)) throw new Error('RPC discovery response too large');
  const text = await response.text();
  if (text.length > limit) throw new Error('RPC discovery response too large');
  return JSON.parse(text) as unknown;
}

function quantity(value: unknown): number {
  if (typeof value !== 'string' || !/^0x(?:0|[1-9a-f][\da-f]*)$/i.test(value)) throw new Error('Invalid RPC block data');
  const number = Number(BigInt(value));
  if (!Number.isSafeInteger(number) || number < 0) throw new Error('Invalid RPC block data');
  return number;
}

async function probe(chainId: number, url: string, fetcher: RpcCatalogFetch, now: () => number, timeoutMs: number, signal: AbortSignal): Promise<RpcEndpointHealth> {
  return withDeadline(async (probeSignal) => {
    const started = now();
    let id = 0;
    const request = async (method: string, params: unknown[]): Promise<unknown> => {
      if (probeSignal.aborted) throw aborted();
      const requestId = ++id;
      const body = await fetchJson(fetcher, url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }),
        credentials: 'omit', redirect: 'error', signal: probeSignal,
      }, MAX_RPC_BYTES);
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid RPC probe response');
      const reply = body as Record<string, unknown>;
      if (reply.jsonrpc !== '2.0' || reply.id !== requestId || 'error' in reply || !Object.prototype.hasOwnProperty.call(reply, 'result')) throw new Error('Invalid RPC probe response');
      return reply.result;
    };
    // Verify chain before making even the public block-health requests.
    if (quantity(await request('eth_chainId', [])) !== chainId) throw new Error('RPC chain mismatch');
    const blockNumber = quantity(await request('eth_blockNumber', []));
    const latest = await request('eth_getBlockByNumber', ['latest', false]);
    if (!latest || typeof latest !== 'object' || Array.isArray(latest)) throw new Error('Invalid RPC latest block');
    const block = latest as Record<string, unknown>;
    const blockTimestamp = quantity(block.timestamp);
    const latestNumber = quantity(block.number);
    const age = Math.floor(now() / 1000) - blockTimestamp;
    if (age > MAX_BLOCK_AGE_SECONDS || age < -MAX_FUTURE_BLOCK_SECONDS ||
        latestNumber < blockNumber - MAX_BLOCK_LAG[chainId] || latestNumber > blockNumber + MAX_BLOCK_LAG[chainId]) throw new Error('RPC block data is stale or inconsistent');
    const latencyMs = Math.max(0, now() - started);
    if (latencyMs > timeoutMs) throw new Error('RPC probe too slow');
    return { url, chainId, blockNumber: latestNumber, blockTimestamp, latencyMs };
  }, timeoutMs, signal);
}

/** Only built-in mainnets and explicitly trusted public operators are probed. */
export function collectRpcCandidates(directory: unknown, previous: RpcEndpointSnapshot | null, now = Date.now()): Map<number, string[]> {
  if (!Array.isArray(directory) || directory.length > 20_000) throw new Error('Invalid RPC directory');
  const listed = new Map<number, string[]>();
  for (const value of directory) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    if (typeof entry.chainId !== 'number' || !DEFAULT_NETWORKS.some((network) => network.chainId === entry.chainId) || !Array.isArray(entry.rpc) || entry.rpc.length > 256) continue;
    const values = entry.rpc.map((rpc: unknown) => typeof rpc === 'string' ? rpc : rpc && typeof rpc === 'object' ? (rpc as Record<string, unknown>).url : undefined);
    listed.set(entry.chainId, [...(listed.get(entry.chainId) ?? []), ...values.filter((url): url is string => typeof url === 'string')]);
  }
  if (!listed.size) throw new Error('RPC directory does not contain supported mainnets');
  const candidates = new Map<number, string[]>();
  for (const network of DEFAULT_NETWORKS) {
    // Four recent/bundled operators plus one rotating discovery slot: five
    // candidates per chain, at most 25 probes over the complete refresh.
    const stable = selectIndependentRpcUrls(network.chainId, [...(previous?.chains[String(network.chainId)] ?? []), network.rpcUrl, ...(network.rpcFallbackUrls ?? [])], 4);
    const operators = new Set(stable.map((url) => trustedRpcCandidate(network.chainId, url)!.operator));
    const unrepresented = (listed.get(network.chainId) ?? []).filter((url) => {
      const candidate = trustedRpcCandidate(network.chainId, url);
      return candidate && !operators.has(candidate.operator);
    });
    const additions = selectIndependentRpcUrls(network.chainId, unrepresented);
    const rotation = Math.floor(now / RPC_CATALOG_REFRESH_MS);
    candidates.set(network.chainId, additions.length ? [...stable, additions[rotation % additions.length]] : stable);
  }
  return candidates;
}

/** Failed refreshes reject; callers retain the current list and cached file. */
export async function refreshRpcCatalog(previous?: RpcEndpointSnapshot | null, options: RpcCatalogOptions = {}): Promise<RpcEndpointSnapshot> {
  const fetcher = options.fetch ?? globalThis.fetch as RpcCatalogFetch;
  if (!fetcher) throw new Error('RPC discovery requires fetch');
  const now = options.now ?? Date.now;
  const prior = parseRpcEndpointSnapshot(previous, now());
  const timeoutMs = checkTiming(options.timeoutMs ?? RPC_CATALOG_TIMEOUT_MS, RPC_CATALOG_TIMEOUT_MS);
  const probeTimeoutMs = checkTiming(options.probeTimeoutMs ?? RPC_PROBE_TIMEOUT_MS, RPC_PROBE_TIMEOUT_MS);
  return withDeadline(async (signal) => {
    let firstDirectoryError: unknown;
    const primaryResults = await Promise.all(DEFAULT_NETWORKS.map(async (network) => {
      const url = getRpcCatalogUrl(network.chainId);
      try {
        const payload = await withDeadline((directorySignal) => fetchJson(fetcher, url, {
          method: 'GET', headers: { accept: 'application/json' }, credentials: 'omit', redirect: 'error', signal: directorySignal,
        }, MAX_CATALOG_BYTES), Math.min(timeoutMs, 10_000), signal);
        return { chainId: network.chainId, entries: parseTokenPocketDirectory(payload, network.chainId) };
      } catch (error) {
        if (signal.aborted) throw error;
        firstDirectoryError ??= error;
        return { chainId: network.chainId, entries: [] as unknown[] };
      }
    }));
    const missing = new Set(primaryResults.filter((result) => result.entries.length === 0).map((result) => result.chainId));
    let fallbackDirectory: unknown[] = [];
    if (missing.size) {
      try {
        const payload = await withDeadline((directorySignal) => fetchJson(fetcher, RPC_CATALOG_FALLBACK_URL, {
          method: 'GET', headers: { accept: 'application/json' }, credentials: 'omit', redirect: 'error', signal: directorySignal,
        }, MAX_CATALOG_BYTES), Math.min(timeoutMs, 10_000), signal);
        fallbackDirectory = parseChainlistDirectory(payload);
      } catch (error) {
        if (signal.aborted) throw error;
        firstDirectoryError ??= error;
      }
    }
    const directory = primaryResults.flatMap((result) => {
      if (result.entries.length) return result.entries;
      return fallbackDirectory.filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry) && (entry as Record<string, unknown>).chainId === result.chainId);
    });
    if (!directory.length) throw firstDirectoryError ?? new Error('RPC directory does not contain supported mainnets');
    const candidates = collectRpcCandidates(directory, prior, now());
    const jobs = [...candidates].flatMap(([chainId, urls]) => urls.map((url) => ({ chainId, url })));
    const health: RpcEndpointHealth[] = [];
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < jobs.length && !signal.aborted) {
        const job = jobs[next++];
        try { health.push(await probe(job.chainId, job.url, fetcher, now, probeTimeoutMs, signal)); }
        catch { if (signal.aborted) throw aborted(); }
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    if (signal.aborted) throw aborted();
    if (!health.length) throw new Error('No healthy RPC endpoints found');
    const chains: Record<string, string[]> = {};
    const chainUpdatedAt: Record<string, number> = {};
    for (const network of DEFAULT_NETWORKS) {
      const available = health.filter((endpoint) => endpoint.chainId === network.chainId);
      const highest = Math.max(0, ...available.map((endpoint) => endpoint.blockNumber));
      const selected = available.filter((endpoint) => highest - endpoint.blockNumber <= MAX_BLOCK_LAG[network.chainId])
        .sort((a, b) => a.latencyMs - b.latencyMs).map((endpoint) => endpoint.url);
      const urls = selectIndependentRpcUrls(network.chainId, selected);
      // A chain outage never replaces its last usable list with an empty list.
      if (urls.length) {
        chains[String(network.chainId)] = urls;
        chainUpdatedAt[String(network.chainId)] = now();
      } else if (prior?.chains[String(network.chainId)]) {
        chains[String(network.chainId)] = [...prior.chains[String(network.chainId)]];
        chainUpdatedAt[String(network.chainId)] = prior.chainUpdatedAt?.[String(network.chainId)] ?? prior.updatedAt;
      }
    }
    return { version: 1, updatedAt: now(), chains, chainUpdatedAt };
  }, timeoutMs, options.signal);
}
