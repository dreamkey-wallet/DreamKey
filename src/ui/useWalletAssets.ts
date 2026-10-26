import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { WalletCore } from '../core/wallet-core.js';
import type { NetworkConfig } from '../core/types.js';
import { loadTokens, subscribeTokens } from '../native/token-storage.js';
import { nativeAsset, walletAssetContextKey, WalletAssetsLoader, type WalletAssetsState } from './wallet-assets-loader.js';

export { nativeAsset, type WalletAssetBalance } from './wallet-assets-loader.js';

/** Common/imported tokens and live balances; missing RPC data is never reported as zero. */
export function useWalletAssets(core: WalletCore, accountIndex: number, network: NetworkConfig) {
  const [state, setState] = useState<WalletAssetsState>({ key: '', assets: [], loading: true, nativeLoading: true, error: null });
  const loaderRef = useRef<WalletAssetsLoader | null>(null);
  if (!loaderRef.current) loaderRef.current = new WalletAssetsLoader(loadTokens, setState);
  const loader = loaderRef.current;
  const key = walletAssetContextKey(core, accountIndex, network);
  const context = useMemo(() => ({ key, core, accountIndex, network }), [key, core, accountIndex, network.id, network.chainId, network.rpcUrl, network.name, network.nativeSymbol]);
  const refresh = useCallback(() => loader.refresh(context), [loader, context]);

  useEffect(() => {
    void refresh();
    // Token edits must supersede an in-flight refresh rather than disappear into it.
    const unsubscribe = subscribeTokens(network.chainId, () => { void loader.refresh(context, true); });
    return () => { loader.invalidate(); unsubscribe(); };
  }, [refresh, context, loader, network.chainId]);

  return {
    assets: state.key === key ? state.assets : [nativeAsset(network)],
    loading: state.key !== key || state.loading,
    nativeLoading: state.key !== key || state.nativeLoading,
    error: state.key === key ? state.error : null,
    contextKey: key,
    refresh,
  };
}

/** Compact only for display. Transaction inputs always use the exact string. */
export function displayAssetBalance(balance: string | null): string {
  if (balance === null) return '—';
  const [whole, fraction] = balance.split('.');
  if (!fraction) return whole;
  if (whole === '0' && Number(balance) > 0 && Number(balance) < 0.000001) return '< 0.000001';
  const compact = fraction.slice(0, 6).replace(/0+$/, '');
  return compact ? `${whole}.${compact}` : whole;
}
