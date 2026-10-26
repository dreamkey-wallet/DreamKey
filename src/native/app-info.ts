import { NativeModules } from 'react-native';

interface NativeAppInfo {
  versionName?: string;
}

/** Android versionName / iOS CFBundleShortVersionString from the installed app. */
export function getAppVersionName(): string {
  const appInfo = NativeModules.DreamKeyAppInfo as NativeAppInfo | undefined;
  return appInfo?.versionName?.trim() || '—';
}
