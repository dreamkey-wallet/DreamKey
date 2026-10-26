# Standalone DApp browser (React Native CLI)

This module is an independent React Native WebView shell. It does not copy MetaMask code and has no dependency on Infura, Firebase, MetaMask services, package names, or branding.

## Install

```sh
npm install react-native-webview
```

For iOS, install CocoaPods after adding the package:

```sh
cd ios && pod install
```

## Usage

```tsx
import { DappBrowser } from './src/dapp';

<DappBrowser
  initialUrl="https://app.example.com"
  allowedHosts={['app.example.com', '*.example.com']}
  onProviderRequest={async (request, context) => {
    // Ask the wallet permission manager first. `context.origin` is the
    // origin captured by native navigation state, not a page supplied value.
    return walletProvider.request(request, context);
  }}
/>
```

The host application owns key storage, signing, RPC endpoints, account/network state, and permission prompts. The browser only forwards requests after the host callback returns. If a callback is not supplied, pass an object implementing `request(args)` through `provider`.

The injected page bridge exposes `window.ethereum.request`, `on`, `once`, and `removeListener`. Native code can emit events through a `DappBrowserRef`, for example `ref.current?.emit('accountsChanged', [address])` or `chainChanged` with a hex chain id.

On iOS the provider installs with a document-start `WKUserScript`. Android uses the app-owned `DreamKeyWebViewManager` and AndroidX WebKit's `DOCUMENT_START_SCRIPT` when supported by the installed system WebView. Older Android WebViews retain the before-content and after-load fallback; updating Android System WebView improves first-load wallet detection on these devices. The manager registers the script before loading the source and removes it when the native view is dropped. Keep `DreamKeyWebViewPackage` registered in `MainApplication` when reusing this module in another Android app.

The Android wallet transport requires `WEB_MESSAGE_LISTENER`: native code accepts only main-frame messages whose HTTPS source origin matches the current document. It deliberately never installs the legacy all-frame `addJavascriptInterface` transport, because it attributes an iframe's requests to its parent. Devices without the secure transport can browse and see an update notice, but cannot connect or sign until Android System WebView is updated. The `walletBridgeSecure` view-manager constant exposes this capability to the browser UI.

Installation and transport readiness are separate: requests made during page startup wait for a native ready acknowledgment before being sent. Repeated injection resumes initialization without replacing the provider or losing pending requests. Only the internal `eth_chainId` and `eth_accounts` bootstrap reads retry on failure or timeout; signing and transaction requests are sent once and wait for the user's decision. `ethereum#initialized`, `_initialized`, and `connect` fire after these initial reads complete. EIP-6963 discovery is available as soon as the provider installs.

## Navigation policy

`evaluateDappUrl` permits HTTPS URLs by default and rejects dangerous schemes (`javascript:`, `data:`, `file:`, `blob:`, extension schemes, and deep-link schemes), credential-bearing URLs, localhost/private-network destinations, and hosts outside `allowedHosts`. `allowHttp` and `allowLocalhost` are explicit development-only opt-ins.

The WebView uses both `onShouldStartLoadWithRequest` and `onNavigationStateChange`; applications should still enforce an allowlist for production DApps and avoid opening arbitrary user supplied URLs.

`onNavigationStateChange` publishes `{ url, title, loading, canGoBack, canGoForward }` from the native WebView. Use these flags to enable browser history controls, and use `DappBrowserRef.navigate(url)` for address submissions so the same WebView retains its history. `goBack()`, `goForward()`, and `reload()` operate on this native instance; changing `initialUrl` explicitly starts a new instance.

The app shell keeps Back, Forward, and Reload in the bottom navigation bar. Its separate Close button sits to the left of the address bar at the top and returns to the DApp landing page.

Loading failures appear as a friendly overlay while the native WebView remains mounted. Retry and history navigation preserve the existing history. Submitting a different address from the error page starts a fresh WebView so navigation also works when the failed native document cannot execute JavaScript. Late finish events cannot dismiss the error, and responses from a previous document are ignored after navigating.

DApp icons use an origin-scoped memory and private file cache. Favorites, recent visits, popular shortcuts, and the address bar reuse saved image bytes across app restarts; a cache miss downloads only the configured icon or `/favicon.ico`, without fetching website HTML. Valid metadata from a visited WebView refreshes the icon, including unchanged icon URLs; download failures keep the previous image. PNG, JPEG, GIF, WebP, SVG, and supported ICO entries are stored as self-contained image data. The cache holds at most 60 origins and 8 MiB on disk; the system may evict it. The native cache modules require rebuilding the app; older builds retain memory caching.

Each installed provider has a document identifier carried by requests and responses. Its receiver ignores responses for other documents, so a late Android load-start or same-document history event cannot discard a valid pending request. This identifier controls response delivery only; permissions continue to use the native event URL as their origin authority.

## Provider boundary

`onProviderRequest` receives `{ method, params }` and `{ origin, url }`. Implement permission checks for methods such as `eth_requestAccounts`, `wallet_switchEthereumChain`, and signing methods in the wallet layer. Return an EIP-1193 compatible error (`code` and `message`) when a request is denied.

The wallet-core adapter rejects signing and connection by default when no approval callback is supplied. Its provider forwards only an explicit list of public read RPC methods; signing requires a local signer and never falls back to a remote account on the RPC node. A site must have a current account grant before it can switch the wallet's network. Transactions accept reviewed scalar fields only, normalize `input` to `data` and JSON-RPC `gas` to ethers `gasLimit`, and reject conflicting aliases, hidden extension fields, and a mismatched chain. EIP-712 requests with a domain chain ID must match the selected network. Signing parameters are detached from the caller and deeply frozen before approval, so approval and signing use the same immutable JSON snapshot even through the standalone in-process API. Chain, connection and account permission are checked again after confirmation.

Run `node scripts/verify-provider-injection.cjs` and `node scripts/verify-dapp-browser.cjs` to check startup readiness, repeated injection, bootstrap recovery, navigation, and document isolation without using live wallet keys or signing transactions.

Run `node scripts/verify-dapp-security.cjs` for offline security-boundary checks, including blocked remote signing/admin methods, absent approval callbacks, exact reviewed gas/calldata, unsupported transaction fields, chain binding, account revocation, and local-network URL restrictions. DNS rebinding and subresource requests require native network-layer controls and are not guaranteed by URL string validation alone.
