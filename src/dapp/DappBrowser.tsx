import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
} from 'react';
import { ActivityIndicator, Platform, StyleSheet, Text, UIManager, View, type StyleProp, type ViewStyle } from 'react-native';
import { WebView,
  type WebViewMessageEvent,
  type WebViewNavigation,
  type WebViewProps,
} from 'react-native-webview';
import {
  createPageMetadataScript,
  createProviderEventScript,
  createProviderReadyScript,
  createProviderResponseScript,
  EIP1193_INJECTED_SCRIPT,
  parseBridgeMessage,
  providerError,
} from './providerBridge.js';
import { evaluateDappUrl } from './urlPolicy.js';
import { DappErrorPage, websiteHost } from './DappErrorPage.js';
import type {
  DappBrowserProps as BaseDappBrowserProps,
  DappBrowserRef,
  Eip1193RequestArguments,
  ProviderRequestContext,
  DappLoadError,
  DappNavigationState,
} from './types.js';

export type DappBrowserProps = Omit<BaseDappBrowserProps, 'style' | 'webViewProps'> & {
  style?: StyleProp<ViewStyle>;
  webViewProps?: Omit<WebViewProps, 'source' | 'onMessage' | 'injectedJavaScriptBeforeContentLoaded'>;
};

/**
 * Standalone DApp browser for a React Native CLI app.
 *
 * It owns navigation policy and the WebView bridge, but deliberately does not
 * implement wallet storage, RPC, signing, or permissions. Supply `provider` or
 * `onProviderRequest` from the wallet layer so every request can be authorized
 * against the current origin before it reaches the signer.
 */
