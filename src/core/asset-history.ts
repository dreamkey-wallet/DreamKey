import { getAddress, isAddress } from 'ethers';
import type { NetworkConfig } from './types.js';

export interface AssetTransaction {
  id: string;
  hash: string;
  chainId: number;
  accountAddress: string;
  tokenAddress?: string;
  symbol: string;
  decimals: number;
  /** Integer base units. Display code must use decimals rather than Number. */
  rawValue: string;
  from: string;
  to: string;
  direction: 'in' | 'out' | 'self';
  state: 'pending' | 'confirmed' | 'failed';
  /** Unix seconds, matching explorer block timestamps. */
  timestamp?: number;
  blockNumber?: number;
  source: 'local' | 'explorer' | 'rpc';
  type?: 'transfer' | 'interaction';
}

export type RpcRequest = (method: string, params: unknown[]) => Promise<unknown>;
export type HistoryFetch = (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;
export type HistoryWarning = 'history-unavailable' | 'recent-history-only' | 'unsupported-network' | 'history-limited' | 'partial-history';
type Cursor = number | Record<string, string | number | boolean>;

/** Opaque pagination token: pass it back unchanged for the same asset/account. */
export interface AssetHistoryPage {
  scope: string;
  provider: 'BscTrace' | 'Blockscout';
  streams: Partial<Record<'external' | 'internal' | 'token', Cursor>>;
}

export interface AssetHistoryQuery {
  network: NetworkConfig;
  accountAddress: string;
  tokenAddress?: string;
  tokenDecimals?: number;
  symbol?: string;
  page?: AssetHistoryPage;
  localRecords?: AssetTransaction[];
  rpc?: RpcRequest;
  fetch?: HistoryFetch;
}

export interface AssetHistoryResult {
  records: AssetTransaction[];
  source: 'BscTrace' | 'Blockscout' | 'RPC' | 'local';
  coverage: 'indexed' | 'recent' | 'local';
  hasMore: boolean;
  nextPage?: AssetHistoryPage;
  warning?: HistoryWarning;
  fromBlock?: number;
  toBlock?: number;
}

const HASH = /^0x[\da-f]{64}$/i;
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const HISTORY_TIMEOUT_MS = 8000;
const BSC_API = 'https://bsc-explorer-api.nodereal.io/api';
// Indexers are selected only by the verified EVM chain id, never by an
// explorer URL supplied by a DApp or a token with a matching ticker.
const BLOCKSCOUT_API: Readonly<Record<number, string>> = Object.freeze({
  1: 'https://eth.blockscout.com/api/v2',
  137: 'https://polygon.blockscout.com/api/v2',
  8453: 'https://base.blockscout.com/api/v2',
  42161: 'https://arbitrum.blockscout.com/api/v2',
});

function rawInteger(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^(?:0x[\da-f]+|\d+)$/i.test(value)) return undefined;
  try { return BigInt(value).toString(); } catch { return undefined; }
}

function positiveInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  if (typeof value === 'string' && !/^(?:0x[\da-f]+|\d+)$/i.test(value)) return undefined;
  const result = Number(value);
  return Number.isSafeInteger(result) && result >= 0 ? result : undefined;
}

function address(value: unknown): string | undefined {
  return typeof value === 'string' && isAddress(value) ? getAddress(value) : undefined;
}

function addressObject(value: any): string | undefined {
  return address(typeof value === 'string' ? value : value?.hash);
}

function direction(from: string, to: string, account: string): AssetTransaction['direction'] | undefined {
  const outgoing = from.toLowerCase() === account.toLowerCase();
  const incoming = to.toLowerCase() === account.toLowerCase();
  return outgoing && incoming ? 'self' : outgoing ? 'out' : incoming ? 'in' : undefined;
}

