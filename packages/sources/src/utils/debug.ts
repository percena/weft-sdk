/**
 * Debug Utility
 *
 * Provides opt-in debug logging for the sources package. Mirrors the gating in
 * `@weft/adapter`'s debug helper: nothing is emitted unless WEFT_DEBUG=1, so
 * credentials that pass through this package (Authorization headers, API keys
 * in query strings, token-bearing renew responses) never reach stdout/container
 * logs by default. Call sites that log request details must additionally
 * redact sensitive headers/bodies (see `redactHeaders`) — defense in depth in
 * case WEFT_DEBUG is enabled in a shared environment.
 */

export interface Logger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

const WEFT_DEBUG_ON = typeof process !== 'undefined' && process.env?.WEFT_DEBUG === '1'

export function createLogger(scope: string): Logger {
  return {
    debug: (...args: unknown[]) => { if (WEFT_DEBUG_ON) console.debug(`[${scope}]`, ...args) },
    info: (...args: unknown[]) => { if (WEFT_DEBUG_ON) console.info(`[${scope}]`, ...args) },
    warn: (...args: unknown[]) => { if (WEFT_DEBUG_ON) console.warn(`[${scope}]`, ...args) },
    error: (...args: unknown[]) => { if (WEFT_DEBUG_ON) console.error(`[${scope}]`, ...args) },
  }
}

/**
 * Debug log function — convenience wrapper for ad-hoc logging.
 * Opt-in: emits only when WEFT_DEBUG=1 (never by default in production).
 */
export function debug(message: string, ...args: unknown[]): void {
  if (!WEFT_DEBUG_ON) return
  console.debug(`[sources] ${message}`, ...args)
}

/**
 * Header names whose VALUES are safe to log. SECURITY: an allowlist
 * (not a denylist) so custom auth header names an integrator may use (e.g.
 * DD-API-KEY, X-Auth-Token, api-key) are redacted by default — only well-known
 * non-sensitive headers pass through.
 */
const SAFE_HEADER_NAMES = new Set([
  'content-type', 'accept', 'user-agent', 'content-length', 'content-encoding',
])

/**
 * Return a shallow copy of `headers` with sensitive values redacted, for safe
 * debug logging. Lower-cases keys for the safety check but preserves the
 * original casing in the output map. Redacts every header NOT in the safe set.
 */
export function redactHeaders(headers: Record<string, string> | undefined | null): Record<string, string> {
  const out: Record<string, string> = {}
  if (!headers) return out
  for (const [k, v] of Object.entries(headers)) {
    out[k] = SAFE_HEADER_NAMES.has(k.toLowerCase()) ? v : '<redacted>'
  }
  return out
}

/**
 * Redact secret query params from a URL for safe debug logging. SECURITY:
 * for query-auth sources the API key is embedded in the URL (?api_key=…)
 * and redactHeaders (which only covers headers) would not catch it.
 */
export function redactUrl(url: string, secretQueryParams: string[] = []): string {
  if (secretQueryParams.length === 0) return url
  try {
    const parsed = new URL(url)
    for (const p of secretQueryParams) {
      if (parsed.searchParams.has(p)) parsed.searchParams.set(p, '<redacted>')
    }
    return String(parsed)
  } catch {
    return url
  }
}
