import type { AgentEvent } from '@weft/core'
import {
  createTimelineSequencer,
  type TimelineEnvelope,
  type TimelineItem,
  type TimelineSequencer,
} from '@weft/timeline'
import type { CliAgentProvider } from './types.ts'

export interface CreateCliTimelineProjectorOptions {
  sessionId: string
  provider: CliAgentProvider
  epoch: string
  startSeq?: number
  now?: () => number
}

export interface CliTimelineProjector {
  project(event: AgentEvent): TimelineEnvelope[]
}

export function createCliTimelineProjector(
  options: CreateCliTimelineProjectorOptions,
): CliTimelineProjector {
  const sequencer = createTimelineSequencer(options)
  let lastTurnId: string | undefined

  return {
    project(event) {
      const items = mapAgentEventToTimelineItems(event, lastTurnId)
      const eventTurnId = turnIdFromAgentEvent(event)
      const itemTurnId = items
        .map(item => 'turnId' in item ? item.turnId : undefined)
        .find((turnId): turnId is string => typeof turnId === 'string')
      if (eventTurnId ?? itemTurnId) lastTurnId = eventTurnId ?? itemTurnId

      return items.map(item => append(sequencer, item, event.type))
    },
  }
}

function append(
  sequencer: TimelineSequencer,
  item: TimelineItem,
  providerEventType: string,
): TimelineEnvelope {
  return sequencer.append(item, { providerEventType })
}

function mapAgentEventToTimelineItems(event: AgentEvent, lastTurnId?: string): TimelineItem[] {
  switch (event.type) {
    case 'status':
    case 'info':
      return [{ type: 'session_status', status: event.message }]

    case 'text_delta': {
      const turnId = event.turnId ?? lastTurnId ?? 'turn-local'
      return [{
        type: 'assistant_message_delta',
        text: event.text,
        messageId: messageIdForTurn(turnId),
        turnId,
      }]
    }

    case 'text_complete': {
      const turnId = event.turnId ?? lastTurnId ?? 'turn-local'
      return [{
        type: 'assistant_message',
        text: event.text,
        messageId: messageIdForTurn(turnId),
        turnId,
      }]
    }

    case 'reasoning_delta': {
      const turnId = event.turnId ?? lastTurnId ?? 'turn-local'
      return [{
        type: 'assistant_message_delta',
        text: event.text,
        messageId: messageIdForTurn(turnId),
        turnId,
      }]
    }

    case 'reasoning': {
      const turnId = event.turnId ?? lastTurnId ?? 'turn-local'
      return [{
        type: 'assistant_message',
        text: event.text,
        messageId: messageIdForTurn(turnId),
        turnId,
      }]
    }

    case 'tool_start':
      return [{
        type: 'tool_call',
        callId: event.toolUseId,
        name: event.toolName,
        status: 'running',
        detail: { input: event.input },
        turnId: event.turnId,
      }]

    case 'tool_result':
      return [{
        type: 'tool_result',
        callId: event.toolUseId,
        result: event.result,
        isError: event.isError,
        turnId: event.turnId,
      }]

    case 'permission_request':
      return [{
        type: 'permission_requested',
        request: {
          requestId: event.requestId,
          toolName: event.toolName,
          input: { command: event.command },
          reason: event.reason,
        },
      }]

    case 'permission_response':
      return [{
        type: 'permission_resolved',
        requestId: event.requestId,
        resolution: {
          allowed: event.allowed,
          remember: event.remember ?? false,
        },
      }]

    case 'complete': {
      const items: TimelineItem[] = []
      if (lastTurnId) {
        items.push({
          type: 'turn_completed',
          turnId: lastTurnId,
          usage: event.usage,
        })
      }
      items.push({ type: 'session_status', status: 'ready' })
      return items
    }

    case 'error':
      if (lastTurnId) {
        return [{
          type: 'turn_failed',
          turnId: lastTurnId,
          error: { message: event.message },
        }]
      }
      return [{ type: 'session_status', status: 'failed' }]

    case 'typed_error':
      if (lastTurnId) {
        return [{
          type: 'turn_failed',
          turnId: lastTurnId,
          error: event.error,
        }]
      }
      return [{ type: 'session_status', status: 'failed' }]

    case 'source_activated':
      return [{
        type: 'source_state_changed',
        source: {
          sourceSlug: event.sourceSlug,
          state: 'active',
          originalMessage: event.originalMessage,
        },
      }]

    case 'usage_update':
      return [{ type: 'session_status', status: 'usage_update' }]

    case 'working_directory_changed':
      return [{
        type: 'session_status',
        status: `working_directory:${event.workingDirectory}`,
      }]

    case 'compaction_started':
      return [{ type: 'compaction_started' }]

    case 'compaction_boundary':
      return [{ type: 'compaction_boundary', summary: event.summary }]

    case 'task_backgrounded':
    case 'shell_backgrounded':
    case 'task_progress':
    case 'task_completed':
    case 'shell_killed':
    case 'steer_undelivered':
      return [{ type: 'session_status', status: event.type }]

    default:
      return []
  }
}

function turnIdFromAgentEvent(event: AgentEvent): string | undefined {
  if ('turnId' in event) return event.turnId
  return undefined
}

function messageIdForTurn(turnId: string): string {
  return `${turnId}:assistant`
}
