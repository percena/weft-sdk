/**
 * Webhook Execution Utilities
 *
 * Shared webhook HTTP execution logic used by both the production WebhookHandler
 * and the RPC test handler. Centralizes timeout, body consumption, request building,
 * env var expansion, and retry logic so the two code paths can't diverge.
 */

import type { WebhookAction, WebhookActionResult } from './types.ts';
import { expandEnvVars } from './utils.ts';
import { DEFAULT_WEBHOOK_METHOD, HISTORY_FIELD_MAX_LENGTH } from './constants.ts';
import { fetchWithSsrfGuard, SsrfBlockedError } from '@weft/core';

/**
 * Redact a URL for safe logging. Webhook URLs frequently embed the secret IN the
 * path (Slack/Discord inbound-webhook tokens, not a query param), so the path
 * is NEVER shown — only scheme + host (enough to identify the target service +
 * find the action in config) + a `/…` marker if a path was present. A previous
 * 15-char path prefix leaked workspace-ID chars for Slack URLs.
 */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname.length > 1 ? `${parsed.origin}/…` : parsed.origin;
  } catch {
    // Unparseable URL — showing any prefix risks leaking a secret path (e.g. a
    // Slack/Discord webhook URL that lost its scheme). Return a fixed marker.
    return '<redacted>';
  }
}

/**
 * Create a webhook history entry for appending to the history JSONL file.
 */
export function createWebhookHistoryEntry(opts: {
  matcherId: string;
  ok: boolean;
  method?: string;
  url: string;
  statusCode: number;
  durationMs: number;
  attempts?: number;
  error?: string;
  responseBody?: string;
}): Record<string, unknown> {
  return {
    id: opts.matcherId,
    ts: Date.now(),
    ok: opts.ok,
    webhook: {
      method: opts.method ?? DEFAULT_WEBHOOK_METHOD,
      url: redactUrl(opts.url),
      statusCode: opts.statusCode,
      durationMs: opts.durationMs,
      ...(opts.attempts && opts.attempts > 1 ? { attempts: opts.attempts } : {}),
      ...(opts.error ? { error: opts.error.slice(0, HISTORY_FIELD_MAX_LENGTH) } : {}),
      ...(opts.responseBody ? { responseBody: opts.responseBody.slice(0, HISTORY_FIELD_MAX_LENGTH) } : {}),
    },
  };
}

/**
 * Create a prompt-action history entry for appending to the history JSONL file.
 */
export function createPromptHistoryEntry(opts: {
  matcherId: string;
  ok: boolean;
  sessionId?: string;
  prompt?: string;
  error?: string;
}): Record<string, unknown> {
  return {
    id: opts.matcherId,
    ts: Date.now(),
    ok: opts.ok,
    ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
    ...(opts.prompt ? { prompt: opts.prompt.slice(0, HISTORY_FIELD_MAX_LENGTH) } : {}),
    ...(opts.error ? { error: opts.error.slice(0, HISTORY_FIELD_MAX_LENGTH) } : {}),
  };
}

/**
 * Return a copy of a WebhookAction with all env-expandable string fields resolved.
 * Used before enqueueing for deferred retry so the retry scheduler doesn't need
 * the original event environment.
 */
export function expandWebhookAction(action: WebhookAction, env: Record<string, string>): WebhookAction {
  const expanded: WebhookAction = {
    ...action,
    url: expandEnvVars(action.url, env),
  };

  if (action.headers) {
    expanded.headers = {};
    for (const [key, value] of Object.entries(action.headers)) {
      expanded.headers[key] = expandEnvVars(value, env);
    }
  }

  if (typeof action.body === 'string') {
    expanded.body = expandEnvVars(action.body, env);
  } else if (action.body !== undefined && typeof action.body === 'object' && action.body !== null) {
    expanded.body = JSON.parse(expandEnvVars(JSON.stringify(action.body), env));
  }

  if (action.auth) {
    if (action.auth.type === 'basic') {
      expanded.auth = {
        type: 'basic',
        username: expandEnvVars(action.auth.username, env),
        password: expandEnvVars(action.auth.password, env),
      };
    } else if (action.auth.type === 'bearer') {
      expanded.auth = {
        type: 'bearer',
        token: expandEnvVars(action.auth.token, env),
      };
    }
  }

  return expanded;
}

// ============================================================================
// SSRF Guard (shared implementation in @weft/core — see utils/ssrf.ts)
// ============================================================================

// Re-export the lexical hostname check under the legacy name the tests import.
// The full redirect-aware guard lives in @weft/core's fetchWithSsrfGuard.
export { isPrivateHost as isPrivateWebhookTarget } from '@weft/core';

/**
 * Node DNS resolver for the SSRF guard — resolves a hostname to all its IPs so
 * fetchWithSsrfGuard can reject names that point at private ranges (e.g.
 * localtest.me → 127.0.0.1, 169.254.169.254.nip.io → 169.254.169.254). Dynamic
 * import keeps this Node-only module out of any future browser bundle.
 *
 * Exported so production callers (WebhookHandler, RetryScheduler) can pass it
 * as opts.resolveIps. Fails open (returns []) on lookup error — the fetch
 * itself fails on an unresolvable host, and failing closed on a transient DNS
 * error would needlessly block all webhooks.
 */
