import { useCallback, useEffect, useRef, useState } from 'react';
import type { WalletCore } from '../core/wallet-core.js';
import type { NetworkConfig } from '../core/types.js';
import { filterAssetTransactions, listAssetTransactions, mergeAssetTransactions, type AssetHistoryPage, type AssetHistoryResult, type AssetTransaction } from '../core/asset-history.js';
import { loadTransactions, subscribeTransactions } from '../native/transaction-storage.js';
import type { StoredToken } from '../native/token-storage.js';
import { walletAssetContextKey } from './wallet-assets-loader.js';

interface HistoryState {
  key: string;
  records: AssetTransaction[];
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  nextPage?: AssetHistoryPage;
  warning?: AssetHistoryResult['warning'];
  coverage?: AssetHistoryResult['coverage'];
}

const initialState: HistoryState = { key: '', records: [], loading: true, loadingMore: false, hasMore: false };

/** Load each account/asset once; refresh and paging are explicit to limit RPC traffic. */
export function useAssetHistory(core: WalletCore, accountAddress: string, network: NetworkConfig, token?: StoredToken) {
  const key = `${walletAssetContextKey(core, 0, network)}:${accountAddress.toLowerCase()}:${token?.address.toLowerCase() ?? 'native'}`;
  const [state, setState] = useState<HistoryState>(initialState);
  const stateRef = useRef(state);
  stateRef.current = state;
  const generation = useRef(0);
  const requestRef = useRef<{ key: string; promise: Promise<void> } | null>(null);
  const localRef = useRef<{ key: string; records: AssetTransaction[] }>({ key: '', records: [] });
  const localRevision = useRef(0);
  const currentKey = useRef(key);
  currentKey.current = key;

  const run = useCallback((more = false): Promise<void> => {
    if (currentKey.current !== key || core.vault.isLocked()) return Promise.resolve();
    if (requestRef.current?.key === key) return requestRef.current.promise;
    const previous = stateRef.current.key === key ? stateRef.current : { ...initialState, key };
    if (more && (!previous.hasMore || !previous.nextPage)) return Promise.resolve();
    const revision = ++generation.current;
    const active = () => revision === generation.current && key === currentKey.current && !core.vault.isLocked();
    const promise = (async () => {
      setState({ ...previous, key, loading: !more, loadingMore: more });
      let localRecords: AssetTransaction[] = [];
      let storageFailed = false;
      const localRead = ++localRevision.current;
      try { localRecords = await loadTransactions(network.chainId, accountAddress); } catch { storageFailed = true; }
      if (!active()) return;
      const query = { network, accountAddress, tokenAddress: token?.address };
      if (localRead === localRevision.current) localRef.current = { key, records: filterAssetTransactions(localRecords, query) };
      const matchingLocal = localRef.current.key === key ? localRef.current.records : [];
      if (!more && matchingLocal.length) setState({ ...previous, key, records: mergeAssetTransactions(previous.records, matchingLocal), loading: true, loadingMore: false });
      let rpcId = 0;
      try {
        const transport = core.getRpcTransport(network.id);
        const result = await listAssetTransactions({
          network, accountAddress, tokenAddress: token?.address, tokenDecimals: token?.decimals,
          symbol: token?.symbol ?? network.nativeSymbol ?? 'ETH', localRecords,
          page: more ? previous.nextPage : undefined,
          rpc: async (method, params) => {
            const response = await transport(network.rpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) });
            const payload = await response.json();
            if (payload.error) throw new Error('History RPC unavailable');
            return payload.result;
          },
        });
        if (!active()) return;
        const latestLocal = localRef.current.key === key ? localRef.current.records : [];
        const records = mergeAssetTransactions(more ? previous.records : [], result.records, latestLocal);
        setState({ key, records,
          loading: false, loadingMore: false, hasMore: result.hasMore, nextPage: result.nextPage,
          coverage: result.coverage, warning: storageFailed ? result.warning ?? 'partial-history' : result.warning });
      } catch {
        if (active()) setState({ ...previous, key, records: mergeAssetTransactions(previous.records, localRef.current.key === key ? localRef.current.records : matchingLocal),
          loading: false, loadingMore: false, warning: 'history-unavailable' });
      }
    })();
    requestRef.current = { key, promise };
    void promise.finally(() => { if (requestRef.current?.promise === promise) requestRef.current = null; });
    return promise;
  }, [core, key, accountAddress, token?.decimals, token?.symbol, network.nativeSymbol]);

  const refresh = useCallback(() => run(), [run]);
  const loadMore = useCallback(() => run(true), [run]);
  useEffect(() => {
    void refresh();
    let active = true;
    const unsubscribe = subscribeTransactions(network.chainId, accountAddress, () => {
      // A storage update can happen while the indexer is slow. Merge locally
      // immediately; detail confirmations never trigger another remote request.
      const localRead = ++localRevision.current;
      void loadTransactions(network.chainId, accountAddress).then((records) => {
        if (!active || currentKey.current !== key || localRead !== localRevision.current || core.vault.isLocked()) return;
        const matching = filterAssetTransactions(records, { network, accountAddress, tokenAddress: token?.address });
        localRef.current = { key, records: matching };
        setState((previous) => ({ ...(previous.key === key ? previous : { ...initialState, key }), records: mergeAssetTransactions(previous.key === key ? previous.records : [], matching) }));
      }).catch(() => undefined);
    });
    return () => { active = false; generation.current += 1; localRevision.current += 1; requestRef.current = null; unsubscribe(); };
  }, [refresh, network.chainId, accountAddress]);
  const current = state.key === key ? state : { ...initialState, key };
  return { ...current, refresh, loadMore };
}

