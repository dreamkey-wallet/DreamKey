import { getAddress, isAddress } from 'ethers';
import * as Keychain from 'react-native-keychain';
import type { Erc20Token } from '../core/types.js';
import { getCommonToken, getCommonTokens, isDefaultCommonToken } from '../core/common-tokens.js';

export interface StoredToken extends Erc20Token {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
}

const listeners = new Map<number, Set<() => void>>();
const writes = new Map<number, Promise<void>>();

interface StoredTokenList {
  version: 1;
  /** Only user imports are persisted; built-in metadata remains bundled. */
  tokens: StoredToken[];
  hiddenBuiltIns: string[];
}

const emptyList = (): StoredTokenList => ({ version: 1, tokens: [], hiddenBuiltIns: [] });

function service(chainId: number): string {
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error('Invalid chain ID');
  return `independent-wallet.tokens.${chainId}`;
}

function validateToken(value: unknown): StoredToken | null {
  if (!value || typeof value !== 'object') return null;
  const token = value as Partial<StoredToken>;
  if (typeof token.address !== 'string' || !isAddress(token.address)
    || !Number.isInteger(token.decimals) || token.decimals! < 0 || token.decimals! > 80
    || typeof token.symbol !== 'string' || !token.symbol.trim()
    || typeof token.name !== 'string') return null;
  return {
    address: getAddress(token.address),
    symbol: token.symbol.slice(0, 24),
    name: token.name.slice(0, 100),
    decimals: token.decimals!,
  };
}

async function readStoredList(chainId: number): Promise<StoredTokenList> {
  const credentials = await Keychain.getGenericPassword({ service: service(chainId) });
  if (!credentials) return emptyList();
  let parsed: unknown;
  try { parsed = JSON.parse(credentials.password); } catch { return emptyList(); }
  // Existing installations stored their imported tokens directly as an array.
  const stored = Array.isArray(parsed) ? { version: 1, tokens: parsed, hiddenBuiltIns: [] } : parsed;
  if (!stored || typeof stored !== 'object') return emptyList();
  const list = stored as { version?: unknown; tokens?: unknown; hiddenBuiltIns?: unknown };
  if (list.version !== 1 || !Array.isArray(list.tokens)) throw new Error('Unsupported token list format');
  const tokens = new Map<string, StoredToken>();
  for (const item of list.tokens) {
    const token = validateToken(item);
    if (token) tokens.set(token.address.toLowerCase(), token);
  }
  const hiddenBuiltIns = Array.isArray(list.hiddenBuiltIns)
    ? [...new Set(list.hiddenBuiltIns.filter((address): address is string => typeof address === 'string' && isAddress(address)).map((address) => address.toLowerCase()))]
    : [];
  return { version: 1, tokens: [...tokens.values()], hiddenBuiltIns };
}

/** Built-in and user-imported tokens are local, deduplicated and isolated by chain ID. */
export async function loadTokens(chainId: number): Promise<StoredToken[]> {
  const list = await readStoredList(chainId);
  const hidden = new Set(list.hiddenBuiltIns);
  const tokens = new Map(getCommonTokens(chainId).filter((token) => !hidden.has(token.address.toLowerCase())).map((token) => [token.address.toLowerCase(), token]));
  for (const token of list.tokens) {
    // Legacy/user imports cannot replace a known contract's precision or bridge identity.
    if (!isDefaultCommonToken(chainId, token.address)) {
      tokens.set(token.address.toLowerCase(), getCommonToken(chainId, token.address) ?? token);
    }
  }
  return [...tokens.values()];
}

function mutate(chainId: number, change: (list: StoredTokenList) => StoredTokenList): Promise<void> {
  const pending = (writes.get(chainId) ?? Promise.resolve()).catch(() => undefined).then(async () => {
    const list = change(await readStoredList(chainId));
    const saved = await Keychain.setGenericPassword('tokens', JSON.stringify(list), {
      service: service(chainId),
      accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
    if (!saved) throw new Error('Could not save token list');
    listeners.get(chainId)?.forEach((listener) => listener());
  });
  writes.set(chainId, pending);
  void pending.finally(() => { if (writes.get(chainId) === pending) writes.delete(chainId); }).catch(() => undefined);
  return pending;
}

export async function saveToken(chainId: number, token: StoredToken): Promise<void> {
  const validated = validateToken(token);
  if (!validated) throw new Error('Invalid token metadata');
  const address = validated.address.toLowerCase();
  const known = getCommonToken(chainId, address);
  const builtIn = isDefaultCommonToken(chainId, address);
  return mutate(chainId, (list) => ({
    version: 1,
    tokens: [...list.tokens.filter((entry) => entry.address.toLowerCase() !== address), ...(builtIn ? [] : [known ?? validated])],
    hiddenBuiltIns: list.hiddenBuiltIns.filter((entry) => entry !== address),
  }));
}

export async function removeToken(chainId: number, address: string): Promise<void> {
  if (!isAddress(address)) throw new Error('Invalid token address');
  const normalized = address.toLowerCase();
  const builtIn = isDefaultCommonToken(chainId, normalized);
  return mutate(chainId, (list) => ({
    version: 1,
    tokens: list.tokens.filter((token) => token.address.toLowerCase() !== normalized),
    hiddenBuiltIns: builtIn ? [...new Set([...list.hiddenBuiltIns, normalized])] : list.hiddenBuiltIns,
  }));
}

export function subscribeTokens(chainId: number, callback: () => void): () => void {
  const subscribers = listeners.get(chainId) ?? new Set<() => void>();
  subscribers.add(callback);
  listeners.set(chainId, subscribers);
  return () => {
    subscribers.delete(callback);
    if (subscribers.size === 0) listeners.delete(chainId);
  };
}
