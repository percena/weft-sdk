/**
 * turn-grouping.ts
 *
 * Core groupMessagesByTurn function plus internal helpers for converting
 * a flat Message[] array into grouped Turn[] for TurnCard rendering.
 */

import type { Message } from '@weft/core'
import { storedToMessage } from '@weft/core'
import type { ActivityItem, ActivityStatus, ActivityType, AssistantTurn, TodoItem, Turn, } from './turn-types'

export { storedToMessage }

// ============================================================================
// Helpers
// ============================================================================

/**
 * Strip error wrapper tags and prefixes from tool error messages.
 * The Claude Agent SDK wraps errors in tags like <error><tool_use_error>...</tool_use_error></error>
 * which aren't user-friendly. Additionally, errorResponse() and blockWithReason() prefix
 * messages with "[ERROR] " so the Codex model can detect failures (the OpenAI API has no
 * error signaling field). We strip that prefix here for clean UI display.
 */
function stripErrorTags(content: string | undefined): string | undefined {
  if (!content) return content
  return content
    .replace(/<\/?error>/gi, '')
    .replace(/<\/?tool_use_error>/gi, '')
    .replace(/^\[ERROR]\s*/i, '')
    .trim()
}

/** Convert tool status from message to ActivityStatus */
function getToolStatus(message: Message): ActivityStatus {
  // response_too_large is success (data was saved, just too large for inline display)
  if (message.errorCode === 'response_too_large') return 'completed'
  if (message.isError) return 'error'
  // Backgrounded takes priority — tool_result arrives before task_backgrounded,
  // so toolResult is set but the task is still running in the background
  if (message.toolStatus === 'backgrounded') return 'backgrounded'
  // Check explicit toolStatus first (set by tool_result handler)
  if (message.toolStatus === 'completed') return 'completed'
  if (message.toolStatus === 'executing') return 'running'
  // Fallback: check if toolResult exists (handles empty string results)
  if (message.toolResult !== undefined) return 'completed'
  if (message.toolStatus === 'pending') return 'pending'
  return 'running'
}

/**
 * Convert message to ActivityItem with incremental depth calculation.
 * Depth is calculated immediately using existing activities, enabling
 * correct tree view rendering during streaming (not just on flush).
 *
 * @param message - The message to convert
 * @param existingActivities - Activities already in the turn (for depth lookup)
 */
function messageToActivity(message: Message, existingActivities: ActivityItem[] = []): ActivityItem {
  const activity: ActivityItem = {
    id: message.id,
    type: 'tool' as ActivityType,
    status: getToolStatus(message),
    toolName: message.toolName,
    toolUseId: message.toolUseId,  // For parent-child matching
    toolInput: message.toolInput,
    content: message.toolResult || message.content,
    intent: message.toolIntent,
    displayName: message.toolDisplayName,  // LLM-generated human-friendly name
    toolDisplayMeta: message.toolDisplayMeta,  // Embedded metadata with base64 icon for viewer
    timestamp: message.timestamp,
    error: message.isError ? stripErrorTags(message.toolResult || message.content) : undefined,
    // parentId: The toolUseId of the parent tool (e.g., Task subagent).
    // This is tracked by session manager's parentToolStack, NOT the SDK's
    // parent_tool_use_id which is for result-matching, not hierarchy.
    parentId: message.parentToolUseId,
    // Background task fields
    taskId: message.taskId,
    shellId: message.shellId,
    elapsedSeconds: message.elapsedSeconds,
    isBackground: message.isBackground,
  }

  // Calculate depth incrementally using existing activities
  // This enables correct tree view rendering during streaming
  if (activity.parentId) {
    const parent = existingActivities.find(a => a.toolUseId === activity.parentId)
    activity.depth = parent ? (parent.depth || 0) + 1 : 1
  } else {
    activity.depth = 0
  }

  return activity
}

/**
 * Calculate nesting depths for activities based on parent-child relationships.
 * Modifies activities in place, adding depth field (0 = root, 1 = child, etc.)
 *
 * Note: With incremental depth calculation in messageToActivity(), this function
 * serves as a safety net for edge cases (e.g., parent arrives after child) and
 * ensures all depths are correctly set when a turn is flushed.
 */
