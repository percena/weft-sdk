import { useRef } from 'react'
import { TimelineAgentChatPanel, useAgentSession } from '@percena/weft/chat'
import { createFlitroEmbedRuntime } from '@percena/weft/providers/flitro'
import { refreshChatToken, type ChatSessionBootstrap } from './chat-bootstrap'

/**
 * Inline chat sidebar: a weftd-backed TimelineAgentChatPanel. The session is
 * bootstrapped by App (with retry) and handed in via `boot`; the token is
 * kept in a ref so `onTokenExpired` can re-fetch without remounting the panel.
 */
export function ChatPane({ boot }: { boot: ChatSessionBootstrap }) {
  const tokenRef = useRef(boot.token)
  tokenRef.current = boot.token

  const session = useAgentSession({
    sessionId: boot.session_id,
    provider: 'flitro',
    createRuntime: () =>
      createFlitroEmbedRuntime({
        baseUrl: boot.base_url,
        token: tokenRef.current,
        sessionId: boot.session_id,
        onTokenExpired: () => refreshChatToken(boot.session_id),
        // The itsm agent's tools (itsm_listcis, itsm_createincident,
        // itsm_linkincidentci, itsm_assignincident, …) are named openapi-toolset
        // tools with execution:client — flitro suspends them with an {method,url}
        // payload hitting the ITSM REST API (/api/*). Since S2, the SDK only
        // auto-executes such client-side HTTP tools behind an explicit opt-in
        // (autoExecuteClientHttp covers only the `client_http_request` marker
        // name, not itsm_*). Without this allowlist the run wedges at the first
        // tool call: handleToolSuspension surfaces "no handler registered" and
        // returns without submitting a tool-output, so the run never resumes.
        clientHttpAllowlist: [{ pathPrefix: '/api/' }],
        // Sized for multi-step Ask flows (approvals + LLM thinking); a faster
        // model or Auto mode can omit this.
        budget: { maxWallTimeSec: 600, maxSteps: 32 },
      }),
  })

  return (
    <TimelineAgentChatPanel
      runtime={session.runtime}
      workspaceId="itsm-agentic"
      workspaceName="ITSM (Agentic)"
      placeholder="Try: P1: payment service down — find the on-call, link the dependent CIs, assign + escalate"
      showStatusBar
      className="flex min-h-0 flex-1 flex-col"
    />
  )
}