/** Validate persisted public history; never accept unrelated addresses or secrets. */
export function validateAssetTransaction(value: unknown): AssetTransaction | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Partial<AssetTransaction>;
  const accountAddress = address(item.accountAddress);
  const from = address(item.from);
  const to = address(item.to);
  const tokenAddress = item.tokenAddress === undefined ? undefined : address(item.tokenAddress);
  const rawValue = rawInteger(item.rawValue);
  if (!accountAddress || !from || !to || !direction(from, to, accountAddress)
    || (item.tokenAddress !== undefined && !tokenAddress)
    || typeof item.id !== 'string' || !item.id || item.id.length > 300
    || typeof item.hash !== 'string' || !HASH.test(item.hash)
    || !Number.isSafeInteger(item.chainId) || item.chainId! <= 0
    || !Number.isInteger(item.decimals) || item.decimals! < 0 || item.decimals! > 80
    || rawValue === undefined || typeof item.symbol !== 'string'
    || !['pending', 'confirmed', 'failed'].includes(item.state ?? '')
    || !['local', 'explorer', 'rpc'].includes(item.source ?? '')) return null;
  return {
    id: item.id, hash: item.hash.toLowerCase(), chainId: item.chainId!, accountAddress,
    tokenAddress, symbol: item.symbol.slice(0, 24), decimals: item.decimals!, rawValue,
    from, to, direction: direction(from, to, accountAddress)!, state: item.state!,
    timestamp: positiveInteger(item.timestamp), blockNumber: positiveInteger(item.blockNumber),
    source: item.source!, type: item.type === 'interaction' ? 'interaction' : 'transfer',
  };
}

function recordKey(item: AssetTransaction): string {
  return `${item.chainId}:${item.accountAddress.toLowerCase()}:${item.tokenAddress?.toLowerCase() ?? 'native'}:${item.id}`;
}

function sameSubmission(a: AssetTransaction, b: AssetTransaction): boolean {
  return a.chainId === b.chainId && a.hash.toLowerCase() === b.hash.toLowerCase()
    && a.accountAddress.toLowerCase() === b.accountAddress.toLowerCase()
    && a.tokenAddress?.toLowerCase() === b.tokenAddress?.toLowerCase()
    && a.from.toLowerCase() === b.from.toLowerCase() && a.to.toLowerCase() === b.to.toLowerCase()
    && a.rawValue === b.rawValue;
}

/** Preserve distinct Transfer logs; replace their matching local submission only. */
export function mergeAssetTransactions(...groups: AssetTransaction[][]): AssetTransaction[] {
  const merged = new Map<string, AssetTransaction>();
  for (const value of groups.flat()) {
    const item = validateAssetTransaction(value);
    if (!item) continue;
    const key = recordKey(item);
    const previous = merged.get(key);
    if (!previous || previous.state === 'pending' || item.state !== 'pending') merged.set(key, item);
  }
  const records = [...merged.values()];
  const remote = records.filter((item) => item.source !== 'local');
  return records.filter((item) => item.source !== 'local' || !remote.some((entry) => sameSubmission(item, entry)))
    .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0) || (b.blockNumber ?? 0) - (a.blockNumber ?? 0) || a.id.localeCompare(b.id));
}

export function filterAssetTransactions(records: AssetTransaction[], query: Pick<AssetHistoryQuery, 'network' | 'accountAddress' | 'tokenAddress'>): AssetTransaction[] {
  const token = query.tokenAddress?.toLowerCase();
  return mergeAssetTransactions(records).filter((item) => item.chainId === query.network.chainId
    && item.accountAddress.toLowerCase() === query.accountAddress.toLowerCase()
    && item.tokenAddress?.toLowerCase() === token);
}

function scope(query: AssetHistoryQuery): string {
  return `${query.network.chainId}:${query.accountAddress.toLowerCase()}:${query.tokenAddress?.toLowerCase() ?? 'native'}`;
}

async function json(query: AssetHistoryQuery, url: string): Promise<any> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        const response = await (query.fetch ?? globalThis.fetch)(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
        if (!response.ok) throw new Error(`History HTTP ${response.status}`);
        return response.json();
      })(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('History request timed out')); }, HISTORY_TIMEOUT_MS);
      }),
    ]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

