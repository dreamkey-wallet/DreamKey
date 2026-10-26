import { JsonRpcProvider, Transaction, keccak256, type JsonRpcError, type JsonRpcPayload, type JsonRpcResult, type TransactionResponse } from 'ethers';
import type { RpcTransport } from '../provider/types.js';
import { getRpcEndpointUrls } from './rpc-endpoints.js';
import { RpcBroadcastUncertainError } from './rpc-broadcast.js';

export interface VerifiedRpcNetwork {
  rpcUrl: string;
  rpcFallbackUrls?: string[];
  chainId: number;
  name: string;
}

/** Injectable for offline verification; the app uses React Native's native fetch. */
export type RpcFetch = (url: string, init: {
  method: 'POST'; headers: Record<string, string>; body: string; signal?: AbortSignal;
}) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface RpcPolicy {
  timeoutMs?: number;
  hedgeDelayMs?: number;
  cooldownMs?: number;
  maxCooldownMs?: number;
  now?: () => number;
  fetch?: RpcFetch;
}

type RpcReply = (JsonRpcResult | JsonRpcError) & { jsonrpc?: string };

// Filters, signing, broadcasts and unfamiliar extension methods may have
// server-side effects, so only these known reads can race another endpoint.
const READ_METHODS = new Set([
  'eth_chainId', 'net_version', 'web3_clientVersion', 'eth_blockNumber',
  'eth_getBalance', 'eth_getCode', 'eth_getStorageAt', 'eth_getTransactionCount',
  'eth_call', 'eth_estimateGas', 'eth_gasPrice', 'eth_maxPriorityFeePerGas',
  'eth_feeHistory', 'eth_getBlockByNumber', 'eth_getBlockByHash',
  'eth_getBlockTransactionCountByNumber', 'eth_getBlockTransactionCountByHash',
  'eth_getTransactionByHash', 'eth_getTransactionByBlockNumberAndIndex',
  'eth_getTransactionByBlockHashAndIndex', 'eth_getTransactionReceipt',
  'eth_getLogs', 'eth_getProof', 'eth_syncing',
]);

// Never classify contract errors or errors carrying execution data as an
// unavailable node, even if their messages happen to mention an RPC failure.
// Public providers use several non-standard codes for rate limits and
// overloads, so the message is considered only for those well-known transient
// patterns. Generic -32000/-32603 errors remain endpoint-local unless their
// message clearly describes a transport/service outage.
function isUnavailableReply(reply: RpcReply): boolean {
  if (!('error' in reply) || Object.prototype.hasOwnProperty.call(reply.error, 'data')) return false;
  const { code, message } = reply.error;
  if (!Number.isInteger(code) || typeof message !== 'string') return false;
  // These errors represent execution/application failures, even when a node
  // omitted the optional `data` field. Retrying them on another endpoint can
  // duplicate expensive calls and obscures the actionable error.
  if (/\b(?:execution\s+revert(?:ed)?|revert(?:ed)?|insufficient\s+funds|nonce\s+(?:is\s+)?too\s+low|replacement\s+transaction\s+underpriced|intrinsic\s+gas)\b/i.test(message)) return false;
  if (code === -32046 && /^cannot fulfill request(?:\s*:\s*)?$/i.test(message.trim())) return true;
  if (code === -32603 && /^internal error$/i.test(message.trim())) return true;
  if (![ -32000, -32005, -32046, -32603 ].includes(code)) return false;
  return /\b(?:rate\s*limit(?:ed)?|request\s+limit(?:\s+exceeded)?|too\s+many\s+requests|limit\s+exceeded|temporarily\s+unavailable|service\s+unavailable|server\s+unavailable|upstream\s+(?:error|timeout)|gateway\s+timeout|tim(?:e|ed)\s*out|overload(?:ed)?|server\s+busy|capacity\s+exceeded|try\s+again\s+later|backend\s+unavailable|header\s+not\s+found|missing\s+trie\s+node|state\s+unavailable|node\s+is\s+sync(?:ing|hronized)|pruned)\b/i.test(message);
}

