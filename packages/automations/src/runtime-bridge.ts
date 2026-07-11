import type { TimelineItem } from '@weft/timeline'
import type { AgentRuntime, CommandOrigin } from '@weft/runtime-core'
import type { PendingPrompt } from './types.ts'

export interface AutomationRuntimeGuard {
  shouldDispatch(key: AutomationDispatchKey): boolean
  remember(key: AutomationDispatchKey): void
}

export interface AutomationDispatchKey {
  runtimeSessionId: string
  automationId: string
  prompt: string
}

export interface ExecuteAutomationPromptOptions {
  runtime: AgentRuntime
  prompt: PendingPrompt
  guard?: AutomationRuntimeGuard
}

export interface ExecuteAutomationPromptResult {
  skipped: boolean
  timelineItems: TimelineItem[]
}

export function createAutomationRuntimeGuard(): AutomationRuntimeGuard {
  const seen = new Set<string>()

  return {
    shouldDispatch(key) {
      return !seen.has(keyString(key))
    },
    remember(key) {
      seen.add(keyString(key))
    },
  }
}

export async function executeAutomationPrompt(
  options: ExecuteAutomationPromptOptions,
): Promise<ExecuteAutomationPromptResult> {
  const automationId = automationIdForPrompt(options.prompt)
  const origin: CommandOrigin = { type: 'automation', id: automationId }
  const dispatchKey: AutomationDispatchKey = {
    runtimeSessionId: options.runtime.sessionId,
    automationId,
    prompt: options.prompt.prompt,
  }
  const triggered = createTriggeredItem(options.prompt, automationId, origin)

  if (options.guard && !options.guard.shouldDispatch(dispatchKey)) {
    return {
      skipped: true,
      timelineItems: [
        triggered,
        createResultItem(options.prompt, automationId, false, {
          skipped: true,
          reason: 'automation loop guard blocked duplicate prompt dispatch',
        }),
      ],
    }
  }

  try {
    await options.runtime.commands.sendMessage(options.prompt.prompt, {
      commandOrigin: origin,
      ...(options.prompt.permissionMode ? { permissionMode: options.prompt.permissionMode } : {}),
    })
    options.guard?.remember(dispatchKey)

    return {
      skipped: false,
      timelineItems: [
        triggered,
        createResultItem(options.prompt, automationId, true),
      ],
    }
  } catch (error) {
    return {
      skipped: false,
      timelineItems: [
        triggered,
        createResultItem(options.prompt, automationId, false, {
          reason: error instanceof Error ? error.message : String(error),
        }),
      ],
    }
  }
}

function automationIdForPrompt(prompt: PendingPrompt): string {
  return prompt.matcherId ?? prompt.automationName ?? 'automation'
}

function createTriggeredItem(
  prompt: PendingPrompt,
  automationId: string,
  origin: CommandOrigin,
): TimelineItem {
  return {
    type: 'automation_triggered',
    automation: {
      automationId,
      origin,
      detail: {
        name: prompt.automationName,
        mentions: prompt.mentions,
        labels: prompt.labels,
        permissionMode: prompt.permissionMode,
      },
    },
  }
}

function createResultItem(
  prompt: PendingPrompt,
  automationId: string,
  success: boolean,
  extras: Record<string, unknown> = {},
): TimelineItem {
  return {
    type: 'automation_action_result',
    result: {
      type: 'prompt',
      automationId,
      success,
      sessionId: prompt.sessionId,
      ...extras,
    },
  }
}

function keyString(key: AutomationDispatchKey): string {
  return `${key.runtimeSessionId}:${key.automationId}:${key.prompt}`
}