function parsedRecord(query: AssetHistoryQuery, data: {
  hash: unknown; from: unknown; to: unknown; value: unknown; block?: unknown;
  timestamp?: unknown; state: AssetTransaction['state']; token?: unknown;
  suffix: string; internal?: boolean; interaction?: boolean;
}): AssetTransaction | null {
  const from = addressObject(data.from);
  const to = addressObject(data.to);
  const hash = typeof data.hash === 'string' ? data.hash.toLowerCase() : undefined;
  const rawValue = rawInteger(data.value);
  const tokenAddress = query.tokenAddress ? address(data.token) : undefined;
  if (!from || !to || !hash || !HASH.test(hash) || rawValue === undefined
    || !direction(from, to, query.accountAddress)
    || (query.tokenAddress && tokenAddress?.toLowerCase() !== query.tokenAddress.toLowerCase())) return null;
  const movement = direction(from, to, query.accountAddress)!;
  // Incoming zero-value calls and internal zero-value traces are not receipts of currency.
  if (!tokenAddress && rawValue === '0' && (movement === 'in' || data.internal)) return null;
  return validateAssetTransaction({
    id: `${hash}:${tokenAddress?.toLowerCase() ?? 'native'}:${data.suffix}`,
    hash, chainId: query.network.chainId, accountAddress: query.accountAddress,
    tokenAddress, symbol: query.symbol ?? (tokenAddress ? 'TOKEN' : query.network.nativeSymbol ?? 'ETH'),
    decimals: tokenAddress ? query.tokenDecimals ?? 18 : 18, rawValue,
    from, to, direction: movement, state: data.state, timestamp: positiveInteger(data.timestamp),
    blockNumber: positiveInteger(data.block), source: 'explorer',
    type: !tokenAddress && (data.interaction || rawValue === '0') ? 'interaction' : 'transfer',
  });
}

interface StreamResult { records: AssetTransaction[]; next?: Cursor; limited?: boolean; }

async function bscStream(query: AssetHistoryQuery, stream: 'external' | 'internal' | 'token', cursor: Cursor): Promise<StreamResult> {
  const page = typeof cursor === 'number' && Number.isSafeInteger(cursor) && cursor >= 1 && cursor <= 25 ? cursor : 1;
  const pageSize = stream === 'token' ? 100 : 50;
  const path = stream === 'internal' ? 'getInternalTxList' : 'getAssetTransferByAddress';
  const type = stream === 'token' ? '20' : 'external';
  const response = await json(query, `${BSC_API}/tx/${path}?address=${encodeURIComponent(query.accountAddress)}&type=${type}&pageSize=${pageSize}&page=${page}&order=desc`);
  const data = response?.data;
  if (!data || !Array.isArray(data.list)) throw new Error('Invalid BscTrace history response');
  const records: AssetTransaction[] = [];
  for (const item of data.list) {
    const timestamp = positiveInteger(item.blockTimeStamp);
    const state: AssetTransaction['state'] = !timestamp ? 'pending' : Number(item.receiptsStatus) === 0 ? 'failed' : 'confirmed';
    const record = parsedRecord(query, {
      hash: item.hash, from: item.from, to: item.to || item.toOrTxCreateAddress,
      value: item.value, block: item.blockNum, timestamp, state, token: item.contractAddress,
      suffix: stream === 'token' ? `log:${item.logIndex ?? item.id}` : stream === 'internal' ? `trace:${item.traceIndex ?? item.id}` : 'external',
      internal: stream === 'internal', interaction: stream === 'external' && typeof item.input === 'string' && item.input !== '0x',
    });
    if (record) records.push(record);
  }
  const total = positiveInteger(data.total) ?? positiveInteger(data.total_num);
  const indexedTotal = positiveInteger(data.total_num);
  const hasNext = data.list.length === pageSize && (total === undefined || page * pageSize < total) && page * pageSize < 500;
  return { records, next: hasNext ? page + 1 : undefined, limited: !!indexedTotal && (total !== undefined ? indexedTotal > total : indexedTotal > 500) };
}

function blockscoutCursor(value: unknown): Record<string, string | number | boolean> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const cursor: Record<string, string | number | boolean> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!/^[a-z_]+$/.test(key) || key.length > 80) continue;
    if ((typeof entry === 'string' && entry.length < 200) || (typeof entry === 'number' && Number.isFinite(entry)) || typeof entry === 'boolean') cursor[key] = entry;
  }
  return Object.keys(cursor).length ? cursor : undefined;
}

