/** Public types for the standalone dApp browser module. */

export interface Eip1193RequestArguments {
  method: string;
  params?: unknown[] | Record<string, unknown>;
}

export interface Eip1193Provider {
  request(args: Eip1193RequestArguments): Promise<unknown>;
}

export interface ProviderRequestContext {
  /** Origin of the page that initiated the request. */
  origin: string;
  /** Full URL currently loaded in the WebView. */
  url: string;
}

export type ProviderRequestHandler = (
  request: Eip1193RequestArguments,
  context: ProviderRequestContext,
) => Promise<unknown>;

export interface DappBrowserRef {
  reload(): void;
  goBack(): void;
  goForward(): void;
  navigate(url: string): boolean;
  /** Deliver an EIP-1193 event to the page (for example accountsChanged). */
  emit(event: string, params: unknown): void;
}

/** The current native WebView history and loading state. */
export interface DappNavigationState {
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

/** Metadata declared by the currently loaded HTML document. */
export interface DappPageMetadata {
  url: string;
  title?: string;
  faviconUrl?: string;
}

export interface DappLoadError {
  /** URL that failed to load, when the WebView supplied one. */
  url: string;
  /** Native WebView error code, or the HTTP status code for an HTTP error. */
  code: number;
  /** Human-readable native error description, when available. */
  message: string;
  kind: 'network' | 'http';
}

export type DappHostPattern = string | RegExp;

export interface DappUrlPolicyOptions {
  /** Exact host names or patterns such as *.example.com. */
  allowedHosts?: readonly DappHostPattern[];
  /** Development-only opt-in. HTTPS is required by default. */
  allowHttp?: boolean;
  /** Development-only opt-in for localhost/loopback addresses. */
  allowLocalhost?: boolean;
}

export interface DappBrowserProps extends DappUrlPolicyOptions {
  initialUrl: string;
  /** A provider whose request method is used when onProviderRequest is absent. */
  provider?: Eip1193Provider;
  /** Use this to enforce origin/permission checks before forwarding to the provider. */
  onProviderRequest?: ProviderRequestHandler;
  onNavigationBlocked?: (url: string, reason: string) => void;
  onProviderError?: (error: unknown, request: Eip1193RequestArguments) => void;
  onPageLoaded?: (url: string) => void;
  /** Called after a document exposes its title and rel=icon metadata. */
  onPageMetadata?: (metadata: DappPageMetadata) => void;
  onNavigationStateChange?: (state: DappNavigationState) => void;
  /** Called when the page cannot be loaded. The browser also renders a retry view. */
  onLoadError?: (error: DappLoadError) => void;
  /** Language used by browser loading and error pages. */
  language?: 'zh' | 'en';
  /** Return to the host's DApp landing page. */
  onBack?: () => void;
  /** Focus the host's address field to correct a failed URL. */
  onEditUrl?: () => void;
  style?: unknown;
  webViewProps?: Record<string, unknown>;
}

export interface DappUrlDecision {
  allowed: boolean;
  url?: string;
  origin?: string;
  reason?: string;
}
