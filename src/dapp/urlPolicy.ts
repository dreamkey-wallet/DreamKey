import type { DappUrlDecision, DappUrlPolicyOptions, DappHostPattern } from './types.js';

const BLOCKED_PROTOCOLS = new Set([
  'javascript:',
  'data:',
  'file:',
  'about:',
  'chrome:',
  'chrome-extension:',
  'moz-extension:',
  'intent:',
  'blob:',
  'ftp:',
]);

function isLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (host.includes(':')) {
    const ipv6 = host.replace(/^\[|\]$/g, '');
    // The public global-unicast allocation is 2000::/3. This also excludes
    // IPv4-mapped loopback/private addresses, ULA, link-local and multicast.
    return !/^[23][0-9a-f]{3}:/.test(ipv6) || ipv6.startsWith('2001:db8:');
  }
  const ipv4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (ipv4) {
    const [, a, b] = ipv4.map(Number);
    if (a === 0 || a === 127 || a === 10 || a >= 224 ||
        (a === 100 && b >= 64 && b <= 127) ||
        (a === 169 && b === 254) || (a === 192 && b === 168) ||
        (a === 172 && b >= 16 && b <= 31) || (a === 198 && (b === 18 || b === 19))) return true;
  }
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host === 'localhost.localdomain' ||
    host === '127.0.0.1' ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host === '[::1]' ||
    /^127(?:\.\d{1,3}){3}$/.test(host) ||
    /^10(?:\.\d{1,3}){3}$/.test(host) ||
    /^192\.168(?:\.\d{1,3}){2}$/.test(host) ||
    /^172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}$/.test(host)
  );
}

function patternMatches(hostname: string, pattern: DappHostPattern): boolean {
  if (pattern instanceof RegExp) return pattern.test(hostname);
  const candidate = pattern
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  if (!candidate) return false;
  if (candidate.startsWith('*.')) {
    const suffix = candidate.slice(1);
    return hostname === suffix.slice(1) || hostname.endsWith(suffix);
  }
  return hostname === candidate;
}

/**
 * Validates browser destinations before any navigation. It intentionally only
 * permits web URLs; wallet deep links and native app schemes must be handled by
 * an explicit native deep-link layer instead of a WebView.
 */
export function evaluateDappUrl(
  rawUrl: string,
  options: DappUrlPolicyOptions = {},
): DappUrlDecision {
  if (!rawUrl || typeof rawUrl !== 'string' || rawUrl.length > 4096) {
    return { allowed: false, reason: 'Invalid or oversized URL' };
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { allowed: false, reason: 'Malformed URL' };
  }

  const protocol = parsed.protocol.toLowerCase();
  if (BLOCKED_PROTOCOLS.has(protocol)) {
    return { allowed: false, reason: `Blocked URL scheme: ${protocol}` };
  }
  if (protocol !== 'https:' && !(options.allowHttp && protocol === 'http:')) {
    return { allowed: false, reason: 'Only HTTPS destinations are allowed' };
  }
  if (parsed.username || parsed.password) {
    return { allowed: false, reason: 'Credential-bearing URLs are blocked' };
  }

  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (!hostname) return { allowed: false, reason: 'Missing hostname' };
  if (!options.allowLocalhost && isLocalHost(hostname)) {
    return { allowed: false, reason: 'Local and private destinations are blocked' };
  }

  if (options.allowedHosts?.length) {
    const matches = options.allowedHosts.some((pattern) => patternMatches(hostname, pattern));
    if (!matches) return { allowed: false, reason: 'Destination is outside the DApp allowlist' };
  }

  const normalized = parsed.toString();
  return { allowed: true, url: normalized, origin: parsed.origin };
}

export function isAllowedDappUrl(rawUrl: string, options: DappUrlPolicyOptions = {}): boolean {
  return evaluateDappUrl(rawUrl, options).allowed;
}