async function blockscoutStream(query: AssetHistoryQuery, stream: 'external' | 'internal' | 'token', cursor: Cursor): Promise<StreamResult> {
  const api = BLOCKSCOUT_API[query.network.chainId];
  if (!api) throw new Error('Unsupported Blockscout network');
  const path = stream === 'external' ? 'transactions' : stream === 'internal' ? 'internal-transactions' : 'token-transfers';
  const params = new URLSearchParams();
  const nextParams = typeof cursor === 'object' ? blockscoutCursor(cursor) : undefined;
  for (const [key, entry] of Object.entries(nextParams ?? {})) params.set(key, String(entry));
  if (stream === 'token') { params.set('type', 'ERC-20'); params.set('token', query.tokenAddress!); }
  const response = await json(query, `${api}/addresses/${encodeURIComponent(query.accountAddress)}/${path}?${params.toString()}`);
  if (!Array.isArray(response?.items)) throw new Error('Invalid Blockscout history response');
  const records: AssetTransaction[] = [];
  for (const item of response.items) {
    const timestamp = typeof item.timestamp === 'string' ? Math.floor(Date.parse(item.timestamp) / 1000) : undefined;
    const state: AssetTransaction['state'] = stream === 'token' ? 'confirmed'
      : stream === 'internal' ? item.success === false ? 'failed' : 'confirmed'
        : item.status === 'error' || (item.result !== 'success' && item.result !== 'pending' && item.status !== null) ? 'failed'
          : !item.timestamp || item.result === 'pending' ? 'pending' : 'confirmed';
    const record = parsedRecord(query, {
      hash: stream === 'external' ? item.hash : item.transaction_hash,
      from: item.from, to: item.to ?? item.created_contract,
      value: stream === 'token' ? item.total?.value : item.value,
      block: item.block_number ?? item.block, timestamp, state,
      token: item.token?.address_hash,
      suffix: stream === 'token' ? `log:${item.log_index}` : stream === 'internal' ? `trace:${item.index}` : 'external',
      internal: stream === 'internal', interaction: stream === 'external' && typeof item.raw_input === 'string' && item.raw_input !== '0x',
    });
    if (record) records.push(record);
  }
  return { records, next: blockscoutCursor(response.next_page_params) };
}

/** Keep an indexer outage's fallback log and block reads within a small queue. */
function limitHistoryRpc(rpc: RpcRequest): RpcRequest {
  const queue: Array<() => void> = [];
  let active = 0;
  const runNext = () => {
    while (active < 2 && queue.length) queue.shift()!();
  };
  return (method, params) => new Promise((resolve, reject) => {
    queue.push(() => {
      active += 1;
      // Defer invocation so a synchronously throwing transport also releases
      // its slot and cannot prevent later reads from leaving the queue.
      void Promise.resolve().then(() => rpc(method, params)).then(resolve, reject).finally(() => {
        active -= 1;
        runNext();
      });
    });
    runNext();
  });
}

async function recentTokenLogs(query: AssetHistoryQuery): Promise<AssetHistoryResult> {
  if (!query.rpc || !query.tokenAddress) throw new Error('RPC token history is unavailable');
  const latest = positiveInteger(await query.rpc('eth_blockNumber', []));
  if (latest === undefined) throw new Error('Invalid latest block');
  const fromBlock = Math.max(0, latest - 2047);
  const topic = `0x${query.accountAddress.slice(2).toLowerCase().padStart(64, '0')}`;
  const requests: Promise<unknown>[] = [];
  for (let start = fromBlock; start <= latest; start += 1024) {
    const filter = { address: query.tokenAddress, fromBlock: `0x${start.toString(16)}`, toBlock: `0x${Math.min(latest, start + 1023).toString(16)}` };
    requests.push(query.rpc('eth_getLogs', [{ ...filter, topics: [TRANSFER_TOPIC, topic] }]));
    requests.push(query.rpc('eth_getLogs', [{ ...filter, topics: [TRANSFER_TOPIC, null, topic] }]));
  }
  const logs = (await Promise.all(requests)).flatMap((value) => { if (!Array.isArray(value)) throw new Error('Invalid transfer logs'); return value; });
  const records: AssetTransaction[] = [];
  for (const log of logs) {
    if (log.removed || address(log.address)?.toLowerCase() !== query.tokenAddress.toLowerCase()
      || !Array.isArray(log.topics) || log.topics.length !== 3 || log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC
      || !/^0x[\da-f]{64}$/i.test(log.topics[1]) || !/^0x[\da-f]{64}$/i.test(log.topics[2])
      || !/^0x[\da-f]{64}$/i.test(log.data) || positiveInteger(log.logIndex) === undefined) continue;
    const record = parsedRecord(query, {
      hash: log.transactionHash, from: `0x${log.topics[1].slice(-40)}`, to: `0x${log.topics[2].slice(-40)}`,
      value: log.data, block: log.blockNumber, state: 'confirmed', token: log.address,
      suffix: `log:${positiveInteger(log.logIndex)}`,
    });
    if (record) records.push({ ...record, source: 'rpc' });
  }
  const blocks = [...new Set(records.map((item) => item.blockNumber!))].sort((a, b) => b - a).slice(0, 10);
  const times = new Map<number, number>();
  await Promise.allSettled(blocks.map(async (number) => {
    const block: any = await query.rpc!('eth_getBlockByNumber', [`0x${number.toString(16)}`, false]);
    const timestamp = positiveInteger(block?.timestamp);
    if (timestamp !== undefined) times.set(number, timestamp);
  }));
  return { records: mergeAssetTransactions(records.map((item) => ({ ...item, timestamp: times.get(item.blockNumber!) }))), source: 'RPC', coverage: 'recent', hasMore: false, warning: 'recent-history-only', fromBlock, toBlock: latest };
}

