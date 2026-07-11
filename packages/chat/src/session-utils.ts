import type { StoredSession } from '@weft/core'
import type { Session } from '@weft/ui'

/**
 * Convert a processor Session (returned by useAgentChatSession) into a
 * StoredSession that SessionViewer can render.
 *
 * Consumers embedding AgentChatPanel don't need this — it's called internally.
 * This utility is exported for consumers who use useAgentChatSession directly
 * and build their own panel around SessionViewer.
 */
export function toStoredSession(
  session: Session,
  fallbackWorkspaceId = 'local-workspace',
): StoredSession {
  const timestamp = session.createdAt ?? session.lastMessageAt ?? Date.now()
  return {
    id: session.id,
    workspaceId: session.workspaceId ?? fallbackWorkspaceId,
    name: session.name,
    messages: session.messages.map(message => ({
      id: message.id,
      type: message.role,
      content: message.content,
      timestamp: message.timestamp,
      toolName: message.toolName,
      toolUseId: message.toolUseId,
      toolInput: message.toolInput,
      toolResult: message.toolResult,
      toolStatus: message.toolStatus,
      isError: message.isError,
      isIntermediate: message.isIntermediate,
      turnId: message.turnId,
      parentToolUseId: message.parentToolUseId,
      infoLevel: message.infoLevel,
      statusType: message.statusType,
    })),
    createdAt: timestamp,
    lastUsedAt: session.lastMessageAt ?? timestamp,
    tokenUsage: session.tokenUsage ?? {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      contextTokens: 0,
      costUsd: 0,
    },
  }
}

/**
 * Build an empty StoredSession placeholder for the initial state
 * before the event processor has received any events.
 */
export function createEmptyStoredSession(
  sessionId: string,
  workspaceId = 'local-workspace',
  workspaceName?: string,
): StoredSession {
  return {
    id: sessionId,
    workspaceId,
    name: workspaceName,
    messages: [],
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    tokenUsage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      contextTokens: 0,
      costUsd: 0,
    },
  }
}
