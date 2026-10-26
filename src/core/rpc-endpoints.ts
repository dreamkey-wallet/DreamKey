import { RPC_CATALOG_CACHE_MAX_AGE_MS } from '../config/rpc.js';
import { DEFAULT_NETWORKS } from './networks.js';

export interface RpcEndpointSnapshot {
  version: 1;
  updatedAt: number;
  chains: Record<string, string[]>;
  /** Successful health-check time per chain; an outage cannot renew its TTL. */
  chainUpdatedAt?: Record<string, number>;
}

interface RpcNetworkIdentity { chainId: number; rpcUrl: string; rpcFallbackUrls?: string[] }
export interface RpcEndpointCandidate { url: string; operator: string }
export type RpcEndpointHealthStatus = 'unknown' | 'ok' | 'slow' | 'offline';
export interface RpcEndpointHealth {
  status: RpcEndpointHealthStatus;
  latencyMs?: number;
  checkedAt?: number;
}

// A public directory is discovery data, not an authority to introduce arbitrary
// servers. Paths are exact so API tokens and private/tenant endpoints stay out.
const TRUSTED_ENDPOINTS: Record<number, ReadonlyArray<readonly [string, string]>> = {
  56: [
    ['https://bsc.mytokenpocket.vip', 'tokenpocket'],
    ['https://bsc-rpc.publicnode.com', 'publicnode'],
    ['https://bsc-dataseed1.bnbchain.org', 'bnbchain'],
    ['https://bsc-dataseed.bnbchain.org', 'bnbchain'],
    ['https://bsc-dataseed1.defibit.io', 'defibit'],
    ['https://api.zan.top/bsc-mainnet', 'zan'],
    ['https://bsc.drpc.org', 'drpc'],
    ['https://public.1rpc.io/bnb', '1rpc'],
  ],
  1: [
    ['https://web3.mytokenpocket.vip', 'tokenpocket'],
    ['https://eth.mytokenpocket.vip', 'tokenpocket'],
    ['https://reth.mytokenpocket.vip', 'tokenpocket'],
    ['https://ethereum-rpc.publicnode.com', 'publicnode'],
    ['https://eth.drpc.org', 'drpc'],
    ['https://mainnet.gateway.tenderly.co', 'tenderly'],
    ['https://gateway.tenderly.co/public/mainnet', 'tenderly'],
    ['https://ethereum.public.blockpi.network/v1/rpc/public', 'blockpi'],
    ['https://api.zan.top/eth-mainnet', 'zan'],
    ['https://public.1rpc.io/eth', '1rpc'],
    ['https://cloudflare-eth.com', 'cloudflare'],
  ],
  42161: [
    ['https://arb.mytokenpocket.vip', 'tokenpocket'],
    ['https://arbitrum.drpc.org', 'drpc'],
    ['https://arbitrum-one-rpc.publicnode.com', 'publicnode'],
    ['https://arb1.arbitrum.io/rpc', 'arbitrum'],
    ['https://arbitrum.gateway.tenderly.co', 'tenderly'],
    ['https://public.1rpc.io/arb', '1rpc'],
    ['https://api.zan.top/arb-one', 'zan'],
  ],
  137: [
    ['https://matic2.mytokenpocket.vip', 'tokenpocket'],
    ['https://matic.mytokenpocket.vip', 'tokenpocket'],
    ['https://polygon.drpc.org', 'drpc'],
    ['https://polygon-bor-rpc.publicnode.com', 'publicnode'],
    ['https://polygon.gateway.tenderly.co', 'tenderly'],
    ['https://gateway.tenderly.co/public/polygon', 'tenderly'],
    ['https://api.zan.top/polygon-mainnet', 'zan'],
    ['https://public.1rpc.io/matic', '1rpc'],
  ],
  8453: [
    ['https://base.mytokenpocket.vip', 'tokenpocket'],
    ['https://base-rpc.publicnode.com', 'publicnode'],
    ['https://base.drpc.org', 'drpc'],
    ['https://mainnet.base.org', 'base'],
    ['https://developer-access-mainnet.base.org', 'base'],
    ['https://base.gateway.tenderly.co', 'tenderly'],
    ['https://gateway.tenderly.co/public/base', 'tenderly'],
    ['https://public.1rpc.io/base', '1rpc'],
    ['https://api.zan.top/base-mainnet', 'zan'],
  ],
};