export async function nodeDnsResolveAll(hostname: string): Promise<string[]> {
  const { lookup } = await import('node:dns');
  return new Promise<string[]>((resolve) => {
    lookup(hostname, { all: true }, (err, addresses) => {
      if (err || !addresses) return resolve([]);
      resolve(addresses.map((a) => a.address));
    });
  });
}

/** Default fetch timeout in milliseconds (30 seconds, matching Claude Code's HTTP hook default) */
const DEFAULT_TIMEOUT_MS = 30_000;

export interface RetryConfig {
  /** Max retry attempts (default: 0 = no retry) */
  maxAttempts: number;
  /** Initial delay in ms (default: 1000). Doubles each attempt. */
  initialDelayMs?: number;
  /** Max delay cap in ms (default: 10000) */
  maxDelayMs?: number;
}

export interface ExecuteWebhookOptions {
  /** Timeout in milliseconds (default: 30000) */
  timeoutMs?: number;
  /** Environment variables for $VAR expansion. If undefined, no expansion is performed (raw mode for tests) */
  env?: Record<string, string>;
  /** Retry config for transient failures. Disabled by default. */
  retry?: RetryConfig;
  /**
   * DNS resolver for the SSRF guard — resolves a hostname to its IP literals so
   * names pointing at private ranges (localtest.me, *.nip.io) are rejected.
   * Production callers pass nodeDnsResolveAll; unit tests omit it (literal-only
   * checks) to avoid real network lookups, or inject a fake for DNS cases.
   */
  resolveIps?: (hostname: string) => Promise<string[]>;
}

/**
 * Execute a single webhook HTTP request.
 *
 * Handles: request building, env var expansion, timeout via AbortController,
 * response body consumption (prevents memory leaks), and error wrapping.
 * Includes durationMs in the result for observability.
 *
 * @param action - The webhook action definition from automations config
 * @param options - Execution options (timeout, env vars for expansion)
 * @returns WebhookActionResult with status, success flag, timing, and any error
 */
