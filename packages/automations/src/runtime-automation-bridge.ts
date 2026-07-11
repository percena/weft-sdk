import type { AgentRuntime } from '@weft/runtime-core'
import type { TimelineEnvelope, TimelineItem } from '@weft/timeline'
import type { PendingPrompt } from './types.ts'
import {
  createAutomationRuntimeGuard,
  executeAutomationPrompt,
  type AutomationRuntimeGuard,
  type ExecuteAutomationPromptResult,
} from './runtime-bridge.ts'
import {
  automationHistoryInputForPromptResult,
  type AutomationHistoryStore,
} from './host-contracts.ts'
import {
  createAutomationTimelineBridge,
  type AutomationInputEvent,
} from './timeline-bridge.ts'

export interface RuntimeAutomationBridge {
  handlePromptsReady(prompts: PendingPrompt[]): Promise<ExecuteAutomationPromptResult[]>
  dispose(): void
}

export interface CreateRuntimeAutomationBridgeOptions {
  runtime: AgentRuntime
  publish(event: AutomationInputEvent): void | Promise<void>
  emitTimelineItem?: (item: TimelineItem) => void | Promise<void>
  historyStore?: AutomationHistoryStore
  guard?: AutomationRuntimeGuard
  onError?: (error: Error) => void
}

export function createRuntimeAutomationBridge(
  options: CreateRuntimeAutomationBridgeOptions,
): RuntimeAutomationBridge {
  const guard = options.guard ?? createAutomationRuntimeGuard()
  const timelineBridge = createAutomationTimelineBridge({
    publish(event) {
      void Promise.resolve(options.publish(event)).catch(error => {
        options.onError?.(toError(error))
      })
    },
  })

  options.runtime.events.connect(
    (envelope: TimelineEnvelope) => timelineBridge.handleTimelineEnvelope(envelope),
    (error: Error) => options.onError?.(error),
  )

  return {
    async handlePromptsReady(prompts) {
      const results: ExecuteAutomationPromptResult[] = []
      for (const prompt of prompts) {
        const result = await executeAutomationPrompt({
          runtime: options.runtime,
          prompt,
          guard,
        })
        results.push(result)

        if (options.historyStore) {
          await options.historyStore.record(automationHistoryInputForPromptResult(prompt, result))
        }

        if (!options.emitTimelineItem) continue
        for (const item of result.timelineItems) {
          await options.emitTimelineItem(item)
        }
      }
      return results
    },
    dispose() {
      options.runtime.events.disconnect()
    },
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