export function trustedRpcCandidate(chainId: number, value: unknown): RpcEndpointCandidate | null {
  if (typeof value !== 'string' || value.length > 256 || /[\s${}<>\\]/.test(value)) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.port) return null;
    // Only exact public DNS hosts in the allowlist are accepted; IP literals,
    // loopback/private addresses and host suffix tricks cannot match it.
    const url = parsed.href.replace(/\/$/, '');
    const entry = TRUSTED_ENDPOINTS[chainId]?.find(([allowed]) => allowed === url);
    return entry ? { url: entry[0], operator: entry[1] } : null;
  } catch { return null; }
}

export function selectIndependentRpcUrls(chainId: number, values: readonly unknown[], limit = 5): string[] {
  const operators = new Set<string>();
  const urls: string[] = [];
  for (const value of values) {
    const candidate = trustedRpcCandidate(chainId, value);
    if (!candidate || operators.has(candidate.operator)) continue;
    operators.add(candidate.operator);
    urls.push(candidate.url);
    if (urls.length >= Math.min(5, Math.max(1, limit))) break;
  }
  return urls;
}

export function parseRpcEndpointSnapshot(value: unknown, now = Date.now()): RpcEndpointSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || typeof record.updatedAt !== 'number' || !Number.isSafeInteger(record.updatedAt) || record.updatedAt <= 0 ||
      record.updatedAt > now + 300_000 || now - record.updatedAt > RPC_CATALOG_CACHE_MAX_AGE_MS ||
      !record.chains || typeof record.chains !== 'object' || Array.isArray(record.chains)) return null;
  const chains: Record<string, string[]> = {};
  const chainUpdatedAt: Record<string, number> = {};
  if (record.chainUpdatedAt !== undefined && (!record.chainUpdatedAt || typeof record.chainUpdatedAt !== 'object' || Array.isArray(record.chainUpdatedAt))) return null;
  const timestamps = record.chainUpdatedAt as Record<string, unknown> | undefined;
  for (const [key, values] of Object.entries(record.chains)) {
    const chainId = Number(key);
    if (!Object.prototype.hasOwnProperty.call(TRUSTED_ENDPOINTS, key) || String(chainId) !== key || !Array.isArray(values) || values.length < 1 || values.length > 5) return null;
    const safe = selectIndependentRpcUrls(chainId, values);
    if (safe.length !== values.length) return null;
    const checkedAt = timestamps?.[key] ?? record.updatedAt;
    if (typeof checkedAt !== 'number' || !Number.isSafeInteger(checkedAt) || checkedAt <= 0 || checkedAt > record.updatedAt || checkedAt > now + 300_000) return null;
    if (now - checkedAt > RPC_CATALOG_CACHE_MAX_AGE_MS) continue;
    chains[key] = safe;
    chainUpdatedAt[key] = checkedAt;
  }
  return Object.keys(chains).length ? { version: 1, updatedAt: record.updatedAt, chains, chainUpdatedAt } : null;
}

let currentSnapshot: RpcEndpointSnapshot | null = null;

/**
 * A user-selected endpoint is an explicit route, not a trust authority. It is kept in
 * memory here so every provider and DApp transport in the process observes a
 * switch immediately; the host can persist the URL separately and restore it
 * on startup with setPreferredRpcEndpoint().
 */
const preferredRpcEndpoints = new Map<number, string>();
const endpointHealth = new Map<string, RpcEndpointHealth>();
const endpointProbes = new Map<string, Promise<RpcEndpointHealth>>();
const endpointHealthListeners = new Map<string, Set<() => void>>();
const UNKNOWN_HEALTH: RpcEndpointHealth = Object.freeze({ status: 'unknown' });

export function getPreferredRpcEndpoint(chainId: number): string | undefined {
  return preferredRpcEndpoints.get(chainId);
}

/** Set a preferred endpoint after checking it against the exact public allowlist. */
export function setPreferredRpcEndpoint(chainId: number, value: unknown): boolean {
  const candidate = trustedRpcCandidate(chainId, value);
  if (!candidate) return false;
  preferredRpcEndpoints.set(chainId, candidate.url);
  return true;
}

export function clearPreferredRpcEndpoint(chainId: number): void {
  preferredRpcEndpoints.delete(chainId);
}

function endpointHealthKey(chainId: number, url: string): string { return `${chainId}:${url}`; }

