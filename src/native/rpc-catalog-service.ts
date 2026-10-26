import { RPC_CATALOG_REFRESH_MS } from '../config/rpc.js';
import { refreshRpcCatalog } from '../core/rpc-catalog.js';
import { applyRpcEndpointSnapshot, type RpcEndpointSnapshot } from '../core/rpc-endpoints.js';
import { subscribeAppVisibility, type AppVisibility } from './app-visibility.js';
import { rpcCatalogStorage } from './rpc-catalog-storage.js';

const RETRY_MS = 15 * 60 * 1000;
const START_DELAY_MS = 3000;
const REFRESH_TIMEOUT_MS = 60_000;
const STORAGE_TIMEOUT_MS = 3000;

async function boundedStorage<T>(operation: Promise<T>, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation.catch(() => fallback), new Promise<T>((resolve) => {
      timer = setTimeout(() => resolve(fallback), STORAGE_TIMEOUT_MS);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

interface CatalogServiceOptions {
  storage?: typeof rpcCatalogStorage;
  refresh?: typeof refreshRpcCatalog;
  apply?: typeof applyRpcEndpointSnapshot;
  visibility?: (listener: (state: AppVisibility) => void) => () => void;
  now?: () => number;
}

/** Never waits for a directory download during startup; existing pools pick up updates. */
export function startRpcCatalogService(options: CatalogServiceOptions = {}): () => void {
  const storage = options.storage ?? rpcCatalogStorage;
  const refresh = options.refresh ?? refreshRpcCatalog;
  const apply = options.apply ?? applyRpcEndpointSnapshot;
  const visibility = options.visibility ?? subscribeAppVisibility;
  const now = options.now ?? Date.now;
  let snapshot: RpcEndpointSnapshot | undefined;
  let active = false;
  let loaded = false;
  let disposed = false;
  let inFlight = false;
  let due = now() + START_DELAY_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;

  const clear = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
  const schedule = () => {
    clear();
    if (disposed || !active || !loaded || inFlight) return;
    timer = setTimeout(() => { timer = undefined; void run(); }, Math.max(START_DELAY_MS, due - now()));
  };
  const run = async () => {
    if (disposed || !active || !loaded || inFlight) return;
    inFlight = true;
    const requestController = new AbortController();
    controller = requestController;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => { requestController.abort(); reject(new Error('RPC directory refresh timed out')); }, REFRESH_TIMEOUT_MS);
      });
      const updated = await Promise.race([refresh(snapshot, { signal: requestController.signal }), deadline]);
      if (disposed || !active || requestController.signal.aborted) return;
      if (apply(updated)) {
        snapshot = updated;
        due = now() + RPC_CATALOG_REFRESH_MS;
        await boundedStorage(storage.write(updated), undefined);
      } else due = now() + RETRY_MS;
    } catch {
      // The verified cache and built-in endpoints remain available during an outage.
      if (!disposed && active) due = now() + RETRY_MS;
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      if (controller === requestController) controller = undefined;
      inFlight = false;
      schedule();
    }
  };
  const unsubscribe = visibility((state) => {
    active = state === 'foreground';
    if (!active) { clear(); controller?.abort(); }
    else schedule();
  });
  void boundedStorage(storage.read(), null).then((saved) => {
    if (disposed) return;
    if (saved && apply(saved)) {
      snapshot = saved;
      due = Math.max(due, saved.updatedAt + RPC_CATALOG_REFRESH_MS);
    }
  }).catch(() => { /* Start with the bundled list when local storage is unavailable. */ })
    .finally(() => { loaded = true; schedule(); });
  return () => { disposed = true; active = false; clear(); controller?.abort(); unsubscribe(); };
}
