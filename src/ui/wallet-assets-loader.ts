import { parseEther } from 'ethers';
import type { WalletCore } from '../core/wallet-core.js';
import type { NetworkConfig } from '../core/types.js';
import type { StoredToken } from '../native/token-storage.js';

export interface WalletAssetBalance {
  id: string;
  symbol: string;
  name: string;
  decimals: number;
  token?: StoredToken;
  balance: string | null;
  rawBalance: string | null;
  /** A retained display balance is not current while this asset is loading. */
  loading?: boolean;
  error?: string;
}

export interface WalletAssetsState {
  key: string;
  assets: WalletAssetBalance[];
  loading: boolean;
  nativeLoading: boolean;
  error: string | null;
}

export interface WalletAssetsContext {
  key: string;
  core: WalletCore;
  accountIndex: number;
  network: NetworkConfig;
}

const walletIds = new WeakMap<WalletCore, number>();
let nextWalletId = 0;

/** A different unlocked wallet must never inherit another wallet's balances. */
export function walletAssetContextKey(core: WalletCore, accountIndex: number, network: NetworkConfig): string {
  let walletId = walletIds.get(core);
  if (walletId === undefined) {
    walletId = ++nextWalletId;
    walletIds.set(core, walletId);
  }
  return `${walletId}:${accountIndex}:${network.id}:${network.chainId}:${network.rpcUrl}:${JSON.stringify(network.rpcFallbackUrls ?? [])}`;
}

export function nativeAsset(network: NetworkConfig): WalletAssetBalance {
  return { id: 'native', symbol: network.nativeSymbol ?? 'ETH', name: network.name, decimals: 18, balance: null, rawBalance: null, loading: true };
}

interface BalanceRequest {
  context: WalletAssetsContext;
  revision: number;
  promise: Promise<void>;
  resolve: () => void;
  metadataLoading: boolean;
  metadataError: string | null;
}

/** Keep imported-token reads bounded so a large token list cannot saturate the
 * shared RPC pool when a wallet screen first opens. */
async function mapWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  operation: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await operation(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}

/** Balance requests settle independently, with one shared refresh per context. */
export class WalletAssetsLoader {
  private state: WalletAssetsState = { key: '', assets: [], loading: true, nativeLoading: true, error: null };
  private request: BalanceRequest | null = null;
  private revision = 0;

  constructor(
    private readonly readTokens: (chainId: number) => Promise<StoredToken[]>,
    private readonly onState: (state: WalletAssetsState) => void,
  ) {}

  /** Cleanup also releases callers awaiting a refresh; late RPC results are ignored. */
  invalidate(): void {
    this.revision += 1;
    this.request?.resolve();
    this.request = null;
  }

  refresh(context: WalletAssetsContext, force = false): Promise<void> {
    if (!force && this.request?.context.key === context.key && this.request.context.core === context.core) {
      return this.request.promise;
    }
    this.invalidate();
    let resolve!: () => void;
    const promise = new Promise<void>((complete) => { resolve = complete; });
    const request: BalanceRequest = {
      context, revision: this.revision, promise, resolve, metadataLoading: true, metadataError: null,
    };
    this.request = request;
    const assets = this.state.key === context.key
      ? this.state.assets.map((asset) => ({ ...asset, loading: true, error: undefined }))
      : [nativeAsset(context.network)];
    this.publish(request, assets);

    // Native balance does not wait for local token metadata or a slow ERC-20 RPC.
    const native = Promise.resolve()
      .then(() => this.isCurrent(request) ? context.core.getNativeBalance(context.accountIndex, context.network.id) : undefined)
      .then((balance) => { if (balance !== undefined) this.settle(request, 'native', { balance, rawBalance: parseEther(balance).toString() }); })
      .catch(() => this.settle(request, 'native', null));
    const tokens = Promise.resolve()
      .then(() => this.isCurrent(request) ? this.readTokens(context.network.chainId) : undefined)
      .then(async (metadata) => {
        if (!metadata || !this.isCurrent(request)) return;
        request.metadataLoading = false;
        const previous = new Map(this.state.assets.map((asset) => [asset.id, asset]));
        const tokenAssets = metadata.map((token): WalletAssetBalance => {
          const id = token.address.toLowerCase();
          const old = previous.get(id);
          return {
            id, symbol: token.symbol, name: token.name, decimals: token.decimals, token,
            balance: old?.balance ?? null, rawBalance: old?.rawBalance ?? null, loading: true,
          };
        });
        this.publish(request, [previous.get('native') ?? nativeAsset(context.network), ...tokenAssets]);
        await mapWithConcurrency(metadata, 4, (token) => Promise.resolve()
          .then(() => this.isCurrent(request) ? context.core.getErc20Balance(context.accountIndex, context.network.id, token) : undefined)
          .then((result) => { if (result !== undefined) this.settle(request, token.address.toLowerCase(), { balance: result.formatted, rawBalance: result.raw }); })
          .catch(() => this.settle(request, token.address.toLowerCase(), null)));
      })
      .catch(() => {
        if (!this.isCurrent(request)) return;
        request.metadataLoading = false;
        request.metadataError = 'Token list unavailable';
        this.publish(request, this.state.assets.map((asset) => asset.id === 'native' ? asset : {
          ...asset, loading: false, balance: null, rawBalance: null, error: 'Token list unavailable',
        }));
      });
    void Promise.all([native, tokens]).then(() => {
      if (this.isCurrent(request)) this.request = null;
      resolve();
    });
    return promise;
  }

  private isCurrent(request: BalanceRequest): boolean {
    return this.request === request && this.revision === request.revision;
  }

  private settle(request: BalanceRequest, id: string, result: { balance: string; rawBalance: string } | null): void {
    if (!this.isCurrent(request)) return;
    this.publish(request, this.state.assets.map((asset) => asset.id !== id ? asset : {
      ...asset, balance: result?.balance ?? null, rawBalance: result?.rawBalance ?? null,
      loading: false, error: result ? undefined : 'Balance unavailable',
    }));
  }

  private publish(request: BalanceRequest, assets: WalletAssetBalance[]): void {
    if (!this.isCurrent(request)) return;
    this.state = {
      key: request.context.key,
      assets,
      loading: request.metadataLoading || assets.some((asset) => asset.loading),
      nativeLoading: assets.find((asset) => asset.id === 'native')?.loading ?? true,
      error: request.metadataError ?? (assets.some((asset) => asset.error) ? 'Balance unavailable' : null),
    };
    this.onState(this.state);
  }
}
