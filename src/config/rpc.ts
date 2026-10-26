/** Public endpoint discovery never includes wallet addresses or transaction data. */
/**
 * TokenPocket's public endpoint directory.  The namespace is deliberately
 * fixed to ethereum: it identifies the EVM RPC catalog, while `chain_id`
 * selects the individual mainnet requested by the caller.
 */
export const RPC_CATALOG_URL = 'https://preserver.mytokenpocket.vip/v1/endpoint/list';
/** Chainlist remains a discovery fallback when the primary directory is empty or unavailable. */
export const RPC_CATALOG_FALLBACK_URL = 'https://chainlist.org/rpcs.json';
export const RPC_CATALOG_NAMESPACE = 'ethereum';
export function getRpcCatalogUrl(chainId: number): string {
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error('Invalid RPC catalog chain id');
  const url = new URL(RPC_CATALOG_URL);
  url.searchParams.set('ns', RPC_CATALOG_NAMESPACE);
  url.searchParams.set('chain_id', String(chainId));
  return url.href;
}
export const RPC_CATALOG_REFRESH_MS = 6 * 60 * 60 * 1000;
export const RPC_CATALOG_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const RPC_CATALOG_TIMEOUT_MS = 60_000;
export const RPC_PROBE_TIMEOUT_MS = 6_000;