function calculateActivityDepths(activities: ActivityItem[]): void {
  // Build a map of toolUseId -> activity for fast parent lookup
  const toolIdToActivity = new Map<string, ActivityItem>()
  for (const activity of activities) {
    if (activity.toolUseId) {
      toolIdToActivity.set(activity.toolUseId, activity)
    }
  }

  // Calculate depth for each activity (recalculates to handle edge cases)
  for (const activity of activities) {
    let depth = 0
    let parentId = activity.parentId

    // Walk up the parent chain, max 10 levels to prevent infinite loops
    while (parentId && depth < 10) {
      depth++
      const parent = toolIdToActivity.get(parentId)
      parentId = parent?.parentId
    }

    activity.depth = depth
  }
}

// ============================================================================
// TodoWrite Extraction
// ============================================================================

/**
 * Extract todos from TodoWrite tool results in activities.
 * Returns the latest todo state (from the most recent TodoWrite call).
 */
function extractTodosFromActivities(activities: ActivityItem[]): TodoItem[] | undefined {
  // Find all TodoWrite tool results, get the latest one
  const todoWriteActivities = activities
    .filter(a => a.toolName === 'TodoWrite' && a.status === 'completed' && a.content)
    .sort((a, b) => b.timestamp - a.timestamp) // Most recent first

  const latestActivity = todoWriteActivities[0]
  if (!latestActivity) return undefined

  const latestResult = latestActivity.content
  if (!latestResult) return undefined

  try {
    // TodoWrite result is typically a success message, but the input contains the todos
    // We need to get the toolInput which has the todos array
    const input = latestActivity.toolInput
    if (input && Array.isArray(input.todos)) {
      return input.todos.map((todo: { content: string; status: string; activeForm?: string }) => ({
        content: todo.content,
        status: todo.status as 'pending' | 'in_progress' | 'completed',
        activeForm: todo.activeForm,
      }))
    }
  } catch {
    // Failed to parse, return undefined
  }

  return undefined
}

// ============================================================================
// Main Grouping Function
// ============================================================================

/**
 * Groups messages into turns for TurnCard rendering
 *
 * Rules:
 * - User messages flush and start fresh context
 * - Tool messages + intermediate assistant messages belong to current turn
 * - Final assistant message (non-streaming, non-intermediate) flushes the turn
 * - Error/status/info messages are standalone system turns
 *
 * Note: We intentionally ignore turnId for grouping. The SDK generates a new
 * turnId for each API message, but from a user perspective, all work between
 * a user message and the final response should be ONE turn. We use isIntermediate
 * as the signal: isIntermediate=true means more work coming, isIntermediate=false
 * means final response.
 */
