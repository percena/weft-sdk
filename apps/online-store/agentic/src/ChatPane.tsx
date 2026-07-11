import { useRef } from 'react'
import { TimelineAgentChatPanel, useAgentSession } from '@percena/weft/chat'
import { createFlitroEmbedRuntime } from '@percena/weft/providers/flitro'
import { refreshChatToken, type ChatSessionBootstrap } from './chat-bootstrap'

/**
 * Sidebar chat panel: drives a weftd session via the Flitro embed runtime.
 * The session is bootstrapped by the host backend (POST /api/chat/session)
 * and the scoped token is refreshed through it on expiry. The named
 * shop toolset's tools suspend to the browser, which executes them
 * same-origin against the online-store-agentic REST API.
 */
export function ChatPane({ boot }: { boot: ChatSessionBootstrap }) {
  // Keep a ref to the latest token so the runtime factory (captured once)
  // always reads the freshest value after a refresh.
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
        // The shop agent's tools (shop_listProducts, shop_addCartItem,
        // shop_createOrder, shop_payOrder, …) are named openapi-toolset tools
        // with execution:client — flitro suspends them with an {method,url}
        // payload hitting the shop REST API (/api/*). The SDK only
        // auto-executes such client-side HTTP tools behind an explicit opt-in
        // (autoExecuteClientHttp covers only the `client_http_request` marker
        // name, not shop_*). Without this allowlist the run wedges at the first
        // tool call: handleToolSuspension surfaces "no handler registered" and
        // returns without submitting a tool-output, so the run never resumes.
        clientHttpAllowlist: [{ pathPrefix: '/api/' }],
      }),
  })

  return (
    <TimelineAgentChatPanel
      runtime={session.runtime}
      workspaceId="online-store-agentic"
      workspaceName="Online Store"
      placeholder="Try: list products, add 2 mechanical keyboards, then pay"
      showStatusBar
      className="flex min-h-0 flex-1 flex-col"
    />
  )
}
