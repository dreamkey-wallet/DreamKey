import { getAddress, isAddress } from 'ethers';
import * as Keychain from 'react-native-keychain';
import { mergeAssetTransactions, validateAssetTransaction, type AssetTransaction } from '../core/asset-history.js';

const writes = new Map<string, Promise<void>>();
const listeners = new Map<string, Set<() => void>>();
const MAX_RECORDS = 500;

function service(chainId: number, accountAddress: string): string {
  if (!Number.isSafeInteger(chainId) || chainId <= 0 || !isAddress(accountAddress)) throw new Error('Invalid transaction account');
  return `independent-wallet.transactions.${chainId}.${getAddress(accountAddress).toLowerCase()}`;
}

/** Public transaction metadata, isolated by chain and account, never wallet secrets. */
export async function loadTransactions(chainId: number, accountAddress: string): Promise<AssetTransaction[]> {
  const credentials = await Keychain.getGenericPassword({ service: service(chainId, accountAddress) });
  if (!credentials) return [];
  let saved: unknown;
  try { saved = JSON.parse(credentials.password); } catch { return []; }
  if (!Array.isArray(saved)) return [];
  return mergeAssetTransactions(saved).filter((item) => item.chainId === chainId && item.accountAddress.toLowerCase() === accountAddress.toLowerCase()).slice(0, MAX_RECORDS);
}

/** Serialized read/merge/write prevents overlapping confirmations losing records. */
export function saveTransaction(value: AssetTransaction): Promise<void> {
  const record = validateAssetTransaction(value);
  if (!record) return Promise.reject(new Error('Invalid transaction record'));
  const key = service(record.chainId, record.accountAddress);
  const pending = (writes.get(key) ?? Promise.resolve()).catch(() => undefined).then(async () => {
    const records = mergeAssetTransactions(await loadTransactions(record.chainId, record.accountAddress), [record]).slice(0, MAX_RECORDS);
    const saved = await Keychain.setGenericPassword('transactions', JSON.stringify(records), {
      service: key, accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
    if (!saved) throw new Error('Could not save the transaction record');
    listeners.get(key)?.forEach((listener) => listener());
  });
  writes.set(key, pending);
  void pending.finally(() => { if (writes.get(key) === pending) writes.delete(key); }).catch(() => undefined);
  return pending;
}

export function subscribeTransactions(chainId: number, accountAddress: string, callback: () => void): () => void {
  const key = service(chainId, accountAddress);
  const subscribers = listeners.get(key) ?? new Set<() => void>();
  subscribers.add(callback);
  listeners.set(key, subscribers);
  return () => { subscribers.delete(callback); if (subscribers.size === 0) listeners.delete(key); };
}
