package com.dreamkey.wallet;

import android.net.Uri;
import android.webkit.WebView;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.ScriptHandler;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import com.facebook.react.uimanager.annotations.ReactProp;
import com.facebook.react.uimanager.ThemedReactContext;
import com.reactnativecommunity.webview.RNCWebView;
import com.reactnativecommunity.webview.RNCWebViewManager;
import com.reactnativecommunity.webview.RNCWebViewWrapper;

import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.HashMap;
import java.util.Map;
import java.util.Objects;

/** Installs the wallet provider before website scripts run on supported Android WebViews. */
public final class DreamKeyWebViewManager extends RNCWebViewManager {
    /** The legacy addJavascriptInterface cannot identify an iframe's origin. */
    private static final class WalletWebView extends RNCWebView {
        WalletWebView(ThemedReactContext context) {
            super(context);
        }

        @Override
        protected void createRNCWebViewBridge(RNCWebView view) {
            // Never install the upstream all-frame JavascriptInterface fallback.
            // Browsing still works; the React surface explains how to update.
            if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)
                    || bridgeListener != null) return;
            bridgeListener = new WebViewCompat.WebMessageListener() {
                @Override
                public void onPostMessage(@NonNull WebView sender,
                        @NonNull WebMessageCompat message, @NonNull Uri sourceOrigin,
                        boolean isMainFrame, @NonNull JavaScriptReplyProxy replyProxy) {
                    if (!isMainFrame || message.getType() != WebMessageCompat.TYPE_STRING) return;
                    String body = message.getData();
                    if (body == null || body.length() > 262144) return;
                    // Resolve the current URL on the UI thread, rather than trusting
                    // a URL declared by JavaScript or a stale top-level navigation.
                    sender.post(() -> {
                        String currentUrl = getUrl();
                        if (!getMessagingEnabled() || !sameSecureOrigin(sourceOrigin, currentUrl)) return;
                        WalletWebView.this.onMessage(body, currentUrl);
                    });
                }
            };
            WebViewCompat.addWebMessageListener(view, JAVASCRIPT_INTERFACE,
                    Collections.singleton("*"), bridgeListener);
        }

        private static boolean sameSecureOrigin(Uri source, @Nullable String currentUrl) {
            if (currentUrl == null) return false;
            Uri current = Uri.parse(currentUrl);
            return "https".equalsIgnoreCase(source.getScheme())
                    && "https".equalsIgnoreCase(current.getScheme())
                    && source.getUserInfo() == null && current.getUserInfo() == null
                    && source.getHost() != null && current.getHost() != null
                    && source.getHost().equalsIgnoreCase(current.getHost())
                    && effectivePort(source) == effectivePort(current);
        }

        private static int effectivePort(Uri uri) {
            return uri.getPort() == -1 ? 443 : uri.getPort();
        }
    }

    @Override
    public RNCWebViewWrapper createViewInstance(ThemedReactContext context) {
        return super.createViewInstance(context, new WalletWebView(context));
    }

    @Override
    public Map<String, Object> getExportedViewConstants() {
        Map<String, Object> constants = new HashMap<>();
        Map<String, Object> inherited = super.getExportedViewConstants();
        if (inherited != null) constants.putAll(inherited);
        constants.put("walletBridgeSecure", WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER));
        return constants;
    }

    private static final class DocumentScript {
        @Nullable String source;
        @Nullable String installedSource;
        @Nullable ScriptHandler handler;
    }

    private final Map<RNCWebViewWrapper, DocumentScript> documentScripts = new IdentityHashMap<>();

    @Override
    @ReactProp(name = "injectedJavaScriptBeforeContentLoaded")
    public void setInjectedJavaScriptBeforeContentLoaded(RNCWebViewWrapper view, @Nullable String value) {
        // Keep the upstream onPageStarted fallback for WebViews without DOCUMENT_START_SCRIPT.
        super.setInjectedJavaScriptBeforeContentLoaded(view, value);
        DocumentScript script = documentScripts.get(view);
        if (script == null) {
            script = new DocumentScript();
            documentScripts.put(view, script);
        }
        script.source = value;
    }

    @Override
    protected void onAfterUpdateTransaction(@NonNull RNCWebViewWrapper view) {
        DocumentScript script = documentScripts.get(view);
        if (script != null && !Objects.equals(script.source, script.installedSource)) {
            removeScript(script);
            if (script.source != null && !script.source.isEmpty()) {
                // AndroidX requires '*' to match arbitrary website hosts. Restrict execution to
                // HTTPS top-level documents; React Native still checks the native URL for every
                // request. HTTP development pages retain the upstream injection fallback.
                String mainDocumentScript = "(function () {"
                        + "if (window.top !== window || window.location.protocol !== 'https:') return;\n"
                        + script.source + "\n})();";
                if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
                    script.handler = WebViewCompat.addDocumentStartJavaScript(
                            view.getWebView(), mainDocumentScript, Collections.singleton("*"));
                    script.installedSource = script.source;
                }
            }
        }
        // The upstream manager loads its pending source here. Register first so initial page
        // scripts cannot observe a missing provider regardless of React prop update order.
        super.onAfterUpdateTransaction(view);
    }

    @Override
    public void onDropViewInstance(@NonNull RNCWebViewWrapper view) {
        DocumentScript script = documentScripts.remove(view);
        if (script != null) removeScript(script);
        super.onDropViewInstance(view);
    }

    private static void removeScript(DocumentScript script) {
        if (script.handler != null && WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            script.handler.remove();
            script.handler = null;
        }
        script.installedSource = null;
    }
}