export async function executeWebhookRequest(
  action: WebhookAction,
  options?: ExecuteWebhookOptions,
): Promise<WebhookActionResult> {
  const env = options?.env;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const method = action.method ?? DEFAULT_WEBHOOK_METHOD;
  const url = env ? expandEnvVars(action.url, env) : action.url;

  // Validate URL scheme and target after expansion
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return {
        type: 'webhook', url, statusCode: 0, success: false,
        error: `Invalid URL scheme "${parsed.protocol}" — only http and https are allowed`,
        durationMs: 0,
      };
    }
    // SSRF guard (redirect + DNS aware) runs at fetch time below — see
    // fetchWithSsrfGuard. It blocks private initial targets, any redirect to a
    // private target, and (with opts.resolveIps) DNS names resolving to private
    // ranges. SsrfBlockedError is mapped to the canonical blocked result in the
    // outer catch so the error surface is unchanged.
  } catch {
    return {
      type: 'webhook', url, statusCode: 0, success: false,
      // SECURITY (audit B1): do NOT embed the expanded URL in the error — the
      // error string flows to the retry-queue `lastError` + history `error`
      // fields (both persisted) and to the onWebhookResults callback. A 50-char
      // prefix of a Slack/Discord webhook URL leaks the workspace ID + partial
      // token. Keep the message generic; the integrator inspects action.url.
      error: `Invalid URL after variable expansion (check action.url template)`,
      durationMs: 0,
    };
  }

  const start = Date.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // Build headers
    const headers: Record<string, string> = {};

    // Apply auth shorthand (before custom headers, so headers can override)
    if (action.auth) {
      if (action.auth.type === 'basic') {
        const user = env ? expandEnvVars(action.auth.username, env) : action.auth.username;
        const pass = env ? expandEnvVars(action.auth.password, env) : action.auth.password;
        headers.Authorization = `Basic ${btoa(`${user}:${pass}`)}`;
      } else if (action.auth.type === 'bearer') {
        const token = env ? expandEnvVars(action.auth.token, env) : action.auth.token;
        headers.Authorization = `Bearer ${token}`;
      }
    }

    if (action.headers) {
      for (const [key, value] of Object.entries(action.headers)) {
        headers[key] = env ? expandEnvVars(value, env) : value;
      }
    }

    // Build body
    let requestBody: string | undefined;
    if (method !== 'GET' && action.body !== undefined) {
      const bodyFormat = action.bodyFormat ?? 'json';

      if (bodyFormat === 'json') {
        if (!headers['Content-Type'] && !headers['content-type']) {
          headers['Content-Type'] = 'application/json';
        }
        if (typeof action.body === 'string') {
          requestBody = env ? expandEnvVars(action.body, env) : action.body;
        } else {
          const raw = JSON.stringify(action.body);
          requestBody = env ? expandEnvVars(raw, env) : raw;
        }
      } else if (bodyFormat === 'form') {
        if (!headers['Content-Type'] && !headers['content-type']) {
          headers['Content-Type'] = 'application/x-www-form-urlencoded';
        }
        if (typeof action.body === 'object' && action.body !== null) {
          const params = new URLSearchParams();
          for (const [k, v] of Object.entries(action.body as Record<string, unknown>)) {
            const val = String(v ?? '');
            params.append(k, env ? expandEnvVars(val, env) : val);
          }
          requestBody = params.toString();
        } else {
          const raw = String(action.body);
          requestBody = env ? expandEnvVars(raw, env) : raw;
        }
      } else {
        // Raw body
        const raw = String(action.body);
        requestBody = env ? expandEnvVars(raw, env) : raw;
      }
    }

    const response = await fetchWithSsrfGuard(
      url,
      { method, headers, body: requestBody, signal: controller.signal },
      { blockPrivateInitial: true, resolveIps: options?.resolveIps },
    );

    const success = response.status >= 200 && response.status < 300;

    // Consume response body to release the TCP connection and prevent memory leaks.
    // Optionally capture it when requested (truncated to 4KB).
    const MAX_RESPONSE_SIZE = 4096;
    let responseBody: string | undefined;
    try {
      const text = await response.text();
      if (action.captureResponse) {
        responseBody = text.length > MAX_RESPONSE_SIZE
          ? `${text.slice(0, MAX_RESPONSE_SIZE)}...(truncated)`
          : text;
      }
    } catch {
      // Body consumption failed — not fatal
    }

    return {
      type: 'webhook',
      url,
      statusCode: response.status,
      success,
      error: success ? undefined : `HTTP ${response.status} ${response.statusText}`,
      durationMs: Date.now() - start,
      ...(responseBody !== undefined ? { responseBody } : {}),
    };
  } catch (err) {
    if (err instanceof SsrfBlockedError) {
      return {
        type: 'webhook',
        url,
        statusCode: 0,
        success: false,
        error: `Blocked webhook target "${err.target}" — private, loopback, and link-local addresses are not allowed`,
        durationMs: Date.now() - start,
      };
    }
    const isTimeout = err instanceof DOMException && err.name === 'AbortError';
    let error = isTimeout
      ? `Request timed out after ${timeoutMs}ms`
      : err instanceof Error ? err.message : 'Unknown error';
    // SECURITY (audit B1): undici/network errors occasionally embed the request
    // URL in the message. If the expanded (secret-bearing) URL appears verbatim,
    // replace it with the redacted form so lastError (persisted to the retry
    // queue + history) + the onWebhookResults callback can't leak the path secret.
    if (url && error.includes(url)) {
      error = error.split(url).join(redactUrl(url));
    }

    return {
      type: 'webhook',
      url,
      statusCode: 0,
      success: false,
      error,
      durationMs: Date.now() - start,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Determine if a webhook result represents a transient failure worth retrying.
 * - 5xx server errors: likely transient
 * - Timeout / connection errors (statusCode 0): likely transient
 * - 4xx client errors: not retryable (bad request, auth issues, etc.)
 * - 2xx success: obviously not
 */
export function isTransientFailure(result: WebhookActionResult): boolean {
  if (result.success) return false;
  // 4xx = client error, not retryable
  if (result.statusCode >= 400 && result.statusCode < 500) return false;
  // 5xx or 0 (timeout/connection error) = retryable
  return true;
}

/**
 * Execute a webhook request with optional retry for transient failures.
 *
 * Wraps executeWebhookRequest with exponential backoff + jitter.
 * If retry is not configured (or maxAttempts=0), behaves identically to executeWebhookRequest.
 *
 * @param action - The webhook action definition
 * @param options - Execution options including retry config
 * @returns WebhookActionResult with attempts count and total duration
 */
export async function executeWithRetry(
  action: WebhookAction,
  options?: ExecuteWebhookOptions,
): Promise<WebhookActionResult> {
  const maxAttempts = options?.retry?.maxAttempts ?? 0;

  // No retry configured — single attempt
  if (maxAttempts <= 0) {
    const result = await executeWebhookRequest(action, options);
    return { ...result, attempts: 1 };
  }

  const initialDelay = options?.retry?.initialDelayMs ?? 1000;
  const maxDelay = options?.retry?.maxDelayMs ?? 10_000;
  const totalStart = Date.now();

  let lastResult: WebhookActionResult | undefined;

  for (let attempt = 0; attempt <= maxAttempts; attempt++) {
    lastResult = await executeWebhookRequest(action, options);

    // Success or non-transient failure — return immediately
    if (!isTransientFailure(lastResult)) {
      return {
        ...lastResult,
        attempts: attempt + 1,
        durationMs: Date.now() - totalStart,
      };
    }

    // Last attempt — don't delay, just return
    if (attempt === maxAttempts) break;

    // Exponential backoff with jitter (±10%)
    const delay = Math.min(initialDelay * 2 ** attempt, maxDelay);
    const jitter = delay * 0.1 * (Math.random() * 2 - 1); // ±10%
    await new Promise(r => setTimeout(r, delay + jitter));
  }

  return {
    ...lastResult!,
    attempts: maxAttempts + 1,
    durationMs: Date.now() - totalStart,
  };
}
