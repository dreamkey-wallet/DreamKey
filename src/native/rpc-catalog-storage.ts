import * as Keychain from 'react-native-keychain';
import { parseRpcEndpointSnapshot, type RpcEndpointSnapshot } from '../core/rpc-endpoints.js';

// A small public configuration record, isolated from wallet secrets and auth items.
const SERVICE = 'dreamkey.rpc-endpoints.v1';
const MAX_CACHE_CHARS = 64 * 1024;

export const rpcCatalogStorage = {
  async read(): Promise<RpcEndpointSnapshot | null> {
    try {
      const saved = await Keychain.getGenericPassword({ service: SERVICE });
      if (!saved || saved.password.length > MAX_CACHE_CHARS) return null;
      return parseRpcEndpointSnapshot(JSON.parse(saved.password));
    } catch { return null; }
  },
  async write(snapshot: RpcEndpointSnapshot): Promise<void> {
    const validated = parseRpcEndpointSnapshot(snapshot);
    if (!validated) return;
    const value = JSON.stringify(validated);
    if (value.length > MAX_CACHE_CHARS) return;
    try {
      await Keychain.setGenericPassword('rpc-endpoints', value, {
        service: SERVICE,
        accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      });
    } catch { /* Keep the active configuration if the device cache cannot be written. */ }
  },
};
