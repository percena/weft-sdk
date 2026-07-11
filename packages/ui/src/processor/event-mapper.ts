import type { AgentEvent as CoreAgentEvent } from '@weft/core'
import type { TimelineEnvelope } from '@weft/timeline'
import type { ChatEvent, CompleteEvent } from './types.ts'

/**
 * Map a core AgentEvent to the processor's session-scoped event format.
 *
 * Core AgentEvent is the raw SDK/runtime format. The processor expects
 * session-scoped events with its own field names. Keeping this as a pure
 * function makes local-runtime, tests, and React hooks share one mapping.
 */
export function mapCoreEventToProcessorEvent(
  coreEvent: CoreAgentEvent,
  sessionId: string,
): ChatEvent {
  switch (coreEvent.type) {
    case 'text_delta':
      return {
        type: 'text_delta',
        sessionId,
        delta: coreEvent.text,
        turnId: coreEvent.turnId,
      }

    case 'text_complete':
      return {
        type: 'text_complete',
        sessionId,
        text: coreEvent.text,
        isIntermediate: coreEvent.isIntermediate,
        turnId: coreEvent.turnId,
        parentToolUseId: coreEvent.parentToolUseId,
      }

    case 'tool_start':
      return {
        type: 'tool_start',
        sessionId,
        toolUseId: coreEvent.toolUseId,
        toolName: coreEvent.toolName,
        toolInput: coreEvent.input,
        turnId: coreEvent.turnId,
        parentToolUseId: coreEvent.parentToolUseId,
        toolIntent: coreEvent.intent,
        toolDisplayName: coreEvent.displayName,
        toolDisplayMeta: coreEvent.toolDisplayMeta,
      }

    case 'tool_result':
      return {
        type: 'tool_result',
        sessionId,
        toolUseId: coreEvent.toolUseId,
        toolName: coreEvent.toolName,
        result: coreEvent.result,
        isError: coreEvent.isError,
        turnId: coreEvent.turnId,
        parentToolUseId: coreEvent.parentToolUseId,
      }

    case 'complete':
      return {
        type: 'complete',
        sessionId,
        tokenUsage: coreEvent.usage ? {
          inputTokens: coreEvent.usage.inputTokens,
          outputTokens: coreEvent.usage.outputTokens,
          totalTokens: 0,
          contextTokens: 0,
          costUsd: coreEvent.usage.costUsd ?? 0,
          ...(coreEvent.usage.cacheReadTokens !== undefined && { cacheReadTokens: coreEvent.usage.cacheReadTokens }),
          ...(coreEvent.usage.cacheCreationTokens !== undefined && { cacheCreationTokens: coreEvent.usage.cacheCreationTokens }),
          ...(coreEvent.usage.contextWindow !== undefined && { contextWindow: coreEvent.usage.contextWindow }),
        } : undefined,
      }

    case 'error':
      return {
        type: 'error',
        sessionId,
        error: coreEvent.message,
      }

    case 'typed_error':
      return {
        type: 'typed_error',
        sessionId,
        error: coreEvent.error,
      }

    case 'permission_request':
      return {
        type: 'permission_request',
        sessionId,
        request: {
          requestId: coreEvent.requestId,
          toolName: coreEvent.toolName,
          command: coreEvent.command,
          description: coreEvent.description,
          type: coreEvent.permissionType,
          appName: coreEvent.appName,
          reason: coreEvent.reason,
          impact: coreEvent.impact,
          requiresSystemPrompt: coreEvent.requiresSystemPrompt,
          rememberForMinutes: coreEvent.rememberForMinutes,
          commandHash: coreEvent.commandHash,
          approvalTtlSeconds: coreEvent.approvalTtlSeconds,
        },
      }

    case 'status':
      return {
        type: 'status',
        sessionId,
        message: coreEvent.message,
      }

    case 'info':
      return {
        type: 'info',
        sessionId,
        message: coreEvent.message,
      }

    case 'working_directory_changed':
      return {
        type: 'working_directory_changed',
        sessionId,
        workingDirectory: coreEvent.workingDirectory,
      }

    case 'task_backgrounded':
      return {
        type: 'task_backgrounded',
        sessionId,
        toolUseId: coreEvent.toolUseId,
        taskId: coreEvent.taskId,
        intent: coreEvent.intent,
        turnId: coreEvent.turnId,
      }

    case 'shell_backgrounded':
      return {
        type: 'shell_backgrounded',
        sessionId,
        toolUseId: coreEvent.toolUseId,
        shellId: coreEvent.shellId,
        intent: coreEvent.intent,
        turnId: coreEvent.turnId,
      }

    case 'task_progress':
      return {
        type: 'task_progress',
        sessionId,
        toolUseId: coreEvent.toolUseId,
        elapsedSeconds: coreEvent.elapsedSeconds,
        turnId: coreEvent.turnId,
      }

    case 'task_completed':
      return {
        type: 'task_completed',
        sessionId,
        taskId: coreEvent.taskId,
        status: coreEvent.status,
        outputFile: coreEvent.outputFile,
        summary: coreEvent.summary,
        turnId: coreEvent.turnId,
      }

    case 'usage_update':
      return {
        type: 'usage_update',
        sessionId,
        tokenUsage: {
          inputTokens: coreEvent.usage.inputTokens,
          ...(coreEvent.usage.contextWindow !== undefined && { contextWindow: coreEvent.usage.contextWindow }),
        },
      }

    case 'source_activated':
      return {
        type: 'source_activated',
        sessionId,
        sourceSlug: coreEvent.sourceSlug,
        originalMessage: coreEvent.originalMessage,
      }

    case 'shell_killed':
      return {
        type: 'info',
        sessionId,
        message: `Shell killed: ${coreEvent.shellId}`,
      }

    case 'steer_undelivered':
      return {
        type: 'info',
        sessionId,
        message: coreEvent.message,
      }

    case 'reasoning_delta':
      return {
        type: 'text_delta',
        sessionId,
        delta: coreEvent.text,
        turnId: coreEvent.turnId,
        isIntermediate: true,
      }

    case 'reasoning':
      return {
        type: 'text_complete',
        sessionId,
        text: coreEvent.text,
        turnId: coreEvent.turnId,
        isIntermediate: true,
      }

    case 'permission_response':
      // permission_response is an action, not a display event — pass through as info
      return {
        type: 'info',
        sessionId,
        message: `Permission response: ${coreEvent.requestId} allowed=${coreEvent.allowed}`,
      }

    case 'compaction_started':
      return {
        type: 'status',
        sessionId,
        message: 'Compaction started',
        statusType: 'compacting',
      }

    case 'compaction_boundary':
      return {
        type: 'info',
        sessionId,
        message: coreEvent.summary ?? 'Compaction boundary reached',
        statusType: 'compaction_complete',
      }

    default:
      return {
        type: 'info',
        sessionId,
        message: `Unknown event type`,
      }
  }
}

