export interface ChatSessionBootstrap {
  session_id: string
  token: string
  base_url: string
  /** Unix seconds (RFC 7519 NumericDate), matching weftd's session response. */
  expires_at: number
}

async function postJson<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  // Same-origin: served by the ITSM backend in production, proxied by Vite in dev.
  // Cookie auth (itsm_session) rides the same-origin fetch — no extra header.
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'same-origin',
    signal,
  })
  if (!response.ok) {
    let detail = `HTTP ${response.status}`
    try {
      const data = (await response.json()) as { error?: string }
      if (data.error) detail = data.error
    } catch {
      // keep the status-only message
    }
    throw new Error(detail)
  }
  return (await response.json()) as T
}

/**
 * Bootstrap a weftd chat session for the logged-in ITSM user. The backend
 * (POST /api/chat/session) holds the weftd developer credential and proxies
 * `POST /v1/sessions` with `end_user_id` = the caller's username.
 */
export async function bootstrapChatSession(
  endUserId: string,
  signal?: AbortSignal,
): Promise<ChatSessionBootstrap> {
  try {
    return await postJson<ChatSessionBootstrap>(
      '/api/chat/session',
      { end_user_id: endUserId },
      signal,
    )
  } catch (error) {
    throw new Error(`ITSM chat session bootstrap failed: ${(error as Error).message}`)
  }
}

/**
 * onTokenExpired handler: asks the ITSM backend to re-issue a token for the
 * existing session (the backend calls weftd's
 * POST /v1/sessions/{id}/token with its developer credential).
 */
export async function refreshChatToken(sessionId: string): Promise<string | undefined> {
  try {
    const refreshed = await postJson<ChatSessionBootstrap>(
      `/api/chat/session/${encodeURIComponent(sessionId)}/token`,
      {},
    )
    return refreshed.token
  } catch {
    // Surface the 401 to the runtime; the user sees a failed send instead of
    // a silent retry loop.
    return undefined
  }
}
