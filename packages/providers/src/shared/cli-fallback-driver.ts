import type { TimelineSequencer } from '@weft/timeline'
import {
  createCliTimelineProjector,
  type AgentSessionRuntime,
  type CliAgentProvider,
} from '@weft/cli-runtime'
import type { ProviderRuntimeDriverInput } from './runtime-scaffold.ts'

export interface CliFallbackDriver {
  sendMessage(input: ProviderRuntimeDriverInput, sequencer: TimelineSequencer): Promise<void>
  abort?(reason?: string): Promise<void>
  respondToPermission?(requestId: string, allowed: boolean, remember?: boolean): Promise<void>
  dispose?(): Promise<void>
}

export function createCliFallbackDriver(options: {
  provider: CliAgentProvider
  session: AgentSessionRuntime
  sessionId: string
  epoch: string
  now?: () => number
}): CliFallbackDriver {
  const projector = createCliTimelineProjector({
    sessionId: options.sessionId,
    provider: options.provider,
    epoch: options.epoch,
    now: options.now,
  })
  let connected = false
  let activeSequencer: TimelineSequencer | undefined

  function connect(sequencer: TimelineSequencer): void {
    activeSequencer = sequencer
    if (connected) return
    connected = true
    options.session.events.connect((event: Parameters<typeof projector.project>[0]) => {
      if (!activeSequencer) return
      // C7: the CLI runtime emits a plain status string for provider session
      // capture (`provider_session:<id>`).  The native SDK driver and codex
      // app-server driver emit structured `host_state_changed` timeline items
      // instead.  Intercept the status event here (where we have a sequencer)
      // and emit the matching timeline item so all three drivers are consistent.
      if (event.type === 'status' && typeof event.message === 'string' && event.message.startsWith('provider_session:')) {
        const capturedId = event.message.split(':').slice(1).join(':')
        activeSequencer.append({
          type: 'host_state_changed',
          state: {
            kind: 'provider_session',
            provider: options.provider,
            ...(options.provider === 'claude'
              ? { providerSessionId: capturedId }
              : { providerThreadId: capturedId }),
          },
        })
      }
      for (const envelope of projector.project(event)) {
        activeSequencer.append(envelope.item, envelope.rawRef)
      }
    })
  }

  let userMessageCounter = 0

  return {
    async sendMessage(input, sequencer) {
      connect(sequencer)
      // A4: neither `claude -p` nor `codex exec --json` echoes the prompt back,
      // so record the user's message on the canonical timeline here — without
      // it a replayed CLI-fallback timeline has no user prompts.
      const messageId = `${options.sessionId}-user-${++userMessageCounter}`
      sequencer.append({
        type: 'user_message',
        text: input.message,
        messageId,
      })
      await options.session.commands.sendMessage(input.message, input.options)
    },
    abort(reason) {
      return options.session.commands.abort(reason)
    },
    respondToPermission(requestId, allowed, remember) {
      return options.session.commands.respondToPermission(requestId, allowed, remember)
    },
    dispose() {
      return options.session.commands.dispose()
    },
  }
}