export function mapTimelineEnvelopeToProcessorEvent(
  envelope: TimelineEnvelope,
): ChatEvent {
  const { item, sessionId, timestamp } = envelope

  switch (item.type) {
    case 'assistant_message_delta':
    case 'reasoning_delta':
      return {
        type: 'text_delta',
        sessionId,
        delta: item.text,
        turnId: item.turnId,
        timestamp,
        ...(item.type === 'reasoning_delta' && { isIntermediate: true }),
      }

    case 'assistant_message':
    case 'reasoning':
      return {
        type: 'text_complete',
        sessionId,
        text: item.text,
        turnId: item.turnId,
        timestamp,
        messageId: item.messageId,
        ...(item.type === 'reasoning' && { isIntermediate: true }),
      }

    case 'tool_call':
      return {
        type: 'tool_start',
        sessionId,
        toolUseId: item.callId,
        toolName: normalizeTimelineToolName(item.name),
        toolInput: extractToolInput(item.detail),
        toolIntent: extractToolIntent(item.detail),
        ...optionalToolDisplayName(item.name, item.detail),
        turnId: item.turnId,
        timestamp,
      }

    case 'tool_output_delta':
      return {
        type: 'tool_delta',
        sessionId,
        toolUseId: item.callId,
        delta: item.text,
        stream: item.stream,
        turnId: item.turnId,
        timestamp,
      }

    case 'tool_result':
      return {
        type: 'tool_result',
        sessionId,
        toolUseId: item.callId,
        result: stringifyTimelineResult(item.result),
        isError: item.isError,
        turnId: item.turnId,
        timestamp,
      }

    case 'permission_requested':
      return {
        type: 'permission_request',
        sessionId,
        request: {
          requestId: item.request.requestId,
          toolName: item.request.toolName,
          command: typeof item.request.input?.command === 'string'
            ? item.request.input.command
            : undefined,
          description: `${item.request.toolName} requested permission`,
          reason: item.request.reason,
        },
      }

    case 'turn_completed':
      return {
        type: 'complete',
        sessionId,
        tokenUsage: normalizeTokenUsage(item.usage),
      }

    case 'turn_interrupted':
      // A server-initiated interrupt ends the turn without failure; treat it
      // as a turn-end marker (same downstream effect as turn_completed).
      return {
        type: 'complete',
        sessionId,
      }

    case 'turn_failed':
      return {
        type: 'error',
        sessionId,
        error: stringifyTimelineResult(item.error),
        timestamp,
      }

    case 'session_status':
      return {
        type: 'status',
        sessionId,
        message: item.status,
        timestamp,
      }

    case 'source_state_changed':
      return {
        type: 'info',
        sessionId,
        message: 'Source state changed',
        timestamp,
      }

    case 'runtime_fallback':
      return {
        type: 'info',
        sessionId,
        message: `Runtime fallback: ${item.reason}`,
        timestamp,
      }

    case 'runtime_capability_report':
    case 'permission_policy_changed':
    case 'skill_activated':
    case 'automation_triggered':
    case 'automation_action_result':
    case 'host_state_changed':
    case 'turn_started':
      return {
        type: 'info',
        sessionId,
        message: `Timeline event: ${item.type}`,
        timestamp,
      }

    case 'permission_resolved': {
      // X-E(b): surface the full resolution to the UI as a typed event
      // (requestId / allowed / reason / detail) instead of the generic
      // info line. The pre-formatted `message` preserves the prior
      // "Permission granted/denied" transcript line; the reducer clears
      // the matching pending request from session state. `detail` is the
      // structured permission-response payload (flitro X-E(a):
      // updatedInput / updatedPermissions / interrupt) forwarded verbatim;
      // undefined until the producer emits it on the wire (the timeline
      // type declares it optional + the lenient zod schema keeps unknown
      // fields, so it flows through the moment flitro's X-E(a) lands).
      const allowed = item.resolution?.allowed
      const reason = item.resolution?.reason
      const outcome = allowed ? 'granted' : 'denied'
      return {
        type: 'permission_resolved',
        sessionId,
        requestId: item.requestId,
        allowed: allowed === true,
        reason,
        detail: item.detail,
        message: reason ? `Permission ${outcome}: ${reason}` : `Permission ${outcome}`,
        timestamp,
      }
    }

    case 'user_message':
      return {
        type: 'user_message',
        sessionId,
        message: {
          id: item.messageId,
          role: 'user',
          content: item.text,
          timestamp,
        },
        status: 'accepted',
      }

    case 'compaction_started':
      return {
        type: 'status',
        sessionId,
        message: 'Compaction started',
        statusType: 'compacting',
        timestamp,
      }

    case 'compaction_boundary':
      return {
        type: 'info',
        sessionId,
        message: item.summary ?? 'Compaction boundary reached',
        statusType: 'compaction_complete',
        timestamp,
      }

    default:
      return {
        type: 'info',
        sessionId,
        message: `Timeline event: ${(item as { type: string }).type}`,
        timestamp,
      }
  }
}

