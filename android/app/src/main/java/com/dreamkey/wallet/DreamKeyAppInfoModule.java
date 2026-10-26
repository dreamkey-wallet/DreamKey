package com.dreamkey.wallet;

import android.content.pm.PackageManager;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import java.util.Collections;
import java.util.Map;

/** Exposes the version of the installed application to React Native. */
public final class DreamKeyAppInfoModule extends ReactContextBaseJavaModule {
  DreamKeyAppInfoModule(ReactApplicationContext context) {
    super(context);
  }

  @Override
  public String getName() {
    return "DreamKeyAppInfo";
  }

  @Override
  public Map<String, Object> getConstants() {
    ReactApplicationContext context = getReactApplicationContext();
    String versionName = "";
    try {
      versionName = context.getPackageManager()
          .getPackageInfo(context.getPackageName(), 0).versionName;
    } catch (PackageManager.NameNotFoundException ignored) {
      // Leave the version unavailable rather than displaying a hardcoded value.
    }
    return Collections.singletonMap("versionName", versionName == null ? "" : versionName);
  }
}