export function groupMessagesByTurn(messages: Message[]): Turn[] {
  // Sort by timestamp for correct chronological order
  // This ensures correct turn grouping even if messages are added out of order during streaming
  const sortedMessages = [...messages].sort((a, b) => a.timestamp - b.timestamp)

  // R-M2: single reverse pass replacing the per-message forward scan (O(n²) → O(n))
  const laterToolScan = precomputeLaterToolScan(sortedMessages)

  const turns: Turn[] = []
  let currentTurn: AssistantTurn | null = null

  const flushCurrentTurn = (interrupted = false) => {
    if (currentTurn) {
      // Sort activities by timestamp to ensure correct chronological order
      // This is necessary because buffering can delay when messages are added
      // to the array, causing commentary to appear after tools that started later
      currentTurn.activities.sort((a, b) => a.timestamp - b.timestamp)

      // Calculate nesting depths for parent-child tool relationships
      calculateActivityDepths(currentTurn.activities)

      // Extract todos from TodoWrite tool results
      currentTurn.todos = extractTodosFromActivities(currentTurn.activities)

      // If interrupted, mark any running activities as error and todos as interrupted
      if (interrupted) {
        currentTurn.activities = currentTurn.activities.map(activity =>
          activity.status === 'running'
            ? { ...activity, status: 'error' as ActivityStatus, error: 'Interrupted' }
            : activity
        )
        if (currentTurn.todos) {
          currentTurn.todos = currentTurn.todos.map(todo =>
            todo.status === 'in_progress'
              ? { ...todo, status: 'interrupted' as const }
              : todo
          )
        }
        currentTurn.isStreaming = false
        currentTurn.isComplete = true
      }

      // If no response but we have intermediate text, promote the last one to response
      // Don't do this for interrupted turns - respect user interruptions
      // Don't do this for turns with plans - the plan is the final output
      // Only promote when turn is complete (processing indicator hidden)
      const hasPlan = currentTurn.activities.some(a => a.type === 'plan')
      if (!interrupted && !hasPlan && !currentTurn.response && currentTurn.isComplete && currentTurn.activities.length > 0) {
        // Find the last intermediate text activity (reverse to get most recent)
        const lastTextActivity = [...currentTurn.activities]
          .reverse()
          .find(a => a.type === 'intermediate' && a.content)

        if (lastTextActivity?.content) {
          currentTurn.response = {
            text: lastTextActivity.content,
            isStreaming: false,
            messageId: lastTextActivity.id,
          }
        }
      }

      turns.push(currentTurn)
      currentTurn = null
    }
  }

  for (let index = 0; index < sortedMessages.length; index += 1) {
    const message = sortedMessages[index]
    if (!message) continue
    // Auth-request messages are standalone turns (credential input, OAuth flows)
    if (message.role === 'auth-request') {
      // If there's a current turn, it's complete (something follows it)
      if (currentTurn) currentTurn.isComplete = true
      flushCurrentTurn()
      turns.push({
        type: 'auth-request',
        message,
        timestamp: message.timestamp,
      })
      continue
    }

    // User messages are their own turn
    if (message.role === 'user') {
      // If there's a current turn, it's complete (something follows it)
      if (currentTurn) currentTurn.isComplete = true
      flushCurrentTurn()
      turns.push({
        type: 'user',
        message,
        timestamp: message.timestamp,
      })
      continue
    }

    // Status messages become activities within the current turn (don't break turn)
    if (message.role === 'status') {
      if (!currentTurn) {
        // Start a new turn for this status
        currentTurn = {
          type: 'assistant',
          turnId: message.id,
          activities: [],
          response: undefined,
          intent: undefined,
          isStreaming: true,
          isComplete: false,
          timestamp: message.timestamp,
        }
      }
      const statusActivity: ActivityItem = {
        id: message.id,
        type: 'status',
        status: 'running',
        content: message.content,
        timestamp: message.timestamp,
        statusType: message.statusType,
        depth: 0,
      }
      currentTurn.activities.push(statusActivity)
      continue
    }

    // Info messages with compaction_complete update the matching status activity
    if (message.role === 'info' && message.statusType === 'compaction_complete') {
      if (currentTurn) {
        const statusIdx = currentTurn.activities.findIndex(
          a => a.type === 'status' && a.statusType === 'compacting'
        )
        const existingActivity = currentTurn.activities[statusIdx]
        if (statusIdx !== -1 && existingActivity) {
          currentTurn.activities[statusIdx] = {
            ...existingActivity,
            status: 'completed',
            content: message.content,
          }
        }
      }
      continue  // Don't create a separate system turn
    }

    // Error/info/warning messages are standalone
    if (message.role === 'error' || message.role === 'info' || message.role === 'warning') {
      // Flush current turn first (mark as interrupted if info message)
      const isInterruption = message.role === 'info'
      // For error/warning (not info), the previous turn is complete
      if (currentTurn && !isInterruption) currentTurn.isComplete = true
      flushCurrentTurn(isInterruption)
      turns.push({
        type: 'system',
        message,
        timestamp: message.timestamp,
      })
      continue
    }

    // Plan messages are added as activities to be time-sorted with tool calls
    // This ensures SubmitPlan tool appears before the plan content chronologically
    if (message.role === 'plan') {
      if (!currentTurn) {
        // Edge case: plan without preceding activities
        currentTurn = {
          type: 'assistant',
          turnId: message.turnId || message.id,
          activities: [],
          response: undefined,
          intent: undefined,
          isStreaming: false,
          isComplete: false,
          timestamp: message.timestamp,
        }
      }
      // Add plan as an activity so it gets time-sorted with other activities
      currentTurn.activities.push({
        id: message.id,
        type: 'plan' as ActivityType,
        status: 'completed',
        content: message.content,
        messageId: message.id,
        annotations: message.annotations,
        displayName: 'Plan',
        timestamp: message.timestamp,
      })
      currentTurn.isStreaming = false
      currentTurn.isComplete = true
      flushCurrentTurn()
      continue
    }

    // Tool messages belong to current assistant turn
    if (message.role === 'tool') {
      // Streaming tool output may populate toolResult before execution is done.
      const isToolComplete = message.toolStatus === 'completed' || message.toolStatus === 'error'
      if (!currentTurn) {
        // Start a new turn
        currentTurn = {
          type: 'assistant',
          turnId: message.turnId || message.id,
          activities: [],
          response: undefined,
          intent: message.toolIntent,
          isStreaming: !isToolComplete,
          isComplete: false,
          timestamp: message.timestamp,
        }
      }
      // Always add to current turn (ignoring turnId differences)
      // Pass existing activities for incremental depth calculation
      currentTurn.activities.push(messageToActivity(message, currentTurn.activities))
      currentTurn.isStreaming = !isToolComplete
      continue
    }

    // Assistant messages are the response part of a turn
    if (message.role === 'assistant') {
      const shouldRenderAsCommentary = !message.isIntermediate &&
        !message.isPending &&
        hasLaterToolBeforeBoundary(laterToolScan, sortedMessages, index)

      // Intermediate messages OR pending messages (don't know yet) are activities, not responses
      // Pending: streaming text where we don't yet know if it's intermediate - treat as intermediate
      // until text_complete arrives with the definitive isIntermediate flag
      if (message.isIntermediate || message.isPending || shouldRenderAsCommentary) {
        if (!currentTurn) {
          // Start a new turn for this intermediate message
          currentTurn = {
            type: 'assistant',
            turnId: message.turnId || message.id,
            activities: [],
            response: undefined,
            intent: undefined,
            isStreaming: !!message.isPending,
            isComplete: false,
            timestamp: message.timestamp,
          }
        }
        // Always add to current turn as activity (ignoring turnId differences)
        // Pending messages show as 'running' until we know they're complete
        // Include parentId for intermediate messages to support nesting within subagents
        const intermediateActivity: ActivityItem = {
          id: message.id,
          type: 'intermediate',
          status: message.isPending ? 'running' : 'completed',
          content: message.content,
          timestamp: message.timestamp,
          parentId: message.parentToolUseId,
        }
        // Calculate depth for intermediate messages too
        if (intermediateActivity.parentId) {
          const parent = currentTurn.activities.find(a => a.toolUseId === intermediateActivity.parentId)
          intermediateActivity.depth = parent ? (parent.depth || 0) + 1 : 1
        } else {
          intermediateActivity.depth = 0
        }
        currentTurn.activities.push(intermediateActivity)

        // Update turn streaming state based on this message
        // If message is no longer pending/streaming, update turn state accordingly
        if (!message.isPending && !message.isStreaming) {
          currentTurn.isStreaming = false
        }
        continue
      }

      // Non-intermediate assistant message = final response
      if (!currentTurn) {
        // This is a response-only turn (no tools)
        currentTurn = {
          type: 'assistant',
          turnId: message.turnId || message.id,
          activities: [],
          response: undefined,
          intent: undefined,
          isStreaming: !!message.isStreaming,
          isComplete: !message.isStreaming,
          timestamp: message.timestamp,
        }
      }

      // Set as response on current turn (ignoring turnId differences)
      currentTurn.response = {
        text: message.content,
        isStreaming: !!message.isStreaming,
        streamStartTime: message.isStreaming ? message.timestamp : undefined,
        messageId: message.id,
        annotations: message.annotations,
      }
      currentTurn.isStreaming = !!message.isStreaming
      currentTurn.isComplete = !message.isStreaming

      // Flush when turn is complete (non-streaming = final response received)
      if (!message.isStreaming) {
        flushCurrentTurn()
      }
    }
  }

  // Flush any remaining turn
  flushCurrentTurn()

  return mergeAdjacentAssistantTurns(turns)
}

