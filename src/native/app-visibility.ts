import { AppState, NativeEventEmitter, NativeModules, Platform } from 'react-native';

export type AppVisibility = 'foreground' | 'background';

interface NativeVisibilityState {
  state: AppVisibility;
  revision: number;
}

interface NativeAppVisibility {
  initialState?: NativeVisibilityState;
  getState(): Promise<NativeVisibilityState>;
  addListener(eventName: string): void;
  removeListeners(count: number): void;
}

/** Android AppState reports background at onPause, even while a system dialog is visible. */
export function subscribeAppVisibility(listener: (state: AppVisibility) => void): () => void {
  const native = Platform.OS === 'android'
    ? NativeModules.DreamKeyAppVisibility as NativeAppVisibility | undefined
    : undefined;
  let active = true;
  let previous: AppVisibility | undefined;
  const notify = (state: AppVisibility) => {
    if (!active || previous === state) return;
    previous = state;
    listener(state);
  };

  if (native && typeof native.getState === 'function') {
    let revision = -1;
    const receive = (value: unknown) => {
      const next = value as Partial<NativeVisibilityState> | null;
      if (!active || !next || (next.state !== 'foreground' && next.state !== 'background')
        || typeof next.revision !== 'number' || !Number.isSafeInteger(next.revision)
        || next.revision < 0 || next.revision <= revision) return;
      revision = next.revision;
      notify(next.state);
    };
    // Subscribe before reading state, then ignore snapshots older than an observed event.
    const subscription = new NativeEventEmitter(native).addListener('DreamKeyAppVisibilityChange', receive);
    receive(native.initialState);
    void native.getState().then(receive).catch(() => {
      if (revision < 0) notify('background');
    });
    return () => { active = false; subscription.remove(); };
  }

  // Preserve the existing lock boundary for iOS and previously installed binaries.
  const receive = (state: string) => {
    if (state === 'active') notify('foreground');
    else if (state === 'background') notify('background');
  };
  const subscription = AppState.addEventListener('change', receive);
  receive(AppState.currentState);
  return () => { active = false; subscription.remove(); };
}