function extractToolInput(detail: unknown): Record<string, unknown> | undefined {
  if (!detail || typeof detail !== 'object') return undefined
  if ('input' in detail) {
    const input = (detail as { input?: unknown }).input
    return input && typeof input === 'object'
      ? input as Record<string, unknown>
      : undefined
  }
  if (Array.isArray(detail)) return { changes: detail }
  const record = detail as Record<string, unknown>
  const input = Object.fromEntries(
    Object.entries(record).filter(([key, value]) => key !== 'intent' && value !== undefined),
  )
  return Object.keys(input).length > 0 ? input : undefined
}

function extractToolIntent(detail: unknown): string | undefined {
  if (!detail || typeof detail !== 'object') return undefined
  const commandActionIntent = summarizeCommandActions((detail as { commandActions?: unknown }).commandActions)
  if (commandActionIntent) return commandActionIntent
  if ('intent' in detail) {
    const intent = (detail as { intent?: unknown }).intent
    if (typeof intent === 'string') return intent
  }
  if ('description' in detail) {
    const description = (detail as { description?: unknown }).description
    if (typeof description === 'string') return description
  }
  if ('command' in detail) {
    return summarizeCommandIntent((detail as { command?: unknown }).command)
  }
  return undefined
}

function normalizeTimelineToolName(name: string): string {
  if (name === 'commandExecution') return 'Bash'
  if (name === 'fileChange') return 'Edit'
  return name
}