/**
 * R-M2: precomputed state for hasLaterToolBeforeBoundary.
 *
 * The original implementation ran a forward linear scan from every final
 * assistant message, making groupMessagesByTurn O(n²) on tool-heavy sessions.
 * A single reverse pass computes, for each index, whether scanning forward
 * from that index reaches a tool message before a boundary.
 *
 * Boundary semantics (preserved exactly from the forward scan):
 * - user / error / warning / auth-request → hard boundary (false)
 * - final assistant (non-intermediate, non-pending) with a turnId DIFFERENT
 *   from the queried message's turnId → boundary (false); final assistants
 *   sharing the queried turnId are scanned past
 * - tool → true
 * - every other role (status, info, plan, intermediate/pending assistant) is
 *   scanned past
 *
 * Because the final-assistant boundary depends on the queried message's
 * turnId, each state records the first tool/hard-boundary stop ahead plus a
 * summary of the final-assistant turnIds seen before that stop: the scan from
 * index i reaches a tool iff the stop is a tool AND every final assistant in
 * between carries messages[i].turnId (i.e. no finals at all, or a single
 * shared turnId equal to it — two distinct turnIds can never both match).
 */
type LaterToolStop = 'none' | 'boundary' | 'tool'

interface LaterToolScanState {
  stop: LaterToolStop
  /** True when a final assistant message sits between here and the tool stop */
  hasFinalAssistant: boolean
  /** True when those finals carry two or more distinct turnIds */
  multipleFinalTurnIds: boolean
  /** The single shared turnId of those finals (meaningful when hasFinalAssistant && !multipleFinalTurnIds) */
  finalTurnId: Message['turnId']
}