/** A restricted query can fail while the same node still serves balances. */
function isQueryUnavailableReply(payload: JsonRpcPayload, reply: RpcReply): boolean {
  if (!READ_METHODS.has(payload.method) || !('error' in reply) || Object.prototype.hasOwnProperty.call(reply.error, 'data')) return false;
  const { code, message } = reply.error;
  if (!Number.isInteger(code) || typeof message !== 'string') return false;
  if (/\b(?:execution\s+revert(?:ed)?|revert(?:ed)?|insufficient\s+funds|nonce\s+(?:is\s+)?too\s+low|replacement\s+transaction\s+underpriced|intrinsic\s+gas)\b/i.test(message)) return false;
  if (code === -32601) return true;
  // Explicit request-rate limits still indicate a node-wide outage. A log
  // range/result limit or unavailable historical state only affects this read.
  if (/\b(?:rate\s*limit(?:ed)?|request\s+limit|too\s+many\s+requests)\b/i.test(message)) return false;
  if (/\b(?:header\s+not\s+found|missing\s+trie\s+node|state\s+unavailable|pruned)\b/i.test(message)) return true;
  return payload.method === 'eth_getLogs' && (
    (code === -32005 && /^limit exceeded[.!]?$/i.test(message.trim())) ||
    /\b(?:block\s+range|range\s+(?:is\s+)?too\s+(?:large|wide)|too\s+many\s+(?:results|logs)|query\s+returned\s+more\s+than|(?:log|response|result)\s+(?:size|limit)|(?:max(?:imum)?|exceed\w*)[^.]*\b(?:blocks|results|logs))\b/i.test(message)
  );
}

function isRetryableReadReply(payload: JsonRpcPayload, reply: RpcReply): boolean {
  return isQueryUnavailableReply(payload, reply) || isUnavailableReply(reply);
}

function isAmbiguousBroadcastReply(reply: RpcReply): boolean {
  return isUnavailableReply(reply) || ('error' in reply &&
    /^(?:already known|known transaction|already imported|transaction already imported)$/i.test(reply.error.message?.trim() ?? ''));
}

class RpcTransportError extends Error {
  healthRecorded = false;
  constructor(message: string, readonly code = -32603, readonly canceled = false) {
    super(message); this.name = 'RpcTransportError';
  }
}

interface Endpoint {
  url: string;
  validatedAt?: number;
  validation?: Validation;
  wrongChain: boolean;
  failures: number;
  cooldownUntil: number;
  lastSuccessAt?: number;
  lastSuccessId?: number;
  lastRecoveryAt?: number;
  latencyMs?: number;
}

interface Validation {
  promise: Promise<void>;
  controller: AbortController;
  waiters: number;
  settled: boolean;
}

/** A pool is owned by one configured chain and shared by wallet and Dapp reads. */
class VerifiedRpcPool {
  private readonly endpoints = new Map<string, Endpoint>();
  private readonly timeoutMs: number;
  private readonly hedgeDelayMs: number;
  private readonly cooldownMs: number;
  private readonly maxCooldownMs: number;
  private readonly now: () => number;
  private readonly fetch: RpcFetch;
  private internalId = 0;
  private attemptId = 0;
  private readonly reads = new Map<string, Promise<RpcReply>>();
  private recovery: Promise<void> | null = null;
  private nextRecoveryAt = 0;
  private preferredUrl: string | undefined;
  private routeKey: string | undefined;