/**
 * Public address-only history. BscTrace / Blockscout are display indexers;
 * all balances, signing and transaction execution continue using verified RPC.
 * Indexer outages and bounded RPC coverage are returned explicitly to the UI.
 */
export async function listAssetTransactions(query: AssetHistoryQuery): Promise<AssetHistoryResult> {
  if (!isAddress(query.accountAddress) || (query.tokenAddress && !isAddress(query.tokenAddress))) throw new Error('Invalid history address');
  if (query.tokenDecimals !== undefined && (!Number.isInteger(query.tokenDecimals) || query.tokenDecimals < 0 || query.tokenDecimals > 80)) throw new Error('Invalid token decimals');
  const currentScope = scope(query);
  if (query.page && query.page.scope !== currentScope) throw new Error('History page belongs to a different asset');
  const local = filterAssetTransactions(query.localRecords ?? [], query);
  // The list uses indexer/local status. Receipt confirmation is requested only
  // by transaction details; an indexer outage may still need bounded log reads.
  const rpcQuery = query.rpc ? { ...query, rpc: limitHistoryRpc(query.rpc) } : query;
  const provider = query.network.chainId === 56 ? 'BscTrace' : BLOCKSCOUT_API[query.network.chainId] ? 'Blockscout' : undefined;
  let result: AssetHistoryResult;
  if (!provider) {
    result = { records: [], source: 'local', coverage: 'local', hasMore: false, warning: 'unsupported-network' };
  } else {
    if (query.page && query.page.provider !== provider) throw new Error('History page uses a different indexer');
    const initialStreams: AssetHistoryPage['streams'] = query.tokenAddress ? { token: 1 } : { external: 1, internal: 1 };
    const streams = query.page?.streams ?? initialStreams;
    const outcomes = await Promise.allSettled(Object.entries(streams).map(async ([stream, cursor]) => ({
      stream: stream as 'external' | 'internal' | 'token',
      result: await (provider === 'BscTrace' ? bscStream : blockscoutStream)(query, stream as 'external' | 'internal' | 'token', cursor!),
    })));
    const records: AssetTransaction[] = [];
    const next: AssetHistoryPage['streams'] = {};
    let failed = 0;
    let limited = false;
    outcomes.forEach((outcome) => {
      if (outcome.status === 'rejected') { failed += 1; return; }
      records.push(...outcome.value.result.records);
      if (outcome.value.result.next !== undefined) next[outcome.value.stream] = outcome.value.result.next;
      limited ||= !!outcome.value.result.limited;
    });
    if (failed === outcomes.length) {
      try { result = await recentTokenLogs(rpcQuery); }
      catch { result = { records: [], source: 'local', coverage: 'local', hasMore: false, warning: 'history-unavailable' }; }
    } else {
      const hasMore = Object.keys(next).length > 0;
      result = { records: mergeAssetTransactions(records), source: provider, coverage: 'indexed', hasMore,
        nextPage: hasMore ? { scope: currentScope, provider, streams: next } : undefined,
        warning: failed ? 'partial-history' : limited ? 'history-limited' : undefined };
    }
  }
  return { ...result, records: mergeAssetTransactions(local, result.records) };
}
