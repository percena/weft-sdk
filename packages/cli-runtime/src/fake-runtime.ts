import type { AgentEvent } from '@weft/core'
import type { ProviderAuthDetection } from '@weft/adapter/auth'
import { PushAgentEventStream } from './event-stream.ts'
import { initialRuntimeState, reduceRuntimeState, type RuntimeAction } from '@weft/runtime-core'
import type {
  AgentRuntimeState,
  AgentSessionRuntime,
  CliAgentProvider,
  CliAgentSessionOptions,
  SendMessageOptions,
} from './types.ts'

export interface FakeCliAgentSessionOptions extends CliAgentSessionOptions {
  provider: CliAgentProvider
  script: AgentEvent[]
}

export function createFakeCliAgentSession(options: FakeCliAgentSessionOptions): AgentSessionRuntime {
  const events = new PushAgentEventStream()
  let state: AgentRuntimeState = initialRuntimeState

  function dispatch(action: RuntimeAction) {
    state = reduceRuntimeState(state, action)
  }

  async function runScript() {
    events.emit({ type: 'status', message: `${options.provider} runtime accepted message` })
    for (const event of options.script) {
      if (event.type === 'permission_request') {
        dispatch({ type: 'permission_request', requestId: event.requestId })
      }
      events.emit(event)
      if (event.type === 'complete') {
        dispatch({ type: 'complete' })
      }
    }
  }

  return {
    sessionId: options.sessionId ?? `cli-${options.provider}-${Date.now()}`,
    provider: options.provider,
    events,
    async preflight(): Promise<ProviderAuthDetection> {
      dispatch({ type: 'preflight_ok' })
      return {
        mode: 'provider-owned',
        configured: true,
        source: 'fake-cli-runtime',
      }
    },
    getState() {
      return state
    },
    commands: {
      async sendMessage(message: string, _sendOptions?: SendMessageOptions) {
        dispatch({ type: 'send_message', message })
        await runScript()
      },
      async abort(reason?: string) {
        dispatch({ type: 'abort', reason })
        events.emit({ type: 'error', message: reason ?? 'Aborted' })
        events.emit({ type: 'complete' })
      },
      async respondToPermission(_requestId: string, _allowed: boolean, _remember?: boolean) {
        dispatch({ type: 'permission_response' })
      },
      async dispose() {
        dispatch({ type: 'dispose' })
        events.close()
      },
    },
  }
}
