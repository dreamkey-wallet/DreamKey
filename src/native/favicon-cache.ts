import { NativeModules } from 'react-native';

interface NativeFaviconCache {
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<boolean>;
}

// Public image data belongs in the disposable app cache, separate from secrets.
// Older installed builds can still use the in-memory cache until recompiled.
export const faviconStorage = {
  async read(key: string): Promise<string | null> {
    const native = NativeModules.DreamKeyFaviconCache as NativeFaviconCache | undefined;
    try { return native?.read ? await native.read(key) : null; }
    catch { return null; }
  },
  async write(key: string, value: string): Promise<void> {
    const native = NativeModules.DreamKeyFaviconCache as NativeFaviconCache | undefined;
    try { if (native?.write) await native.write(key, value); }
    catch { /* A full or unavailable cache must not affect browsing. */ }
  },
};
