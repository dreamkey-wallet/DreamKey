package com.dreamkey.wallet;

import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.uimanager.ViewManager;
import com.reactnativecommunity.webview.RNCWebViewPackage;

import java.util.Collections;
import java.util.List;

/** Preserves the upstream WebView native modules and replaces only its view manager. */
public final class DreamKeyWebViewPackage extends RNCWebViewPackage {
    @Override
    public List<ViewManager> createViewManagers(ReactApplicationContext reactContext) {
        return Collections.singletonList(new DreamKeyWebViewManager());
    }
}
