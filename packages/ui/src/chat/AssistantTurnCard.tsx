import { useState, useEffect } from 'react'
import { TurnCard } from './TurnCard'
import type { ActivityItem, Turn } from './turn-types'

/**
 * Standard assistant-turn presentation: a TurnCard with local expand state that
 * stays open while the turn streams, the detailed display mode, and a click
 * handler that surfaces a step for inspection. Shared so the web app and the
 * embeddable chat panel render thinking steps identically.
 */
export function AssistantTurnCard({
  sessionId,
  turn,
  isLast,
  onInspectActivity,
}: {
  sessionId: string
  turn: Extract<Turn, { type: 'assistant' }>
  isLast: boolean
  onInspectActivity: (activity: ActivityItem) => void
}) {
  const [isExpanded, setIsExpanded] = useState(true)
  const [expandedActivityGroups, setExpandedActivityGroups] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (turn.isStreaming) {
      setIsExpanded(true)
    }
  }, [turn.isStreaming])

  return (
    <TurnCard
      sessionId={sessionId}
      turnId={turn.turnId}
      activities={turn.activities}
      response={turn.response}
      intent={turn.intent}
      isStreaming={turn.isStreaming}
      isComplete={turn.isComplete}
      isExpanded={isExpanded}
      onExpandedChange={setIsExpanded}
      expandedActivityGroups={expandedActivityGroups}
      onExpandedActivityGroupsChange={setExpandedActivityGroups}
      onOpenActivityDetails={onInspectActivity}
      hasEditOrWriteActivities={turn.activities.some(activity =>
        activity.toolName === 'Edit' || activity.toolName === 'Write'
      )}
      todos={turn.todos}
      isLastResponse={isLast}
      displayMode="detailed"
      animateResponse
      annotationInteractionMode="tooltip-only"
    />
  )
}
