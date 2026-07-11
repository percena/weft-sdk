/**
 * turn-phase.ts
 *
 * Turn lifecycle phase detection for assistant turns.
 */

import type { AssistantTurn } from './turn-types'

// ============================================================================
// Turn Lifecycle Phase
// ============================================================================

/**
 * TurnPhase represents the current lifecycle state of an assistant turn.
 *
 * State Machine:
 * ┌─────────────────────────────────────────────────────────────────────────────┐
 * │  PENDING ──(tool_start)──► TOOL_ACTIVE ──(all_tools_done)──► AWAITING      │
 * │     │                          │                                  │        │
 * │     │ text_delta               │ text_delta                       │        │
 * │     ▼                          ▼                                  │        │
 * │  STREAMING ◄───────────── STREAMING (intermediate) ◄──────────────┘        │
 * │     │                          │                                           │
 * │     │ text_complete            │ text_complete + more work coming          │
 * │     ▼                          ▼                                           │
 * │  COMPLETE                   AWAITING                                       │
 * └─────────────────────────────────────────────────────────────────────────────┘
 *
 * Key insight: The "awaiting" phase is the GAP between tool completion and
 * the next action. This was previously invisible, causing the turn card to
 * "disappear" after a tool completed.
 */
export type TurnPhase =
  | 'pending'      // Turn created, waiting for first activity
  | 'tool_active'  // At least one tool is currently running
  | 'awaiting'     // All tools done, waiting for next action (THE GAP!)
  | 'streaming'    // Final response text is actively streaming
  | 'complete'     // Turn is finished

/**
 * Build a stable UI identity key for an assistant turn card.
 *
 * Why this exists:
 * - Backend turnId can be reused across visually split assistant cards
 *   (e.g., steer/interruption boundaries).
 * - Expansion state must be keyed by UI-card identity, not raw backend turnId.
 */
export function getAssistantTurnUiKey(turn: AssistantTurn, index: number): string {
  if (turn.response?.messageId) {
    return `assistant:msg:${turn.response.messageId}`
  }
  return `assistant:turn:${turn.turnId}:${turn.timestamp}:${index}`
}

/**
 * Derives the current phase of a turn from its data.
 *
 * This is a pure function that examines turn state to determine phase.
 * The phase is derived (not tracked), making it testable and consistent.
 *
 * Priority order (first match wins):
 * 1. complete - turn.isComplete is true
 * 2. streaming - response exists and is streaming (final response)
 * 3. tool_active - any TOOL activity has status 'running'
 * 4. awaiting - has activities but no tools running (the gap!)
 * 5. pending - no activities yet
 *
 * Note: Only `type: 'tool'` activities count for tool_active phase.
 * Intermediate text (type: 'intermediate') and status activities (type: 'status')
 * with 'running' status do NOT trigger tool_active - they show "Thinking..." instead.
 */
export function deriveTurnPhase(turn: AssistantTurn): TurnPhase {
  // Complete takes precedence - turn is definitively done
  if (turn.isComplete) {
    return 'complete'
  }

  // Check if final response is streaming
  // Note: turn.response only exists for final responses, not intermediate text
  if (turn.response?.isStreaming) {
    return 'streaming'
  }

  // Check if any TOOL activities are currently running.
  // Only tool-type activities count - intermediate text and status activities
  // with 'running' status should show "Thinking...", not tool spinners.
  const hasRunningTools = turn.activities.some(a => a.type === 'tool' && a.status === 'running')
  if (hasRunningTools) {
    return 'tool_active'
  }

  // Has activities but none running = the "gap" state
  // This is the critical state that was previously not represented,
  // causing the UI to hide the turn card after tool completion.
  if (turn.activities.length > 0) {
    return 'awaiting'
  }

  // No activities yet - turn is pending first action
  return 'pending'
}

/**
 * Determines if the "Thinking..." indicator should be shown.
 *
 * The thinking indicator appears when the turn is active but there's
 * nothing visible to show the user (no running tools, no streaming response).
 * This covers both the initial pending state and the gap after tools complete.
 *
 * @param phase - The current turn phase
 * @param isBuffering - Whether response text is still being buffered
 */
export function shouldShowThinkingIndicator(phase: TurnPhase, isBuffering: boolean): boolean {
  // Show thinking indicator during:
  // - pending: waiting for first activity
  // - awaiting: gap between tool completion and next action
  // - streaming but buffering: text started but not ready to display
  return phase === 'pending' || phase === 'awaiting' || (phase === 'streaming' && isBuffering)
}
