/**
 * SSRF guard helpers (pure — no node: imports, safe for browser bundles).
 *
 * Prevents outbound fetches from reaching private/loopback/link-local targets
 * (notably the cloud metadata endpoint 169.254.169.254), including via redirect
 * chains and, when a resolver is injected, DNS names that resolve to private IPs.
 *
 * Two layers:
 *  - IP classifiers + isPrivateHost: lexical check on a hostname.
 *  - fetchWithSsrfGuard: a redirect-manual loop that re-checks EVERY hop and
 *    applies Fetch-spec method downgrade so legitimate redirects still work.
 *
 * DNS resolution is injected (opts.resolveIps) so this module has no node:
 * dependency; Node callers pass a node:dns.lookup-backed resolver. When no
 * resolver is provided, only literal hostnames/IPs are checked (static
 * DNS-to-private and DNS-rebinding are NOT blocked — pair with a resolver).
 *
 * Residual TOCTOU: even WITH a resolver,
 * this guard resolves the hostname to check it but then calls `fetch(url)` on
 * the hostname STRING — undici re-resolves DNS independently at connect time,
 * so a TTL-0 rebinding nameserver can return a public IP on the guard's lookup
 * and a private IP (169.254.169.254 / 127.0.0.1) on fetch's lookup, defeating
 * the check. Because the origin string is unchanged, cross-origin credential
 * stripping does not apply, so the caller's Authorization may reach the private
 * target. Closing this fully requires pinning the verified IP across the fetch
 * (a custom undici Agent/connect that reuses the guard's lookup, or fetching
 * against https://<ip>/ with a Host header — note TLS SNI/cert considerations).
 * Until that dispatcher lands, callers in higher-trust contexts (operator-set
 * webhook/automation URLs) should treat the rebinding window as a known residual
 * and prefer operator-allowlisted hosts. The injected-resolver paths (sources
 * api-tools + credential-manager; automations webhook-utils) close the simpler
 * static-DNS-name-to-private-IP bypass; only the rebinding race remains.
 */

// ---------------------------------------------------------------------------
// IP literal classification (mirrors packages/automations/src/webhook-utils.ts
// — kept in sync. Centralized here so automations + sources share one copy.)
// ---------------------------------------------------------------------------

/**
 * Parse a dotted-decimal IPv4 literal into octets, or null if not IPv4.
 * The WHATWG URL parser already normalizes integer/octal/hex host forms
 * (e.g. "http://2130706433/") to dotted decimal, so this covers all literals.
 */
export function parseIPv4(host: string): number[] | null {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }
  return octets;
}

/** Check IPv4 octets against loopback / private / link-local / unspecified ranges */
export function isPrivateIPv4(octets: number[]): boolean {
  const [a = 0, b = 0] = octets;
  if (a === 127) return true; // 127/8 loopback
  if (a === 10) return true; // 10/8 private
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12 private
  if (a === 192 && b === 168) return true; // 192.168/16 private
  if (a === 169 && b === 254) return true; // 169.254/16 link-local (incl. cloud metadata)
  if (a === 0) return true; // 0/8 unspecified / "this network"
  return false;
}

