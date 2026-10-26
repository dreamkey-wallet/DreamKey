package com.dreamkey.wallet;

import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.UiThreadUtil;
import com.facebook.react.bridge.WritableMap;
import com.facebook.react.modules.core.DeviceEventManagerModule;
import org.json.JSONObject;
import java.util.Iterator;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;

/** JS bridge for user initiated APK installs and next-launch OTA updates. */
public final class DreamKeyUpdatesModule extends ReactContextBaseJavaModule {
  // Downloads may take minutes. Launch confirmation and state reads must never
  // queue behind them or a working OTA launch can be incorrectly rolled back.
  private final ExecutorService executor = Executors.newSingleThreadExecutor();
  private final ExecutorService controlExecutor = Executors.newSingleThreadExecutor();
  private volatile boolean invalidated;
  private volatile Thread worker;
  private volatile Thread controlWorker;

  DreamKeyUpdatesModule(ReactApplicationContext context) { super(context); }
  @Override public String getName() { return "DreamKeyUpdates"; }

  @ReactMethod public void getState(Promise promise) {
    execute("E_UPDATE_STATE", promise, () -> {
      JSONObject json = DreamKeyUpdateStore.get(getReactApplicationContext()).state();
      WritableMap result = Arguments.createMap();
      for (Iterator<String> keys = json.keys(); keys.hasNext();) {
        String key = keys.next();
        Object value = json.get(key);
        if (value instanceof Boolean) result.putBoolean(key, (Boolean) value);
        else if (value instanceof Number) result.putDouble(key, ((Number) value).doubleValue());
        else result.putString(key, String.valueOf(value));
      }
      promise.resolve(result);
    });
  }

  @ReactMethod public void downloadApk(String url, String appVersion, Promise promise) {
    mutation("E_UPDATE_APK", promise, store -> {
      store.downloadApk(url, appVersion, (received, total) -> progress("apk", received, total));
      promise.resolve(null);
    });
  }

  @ReactMethod public void stageBundle(String url, String appVersion, double bundleVersion, Promise promise) {
    if (!Double.isFinite(bundleVersion) || bundleVersion != Math.rint(bundleVersion)
        || bundleVersion <= 0 || bundleVersion > Integer.MAX_VALUE) {
      promise.reject("E_UPDATE_BUNDLE", "Invalid update bundle version");
      return;
    }
    mutation("E_UPDATE_BUNDLE", promise, store -> {
      store.stage(url, appVersion, (int) bundleVersion,
          (received, total) -> progress("bundle", received, total));
      promise.resolve(null);
    });
  }

  @ReactMethod public void markLaunchSuccessful(Promise promise) {
    execute("E_UPDATE_CONFIRM", promise, () -> {
      DreamKeyUpdateStore.get(getReactApplicationContext()).confirm();
      promise.resolve(null);
    });
  }

  @ReactMethod public void acknowledgeRollback(Promise promise) {
    execute("E_UPDATE_STATE", promise, () -> {
      DreamKeyUpdateStore.get(getReactApplicationContext()).acknowledgeRollback();
      promise.resolve(null);
    });
  }

  @ReactMethod public void installApk(Promise promise) {
    execute("E_UPDATE_INSTALL", promise, () -> {
      DreamKeyUpdateStore store = DreamKeyUpdateStore.get(getReactApplicationContext());
      // Revalidate the cached APK before entering UI work.
      android.content.Intent install = store.installIntent();
      UiThreadUtil.runOnUiThread(() -> {
        try {
          if (invalidated) throw new IllegalStateException("Update screen is unavailable");
          if (!store.canInstall()) {
            getReactApplicationContext().startActivity(store.installationPermissionIntent());
            promise.reject("E_INSTALL_PERMISSION", "Allow installation from DreamKey, then tap install again");
            return;
          }
          getReactApplicationContext().startActivity(install);
          promise.resolve(null);
        } catch (Exception exception) {
          promise.reject("E_UPDATE_INSTALL", "Unable to open the Android installer", exception);
        }
      });
    });
  }

  @ReactMethod public void addListener(String eventName) { /* RN NativeEventEmitter contract. */ }
  @ReactMethod public void removeListeners(double count) { /* RN NativeEventEmitter contract. */ }

  private void progress(String kind, long received, long total) {
    if (invalidated || !getReactApplicationContext().hasActiveReactInstance()) return;
    WritableMap payload = Arguments.createMap();
    payload.putString("kind", kind);
    payload.putDouble("received", received);
    payload.putDouble("total", Math.max(0, total));
    getReactApplicationContext().getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class)
        .emit("DreamKeyUpdateProgress", payload);
  }

  private interface Operation { void run() throws Exception; }
  private interface Mutation { void run(DreamKeyUpdateStore store) throws Exception; }

  private void execute(String code, Promise promise, Operation task) {
    try {
      controlExecutor.execute(() -> {
        controlWorker = Thread.currentThread();
        try {
          if (invalidated) throw new IllegalStateException("Updates are unavailable");
          task.run();
        } catch (Exception exception) {
          reject(promise, code, exception);
        } finally { controlWorker = null; }
      });
    } catch (RejectedExecutionException exception) {
      promise.reject("E_UPDATE_UNAVAILABLE", "Updates are unavailable", exception);
    }
  }

  private void mutation(String code, Promise promise, Mutation task) {
    final DreamKeyUpdateStore store;
    try { store = DreamKeyUpdateStore.get(getReactApplicationContext()); }
    catch (Exception exception) { promise.reject(code, "Update storage is unavailable", exception); return; }
    // Claim synchronously, rather than queueing another operation behind a long download.
    if (!store.busy.compareAndSet(false, true)) {
      promise.reject("E_UPDATE_BUSY", "Another update is already in progress");
      return;
    }
    try {
      executor.execute(() -> {
        worker = Thread.currentThread();
        try {
          if (invalidated) throw new IllegalStateException("Updates are unavailable");
          task.run(store);
        } catch (Exception exception) {
          reject(promise, code, exception);
        } finally { worker = null; store.busy.set(false); }
      });
    } catch (RejectedExecutionException exception) {
      store.busy.set(false);
      promise.reject("E_UPDATE_UNAVAILABLE", "Updates are unavailable", exception);
    }
  }

  @Override public void invalidate() {
    invalidated = true;
    Thread running = worker;
    if (running != null) running.interrupt();
    Thread control = controlWorker;
    if (control != null) control.interrupt();
    // Drain queued work so its finally block can release the process-wide task
    // lock; shutdownNow would silently discard a queued mutation and strand it.
    executor.shutdown();
    controlExecutor.shutdown();
    super.invalidate();
  }

  private static void reject(Promise promise, String fallback, Exception exception) {
    String code = exception instanceof DreamKeyUpdateException
        ? ((DreamKeyUpdateException) exception).code : fallback;
    promise.reject(code, exception.getMessage() == null ? "Update failed" : exception.getMessage(), exception);
  }
}
