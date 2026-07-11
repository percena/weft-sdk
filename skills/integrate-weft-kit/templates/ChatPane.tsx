import { useRef } from 'react'
import { TimelineAgentChatPanel, useAgentSession } from '@percena/weft/chat'
import { createFlitroEmbedRuntime } from '@percena/weft/providers/flitro'
import { refreshChatToken, type ChatSessionBootstrap } from './chat-bootstrap'

/**
 * Sidebar chat panel: drives a weftd session via the Flitro embed runtime.
 * The session is bootstrapped by the host backend (POST /api/chat/session)
 * and the scoped token is refreshed through it on expiry. The named
 * {{toolset}} toolset's tools suspend to the browser, which executes them
 * same-origin against the {{appSlug}} REST API.
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
        // MANDATORY for named `execution: client` toolsets (the {{toolset}}_*
        // tools): without this allowlist the SDK only auto-executes the
        // `client_http_request` marker tool, NOT the named-toolset tools, so
        // every agent tool call suspends forever at the first one (the run
        // "wedges"). `pathPrefix: '/api/'` lets same-origin business calls
        // through; tighten per app if your tools hit other prefixes.
        clientHttpAllowlist: [{ pathPrefix: '/api/' }],
      }),
  })

  return (
    <TimelineAgentChatPanel
      runtime={session.runtime}
      workspaceId="{{appSlug}}"
      workspaceName="{{appName}}"
      placeholder="Try: list products, add 2 mechanical keyboards, then pay"
      showStatusBar
      className="flex min-h-0 flex-1 flex-col"
    />
  )
}
