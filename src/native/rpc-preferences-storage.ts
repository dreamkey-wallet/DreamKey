import * as Keychain from 'react-native-keychain';
import {
  clearPreferredRpcEndpoint,
  getPreferredRpcEndpoint,
  setPreferredRpcEndpoint,
  trustedRpcCandidate,
} from '../core/rpc-endpoints.js';

// RPC preferences are public routing choices. Keep them separate from the
// wallet vault and catalog cache so clearing either one cannot alter secrets.
const SERVICE = 'dreamkey.rpc-preferences.v1';
const MAX_CACHE_CHARS = 16 * 1024;

type PreferenceRecord = Record<string, string>;
const changedChains = new Set<number>();
let writes = Promise.resolve();

function parse(value: unknown): PreferenceRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: PreferenceRecord = {};
  for (const [chainId, endpoint] of Object.entries(value as Record<string, unknown>)) {
    if (!/^\d+$/.test(chainId) || !Number.isSafeInteger(Number(chainId)) || Number(chainId) <= 0 || typeof endpoint !== 'string') continue;
    const candidate = trustedRpcCandidate(Number(chainId), endpoint);
    if (candidate) result[chainId] = candidate.url;
  }
  return result;
}

async function readStored(): Promise<PreferenceRecord> {
  try {
    const saved = await Keychain.getGenericPassword({ service: SERVICE });
    if (!saved || saved.password.length > MAX_CACHE_CHARS) return {};
    return parse(JSON.parse(saved.password));
  } catch { return {}; }
}

async function writeStored(preferences: PreferenceRecord): Promise<void> {
  const safe = parse(preferences);
  const value = JSON.stringify(safe);
  if (value.length > MAX_CACHE_CHARS) return;
  try {
    if (!Object.keys(safe).length) {
      await Keychain.resetGenericPassword({ service: SERVICE });
      return;
    }
    await Keychain.setGenericPassword('rpc-preferences', value, {
      service: SERVICE,
      accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  } catch { /* Continue using the in-memory preference if storage is unavailable. */ }
}

function enqueueWrite(operation: () => Promise<void>): Promise<void> {
  const pending = writes.catch(() => {}).then(operation);
  writes = pending;
  return pending;
}

export const rpcPreferencesStorage = {
  async read(): Promise<PreferenceRecord> {
    const saved = await readStored();
    for (const [chainId, endpoint] of Object.entries(saved)) {
      // Startup I/O must not restore a previous selection after the user has
      // already changed that chain or explicitly chosen Automatic.
      if (!changedChains.has(Number(chainId))) setPreferredRpcEndpoint(Number(chainId), endpoint);
    }
    return saved;
  },
  write(preferences: PreferenceRecord): Promise<void> {
    const safe = parse(preferences);
    return enqueueWrite(() => writeStored(safe));
  },
  async set(chainId: number, endpoint: string): Promise<boolean> {
    if (!setPreferredRpcEndpoint(chainId, endpoint)) return false;
    changedChains.add(chainId);
    const selected = getPreferredRpcEndpoint(chainId)!;
    await enqueueWrite(async () => {
      const current = await readStored();
      current[String(chainId)] = selected;
      await writeStored(current);
    });
    return true;
  },
  async clear(chainId: number): Promise<void> {
    changedChains.add(chainId);
    clearPreferredRpcEndpoint(chainId);
    await enqueueWrite(async () => {
      const current = await readStored();
      delete current[String(chainId)];
      await writeStored(current);
    });
  },
};
