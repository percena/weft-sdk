import { createRoot } from 'react-dom/client'
import { useAgentSession, TimelineAgentChatPanel, EN_FALLBACK } from '@percena/weft'
import { createFlitroEmbedRuntime } from '@percena/weft/providers/flitro'
import '@percena/weft/styles'
import { weftAction, ActionReplayLayer, createActionBridge } from '@percena/weft/action-bridge'

function Canary() {
  // useAgentSession (@weft/chat) takes a `createRuntime` factory, not server/token.
  // Wire the embed runtime (the browser entry path) through it so the canary
  // actually exercises createFlitroEmbedRuntime, not just references it.
  const session = useAgentSession({
    sessionId: 'sess_canary',
    createRuntime: () => createFlitroEmbedRuntime({
      baseUrl: 'http://127.0.0.1:0',
      token: 'canary',
      sessionId: 'sess_canary',
    }),
  })
  return (
    <div>
      <TimelineAgentChatPanel runtime={session.runtime} />
      <button {...weftAction('canary', 1)}>canary</button>
      <ActionReplayLayer onReplayed={() => {}} />
    </div>
  )
}

console.log(
  Boolean(createFlitroEmbedRuntime) && Boolean(createActionBridge) && Boolean(EN_FALLBACK) && Boolean(Canary),
)
createRoot(document.getElementById('root')!).render(<Canary />)