function optionalToolDisplayName(
  toolName: string,
  detail: unknown,
): { toolDisplayName?: string } {
  // A provider may ship an explicit human-readable label on the tool_call
  // detail (e.g. Flitro sends "GET /api/users" for http_request). Prefer it
  // so the step leads with the operation instead of the opaque tool name.
  if (detail && typeof detail === 'object') {
    const explicit = (detail as { displayName?: unknown }).displayName
    if (typeof explicit === 'string' && explicit) return { toolDisplayName: explicit }
  }
  if (toolName !== 'commandExecution') return {}
  const displayName = commandDisplayName(detail)
  return displayName ? { toolDisplayName: displayName } : {}
}

function commandDisplayName(detail: unknown): string | undefined {
  if (!detail || typeof detail !== 'object') return undefined
  const commandActions = (detail as { commandActions?: unknown }).commandActions
  const commandActionName = displayNameFromCommandActions(commandActions)
  if (commandActionName) return commandActionName
  const command = (detail as { command?: unknown }).command
  if (typeof command !== 'string') return undefined
  const normalized = unwrapShellCommand(command)
  if (/^(sed|cat)\b/.test(normalized)) return 'Read File'
  if (/^(rg|grep)\b/.test(normalized)) return 'Search Files'
  if (/^find\b/.test(normalized)) return 'Find Files'
  if (/^ls\b/.test(normalized)) return 'List Directory'
  if (/^pwd\b/.test(normalized)) return 'Print Directory'
  if (/^git\s+status\b/.test(normalized)) return 'Git Status'
  if (/^git\b/.test(normalized)) return 'Git'
  return 'Run Command'
}

function displayNameFromCommandActions(commandActions: unknown): string | undefined {
  const action = firstCommandAction(commandActions)
  if (!action) return undefined
  const type = commandActionType(action)
  if (type.includes('read')) return 'Read File'
  if (type.includes('search')) return 'Search Files'
  if (type.includes('list')) return 'List Directory'
  return undefined
}