/** Expand an IPv6 literal (without brackets) into 8 16-bit groups, or null if unparseable */
export function expandIPv6(host: string): number[] | null {
  // Strip zone index (e.g. fe80::1%eth0)
  let head = host.split('%')[0] ?? host;

  // Convert an embedded IPv4 tail (e.g. ::ffff:127.0.0.1) into two hex groups
  const tail = head.slice(head.lastIndexOf(':') + 1);
  if (tail.includes('.')) {
    const embedded = parseIPv4(tail);
    if (!embedded) return null;
    const [a = 0, b = 0, c = 0, d = 0] = embedded;
    head = `${head.slice(0, head.lastIndexOf(':') + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }

  const parts = head.split('::');
  if (parts.length > 2) return null;
  const left = parts[0] ? parts[0].split(':') : [];
  const right = parts.length === 2 && parts[1] ? parts[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if (parts.length === 2 ? missing < 0 : left.length !== 8) return null;

  const full = [...left, ...Array(parts.length === 2 ? missing : 0).fill('0'), ...right];
  if (full.length !== 8) return null;

  const groups: number[] = [];
  for (const part of full) {
    if (!/^[0-9a-f]{1,4}$/i.test(part)) return null;
    groups.push(Number.parseInt(part, 16));
  }
  return groups;
}

/** Check IPv6 groups against loopback / link-local / unspecified / IPv4-mapped ranges */
export function isPrivateIPv6(host: string): boolean {
  const groups = expandIPv6(host);
  if (!groups) return true; // unparseable IPv6 literal — fail closed

  const leading = groups.slice(0, 7);
  if (leading.every((g) => g === 0)) {
    if (groups[7] === 0) return true; // :: unspecified
    if (groups[7] === 1) return true; // ::1 loopback
  }
  if (((groups[0] ?? 0) & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  // IPv4-mapped (::ffff:a.b.c.d) — apply the IPv4 ranges to the embedded address
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    const g6 = groups[6] ?? 0;
    const g7 = groups[7] ?? 0;
    return isPrivateIPv4([g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff]);
  }
  return false;
}

/**
 * Whether a hostname (literal IP or localhost name) points at a private,
 * loopback, link-local, or otherwise internal target. Lexical only — does NOT
 * resolve DNS. Pair with opts.resolveIps in fetchWithSsrfGuard for DNS-based
 * protection (static DNS-to-private / DNS-rebinding).
 */
export function isPrivateHost(hostname: string): boolean {
  // URL.hostname wraps IPv6 literals in brackets — strip them
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();

  if (host === 'localhost' || host.endsWith('.localhost') || host === 'local' || host.endsWith('.local')) {
    return true;
  }

  const ipv4 = parseIPv4(host);
  if (ipv4) return isPrivateIPv4(ipv4);

  if (host.includes(':')) return isPrivateIPv6(host);

  return false;
}

// ---------------------------------------------------------------------------
// Redirect-aware fetch with per-hop SSRF re-validation
// ---------------------------------------------------------------------------

/** Thrown when the SSRF guard blocks a target (initial or redirect hop). */
export class SsrfBlockedError extends Error {
  constructor(public readonly target: string) {
    super(`SSRF guard blocked target "${target}" — private, loopback, and link-local addresses are not allowed`);
    this.name = 'SsrfBlockedError';
  }
}

export interface SsrfGuardOptions {
  /**
   * Block the INITIAL url if it resolves to a private target. Default false.
   * - true  → untrusted url (automation webhooks): a private initial target is
   *           always blocked, and ANY redirect to a private target is blocked.
   * - false → trusted-but-redirected url (source baseUrls, which may
   *           legitimately be internal): a private INITIAL target is allowed,
   *           but a redirect FROM a public target TO a private target is still
   *           blocked (the only legit internal redirect is from an already-internal
   *           origin, which is allowed as "same network, opted in").
   */
  blockPrivateInitial?: boolean;
  /**
   * Resolve a hostname to its IP literals (e.g. node:dns.lookup {all:true}).
   * When omitted, only literal hostnames/IPs are checked — DNS names that
   * resolve to private IPs (localtest.me, 169.254.169.254.nip.io) are NOT blocked.
   */
  resolveIps?: (hostname: string) => Promise<string[]>;
  /** Max redirect hops to follow (default 20, matching undici). */
  maxRedirects?: number;
}

const DEFAULT_MAX_REDIRECTS = 20;

/** Status codes that carry a Location and should be followed (matches undici). */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Header names removed when a request body is dropped on a method downgrade. */
const BODY_HEADERS = new Set(['content-type', 'content-length', 'transfer-encoding']);
/** Credential headers stripped on a cross-origin redirect (Fetch spec). */
const CREDENTIAL_HEADERS = new Set(['authorization', 'cookie', 'cookie2']);

/** Normalize a RequestInit.headers value into a plain string record. */
function headersToRecord(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) {
    const rec: Record<string, string> = {};
    headers.forEach((value, key) => { rec[key] = value; });
    return rec;
  }
  if (Array.isArray(headers)) {
    const rec: Record<string, string> = {};
    for (const [k, v] of headers) rec[k] = String(v);
    return rec;
  }
  // Record<string, string>
  const rec: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) rec[k] = String(v);
  return rec;
}

/** Return a copy of the header record with names matching `strip` removed (case-insensitive). */
function stripHeaders(headers: Record<string, string>, strip: Set<string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!strip.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

/**
 * Resolve a hostname and return true if ANY resolved IP is private.
 * Fails open (returns false) when no resolver is provided or the resolver
 * throws — the fetch itself will fail on an unresolvable host, and failing
 * closed on a transient DNS error would needlessly block all webhooks.
 */
async function resolvesToPrivate(
  hostname: string,
  resolveIps: ((host: string) => Promise<string[]>) | undefined,
): Promise<boolean> {
  if (!resolveIps) return false;
  try {
    const ips = await resolveIps(hostname);
    return ips.some((ip) => isPrivateHost(ip));
  } catch {
    return false;
  }
}

/**
 * Fetch with SSRF re-validation on every redirect hop.
 *
 * Sets `redirect: 'manual'` and re-checks each Location target (literal
 * hostname + injected DNS resolver) before following. Applies Fetch-spec
 * method downgrade (303→GET; 301/302 POST→GET; 307/308 preserve) and strips
 * credential headers on cross-origin redirects so an open-redirect chain
 * cannot exfiltrate Authorization.
 *
 * Only string/URLSearchParams bodies are re-sent across redirects (callers in
 * this codebase send strings); a ReadableStream body would be consumed on the
 * first request and is not supported across hops.
 */
export async function fetchWithSsrfGuard(
  url: string,
  init: RequestInit = {},
  opts: SsrfGuardOptions = {},
): Promise<Response> {
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const resolveIps = opts.resolveIps;

  let headers = headersToRecord(init.headers);
  let method = init.method ?? 'GET';
  // Body is re-sent verbatim on 307/308; dropped on method downgrade.
  let requestBody: BodyInit | undefined = init.body as BodyInit | undefined;

  let initialOrigin: string | null = null;
  let initialWasPrivate = false;
  let currentUrl = url;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const parsed = new URL(currentUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`SSRF guard: invalid URL scheme "${parsed.protocol}" — only http and https are allowed`);
    }

    const hostPrivate = isPrivateHost(parsed.hostname) || (await resolvesToPrivate(parsed.hostname, resolveIps));

    if (hop === 0) {
      initialOrigin = parsed.origin;
      initialWasPrivate = hostPrivate;
      if (opts.blockPrivateInitial && hostPrivate) {
        throw new SsrfBlockedError(parsed.hostname);
      }
    } else {
      // Redirect hop: block public→private. Allow private→private (the caller
      // opted into an internal initial target, so same-network redirects are fine).
      if (hostPrivate && !initialWasPrivate) {
        throw new SsrfBlockedError(parsed.hostname);
      }
    }

    const hasBody = method !== 'GET' && method !== 'HEAD' && requestBody !== undefined;
    const response = await fetch(currentUrl, {
      ...init,
      method,
      headers,
      body: hasBody ? requestBody : undefined,
      // We follow redirects ourselves so every hop is re-validated.
      redirect: 'manual',
    });

    if (!REDIRECT_STATUSES.has(response.status)) {
      return response;
    }

    const location = response.headers.get('location');
    if (!location) return response;

    const nextUrl = new URL(location, currentUrl).toString();

    // Method downgrade (Fetch spec): 303 → GET; 301/302 POST → GET; 307/308 preserve.
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
      method = 'GET';
      requestBody = undefined;
      headers = stripHeaders(headers, BODY_HEADERS);
    }

    // Cross-origin redirect: strip credentials so an open-redirect chain can't
    // leak Authorization/Cookie to a different origin.
    const nextOrigin = new URL(nextUrl).origin;
    if (nextOrigin !== initialOrigin) {
      headers = stripHeaders(headers, CREDENTIAL_HEADERS);
    }

    // Consume the redirect response body to release the TCP connection.
    await response.text().catch(() => {});
    currentUrl = nextUrl;
  }

  throw new Error(`SSRF guard: too many redirects (>${maxRedirects})`);
}
