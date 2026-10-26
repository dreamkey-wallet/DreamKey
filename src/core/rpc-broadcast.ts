const TRANSACTION_HASH = /^0x[\da-f]{64}$/i;
export const RPC_BROADCAST_UNCERTAIN = 'RPC_BROADCAST_UNCERTAIN';

/** A timeout after sending bytes does not prove that the transaction failed. */
export class RpcBroadcastUncertainError extends Error {
  readonly code = RPC_BROADCAST_UNCERTAIN;
  readonly transactionHash: string;

  constructor(hash: string) {
    super('Transaction submission is unconfirmed. Check the transaction hash before sending again.');
    this.name = 'RpcBroadcastUncertainError';
    this.transactionHash = hash.toLowerCase();
  }
}

/**
 * Ethers wraps transport errors in info.error and JSON-RPC error.data. Accept
 * only our explicit broadcast marker and a full hash; a read timeout, revert,
 * or arbitrary hash in an unrelated error must remain an ordinary error.
 */
export function getUncertainBroadcastHash(error: unknown): string | null {
  const pending: unknown[] = [error];
  const visited = new Set<object>();
  for (let count = 0; pending.length && count < 40; count += 1) {
    const value = pending.shift();
    if (!value || typeof value !== 'object' || visited.has(value)) continue;
    visited.add(value);
    const item = value as Record<string, unknown>;
    if (item.code === RPC_BROADCAST_UNCERTAIN && typeof item.transactionHash === 'string'
      && TRANSACTION_HASH.test(item.transactionHash)) return item.transactionHash.toLowerCase();
    for (const key of ['error', 'cause', 'info', 'data']) {
      if (item[key] && typeof item[key] === 'object') pending.push(item[key]);
    }
  }
  return null;
}
