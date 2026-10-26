package com.dreamkey.wallet;

import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.WritableMap;
import com.facebook.react.modules.core.DeviceEventManagerModule;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CopyOnWriteArraySet;
import java.util.concurrent.atomic.AtomicInteger;

/** Distinguishes a visible Activity under a system prompt from a stopped Activity. */
public final class DreamKeyAppVisibilityModule extends ReactContextBaseJavaModule {
  private static final String EVENT = "DreamKeyAppVisibilityChange";
  private static final Object STATE_LOCK = new Object();
  private static final Set<DreamKeyAppVisibilityModule> MODULES = new CopyOnWriteArraySet<>();
  private static boolean foreground;
  private static long revision;
  private final AtomicInteger listeners = new AtomicInteger();

  DreamKeyAppVisibilityModule(ReactApplicationContext context) {
    super(context);
    MODULES.add(this);
  }

  @Override public String getName() { return "DreamKeyAppVisibility"; }

  @Override public Map<String, Object> getConstants() {
    return Collections.singletonMap("initialState", snapshot());
  }

  @ReactMethod public void getState(Promise promise) {
    Map<String, Object> state = snapshot();
    WritableMap result = Arguments.createMap();
    result.putString("state", (String) state.get("state"));
    result.putDouble("revision", (Double) state.get("revision"));
    promise.resolve(result);
  }

  @ReactMethod public void addListener(String eventName) {
    if (EVENT.equals(eventName)) listeners.incrementAndGet();
  }

  @ReactMethod public void removeListeners(double count) {
    int removed = (int) Math.max(0, Math.min(Integer.MAX_VALUE, count));
    listeners.updateAndGet(current -> Math.max(0, current - removed));
  }

  // MainActivity calls this only from onResume/onStop. onPause is deliberately
  // ignored: permission, biometric and share dialogs can leave the Activity visible.
  public static void setForeground(boolean next) {
    Map<String, Object> state;
    synchronized (STATE_LOCK) {
      if (foreground == next) return;
      foreground = next;
      revision++;
      state = snapshotLocked();
    }
    for (DreamKeyAppVisibilityModule module : MODULES) module.emit(state);
  }

  private static Map<String, Object> snapshot() {
    synchronized (STATE_LOCK) { return snapshotLocked(); }
  }

  private static Map<String, Object> snapshotLocked() {
    Map<String, Object> state = new HashMap<>();
    state.put("state", foreground ? "foreground" : "background");
    state.put("revision", (double) revision);
    return state;
  }

  private void emit(Map<String, Object> state) {
    ReactApplicationContext context = getReactApplicationContext();
    if (listeners.get() == 0 || !context.hasActiveReactInstance()) return;
    WritableMap payload = Arguments.createMap();
    payload.putString("state", (String) state.get("state"));
    payload.putDouble("revision", (Double) state.get("revision"));
    context.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class).emit(EVENT, payload);
  }

  @Override public void invalidate() {
    MODULES.remove(this);
    listeners.set(0);
    super.invalidate();
  }
}
