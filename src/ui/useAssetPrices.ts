import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { assetPriceService, valueWalletAssets, type AssetPriceSnapshot } from '../core/asset-prices.js';
import type { NetworkConfig } from '../core/types.js';
import type { WalletAssetBalance } from './wallet-assets-loader.js';

const emptySnapshot: AssetPriceSnapshot = { native: null, tokens: {}, error: false, fetchedAt: 0 };
interface PriceState { key: string; snapshot: AssetPriceSnapshot; loading: boolean }

/**
 * Prices are shared publicly; valuations always use this wallet/account's balances.
 * Disabling autoRefresh keeps the initial/context load and explicit refresh calls.
 */
export function useAssetPrices(
  network: NetworkConfig,
  assets: WalletAssetBalance[],
  contextKey: string,
  balancesLoading = false,
  enabled = true,
  autoRefresh = true,
) {
  const addressesKey = JSON.stringify([...new Set(assets.flatMap((asset) => asset.token ? [asset.token.address.toLowerCase()] : []))].sort());
  const addresses = useMemo<string[]>(() => JSON.parse(addressesKey), [addressesKey]);
  const key = `${contextKey}:${network.chainId}:${addressesKey}`;
  const currentKey = useRef(key);
  currentKey.current = key;
  const generation = useRef(0);
  const request = useRef<{ key: string; promise: Promise<void> } | null>(null);
  const [state, setState] = useState<PriceState>({ key: '', snapshot: emptySnapshot, loading: true });

  const refresh = useCallback((force = false): Promise<void> => {
    if (!enabled) return Promise.resolve();
    if (request.current?.key === key) return request.current.promise;
    const revision = ++generation.current;
    const active = () => generation.current === revision && currentKey.current === key;
    setState((previous) => ({ key, snapshot: previous.key === key ? previous.snapshot : emptySnapshot, loading: true }));
    const promise = (async () => {
      try {
        // Only chain IDs and public token contracts go to the price service.
        const snapshot = await assetPriceService.getQuotes(network.chainId, addresses, force);
        if (active()) setState({ key, snapshot, loading: false });
      } catch {
        if (active()) setState({ key, snapshot: { ...emptySnapshot, error: true }, loading: false });
      }
    })();
    request.current = { key, promise };
    void promise.finally(() => { if (request.current?.promise === promise) request.current = null; });
    return promise;
  }, [enabled, key, network.chainId, addresses]);

  useEffect(() => {
    void refresh();
    return () => { generation.current += 1; request.current = null; };
  }, [refresh]);

  useEffect(() => {
    if (!enabled || !autoRefresh) return;
    let previousState = AppState.currentState;
    const timer = setInterval(() => {
      if (AppState.currentState !== 'background' && AppState.currentState !== 'inactive') void refresh();
    }, 60_000);
    const subscription = AppState.addEventListener('change', (nextState) => {
      const resumed = nextState === 'active' && previousState !== 'active';
      previousState = nextState;
      if (resumed) void refresh(true);
    });
    return () => { clearInterval(timer); subscription.remove(); };
  }, [enabled, autoRefresh, refresh]);

  const snapshot = enabled && state.key === key ? state.snapshot : emptySnapshot;
  const valuation = useMemo(() => valueWalletAssets(assets, snapshot), [assets, snapshot]);
  const loading = enabled && (state.key !== key || state.loading);
  return { ...valuation, complete: enabled && valuation.complete && !balancesLoading && !loading, loading, error: snapshot.error, refresh };
}