  constructor(private readonly network: VerifiedRpcNetwork, policy: RpcPolicy = {}) {
    if (!Number.isSafeInteger(network.chainId) || network.chainId < 0) throw new Error('Invalid RPC chain id');
    this.timeoutMs = policy.timeoutMs ?? 8000;
    this.hedgeDelayMs = policy.hedgeDelayMs ?? 800;
    this.cooldownMs = policy.cooldownMs ?? 30000;
    this.maxCooldownMs = policy.maxCooldownMs ?? 300000;
    this.now = policy.now ?? Date.now;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0 || !Number.isFinite(this.hedgeDelayMs) || this.hedgeDelayMs < 0 ||
        !Number.isFinite(this.cooldownMs) || this.cooldownMs <= 0 || !Number.isFinite(this.maxCooldownMs) || this.maxCooldownMs < this.cooldownMs) {
      throw new Error('Invalid RPC timing policy');
    }
    this.fetch = policy.fetch ?? globalThis.fetch as RpcFetch;
    if (!this.fetch) throw new Error('A fetch implementation is required');
    this.snapshot();
  }

  private nextInternalId(): number {
    // Some BNB gateways reject negative JSON-RPC IDs. Each HTTP response is
    // matched to its own payload, so internal and caller ID ranges may overlap.
    this.internalId = this.internalId >= 0x7fffffff ? 1 : this.internalId + 1;
    return this.internalId;
  }

  private snapshot(): Endpoint[] {
    const urls = [...new Set(getRpcEndpointUrls(this.network).map((url) => url.trim()))].slice(0, 5);
    if (!urls.length || urls.some((url) => !/^https?:\/\//i.test(url))) throw new RpcTransportError('RPC endpoints must use HTTP or HTTPS');
    const routeKey = JSON.stringify(urls);
    if (this.routeKey !== routeKey) {
      // A previous mode's recovery must not delay or satisfy a newly selected
      // node's recovery. Its existing callers may still await their own work.
      this.recovery = null;
      this.nextRecoveryAt = 0;
      this.routeKey = routeKey;
    }
    const switched = this.preferredUrl !== undefined && this.preferredUrl !== urls[0];
    this.preferredUrl = urls[0];
    const current = urls.map((url) => {
      let endpoint = this.endpoints.get(url);
      if (!endpoint) {
        endpoint = { url, wrongChain: false, failures: 0, cooldownUntil: 0 };
        this.endpoints.set(url, endpoint);
      }
      // A manual switch should take effect immediately even when this endpoint
      // was temporarily cooled down by an earlier automatic failure. Keep a
      // chain-mismatch quarantine intact so a bad response cannot be forced
      // back into the pool by repeated UI taps.
      if (switched && url === urls[0] && !endpoint.wrongChain) {
        endpoint.failures = 0;
        endpoint.cooldownUntil = 0;
      }
      return endpoint;
    });
    // Catalog refreshes should preserve live nodes' health without retaining
    // every URL ever supplied by an older catalog for the whole app session.
    if (this.endpoints.size > 25) {
      for (const [url, endpoint] of this.endpoints) {
        if (!urls.includes(url) && !endpoint.validation) this.endpoints.delete(url);
        if (this.endpoints.size <= 25) break;
      }
    }
    return current;
  }

  private order(endpoints: Endpoint[], includeCooling = false): Endpoint[] {
    const now = this.now();
    return endpoints.filter((endpoint) => !endpoint.wrongChain && (includeCooling || endpoint.cooldownUntil <= now)).sort((a, b) => {
      // Successful nodes stay ahead of untried ones, then prefer measured
      // latency within the same recent-success window (one minute).
      const aRecent = a.lastSuccessAt !== undefined && now - a.lastSuccessAt < 60000;
      const bRecent = b.lastSuccessAt !== undefined && now - b.lastSuccessAt < 60000;
      if (aRecent !== bRecent) return aRecent ? -1 : 1;
      if (aRecent && bRecent) return (a.latencyMs ?? Infinity) - (b.latencyMs ?? Infinity);
      if ((a.lastSuccessAt !== undefined) !== (b.lastSuccessAt !== undefined)) return a.lastSuccessAt !== undefined ? -1 : 1;
      return (b.lastSuccessAt ?? 0) - (a.lastSuccessAt ?? 0);
    });
  }

  private unavailable(endpoints: Endpoint[]): RpcTransportError {
    return endpoints.every((endpoint) => endpoint.wrongChain)
      ? new RpcTransportError('RPC chain does not match the selected network', 4901)
      : new RpcTransportError('RPC endpoints are temporarily unavailable; please try again shortly', -32002);
  }

  private success(endpoint: Endpoint, started: number, attemptId: number): void {
    const latency = Math.max(0, this.now() - started);
    endpoint.lastSuccessAt = this.now();
    endpoint.lastSuccessId = Math.max(endpoint.lastSuccessId ?? 0, attemptId);
    endpoint.latencyMs = endpoint.latencyMs === undefined ? latency : endpoint.latencyMs * 0.7 + latency * 0.3;
    endpoint.failures = 0;
    endpoint.cooldownUntil = 0;
  }

  private failure(endpoint: Endpoint, error?: unknown, attemptId = 0): void {
    if (error instanceof RpcTransportError) {
      if (error.canceled || error.healthRecorded) return;
      error.healthRecorded = true;
    }
    // Parallel reads share one outage window. They must not turn a single
    // 30-second failure into a five-minute lockout, or overwrite a newer success.
    if (attemptId < (endpoint.lastSuccessId ?? 0) || endpoint.cooldownUntil > this.now()) return;
    endpoint.failures = Math.min(endpoint.failures + 1, 32);
    endpoint.cooldownUntil = this.now() + Math.min(this.maxCooldownMs, this.cooldownMs * 2 ** (endpoint.failures - 1));
  }

  private assertChain(reply: RpcReply): void {
    if (!('result' in reply) || typeof reply.result !== 'string' || !/^0x[\da-f]+$/i.test(reply.result) || BigInt(reply.result) !== BigInt(this.network.chainId)) {
      throw new RpcTransportError('RPC chain does not match the selected network', 4901);
    }
  }

  private async post(endpoint: Endpoint, payload: JsonRpcPayload, timeoutMs: number, signal?: AbortSignal): Promise<RpcReply> {
    if (signal?.aborted) throw new RpcTransportError('RPC request canceled', -32603, true);
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let cancel: (() => void) | undefined;
    const interrupted = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => { reject(new RpcTransportError('RPC request timed out', -32002)); controller.abort(); }, Math.max(1, timeoutMs));
      cancel = () => { reject(new RpcTransportError('RPC request canceled', -32603, true)); controller.abort(); };
      signal?.addEventListener('abort', cancel, { once: true });
    });
    const request = (async (): Promise<RpcReply> => {
      let response: Awaited<ReturnType<RpcFetch>>;
      try {
        response = await this.fetch(endpoint.url, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload), signal: controller.signal,
        });
      } catch { throw new RpcTransportError('RPC connection failed'); }
      if (!response.ok) throw new RpcTransportError(`RPC request failed (${response.status})`);
      let body: unknown;
      try { body = await response.json(); } catch { throw new RpcTransportError('RPC returned invalid JSON'); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RpcTransportError('RPC returned an invalid response');
      const reply = body as Record<string, unknown>;
      const hasResult = Object.prototype.hasOwnProperty.call(reply, 'result');
      const hasError = Object.prototype.hasOwnProperty.call(reply, 'error');
      const error = reply.error as Record<string, unknown> | undefined;
      if (reply.id !== payload.id || reply.jsonrpc !== '2.0' || (hasResult === hasError) ||
          (hasError && (!error || typeof error !== 'object' || Array.isArray(error) || !Number.isInteger(error.code) || typeof error.message !== 'string'))) {
        throw new RpcTransportError('RPC returned an invalid response');
      }
      return body as RpcReply;
    })();
    try { return await Promise.race([request, interrupted]); }
    finally {
      if (timeout !== undefined) clearTimeout(timeout);
      if (cancel) signal?.removeEventListener('abort', cancel);
    }
  }

  private async waitValidation(validation: Validation, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new RpcTransportError('RPC request canceled', -32603, true);
    validation.waiters += 1;
    let cancel: (() => void) | undefined;
    const interrupted = new Promise<never>((_resolve, reject) => {
      cancel = () => reject(new RpcTransportError('RPC request canceled', -32603, true));
      signal?.addEventListener('abort', cancel, { once: true });
    });
    try { await Promise.race([validation.promise, interrupted]); }
    finally {
      if (cancel) signal?.removeEventListener('abort', cancel);
      validation.waiters -= 1;
      if (!validation.waiters && !validation.settled) validation.controller.abort();
    }
  }

  private async validate(endpoint: Endpoint, fresh: boolean, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new RpcTransportError('RPC request canceled', -32603, true);
    if (endpoint.wrongChain) throw new RpcTransportError('RPC chain does not match the selected network', 4901);
    if (!fresh && endpoint.validatedAt !== undefined && this.now() - endpoint.validatedAt < 30000) return;
    // Even fresh pre-broadcast validation shares an already in-flight chain
    // query; canceling one hedged read must not cancel another caller's check.
    if (endpoint.validation?.controller.signal.aborted) endpoint.validation = undefined;
    if (endpoint.validation) return this.waitValidation(endpoint.validation, signal);
    const controller = new AbortController();
    const attemptId = ++this.attemptId;
    const validation: Validation = { controller, waiters: 0, settled: false, promise: Promise.resolve() };
    validation.promise = (async () => {
      try {
        const reply = await this.post(endpoint, { jsonrpc: '2.0', id: this.nextInternalId(), method: 'eth_chainId', params: [] }, this.timeoutMs, controller.signal);
        if ('error' in reply) throw new RpcTransportError('RPC chain validation failed');
        try { this.assertChain(reply); }
        catch (error) { endpoint.wrongChain = true; throw error; }
        endpoint.validatedAt = this.now();
      } catch (error) { this.failure(endpoint, error, attemptId); throw error; }
    })();
    endpoint.validation = validation;
    void validation.promise.finally(() => {
      validation.settled = true;
      if (endpoint.validation === validation) endpoint.validation = undefined;
    }).catch(() => {});
    return this.waitValidation(validation, signal);
  }

  private async attempt(endpoint: Endpoint, payload: JsonRpcPayload, signal?: AbortSignal): Promise<RpcReply> {
    const started = this.now();
    const attemptId = ++this.attemptId;
    try {
      if (endpoint.wrongChain) throw new RpcTransportError('RPC chain does not match the selected network', 4901);
      if (payload.method !== 'eth_chainId') await this.validate(endpoint, false, signal);
      if (signal?.aborted) throw new RpcTransportError('RPC request canceled', -32603, true);
      const remaining = this.timeoutMs - (this.now() - started);
      if (remaining <= 0) throw new RpcTransportError('RPC request timed out', -32002);
      const reply = await this.post(endpoint, payload, remaining, signal);
      if (payload.method === 'eth_chainId' && 'result' in reply) {
        try { this.assertChain(reply); }
        catch (error) { endpoint.wrongChain = true; throw error; }
        endpoint.validatedAt = this.now();
      }
      if (!isQueryUnavailableReply(payload, reply)) {
        if (isUnavailableReply(reply)) this.failure(endpoint, undefined, attemptId);
        else this.success(endpoint, started, attemptId);
      }
      return reply;
    } catch (error) { this.failure(endpoint, error, attemptId); throw error; }
  }

  private async recover(endpoints: Endpoint[]): Promise<void> {
    if (this.recovery) return this.recovery;
    if (this.now() < this.nextRecoveryAt) throw this.unavailable(endpoints);
    const endpoint = this.order(endpoints, true).sort((a, b) =>
      (a.lastRecoveryAt ?? -Infinity) - (b.lastRecoveryAt ?? -Infinity) || a.cooldownUntil - b.cooldownUntil)[0];
    if (!endpoint) throw this.unavailable(endpoints);
    endpoint.lastRecoveryAt = this.now();
    this.nextRecoveryAt = this.now() + Math.min(5000, this.cooldownMs);
    // Probe a lightweight read rather than the failing historical query. All
    // parallel readers wait for this one probe before retrying their own reads.
    const recovery = (async () => {
      await this.validate(endpoint, true);
      const reply = await this.attempt(endpoint, { jsonrpc: '2.0', id: this.nextInternalId(), method: 'eth_blockNumber', params: [] });
      if (!('result' in reply) || typeof reply.result !== 'string' || !/^0x[\da-f]+$/i.test(reply.result)) throw this.unavailable(endpoints);
    })();
    this.recovery = recovery;
    try { await recovery; }
    finally { if (this.recovery === recovery) this.recovery = null; }
  }

  private sharedRead(payload: JsonRpcPayload, endpoints: Endpoint[]): Promise<RpcReply> {
    // A request made after switching nodes must never inherit a pending read
    // from the previous manual node or automatic pool.
    const key = JSON.stringify([endpoints.map((endpoint) => endpoint.url), payload.method, payload.params ?? []]);
    let pending = this.reads.get(key);
    if (!pending) {
      pending = this.read(payload, endpoints);
      this.reads.set(key, pending);
      const current = pending;
      void current.finally(() => { if (this.reads.get(key) === current) this.reads.delete(key); }).catch(() => {});
    }
    return pending.then((reply) => ({ ...reply, id: payload.id }));
  }

  private async read(payload: JsonRpcPayload, endpoints: Endpoint[]): Promise<RpcReply> {
    // A public RPC may legitimately return null when a transaction has not
    // reached that node yet. For transaction lookups, null is therefore a
    // soft miss; query remaining healthy endpoints before accepting it.
    const softMissing = payload.method === 'eth_getTransactionByHash' || payload.method === 'eth_getTransactionReceipt';
    let order = this.order(endpoints);
    if (!order.length) {
      await this.recover(endpoints);
      order = this.order(endpoints);
      if (!order.length) throw this.unavailable(endpoints);
    }
    return new Promise<RpcReply>((resolve, reject) => {
      let next = 0;
      let active = 0;
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const controllers: AbortController[] = [];
      const errors: unknown[] = [];
      const unavailableReplies: RpcReply[] = [];
      const missingReplies: RpcReply[] = [];
      const finish = () => {
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        for (const controller of controllers) controller.abort();
      };
      const schedule = () => {
        if (!settled && next < order.length && active < 2 && timer === undefined) {
          timer = setTimeout(() => { timer = undefined; launch(); }, this.hedgeDelayMs);
        }
      };
      const failed = () => {
        active -= 1;
        if (settled) return;
        if (next < order.length) launch();
        else if (active === 0) {
          finish();
          if (unavailableReplies.length) resolve(unavailableReplies[0]);
          else if (missingReplies.length) resolve(missingReplies[0]);
          else reject(errors[errors.length - 1] ?? this.unavailable(endpoints));
        }
      };
      const launch = () => {
        if (settled || active >= 2) return;
        if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
        // Other concurrent requests may have cooled a candidate since this
        // request captured its order. Do not keep hitting that failed node.
        while (next < order.length && (order[next].wrongChain || order[next].cooldownUntil > this.now())) next += 1;
        if (next >= order.length) {
          if (active === 0) {
            finish();
            if (unavailableReplies.length) resolve(unavailableReplies[0]);
            else if (missingReplies.length) resolve(missingReplies[0]);
            else reject(errors[errors.length - 1] ?? this.unavailable(endpoints));
          }
          return;
        }
        const endpoint = order[next++];
        const controller = new AbortController();
        controllers.push(controller);
        active += 1;
        void this.attempt(endpoint, payload, controller.signal).then((reply) => {
          if (settled) return;
          if (isRetryableReadReply(payload, reply)) { unavailableReplies.push(reply); failed(); return; }
          if (softMissing && 'result' in reply && reply.result === null) { missingReplies.push(reply); failed(); return; }
          finish();
          resolve(reply);
        }, (error: unknown) => { errors.push(error); failed(); });
        schedule();
      };
      launch();
    });
  }

  private async reconcile(hash: string, endpoints: Endpoint[]): Promise<boolean> {
    // Recovery only reads transaction status, so it can probe the broadcast
    // node even if the ambiguous write just put that endpoint into cooldown.
    const order = this.order(endpoints, true);
    return new Promise<boolean>((resolve) => {
      let next = 0;
      let active = 0;
      let done = false;
      const controllers: AbortController[] = [];
      const finish = (found: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(deadline);
        for (const pending of controllers) pending.abort();
        resolve(found);
      };
      // A slow or partitioned public RPC pool must not keep the send screen
      // waiting while every node exhausts two full per-request timeouts.
      const deadline = setTimeout(() => finish(false), Math.min(12000, this.timeoutMs * 3));
      const probe = async (endpoint: Endpoint, signal: AbortSignal): Promise<boolean> => {
        for (const method of ['eth_getTransactionByHash', 'eth_getTransactionReceipt']) {
          if (signal.aborted) return false;
          try {
            const reply = await this.attempt(endpoint, { jsonrpc: '2.0', id: this.nextInternalId(), method, params: [hash] }, signal);
            if ('result' in reply && reply.result && typeof reply.result === 'object' && !Array.isArray(reply.result)) {
              const result = reply.result as Record<string, unknown>;
              const foundHash = method === 'eth_getTransactionByHash' ? result.hash : result.transactionHash;
              if (typeof foundHash === 'string' && foundHash.toLowerCase() === hash) return true;
            }
          } catch { /* An unavailable node cannot establish a transaction's absence. */ }
        }
        return false;
      };
      const launch = () => {
        while (!done && active < 2 && next < order.length) {
          const endpoint = order[next++];
          const controller = new AbortController();
          controllers.push(controller);
          active += 1;
          void probe(endpoint, controller.signal).then((found) => {
            active -= 1;
            if (done) return;
            if (found) {
              finish(true);
            } else if (next === order.length && active === 0) finish(false);
            else launch();
          });
        }
        if (!order.length) finish(false);
      };
      launch();
    });
  }

  private async broadcast(payload: JsonRpcPayload, endpoints: Endpoint[]): Promise<RpcReply> {
    const raw = Array.isArray(payload.params) ? payload.params[0] : undefined;
    if (typeof raw !== 'string' || !/^0x(?:[\da-f]{2})+$/i.test(raw)) throw new RpcTransportError('Invalid signed transaction');
    const hash = keccak256(raw).toLowerCase();
    const order = this.order(endpoints);
    if (!order.length) throw this.unavailable(endpoints);
    let lastValidationError: unknown;
    let selected: Endpoint | undefined;
    const validationScope = new AbortController();
    const validationDeadline = setTimeout(() => validationScope.abort(), Math.min(12000, this.timeoutMs * 2));
    try {
      for (const endpoint of order) {
        if (validationScope.signal.aborted) break;
        try { await this.validate(endpoint, true, validationScope.signal); selected = endpoint; break; }
        catch (error) { lastValidationError = error; }
      }
    } finally {
      clearTimeout(validationDeadline);
    }
    // No raw transaction has left the device when chain verification fails.
    if (!selected) throw lastValidationError ?? this.unavailable(endpoints);
    const started = this.now();
    const attemptId = ++this.attemptId;
    try {
      const reply = await this.post(selected, payload, this.timeoutMs);
      if ('error' in reply) {
        // A gateway outage or an "already known" reply cannot tell us that
        // this signed transaction is absent. Confirm its locally derived hash.
        if (isAmbiguousBroadcastReply(reply)) throw new RpcTransportError('RPC could not confirm transaction acceptance');
        this.success(selected, started, attemptId);
        return reply;
      }
      if (typeof reply.result !== 'string' || reply.result.toLowerCase() !== hash) throw new RpcTransportError('RPC returned a mismatched transaction hash');
      this.success(selected, started, attemptId);
      return { ...reply, result: hash };
    } catch (error) {
      this.failure(selected, error, attemptId);
      if (await this.reconcile(hash, endpoints)) return { jsonrpc: '2.0', id: payload.id, result: hash };
      throw new RpcBroadcastUncertainError(hash);
    }
  }

  async request(payload: JsonRpcPayload): Promise<RpcReply> {
    if (!payload || payload.jsonrpc !== '2.0' || !Number.isSafeInteger(payload.id) || typeof payload.method !== 'string' || !payload.method) throw new RpcTransportError('Invalid JSON-RPC payload');
    const endpoints = this.snapshot();
    if (payload.method === 'eth_sendRawTransaction') return this.broadcast(payload, endpoints);
    if (READ_METHODS.has(payload.method)) return this.sharedRead(payload, endpoints);
    const endpoint = this.order(endpoints)[0];
    if (!endpoint) throw this.unavailable(endpoints);
    // Unfamiliar/stateful methods are sent once, after a fresh chain check.
    await this.validate(endpoint, true);
    return this.attempt(endpoint, payload);
  }

  readonly transport: RpcTransport = async (url, init) => {
    // The Dapp never supplies another endpoint or selects the backup chain.
    if (url !== this.network.rpcUrl) throw new RpcTransportError('RPC endpoint is not configured by the wallet');
    let payload: JsonRpcPayload | JsonRpcPayload[];
    try { payload = JSON.parse(init.body); } catch { throw new RpcTransportError('Invalid JSON-RPC payload'); }
    const body = Array.isArray(payload) ? await Promise.all(payload.map((request) => this.request(request))) : await this.request(payload);
    return { ok: true, status: 200, json: async () => body };
  };
}