export function getRpcEndpointHealth(chainId: number, url: string): RpcEndpointHealth {
  return endpointHealth.get(endpointHealthKey(chainId, url)) ?? UNKNOWN_HEALTH;
}

/** Automatic routes remain usable if any member works. An untested member
 * keeps the pool pending rather than reporting an outage prematurely. */
export function getRpcEndpointsHealth(chainId: number, urls: readonly string[]): RpcEndpointHealth {
  const values = [...new Set(urls)].map((url) => getRpcEndpointHealth(chainId, url));
  const fastest = (status: RpcEndpointHealthStatus) => values.filter((health) => health.status === status)
    .reduce<RpcEndpointHealth | undefined>((best, health) => !best || (health.latencyMs ?? Infinity) < (best.latencyMs ?? Infinity) ? health : best, undefined);
  return fastest('ok') ?? fastest('slow') ?? values.find((health) => health.status === 'unknown') ?? values[0] ?? UNKNOWN_HEALTH;
}

/** Both the picker and home badge observe the same completed measurement. */
export function subscribeRpcEndpointHealth(chainId: number, url: string, listener: () => void): () => void {
  const key = endpointHealthKey(chainId, url);
  const listeners = endpointHealthListeners.get(key) ?? new Set<() => void>();
  listeners.add(listener);
  endpointHealthListeners.set(key, listeners);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) endpointHealthListeners.delete(key);
  };
}

function updateEndpointHealth(key: string, health: RpcEndpointHealth): RpcEndpointHealth {
  endpointHealth.set(key, health);
  for (const listener of endpointHealthListeners.get(key) ?? []) {
    try { listener(); } catch { /* A departed view cannot interrupt the probe. */ }
  }
  return health;
}

/** Probe one allowlisted node with only eth_chainId. The result is shared by
 * concurrent callers so opening the picker never creates duplicate probes. */
export function probeRpcEndpoint(chainId: number, value: unknown, timeoutMs = 5000): Promise<RpcEndpointHealth> {
  const candidate = trustedRpcCandidate(chainId, value);
  if (!candidate) return Promise.resolve({ status: 'offline', checkedAt: Date.now() });
  const key = endpointHealthKey(chainId, candidate.url);
  const running = endpointProbes.get(key);
  if (running) return running;
  const run = (async (): Promise<RpcEndpointHealth> => {
    const started = Date.now();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error('RPC probe timed out'));
          controller.abort();
        }, Number.isFinite(timeoutMs) ? Math.max(500, timeoutMs) : 5000);
      });
      const latencyMs = await Promise.race([(async () => {
        const response = await fetch(candidate.url, {
          method: 'POST',
          credentials: 'omit',
          redirect: 'error',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('RPC probe HTTP failure');
        const body = await response.json() as unknown;
        const reply = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null;
        if (!reply || reply.jsonrpc !== '2.0' || reply.id !== 1 || 'error' in reply
          || typeof reply.result !== 'string' || !/^0x[\da-f]+$/i.test(reply.result)
          || BigInt(reply.result) !== BigInt(chainId)) throw new Error('RPC probe invalid response');
        return Math.max(0, Date.now() - started);
      })(), deadline]);
      return updateEndpointHealth(key, { status: latencyMs >= 800 ? 'slow' : 'ok', latencyMs, checkedAt: Date.now() });
    } catch {
      // A quick HTTP/error/wrong-chain response is not usable RPC latency.
      return updateEndpointHealth(key, { status: 'offline', checkedAt: Date.now() });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      endpointProbes.delete(key);
    }
  })();
  endpointProbes.set(key, run);
  return run;
}

/** Check the actual route with at most two probes at a time. Once a usable
 * member answers, keep the UI responsive and stop scheduling further work. */
export function probeRpcEndpoints(chainId: number, urls: readonly string[]): Promise<RpcEndpointHealth> {
  const candidates = [...new Set(urls)];
  if (!candidates.length) return Promise.resolve(UNKNOWN_HEALTH);
  return new Promise((resolve) => {
    let next = 0;
    let active = 0;
    let settled = false;
    const finish = () => { settled = true; resolve(getRpcEndpointsHealth(chainId, candidates)); };
    const launch = () => {
      while (!settled && active < 2 && next < candidates.length) {
        const url = candidates[next++];
        active += 1;
        void probeRpcEndpoint(chainId, url).then((health) => {
          active -= 1;
          if (settled) return;
          if (health.status === 'ok' || health.status === 'slow') finish();
          else if (next === candidates.length && active === 0) finish();
          else launch();
        });
      }
    };
    launch();
  });
}

