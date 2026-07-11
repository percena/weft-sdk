/**
 * WeftHttpClient
 *
 * Typed HTTP client for the Weft Server REST API.
 * All methods map 1-to-1 with the server's HTTP endpoints.
 */

import type { PermissionResponseDetail } from '@weft/runtime-core'

export interface WeftHttpClientOptions {
  /** Base URL of the Weft server, e.g. http://localhost:8080 */
  baseUrl: string
  /** Optional timeout in milliseconds (default: 30000) */
  timeout?: number
  /**
   * Scoped session token. Sent as the Authorization bearer.
   */
  token?: string
  /**
   * Called when the server rejects the scoped token (HTTP 401, typically
   * expiry). Return a fresh token (e.g. by re-asking the host backend) and
   * the failed request is retried once; return undefined to surface the 401.
   */
  onTokenExpired?: () => Promise<string | undefined> | string | undefined
}

export interface RefreshEmbedTokenResponse {
  session_id?: string
  token: string
  expires_at: number
}

export interface WeftSession {
  session_id: string
  tenant_id: string
  app_id?: string
  external_account_id?: string
  external_user_id?: string
  principal_id?: string
  auth_method?: string
  project_id?: string
  workspace_id?: string
  title: string
  status: string
  labels?: string[]
  flagged?: boolean
  topic?: string
  config_snapshot: unknown
  summary_snapshot?: unknown
  created_at: string
  updated_at: string
}

export interface WeftRun {
  run_id: string
  session_id: string
  tenant_id?: string
  app_id?: string
  external_account_id?: string
  external_user_id?: string
  parent_run_id?: string
  status: string
  execution_mode: string
  permission_envelope?: string
  input_message: string
  config_snapshot?: unknown
  model_profile?: string
  skill_names?: string[]
  budget?: { max_steps?: number; max_tokens?: number; max_wall_time_sec?: number }
  error?: string
  started_at?: string
  finished_at?: string
  created_at: string
  updated_at: string
}

export interface WeftCapabilityReport {
  provider: string
  runtimeKind: string
  selected: string
  fallback: boolean
  auth: {
    mode: string
    configured: boolean
    source: string
    accountPresent?: boolean
    method?: string
    provider?: string
    error?: string
  }
  features: string[]
  policyCapabilities: Record<string, unknown>
  sourceCapabilities: Record<string, unknown>
  skillCapabilities: Record<string, unknown>
  automationCapabilities: Record<string, unknown>
  hostToolCapabilities: Record<string, unknown>
}

export interface WeftPatchSessionOptions {
  title?: string
  status?: string
  labels?: string[]
  flagged?: boolean
  topic?: string
}

export interface WeftModelInfo {
  id: string
  provider: string
  display_name?: string
  aliases?: string[]
  capabilities: Record<string, unknown>
}

export interface WeftModelListResult {
  models: WeftModelInfo[]
  default?: string
}

export interface WeftTimelineItem {
  sessionId: string
  provider: string
  seq: number
  epoch: string
  timestamp: number
  item: Record<string, unknown>
}

export interface WeftTimelineFetchResult {
  items: WeftTimelineItem[]
  nextCursor: { epoch: string; afterSeq: number }
  hasGap: boolean
}

export class WeftHttpClient {
  private readonly baseUrl: string
  private readonly timeout: number
  private readonly onTokenExpired?: WeftHttpClientOptions['onTokenExpired']
  private token: string

