import { NativeEventEmitter, NativeModules } from 'react-native';
import type { UpdateRuntimeState } from '../updates/update-policy.js';
import { UpdateError } from '../updates/update-policy.js';

interface NativeUpdates {
  getState(): Promise<UpdateRuntimeState>;
  downloadApk(url: string, appVersion: string): Promise<void>;
  installApk(): Promise<void>;
  stageBundle(url: string, appVersion: string, bundleVersion: number): Promise<void>;
  markLaunchSuccessful(): Promise<void>;
  acknowledgeRollback?(): Promise<void>;
  addListener(eventName: string): void;
  removeListeners(count: number): void;
}

export interface UpdateProgress { kind: 'apk' | 'bundle'; received: number; total: number }

function native(): NativeUpdates {
  const module = NativeModules.DreamKeyUpdates as NativeUpdates | undefined;
  if (!module) throw new UpdateError('E_UPDATE_NATIVE');
  return module;
}

export const appUpdates = {
  getState: () => native().getState(),
  downloadApk: (url: string, version: string) => native().downloadApk(url, version),
  installApk: () => native().installApk(),
  stageBundle: (url: string, version: string, bundleVersion: number) => native().stageBundle(url, version, bundleVersion),
  markLaunchSuccessful: () => native().markLaunchSuccessful(),
  // Older installed binaries consume this notice in getState. Keep OTA JS
  // compatible while newer binaries acknowledge only after it is displayed.
  acknowledgeRollback: () => native().acknowledgeRollback?.() ?? Promise.resolve(),
  subscribe(listener: (progress: UpdateProgress) => void): () => void {
    const module = NativeModules.DreamKeyUpdates as NativeUpdates | undefined;
    if (!module) return () => undefined;
    const subscription = new NativeEventEmitter(module).addListener('DreamKeyUpdateProgress', (event: UpdateProgress) => {
      if (event && (event.kind === 'apk' || event.kind === 'bundle')
        && Number.isFinite(event.received) && event.received >= 0
        && Number.isFinite(event.total)) listener(event);
    });
    return () => subscription.remove();
  },
};