/**
 * Return the endpoints that can be shown in a manual picker. Dynamic healthy
 * entries are listed first, followed by bundled trusted rescue nodes. The
 * list order remains stable when a user changes the preference; only request
 * routing promotes that endpoint.
 */
export function getRpcEndpointChoices(chainId: number): string[] {
  const preferred = getPreferredRpcEndpoint(chainId);
  const dynamic = currentSnapshot && Date.now() - (currentSnapshot.chainUpdatedAt?.[String(chainId)] ?? currentSnapshot.updatedAt) <= RPC_CATALOG_CACHE_MAX_AGE_MS
    ? currentSnapshot.chains[String(chainId)] ?? [] : [];
  const bundled = TRUSTED_ENDPOINTS[chainId]?.map(([url]) => url) ?? [];
  const automatic = TRUSTED_ENDPOINTS[chainId]?.find(([, operator]) => operator === 'tokenpocket')?.[0];
  const values = [...(automatic ? [automatic] : []), ...dynamic, ...bundled];
  const choices = selectIndependentRpcUrls(chainId, values, 5);
  // Keep the selected endpoint visible in its stable catalog position. It is
  // deliberately not promoted to the first row; only request routing gives it
  // priority after the user explicitly selects it.
  if (preferred && !choices.includes(preferred)) {
    const selected = trustedRpcCandidate(chainId, preferred);
    const withoutOperator = selected ? choices.filter((url) => trustedRpcCandidate(chainId, url)?.operator !== selected.operator) : choices;
    return [...withoutOperator.slice(0, 4), preferred];
  }
  return choices;
}

/** Whether a network uses one of the app's built-in, verified endpoint pools. */
export function supportsRpcEndpointPreference(network: RpcNetworkIdentity): boolean {
  return DEFAULT_NETWORKS.some((entry) => entry.chainId === network.chainId && entry.rpcUrl === network.rpcUrl &&
    JSON.stringify(entry.rpcFallbackUrls ?? []) === JSON.stringify(network.rpcFallbackUrls ?? []));
}

export function applyRpcEndpointSnapshot(snapshot: RpcEndpointSnapshot): boolean {
  const parsed = parseRpcEndpointSnapshot(snapshot);
  if (!parsed || (currentSnapshot && parsed.updatedAt < currentSnapshot.updatedAt)) return false;
  currentSnapshot = parsed;
  return true;
}

/** Registry changes affect future requests without replacing a wallet/session. */
export function getRpcEndpointUrls(network: RpcNetworkIdentity): string[] {
  const builtin = DEFAULT_NETWORKS.find((entry) => entry.chainId === network.chainId && entry.rpcUrl === network.rpcUrl &&
    JSON.stringify(entry.rpcFallbackUrls ?? []) === JSON.stringify(network.rpcFallbackUrls ?? []));
  // User preferences belong only to the corresponding built-in network. A
  // custom network with the same chain ID must retain its explicitly supplied
  // endpoint policy and never inherit a public node selected elsewhere.
  if (!builtin) return [...new Set([network.rpcUrl, ...(network.rpcFallbackUrls ?? [])].map((url) => url.trim()))];
  const preferred = getPreferredRpcEndpoint(network.chainId);
  // Manual mode uses exactly the chosen node. An unavailable selection stays
  // unavailable until the user selects another node or returns to Automatic.
  if (preferred) return [preferred];
  const dynamic = currentSnapshot && Date.now() - (currentSnapshot.chainUpdatedAt?.[String(network.chainId)] ?? currentSnapshot.updatedAt) <= RPC_CATALOG_CACHE_MAX_AGE_MS
    ? currentSnapshot.chains[String(network.chainId)] ?? [] : [];
  // Once three operators pass health checks, failed bundled nodes stay out of
  // the active pool. An incomplete cold-start list can still use bundled rescue.
  const automatic = TRUSTED_ENDPOINTS[network.chainId]?.find(([, operator]) => operator === 'tokenpocket')?.[0];
  const selected = [...(automatic ? [automatic] : []), ...dynamic];
  if (dynamic.length >= 3) return selectIndependentRpcUrls(network.chainId, selected, 5);
  const ordered = [...selected, builtin.rpcUrl, ...(builtin.rpcFallbackUrls ?? [])];
  return selectIndependentRpcUrls(network.chainId, ordered, 5);
}