function summarizeCommandActions(commandActions: unknown): string | undefined {
  const action = firstCommandAction(commandActions)
  if (!action) return undefined
  const type = commandActionType(action)
  const query = firstStringValue(action, ['query', 'pattern', 'needle', 'term'])
  const path = firstStringValue(action, ['path', 'filePath', 'file_path', 'directory', 'cwd', 'target'])

  if (type.includes('search')) {
    if (query && path) return `Search ${query} in ${path}`
    if (query) return `Search ${query}`
    if (path) return `Search ${path}`
    return 'Search project files'
  }
  if (type.includes('read')) {
    return path ? `Read ${path}` : 'Read file'
  }
  if (type.includes('list')) {
    return path ? `List ${path}` : 'List directory contents'
  }
  return undefined
}

function firstCommandAction(commandActions: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(commandActions)) return undefined
  return commandActions.find((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
}

function commandActionType(action: Record<string, unknown>): string {
  for (const key of ['type', 'kind', 'action']) {
    const value = action[key]
    if (typeof value === 'string') return value.toLowerCase()
  }
  if ('read' in action) return 'read'
  if ('search' in action) return 'search'
  if ('listFiles' in action || 'list_files' in action) return 'list'
  return ''
}

function firstStringValue(action: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = action[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return undefined
}

function summarizeCommandIntent(command: unknown): string | undefined {
  if (typeof command !== 'string') return undefined
  const normalized = unwrapShellCommand(command)
  const path = firstReadablePath(normalized)
  if (/^(sed|cat)\b/.test(normalized) && path) return `Read ${path}`
  if (/^(rg|grep)\b/.test(normalized)) return 'Search project files'
  if (/^find\b/.test(normalized)) return 'Find project files'
  if (/^ls\b/.test(normalized)) return 'List directory contents'
  if (/^pwd\b/.test(normalized)) return 'Print working directory'
  if (/^git\s+status\b/.test(normalized)) return 'Check git status'
  return normalized.length > 96 ? `${normalized.slice(0, 93)}...` : normalized
}

function unwrapShellCommand(command: string): string {
  const normalized = command.trim()
  const match = normalized.match(/^(?:\/bin\/)?(?:zsh|bash|sh)\s+-lc\s+([\s\S]+)$/)
  if (!match) return normalized
  return stripWrappingQuotes(match[1]!.trim())
}

function stripWrappingQuotes(value: string): string {
  if (value.length < 2) return value
  const first = value[0]
  const last = value[value.length - 1]
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return value.slice(1, -1)
  }
  return value
}

function firstReadablePath(command: string): string | undefined {
  const matches = [...command.matchAll(/(?:^|\s)([^\s'"|;&<>]+(?:README|ARCHITECTURE|\.md|\.tsx|\.ts|\.js|\.json)[^\s'"|;&<>]*)/gi)]
  const candidate = matches.at(-1)?.[1]
  return candidate?.replace(/^\.\/+/, '')
}

function stringifyTimelineResult(result: unknown): string {
  if (typeof result === 'string') return result
  if (result instanceof Error) return result.message
  if (result && typeof result === 'object' && 'message' in result) {
    const msg = (result as { message?: unknown }).message
    if (typeof msg === 'string') return msg
  }
  try {
    return JSON.stringify(result)
  } catch {
    return String(result)
  }
}

function normalizeTokenUsage(usage: unknown): CompleteEvent['tokenUsage'] | undefined {
  if (!usage || typeof usage !== 'object') return undefined
  const record = usage as Record<string, unknown>
  if (typeof record.inputTokens !== 'number' || typeof record.outputTokens !== 'number') {
    return undefined
  }

  return {
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    totalTokens: typeof record.totalTokens === 'number'
      ? record.totalTokens
      : record.inputTokens + record.outputTokens,
    contextTokens: typeof record.contextTokens === 'number' ? record.contextTokens : 0,
    costUsd: typeof record.costUsd === 'number' ? record.costUsd : 0,
    ...(typeof record.cacheReadTokens === 'number' && { cacheReadTokens: record.cacheReadTokens }),
    ...(typeof record.cacheCreationTokens === 'number' && { cacheCreationTokens: record.cacheCreationTokens }),
    ...(typeof record.contextWindow === 'number' && { contextWindow: record.contextWindow }),
  }
}