export const DappBrowser = forwardRef<DappBrowserRef, DappBrowserProps>(function DappBrowser(
  {
    initialUrl,
    provider,
    onProviderRequest,
    onNavigationBlocked,
    onProviderError,
    onPageLoaded,
    onPageMetadata,
    onNavigationStateChange: onBrowserNavigation,
    onLoadError,
    onBack,
    onEditUrl,
    language = 'zh',
    allowedHosts,
    allowHttp = false,
    allowLocalhost = false,
    style,
    webViewProps,
  },
  ref,
) {
  const webViewRef = useRef<WebView>(null);
  const nativeWebViewConfig = UIManager?.getViewManagerConfig?.('RNCWebView') as { Constants?: { walletBridgeSecure?: boolean } } | undefined;
  const secureBridgeSupported = Platform?.OS !== 'android' ||
    nativeWebViewConfig?.Constants?.walletBridgeSecure === true;
  const currentUrlRef = useRef(initialUrl);
  const documentRef = useRef(0);
  const mountedRef = useRef(true);
  const [loadError, setLoadError] = React.useState<DappLoadError | null>(null);
  const loadErrorRef = useRef<DappLoadError | null>(null);
  const [sourceUrl, setSourceUrl] = React.useState(initialUrl);
  const [webViewKey, setWebViewKey] = React.useState(0);
  const attemptRef = useRef(0);
  const initialUrlRef = useRef(initialUrl);
  const awaitingLoadStartRef = useRef(false);
  const navigationRef = useRef<DappNavigationState>({ url: initialUrl, title: '', loading: true, canGoBack: false, canGoForward: false });
  const publishNavigation = useCallback((state: DappNavigationState) => {
    navigationRef.current = state;
    onBrowserNavigation?.(state);
  }, [onBrowserNavigation]);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; documentRef.current += 1; };
  }, []);
  const policy = useMemo(
    () => ({ allowedHosts, allowHttp, allowLocalhost }),
    [allowedHosts, allowHttp, allowLocalhost],
  );
  const sourceDecision = useMemo(() => evaluateDappUrl(sourceUrl, policy), [sourceUrl, policy]);

  const startAttempt = useCallback((url: string) => {
    documentRef.current += 1;
    awaitingLoadStartRef.current = false;
    attemptRef.current += 1;
    currentUrlRef.current = url;
    loadErrorRef.current = null;
    setLoadError(null);
    setSourceUrl(url);
    setWebViewKey(attemptRef.current);
    publishNavigation({ url, title: '', loading: true, canGoBack: false, canGoForward: false });
  }, [publishNavigation]);

  const resumeNavigation = useCallback((waitForLoadStart = true) => {
    documentRef.current += 1;
    awaitingLoadStartRef.current = waitForLoadStart;
    loadErrorRef.current = null;
    setLoadError(null);
    publishNavigation({ ...navigationRef.current, loading: true });
  }, [publishNavigation]);

  useEffect(() => {
    if (initialUrlRef.current !== initialUrl) {
      initialUrlRef.current = initialUrl;
      startAttempt(initialUrl);
    }
  }, [initialUrl, startAttempt]);

  const retry = useCallback(() => {
    const target = loadErrorRef.current?.url || currentUrlRef.current || sourceUrl;
    const decision = evaluateDappUrl(target, policy);
    if (!decision.allowed || !decision.url) return;
    if (!webViewRef.current) startAttempt(decision.url);
    else {
      resumeNavigation();
      webViewRef.current.reload();
    }
  }, [policy, resumeNavigation, sourceUrl, startAttempt]);

  const block = useCallback(
    (url: string, reason: string) => {
      onNavigationBlocked?.(url, reason);
    },
    [onNavigationBlocked],
  );

  const navigate = useCallback(
    (url: string) => {
      const decision = evaluateDappUrl(url, policy);
      if (!decision.allowed || !decision.url) {
        block(url, decision.reason ?? 'Navigation blocked');
        return false;
      }
      if (!webViewRef.current) {
        startAttempt(decision.url);
        return true;
      }
      if (loadErrorRef.current) {
        // A failed native document may not execute injected JS. Reload its
        // actual URL, or explicitly start the corrected address in a new view.
        // Comparing against sourceUrl would reload the wrong page after a
        // redirect back to the initial source address.
        if (loadErrorRef.current.url === decision.url) retry();
        else startAttempt(decision.url);
        return true;
      }
      // WebView navigation is driven through JS to avoid changing the `source`
      // prop on every request and to preserve browser history semantics.
      resumeNavigation();
      webViewRef.current?.injectJavaScript(
        `window.location.href = ${JSON.stringify(decision.url).replace(/</g, '\\u003c')}; true;`,
      );
      return true;
    },
    [block, policy, resumeNavigation, retry, startAttempt],
  );

  useImperativeHandle(
    ref,
    () => ({
      reload: retry,
      goBack: () => {
        if (!navigationRef.current.canGoBack || !webViewRef.current) return;
        resumeNavigation(false);
        webViewRef.current.goBack();
      },
      goForward: () => {
        if (!navigationRef.current.canGoForward || !webViewRef.current) return;
        resumeNavigation(false);
        webViewRef.current.goForward();
      },
      navigate,
      emit: (event: string, params: unknown) => {
        webViewRef.current?.injectJavaScript(createProviderEventScript(event, params));
      },
    }),
    [navigate, resumeNavigation, retry],
  );

  const handleProviderRequest = useCallback(
    async (id: string, request: Eip1193RequestArguments, pageUrl: string, documentId?: string) => {
      const document = documentRef.current;
      const attempt = attemptRef.current;
      const sameCurrentOrigin = () => {
        try { return new URL(currentUrlRef.current).origin === new URL(pageUrl).origin; }
        catch { return false; }
      };
      const canRespond = () => mountedRef.current && attemptRef.current === attempt && !loadErrorRef.current && sameCurrentOrigin() &&
        // Android can report load-start after an early request, and also for
        // same-document history updates. Tagged responses are checked against
        // the actual JS document by the injected receiver instead.
        (documentId !== undefined || (!awaitingLoadStartRef.current && documentRef.current === document));
      const origin = (() => {
        try {
          return new URL(pageUrl).origin;
        } catch {
          return '';
        }
      })();
      const context: ProviderRequestContext = { origin, url: pageUrl };
      try {
        if (!onProviderRequest && !provider) {
          throw Object.assign(new Error('No EIP-1193 provider is configured'), { code: 4900 });
        }
        const result = onProviderRequest
          ? await onProviderRequest(request, context)
          : await provider!.request(request);
        if (!canRespond()) return;
        webViewRef.current?.injectJavaScript(
          createProviderResponseScript({ type: 'wallet:provider-response', id, documentId, ok: true, result }),
        );
      } catch (error) {
        if (!canRespond()) return;
        onProviderError?.(error, request);
        webViewRef.current?.injectJavaScript(
          createProviderResponseScript({
            type: 'wallet:provider-response',
            id,
            documentId,
            ok: false,
            error: providerError(error),
          }),
        );
      }
    },
    [onProviderError, onProviderRequest, provider],
  );

  const onMessage = useCallback(
    (event: WebViewMessageEvent) => {
      if (loadErrorRef.current || awaitingLoadStartRef.current || webViewKey !== attemptRef.current) return;
      const message = parseBridgeMessage(event.nativeEvent.data);
      if (!message) return;
      // The native URL is the authority for origin checks. The URL included by
      // page JavaScript is intentionally ignored for authorization decisions.
      const pageUrl = event.nativeEvent.url || currentUrlRef.current;
      if (!evaluateDappUrl(pageUrl, policy).allowed) return;
      try {
        // iOS reports the sending frame's URL. A cross-origin iframe must
        // neither authorize requests nor receive replies in the main document.
        if (new URL(pageUrl).origin !== new URL(currentUrlRef.current).origin) return;
      } catch { return; }
      if (message.type === 'wallet:provider-ready') {
        // The page retries this read-only handshake if native navigation is
        // still catching up. User requests stay queued until this ack arrives.
        webViewRef.current?.injectJavaScript(createProviderReadyScript(message.documentId));
      } else if (message.type === 'wallet:provider-request') {
        void handleProviderRequest(message.id, message.request, pageUrl, message.documentId);
      } else if (message.type === 'wallet:page-metadata') {
        // Ignore metadata from a document that was replaced while the message
        // was in flight. The page's own URL is never used for authorization.
        try {
          const nativeUrl = new URL(pageUrl);
          const declaredUrl = new URL(message.url);
          nativeUrl.hash = ''; declaredUrl.hash = '';
          if (nativeUrl.toString() !== declaredUrl.toString()) return;
          const icon = message.faviconUrl ? new URL(message.faviconUrl, pageUrl) : undefined;
          const faviconUrl = icon && (icon.protocol === 'https:' || (allowHttp && icon.protocol === 'http:')) && !icon.username && !icon.password
            ? icon.toString() : undefined;
          onPageMetadata?.({ url: pageUrl, title: message.title, faviconUrl });
        } catch { /* Malformed page metadata falls back to the origin icon. */ }
      }
    },
    [allowHttp, handleProviderRequest, onPageMetadata, policy, webViewKey],
  );

  const onNavigationStateChange = useCallback(
    (navigation: WebViewNavigation) => {
      if (loadErrorRef.current || webViewKey !== attemptRef.current || !navigation.url) return;
      const decision = evaluateDappUrl(navigation.url, policy);
      if (!decision.allowed) {
        block(navigation.url, decision.reason ?? 'Navigation blocked');
        return;
      }
      if (awaitingLoadStartRef.current) {
        const previous = navigationRef.current;
        // Hash changes and History API navigation can complete without a
        // native load-start event. An actual URL/history change is sufficient.
        const historyChanged = navigation.url !== previous.url || navigation.canGoBack !== previous.canGoBack || navigation.canGoForward !== previous.canGoForward;
        if (!navigation.loading && !historyChanged) return;
        awaitingLoadStartRef.current = false;
      }
      currentUrlRef.current = navigation.url;
      publishNavigation({ url: navigation.url, title: navigation.title, loading: navigation.loading, canGoBack: navigation.canGoBack, canGoForward: navigation.canGoForward });
      onPageLoaded?.(navigation.url);
    },
    [block, onPageLoaded, policy, publishNavigation, webViewKey],
  );

  const handleLoadStart = useCallback((event: Parameters<NonNullable<WebViewProps['onLoadStart']>>[0]) => {
    if (loadErrorRef.current || webViewKey !== attemptRef.current) return;
    awaitingLoadStartRef.current = false;
    documentRef.current += 1;
    const url = event.nativeEvent.url;
    if (url && evaluateDappUrl(url, policy).allowed) currentUrlRef.current = url;
    webViewProps?.onLoadStart?.(event);
  }, [policy, webViewProps, webViewKey]);

  const handleLoad = useCallback((event: Parameters<NonNullable<WebViewProps['onLoad']>>[0]) => {
    // Android and iOS may deliver a finish event after an HTTP failure. Only
    // an explicit new attempt clears the error; a late finish cannot dismiss it.
    if (loadErrorRef.current || awaitingLoadStartRef.current || webViewKey !== attemptRef.current) return;
    // Ask the document for its declared rel=icon after scripts and head
    // elements are available. This covers relative/cache-busted hrefs.
    webViewRef.current?.injectJavaScript(createPageMetadataScript());
    webViewProps?.onLoad?.(event);
  }, [webViewProps, webViewKey]);

  const failAttempt = useCallback((failure: DappLoadError, history: Pick<DappNavigationState, 'canGoBack' | 'canGoForward' | 'title'>) => {
    if (!mountedRef.current || loadErrorRef.current || awaitingLoadStartRef.current || webViewKey !== attemptRef.current) return;
    documentRef.current += 1;
    loadErrorRef.current = failure;
    setLoadError(failure);
    publishNavigation({ ...navigationRef.current, ...history, url: failure.url, loading: false });
    onLoadError?.(failure);
  }, [onLoadError, publishNavigation, webViewKey]);

  const handleError = useCallback((event: Parameters<NonNullable<WebViewProps['onError']>>[0]) => {
    // WebViewShared otherwise renders its white defaultRenderError component,
    // including the Android-only undefined domain and internal error strings.
    event.preventDefault();
    const native = event.nativeEvent;
    const decision = evaluateDappUrl(native.url || '', policy);
    const failure: DappLoadError = {
      url: decision.allowed && decision.url ? decision.url : currentUrlRef.current,
      code: native.code,
      message: native.description || 'The page could not be loaded.',
      kind: 'network',
    };
    failAttempt(failure, native);
    webViewProps?.onError?.(event);
  }, [failAttempt, policy, webViewProps]);

  const handleHttpError = useCallback((event: Parameters<NonNullable<WebViewProps['onHttpError']>>[0]) => {
    const native = event.nativeEvent;
    // HTTP errors also arrive for images, scripts, and other subresources. Only
    // replace the browser with an error view for the document currently open.
    if (native.url && native.url.split('#')[0] !== currentUrlRef.current.split('#')[0]) {
      webViewProps?.onHttpError?.(event);
      return;
    }
    if (native.statusCode < 400) {
      webViewProps?.onHttpError?.(event);
      return;
    }
    const failure: DappLoadError = {
      url: native.url || currentUrlRef.current,
      code: native.statusCode,
      message: native.description || `HTTP ${native.statusCode}`,
      kind: 'http',
    };
    failAttempt(failure, native);
    webViewProps?.onHttpError?.(event);
  }, [failAttempt, webViewProps]);

  const onShouldStartLoadWithRequest = useCallback(
    (request: { url: string }) => {
      const decision = evaluateDappUrl(request.url, policy);
      if (!decision.allowed) {
        block(request.url, decision.reason ?? 'Navigation blocked');
        return false;
      }
      return true;
    },
    [block, policy],
  );

  if (!sourceDecision.allowed || !sourceDecision.url) {
    return (
      <View style={[styles.container, style]}>
        <DappErrorPage url={sourceUrl} language={language} invalid onEditUrl={onEditUrl} onBack={onBack} />
      </View>
    );
  }

  return (
    <View style={[styles.container, style]}>
      {!secureBridgeSupported ? <View accessibilityRole="alert" style={styles.bridgeWarning}><Text style={styles.bridgeWarningText}>{language === 'zh' ? '当前 Android System WebView 不支持安全的钱包连接，请更新系统 WebView 后使用连接和签名。网页仍可浏览。' : 'Update Android System WebView to connect your wallet and sign securely. You can still browse websites.'}</Text></View> : null}
      <View style={styles.container} pointerEvents={loadError ? 'none' : 'auto'} accessibilityElementsHidden={Boolean(loadError)} importantForAccessibility={loadError ? 'no-hide-descendants' : 'auto'}>
        <WebView
          key={webViewKey}
          {...webViewProps}
          ref={webViewRef}
          source={{ uri: sourceDecision.url }}
          javaScriptEnabled
          allowFileAccess={false}
          allowFileAccessFromFileURLs={false}
          allowUniversalAccessFromFileURLs={false}
          mixedContentMode="never"
          webviewDebuggingEnabled={false}
          domStorageEnabled
          thirdPartyCookiesEnabled
          sharedCookiesEnabled
          setSupportMultipleWindows={false}
          originWhitelist={allowHttp ? ['https://*', 'http://*'] : ['https://*']}
          injectedJavaScriptBeforeContentLoaded={EIP1193_INJECTED_SCRIPT}
          // Resume the same provider if the transport/host wasn't ready at
          // document-start; preserve pending requests and provider identity.
          injectedJavaScript={EIP1193_INJECTED_SCRIPT}
          onMessage={onMessage}
          onLoadStart={handleLoadStart}
          onLoad={handleLoad}
          onError={handleError}
          onHttpError={handleHttpError}
          onShouldStartLoadWithRequest={onShouldStartLoadWithRequest}
          onNavigationStateChange={onNavigationStateChange}
          renderError={(_domain, code, description) => (
            <DappErrorPage error={loadErrorRef.current ?? { url: currentUrlRef.current, code, message: description, kind: 'network' }} url={currentUrlRef.current} language={language} onRetry={retry} onEditUrl={onEditUrl} onBack={onBack} />
          )}
          renderLoading={() => (
            <View style={styles.loading}>
              <ActivityIndicator color="#b6a7ff" size="large" />
              <Text style={styles.loadingTitle}>{language === 'zh' ? '正在打开网页' : 'Opening website'}</Text>
              <Text style={styles.loadingHost}>{websiteHost(currentUrlRef.current)}</Text>
            </View>
          )}
          startInLoadingState
        />
      </View>
      {loadError ? <View style={styles.errorOverlay}><DappErrorPage error={loadError} url={loadError.url} language={language} onRetry={retry} onEditUrl={onEditUrl} onBack={onBack} /></View> : null}
    </View>
  );
});

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0c1224' },
  bridgeWarning: { paddingHorizontal: 16, paddingVertical: 12, backgroundColor: '#3a2b15' },
  bridgeWarningText: { color: '#ffdb99', fontSize: 12, lineHeight: 19 },
  errorOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: '#0c1224' },
  loading: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', backgroundColor: '#0c1224', padding: 28 },
  loadingTitle: { color: '#cbd2e3', fontSize: 15, fontWeight: '600', marginTop: 18 },
  loadingHost: { color: '#8290ae', fontSize: 12, marginTop: 8 },
});

DappBrowser.displayName = 'DappBrowser';