function precomputeLaterToolScan(messages: Message[]): LaterToolScanState[] {
  // states[i] describes a forward scan starting AT index i (inclusive);
  // the query for message index i reads states[i + 1].
  const states: LaterToolScanState[] = new Array(messages.length + 1)
  states[messages.length] = { stop: 'none', hasFinalAssistant: false, multipleFinalTurnIds: false, finalTurnId: undefined }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    const nextState = states[index + 1] as LaterToolScanState

    // Holes are skipped, matching `if (!next) continue` in the forward scan
    if (!message) {
      states[index] = nextState
      continue
    }

    if (message.role === 'user' || message.role === 'error' || message.role === 'warning' || message.role === 'auth-request') {
      states[index] = { stop: 'boundary', hasFinalAssistant: false, multipleFinalTurnIds: false, finalTurnId: undefined }
      continue
    }

    if (message.role === 'tool') {
      states[index] = { stop: 'tool', hasFinalAssistant: false, multipleFinalTurnIds: false, finalTurnId: undefined }
      continue
    }

    if (message.role === 'assistant' && !message.isIntermediate && !message.isPending && nextState.stop === 'tool') {
      // A final assistant before a tool stop: fold its turnId into the summary.
      // (When the stop ahead is a boundary or end-of-list, the summary is
      // irrelevant — the state propagates unchanged below.)
      states[index] = {
        stop: 'tool',
        hasFinalAssistant: true,
        multipleFinalTurnIds: nextState.multipleFinalTurnIds ||
          (nextState.hasFinalAssistant && nextState.finalTurnId !== message.turnId),
        finalTurnId: nextState.hasFinalAssistant ? nextState.finalTurnId : message.turnId,
      }
      continue
    }

    // All other roles (status, info, plan, intermediate/pending assistant) are
    // transparent to the scan
    states[index] = nextState
  }

  return states
}

function hasLaterToolBeforeBoundary(states: LaterToolScanState[], messages: Message[], index: number): boolean {
  const current = messages[index]
  if (!current) return false

  const state = states[index + 1]
  if (!state || state.stop !== 'tool') return false
  if (!state.hasFinalAssistant) return true
  if (state.multipleFinalTurnIds) return false
  return state.finalTurnId === current.turnId
}

function mergeAdjacentAssistantTurns(turns: Turn[]): Turn[] {
  const merged: Turn[] = []

  for (const turn of turns) {
    const previous = merged[merged.length - 1]
    if (
      previous?.type === 'assistant' &&
      turn.type === 'assistant' &&
      previous.turnId === turn.turnId &&
      shouldMergeAssistantTurns(previous, turn)
    ) {
      const activities = [...previous.activities, ...turn.activities].sort((a, b) => a.timestamp - b.timestamp)
      calculateActivityDepths(activities)
      const isComplete = previous.isComplete || turn.isComplete
      merged[merged.length - 1] = {
        ...previous,
        activities,
        response: previous.response ?? turn.response,
        intent: previous.intent ?? turn.intent,
        isStreaming: (previous.isStreaming || turn.isStreaming) && !isComplete,
        isComplete,
        timestamp: Math.min(previous.timestamp, turn.timestamp),
        todos: extractTodosFromActivities(activities),
      }
      continue
    }

    merged.push(turn)
  }

  return merged
}

function shouldMergeAssistantTurns(left: AssistantTurn, right: AssistantTurn): boolean {
  // Two final responses with the same backend turnId can represent an intentional
  // visual split (for example interruption/steering boundaries). Only merge when
  // at least one side is activity-only or response-only.
  return !(left.response && right.response)
}
