export interface UpdateManifest {
  appVersion: string;
  bundleVersion: number;
  mandatory: boolean;
  description: string;
  downloadAndroidUrlApk: string;
  downloadAndroidUrlBundle: string;
  downloadIosUrlApk: string;
  downloadIosUrlBundle: string;
}

export interface UpdateRuntimeState {
  appVersion: string;
  bundleVersion: number;
  pendingBundleVersion: number;
  highestBundleVersion?: number;
  failedBundleVersion?: number;
  rollback: boolean;
  supported: boolean;
  apkReady?: boolean;
  apkVersion?: string;
}

export interface AvailableUpdate {
  kind: 'apk' | 'store' | 'bundle';
  url: string;
  manifest: UpdateManifest;
}

export class UpdateError extends Error {
  constructor(public readonly code: string) { super(code); }
}

const VERSION = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;

export function compareAppVersions(left: string, right: string): number {
  if (!VERSION.test(left) || !VERSION.test(right)) throw new UpdateError('E_UPDATE_VERSION');
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  return 0;
}

export function parseUpdateManifest(input: unknown): UpdateManifest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new UpdateError('E_UPDATE_JSON');
  const data = input as Record<string, unknown>;
  if (typeof data.appVersion !== 'string' || !VERSION.test(data.appVersion)
    || !Number.isSafeInteger(data.bundleVersion) || Number(data.bundleVersion) < 0 || Number(data.bundleVersion) > 2147483647
    || typeof data.mandatory !== 'boolean'
    || typeof data.description !== 'string' || data.description.length > 8000) {
    throw new UpdateError('E_UPDATE_JSON');
  }
  const urls = ['downloadAndroidUrlApk', 'downloadAndroidUrlBundle', 'downloadIosUrlApk', 'downloadIosUrlBundle'] as const;
  for (const key of urls) {
    if (typeof data[key] !== 'string' || data[key].length > 2048) throw new UpdateError('E_UPDATE_JSON');
  }
  return {
    appVersion: data.appVersion,
    bundleVersion: data.bundleVersion as number,
    mandatory: data.mandatory,
    description: data.description,
    downloadAndroidUrlApk: data.downloadAndroidUrlApk as string,
    downloadAndroidUrlBundle: data.downloadAndroidUrlBundle as string,
    downloadIosUrlApk: data.downloadIosUrlApk as string,
    downloadIosUrlBundle: data.downloadIosUrlBundle as string,
  };
}

export function requireHttpsUrl(value: string, hosts?: readonly string[]): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new UpdateError('E_UPDATE_URL'); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.hash
    || (url.port && url.port !== '443') || host === 'localhost' || host.endsWith('.localhost')
    || !host.includes('.') || /^[\d.]+$/.test(host) || host.includes(':')
    || (hosts && !hosts.some((allowed) => allowed.toLowerCase() === host))) {
    throw new UpdateError('E_UPDATE_URL');
  }
  return url.href;
}

/** A patch targets exactly one native appVersion. A newer installed app never downgrades. */
export function selectUpdate(manifest: UpdateManifest, state: UpdateRuntimeState, platform: string,
  downloadHosts: readonly string[], storeHosts: readonly string[]): AvailableUpdate | null {
  const comparison = compareAppVersions(state.appVersion, manifest.appVersion);
  if (comparison > 0) return null;
  if (comparison < 0) {
    const kind = platform === 'android' ? 'apk' : platform === 'ios' ? 'store' : null;
    const url = kind === 'apk' ? manifest.downloadAndroidUrlApk : manifest.downloadIosUrlApk;
    if (!kind || !url) return null;
    return { kind, url: requireHttpsUrl(url, kind === 'apk' ? downloadHosts : storeHosts), manifest };
  }
  const highest = Math.max(state.bundleVersion, state.pendingBundleVersion,
    state.highestBundleVersion ?? 0, state.failedBundleVersion ?? 0);
  if (!state.supported || manifest.bundleVersion <= highest) return null;
  const url = platform === 'android' ? manifest.downloadAndroidUrlBundle
    : platform === 'ios' ? manifest.downloadIosUrlBundle : '';
  if (!url) return null;
  return { kind: 'bundle', url: requireHttpsUrl(url, downloadHosts), manifest };
}
