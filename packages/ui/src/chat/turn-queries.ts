/**
 * turn-queries.ts
 *
 * Query functions that inspect turns.
 */

import type { ActivityItem, AssistantTurn, Turn, UserTurn } from './turn-types'

/**
 * Get the primary intent for a turn (first available intent from activities)
 */
export function getTurnIntent(turn: AssistantTurn): string | undefined {
  // First check explicit turn intent
  if (turn.intent) return turn.intent

  // Then look for activity intents
  for (const activity of turn.activities) {
    if (activity.intent) return activity.intent
  }

  return undefined
}

/**
 * Check if any activity in the turn is still running
 */
export function hasPendingActivities(turn: AssistantTurn): boolean {
  return turn.activities.some(a => a.status === 'running' || a.status === 'pending' || a.status === 'backgrounded')
}

/**
 * Check if any activity in the turn has an error
 */
export function hasErrorActivities(turn: AssistantTurn): boolean {
  return turn.activities.some(a => a.status === 'error')
}

/**
 * Get a summary of completed activities
 */
export function getActivitySummary(turn: AssistantTurn): string {
  const completed = turn.activities.filter(a => a.status === 'completed').length
  const running = turn.activities.filter(a => a.status === 'running').length
  const errors = turn.activities.filter(a => a.status === 'error').length

  const parts: string[] = []
  if (running > 0) parts.push(`${running} running`)
  if (completed > 0) parts.push(`${completed} completed`)
  if (errors > 0) parts.push(`${errors} failed`)

  return parts.join(', ') || 'No activities'
}

/**
 * Get the last assistant turn from a list of turns.
 * Useful for determining the current/most recent assistant response.
 */
export function getLastAssistantTurn(turns: Turn[]): AssistantTurn | undefined {
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i]
    if (turn?.type === 'assistant') {
      return turn as AssistantTurn
    }
  }
  return undefined
}

/**
 * Get the timestamp of the last user message from turns.
 * Useful for calculating elapsed time since user sent their message.
 */
export function getLastUserMessageTime(turns: Turn[]): number | undefined {
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i]
    if (turn?.type === 'user') {
      return (turn as UserTurn).timestamp
    }
  }
  return undefined
}

/**
 * Check if the last assistant turn is still streaming/processing.
 */
export function isLastTurnStreaming(turns: Turn[]): boolean {
  const lastAssistant = getLastAssistantTurn(turns)
  return lastAssistant?.isStreaming ?? false
}

/**
 * Pre-compute which activities are the last child at their depth level.
 * Returns a Set of activity IDs that are last children.
 * This is O(n) instead of O(n²) for checking during render.
 */
export function computeLastChildSet(activities: ActivityItem[]): Set<string> {
  // Track the last activity for each parentId
  const lastByParent = new Map<string | undefined, string>()

  for (const activity of activities) {
    if (activity.depth && activity.depth > 0) {
      // This activity has a parent - mark it as the (potentially) last child
      lastByParent.set(activity.parentId, activity.id)
    }
  }

  return new Set(lastByParent.values())
}
