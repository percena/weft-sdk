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
      for (const envelope of projector.project(event)) {
        activeSequencer.append(envelope.item, envelope.rawRef)
      }
    })
  }

  return {
    async sendMessage(input, sequencer) {
      connect(sequencer)
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