  constructor(options: WeftHttpClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '')
    this.timeout = options.timeout ?? 30_000
    this.token = options.token ?? ''
    this.onTokenExpired = options.onTokenExpired
  }

  /** Current Authorization bearer token. */
  getBearerToken(): string {
    return this.token
  }

  /** Replace the scoped token (e.g. after a host-backend refresh). */
  setToken(token: string): void {
    this.token = token
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    const bearer = this.getBearerToken()
    if (bearer) headers.Authorization = `Bearer ${bearer}`
    return headers
  }

  async health(): Promise<{ status: string }> {
    return this.get<{ status: string }>('/health')
  }

  async getSession(sessionId: string): Promise<WeftSession> {
    return this.get<WeftSession>(`/v1/sessions/${encodeURIComponent(sessionId)}`)
  }

  /**
   * Create a run (one message = one turn). Sends the provider-neutral
   * run parameters: `message`, `model`, `budget`, `permission_mode`,
   * `skill_names`, `mcp_server_names`.
   *
   * weftd honors the client's valid `permission_mode` (fail-safe `ask` if
   * invalid/legacy) and subset-clamps `skill_names`/`mcp_server_names` to the
   * session's sealed set before forwarding to the agentd backend, which maps
   * `permission_mode` to its own native params. `approval_policy`/
   * `execution_mode`/`tool_names`/`workspace_id` are no longer client-settable
   * and are intentionally absent from the body.
   */
  async createRun(
    sessionId: string,
    message: string,
    options?: {
      model?: string
      skillNames?: string[]
      mcpServerNames?: string[]
      /** Canonical permission_mode wire value: 'explore' | 'ask' | 'auto' */
      permissionMode?: string
      budget?: { maxSteps?: number; maxTokens?: number; maxWallTimeSec?: number }
    },
  ): Promise<WeftRun> {
    const budget = options?.budget
      ? {
          max_steps: options.budget.maxSteps,
          max_tokens: options.budget.maxTokens,
          max_wall_time_sec: options.budget.maxWallTimeSec,
        }
      : undefined
    return this.post<WeftRun>(`/v1/sessions/${encodeURIComponent(sessionId)}/runs`, {
      message,
      model: options?.model,
      permission_mode: options?.permissionMode,
      skill_names: options?.skillNames,
      mcp_server_names: options?.mcpServerNames,
      budget,
    })
  }

  async cancelRun(sessionId: string, runId: string): Promise<{ status: string }> {
    return this.post<{ status: string }>(
      `/v1/sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}/cancel`,
      {},
    )
  }

  /**
   * Refresh a session's scoped embed token. `expires_at` is Unix seconds.
   */
  async refreshToken(
    sessionId: string,
    options?: { ttlSeconds?: number; credential?: unknown },
  ): Promise<RefreshEmbedTokenResponse> {
    return this.post<RefreshEmbedTokenResponse>(
      `/v1/sessions/${encodeURIComponent(sessionId)}/token`,
      { ttl_seconds: options?.ttlSeconds, credential: options?.credential },
    )
  }

  /**
   * Submit tool outputs for a suspended run (public API).
   * The server translates this to Flitro's internal resume_data format.
   * MVP: only the first tool output is processed.
   */
  async submitToolOutputs(
    sessionId: string,
    runId: string,
    outputs: { toolCallId: string; output: unknown; isError?: boolean }[],
  ): Promise<{ status: string }> {
    const path = `/v1/sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}/tool-outputs`
    return this.post<{ status: string }>(path, {
      tool_outputs: outputs.map(o => ({
        tool_call_id: o.toolCallId,
        output: o.output,
        is_error: o.isError ?? false,
      })),
    })
  }

  async respondToPermission(
    sessionId: string,
    requestId: string,
    allowed: boolean,
    options?: { remember?: boolean; comment?: string; detail?: PermissionResponseDetail },
  ): Promise<{ ok: boolean; type: string; requestId: string }> {
    // Wire gap: the weftd /permission-response handler
    // (internal/api/handlers_session.go) currently decodes only
    // {requestId, allowed, remember, comment} — it does NOT yet read the
    // structured `detail` object (updatedInput / updatedPermissions /
    // interrupt). Go's json.Decode silently ignores unknown fields, so
    // forwarding `detail` here is additive and non-breaking: when weftd/Flitro
    // gain support for input-rewrite/interrupt, they can read this field
    // without an SDK rev. Until then `detail` is carried on the wire but not
    // acted upon server-side — `comment` remains the only "extra" the server
    // consumes. Closing the loop requires a weftd change (out of scope here).
    return this.post(
      `/v1/sessions/${encodeURIComponent(sessionId)}/permission-response`,
      {
        requestId,
        allowed,
        remember: options?.remember,
        comment: options?.comment,
        detail: options?.detail,
      },
    )
  }

  async patchSession(
    sessionId: string,
    patch: WeftPatchSessionOptions,
  ): Promise<WeftSession> {
    return this.patch<WeftSession>(
      `/v1/sessions/${encodeURIComponent(sessionId)}`,
      patch,
    )
  }

  async fetchTimeline(
    sessionId: string,
    afterSeq?: number,
    limit?: number,
    /**
     * catchup-epoch contract: the last-seen epoch. Sent on a full-close catchup fetch so
     * flitro can detect a stale cursor after a restart (its fetch handler
     * resets afterSeq=0 when reqEpoch != SessionEpoch) and replay durable
     * history from 0 instead of returning empty (which left the gap unback-
     * filled). Omitted on the initial fetch (no cursor yet).
     */
    epoch?: string,
  ): Promise<WeftTimelineFetchResult> {
    const params = new URLSearchParams()
    if (afterSeq !== undefined) params.set('after_seq', String(afterSeq))
    if (limit !== undefined) params.set('limit', String(limit))
    if (epoch) params.set('epoch', epoch)
    const qs = params.toString()
    const url = `/v1/sessions/${encodeURIComponent(sessionId)}/timeline/fetch${qs ? `?${qs}` : ''}`
    return this.get<WeftTimelineFetchResult>(url)
  }

  /** Returns the SSE stream URL for a session's canonical timeline. */
  timelineUrl(sessionId: string): string {
    return `${this.baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/timeline`
  }

  private async get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path, undefined)
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('POST', path, body)
  }

  private async patch<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('PATCH', path, body)
  }

  private async request<T>(method: string, path: string, body: unknown, isRetry = false): Promise<T> {
    const url = `${this.baseUrl}${path}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error(`Weft request timed out after ${this.timeout}ms: ${method} ${path}`)), this.timeout)

    try {
      const response = await fetch(url, {
        method,
        headers: this.buildHeaders(),
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      })

      if (response.status === 401 && this.token && this.onTokenExpired && !isRetry) {
        const fresh = await this.onTokenExpired()
        if (fresh) {
          this.token = fresh
          return this.request<T>(method, path, body, true)
        }
      }

      if (!response.ok) {
        let errorMsg = `Weft HTTP ${response.status}`
        try {
          // weftd emits an RFC 9457-inspired nested error: {"error":{"type","message"}}
          const errBody = await response.json() as { error?: string | { message?: string } }
          const detail = typeof errBody.error === 'string' ? errBody.error : errBody.error?.message
          if (detail) errorMsg = `${errorMsg}: ${detail}`
        } catch {
          // ignore parse error
        }
        throw new Error(errorMsg)
      }

      return response.json() as Promise<T>
    } finally {
      clearTimeout(timer)
    }
  }
}