export function createVerifiedRpcTransport(network: VerifiedRpcNetwork, policy: RpcPolicy = {}): RpcTransport {
  return new VerifiedRpcPool(network, policy).transport;
}

/** Ethers signing and EIP-1193 reads share one validated, healthy RPC pool. */
export class VerifiedRpcProvider extends JsonRpcProvider {
  private readonly transport: RpcTransport;
  private readonly configuredUrl: string;

  constructor(network: VerifiedRpcNetwork, policy: RpcPolicy = {}) {
    // Route-aware in-flight deduplication lives in VerifiedRpcPool. Ethers'
    // URL-unaware short cache could otherwise reuse a previous node's result
    // immediately after the user changes the route.
    super(network.rpcUrl, { chainId: network.chainId, name: network.name }, { staticNetwork: true, batchMaxCount: 1, polling: true, cacheTimeout: -1 });
    this.configuredUrl = network.rpcUrl;
    this.transport = createVerifiedRpcTransport(network, policy);
  }

  getRpcTransport(): RpcTransport { return this.transport; }

  override async broadcastTransaction(signedTx: string): Promise<TransactionResponse> {
    const transaction = Transaction.from(signedTx);
    if (!transaction.isSigned() || !transaction.hash) throw new RpcTransportError('Invalid signed transaction');
    // Ethers normally starts these reads in parallel with the broadcast. If a
    // read fails first it can hide an already-submitted transaction's outcome.
    // Resolve and format all ancillary data before any signed bytes are sent.
    const [blockNumber, network] = await Promise.all([this.getBlockNumber(), this.getNetwork()]);
    if (transaction.chainId !== 0n && transaction.chainId !== network.chainId) throw new RpcTransportError('Signed transaction chain does not match the selected network', 4901);
    // Ethers itself passes this Transaction instance to its response formatter;
    // its declaration requires mined fields even though pending txs lack them.
    const pending = this._wrapTransactionResponse(transaction as unknown as Parameters<VerifiedRpcProvider['_wrapTransactionResponse']>[0], network)
      .replaceableTransaction(blockNumber);
    const hash: unknown = await this.send('eth_sendRawTransaction', [signedTx]);
    if (hash !== transaction.hash) throw new RpcBroadcastUncertainError(transaction.hash);
    return pending;
  }

  override async _send(payload: JsonRpcPayload | JsonRpcPayload[]): Promise<JsonRpcResult[]> {
    const response = await this.transport(this.configuredUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    const body = await response.json() as RpcReply | RpcReply[];
    // Ethers also consumes error envelopes here and preserves contract errors.
    return (Array.isArray(body) ? body : [body]) as JsonRpcResult[];
  }
}
