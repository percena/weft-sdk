/**
 * TurnCard.tsx
 *
 * Main TurnCard component for displaying assistant turns.
 * Sub-components and utilities have been extracted to:
 * - turn-helpers.ts: Non-React utility functions and constants
 * - tool-display.ts: Tool display formatting (no JSX)
 * - ActivityRow.tsx: Activity display components
 * - ResponseCard.tsx: ResponseCard component and annotation helpers
 * - TodoList.tsx: Todo display components
 */

import * as React from 'react'
import { useMemo, useEffect, useRef, useCallback, useState } from 'react'
import type { AnnotationV1 } from '@weft/core'
import type { ActivityItem, ResponseContent, TodoItem, AnnotationInteractionMode, OpenAnnotationRequest } from './turn-types'
import { motion, AnimatePresence } from 'motion/react'
import { ChevronRight } from 'lucide-react'
import { cn } from '../lib/utils'
import { Spinner } from '../ui/LoadingIndicator'
import { TurnCardActionsMenu } from './TurnCardActionsMenu'
import { computeLastChildSet, groupActivitiesByParent, isActivityGroup, deriveTurnPhase, shouldShowThinkingIndicator, type AssistantTurn } from './turn-utils'

// Imports from extracted modules
import { SIZE_CONFIG } from './turn-helpers'
import { isResponseBuffering, getPreviewText } from './tool-display'
import { ActivityRow, ActivityGroupRow } from './ActivityRow'
import { ResponseCard, } from './ResponseCard'
import { TodoList } from './TodoList'

export interface TurnCardProps {
  /** Session ID for state persistence (optional in shared context) */
  sessionId?: string
  /** Turn ID for state persistence */
  turnId: string
  /** All activities in this turn (tools, thinking, intermediate text) */
  activities: ActivityItem[]
  /** Final response content (may be streaming) */
  response?: ResponseContent
  /** Primary intent/goal for this turn (shown in collapsed preview) */
  intent?: string
  /** Whether content is still being received */
  isStreaming: boolean
  /** Whether this turn is fully complete */
  isComplete: boolean
  /** Start in expanded state */
  defaultExpanded?: boolean
  /** Controlled expansion state (overrides internal state) */
  isExpanded?: boolean
  /** Callback when expansion state changes */
  onExpandedChange?: (expanded: boolean) => void
  /** Controlled expansion state for activity groups */
  expandedActivityGroups?: Set<string>
  /** Callback when activity group expansion changes */
  onExpandedActivityGroupsChange?: (groups: Set<string>) => void
  /** Callback when file path is clicked */
  onOpenFile?: (path: string) => void
  /** Callback when URL is clicked */
  onOpenUrl?: (url: string) => void
  /** Callback to open response in Monaco editor */
  onPopOut?: (text: string) => void
  /** Callback to open turn details in a new window */
  onOpenDetails?: () => void
  /** Callback to open individual activity details in Monaco */
  onOpenActivityDetails?: (activity: ActivityItem) => void
  /** Callback to open all edits/writes in multi-file diff view */
  onOpenMultiFileDiff?: () => void
  /** Whether this turn has any Edit or Write activities */
  hasEditOrWriteActivities?: boolean
  /** TodoWrite tool state - shown at bottom of turn */
  todos?: TodoItem[]
  /** Optional render prop for actions menu (Electron provides dropdown) */
  renderActionsMenu?: () => React.ReactNode
  /** Callback when user accepts the plan (plan responses only) */
  onAcceptPlan?: () => void
  /** Callback when user accepts the plan with compaction (compact conversation first, then execute) */
  onAcceptPlanWithCompact?: () => void
  /** Whether this is the last response in the session (shows Accept Plan button only for last response) */
  isLastResponse?: boolean
  /** Session folder path for stripping from file paths in tool display */
  sessionFolderPath?: string
  /** Display mode: 'detailed' shows all info, 'informative' hides MCP/API names and params */
  displayMode?: 'informative' | 'detailed'
  /** Animate response appearance (for playground demos) */
  animateResponse?: boolean
  /** Hide footers for compact embedding (EditPopover) */
  compactMode?: boolean
  /** Callback to branch the session from a specific message */
  onBranch?: (messageId: string, options?: { newPanel?: boolean }) => void
  /** Callback to add an annotation to a response message */
  onAddAnnotation?: (messageId: string, annotation: AnnotationV1) => void
  /** Callback to remove a persisted annotation from a response message */
  onRemoveAnnotation?: (messageId: string, annotationId: string) => void
  /** Callback to update a persisted annotation */
  onUpdateAnnotation?: (messageId: string, annotationId: string, patch: Partial<AnnotationV1>) => void
  /** Input send key behavior used by follow-up editor */
  sendMessageKey?: 'enter' | 'cmd-enter'
  /** Callback when follow-up is saved via "Save & Send" action */
  onSaveAndSendFollowUp?: (target: { messageId: string; annotationId: string; note: string; selectedText: string }) => void
  /** Whether there are active pending follow-up annotations in the session */
  hasActiveFollowUpAnnotations?: boolean
  /** External request to open a specific annotation in the follow-up island */
  openAnnotationRequest?: OpenAnnotationRequest | null
  /** Annotation interaction mode (viewer uses tooltip-only to suppress the island) */
  annotationInteractionMode?: AnnotationInteractionMode
}

// ============================================================================
// Main Component
// ============================================================================

/**
 * TurnCard - Email-like display for one assistant turn
 *
 * Batches all activities (tools, thinking) into a collapsible section
 * with the final response displayed separately below.
 *
 * Memoized to prevent re-renders of completed turns during session switches.
 * Only complete, non-streaming turns are memoized - active turns always re-render.
 */
export const TurnCard = React.memo(function TurnCard({
  sessionId,
  turnId,
  activities,
  response,
  intent,
  isStreaming,
  isComplete,
  defaultExpanded = false,
  isExpanded: externalIsExpanded,
  onExpandedChange,
  expandedActivityGroups: externalExpandedActivityGroups,
  onExpandedActivityGroupsChange,
  onOpenFile,
  onOpenUrl,
  onPopOut,
  onOpenDetails,
  onOpenActivityDetails,
  onOpenMultiFileDiff,
  hasEditOrWriteActivities,
  todos,
  renderActionsMenu,
  onAcceptPlan,
  onAcceptPlanWithCompact,
  isLastResponse,
  sessionFolderPath,
  displayMode = 'detailed',
  animateResponse = false,
  compactMode = false,
  onBranch,
  onAddAnnotation,
  onRemoveAnnotation,
  onUpdateAnnotation,
  sendMessageKey = 'enter',
  onSaveAndSendFollowUp,
  hasActiveFollowUpAnnotations = false,
  openAnnotationRequest,
  annotationInteractionMode = 'interactive',
}: TurnCardProps) {
  // Derive the turn phase from props using the state machine.
  // This provides a single source of truth for lifecycle state,
  // replacing the old ad-hoc boolean combinations.
  const turnPhase = useMemo(() => {
    // Construct a minimal turn-like object for deriveTurnPhase
    const turnData: Pick<AssistantTurn, 'isComplete' | 'response' | 'activities'> = {
      isComplete,
      response,
      activities,
    }
    return deriveTurnPhase(turnData as AssistantTurn)
  }, [isComplete, response, activities])

  // Use local state if no controlled state provided
  const [localExpandedTurns, setLocalExpandedTurns] = useState<Set<string>>(() => defaultExpanded ? new Set([turnId]) : new Set())
  const isExpanded = externalIsExpanded ?? localExpandedTurns.has(turnId)

  // Track if user has toggled expansion (skip animation on initial mount)
  const hasUserToggled = useRef(false)

  // Ref for scrollable activities container (to scroll to bottom on expand)
  const activitiesContainerRef = useRef<HTMLDivElement>(null)

  // Track if component has mounted (enable fade-in for new activities after mount)
  const hasMounted = useRef(false)
  useEffect(() => {
    hasMounted.current = true
  }, [])

  const toggleExpanded = useCallback(() => {
    hasUserToggled.current = true
    const newExpanded = !isExpanded
    if (onExpandedChange) {
      onExpandedChange(newExpanded)
    } else {
      setLocalExpandedTurns(prev => {
        const next = new Set(prev)
        if (next.has(turnId)) {
          next.delete(turnId)
        } else {
          next.add(turnId)
        }
        return next
      })
    }
  }, [turnId, isExpanded, onExpandedChange])

  // Scroll to bottom of activities list when user manually expands
  // This shows the most recent step instead of the oldest
  useEffect(() => {
    if (isExpanded && hasUserToggled.current && activitiesContainerRef.current) {
      // Wait for expansion animation to complete (250ms) before scrolling
      const timer = setTimeout(() => {
        activitiesContainerRef.current?.scrollTo({
          top: activitiesContainerRef.current.scrollHeight,
          behavior: 'smooth'
        })
      }, 260)
      return () => clearTimeout(timer)
    }
  }, [isExpanded])

  // Use local state for activity groups if no controlled state provided
  const [localExpandedActivityGroups, setLocalExpandedActivityGroups] = useState<Set<string>>(new Set())
  const expandedActivityGroups = externalExpandedActivityGroups ?? localExpandedActivityGroups
  const handleExpandedActivityGroupsChange = onExpandedActivityGroupsChange ?? setLocalExpandedActivityGroups

  // Check if response is in buffering state
  // No polling needed - parent updates trigger re-evaluation naturally
  const isBuffering = useMemo(
    () => isResponseBuffering(response),
    [response]
  )


  // Compute preview text with cross-fade animation
  const previewText = useMemo(
    () => getPreviewText(activities, intent, isStreaming, !!response, isComplete),
    [activities, intent, isStreaming, response, isComplete]
  )

  // Sort activities by timestamp for correct chronological order
  // This handles the live streaming case (turn-utils sorts on flush for completed turns)
  const allSortedActivities = useMemo(
    () => [...activities].sort((a, b) => a.timestamp - b.timestamp),
    [activities]
  )

  // Separate plan activities from regular activities
  // Plans are rendered as full ResponseCards, not in the collapsible activities section
  const planActivities = useMemo(
    () => allSortedActivities.filter(a => a.type === 'plan'),
    [allSortedActivities]
  )
  const sortedActivities = useMemo(
    () => allSortedActivities.filter(a => a.type !== 'plan'),
    [allSortedActivities]
  )

  // Check if we have any Task subagents - if so, use grouped view
  const hasTaskSubagents = useMemo(
    () => sortedActivities.some(a => a.toolName === 'Task'),
    [sortedActivities]
  )

  // Group activities by parent Task for better visualization
  // Only group if there are Task subagents, otherwise keep flat for simpler view
  const groupedActivities = useMemo(
    () => hasTaskSubagents ? groupActivitiesByParent(sortedActivities) : null,
    [sortedActivities, hasTaskSubagents]
  )

  // Pre-compute which activities are last children - O(n) instead of O(n²) per-render check
  // Only used for flat view (non-grouped)
  const lastChildSet = useMemo(
    () => !hasTaskSubagents ? computeLastChildSet(sortedActivities) : new Set<string>(),
    [sortedActivities, hasTaskSubagents]
  )

  // Don't render if nothing to show and turn is complete
  if (activities.length === 0 && !response && isComplete) {
    return null
  }

  // Don't render turns that were interrupted before any meaningful work happened.
  // Hide the turn if:
  // - All tool activities are errors (nothing completed successfully)
  // - Any intermediate activities have no meaningful content (empty or just whitespace)
  // - No response text to show
  // - No plan activities
  // The "Response interrupted" info banner alone is sufficient feedback.
  const hasNoMeaningfulWork = activities.length > 0
    && activities.every(a => {
      // Tool activities must be errors (interrupted/failed)
      if (a.type === 'tool') return a.status === 'error'
      // Intermediate activities must have no meaningful content
      if (a.type === 'intermediate') return !a.content?.trim()
      // Plan activities are meaningful work
      if (a.type === 'plan') return false
      // Other activity types - consider as no meaningful work
      return true
    })
    && !response
  if (hasNoMeaningfulWork) {
    return null
  }

  // Only count non-plan activities for the collapsible section
  const hasActivities = sortedActivities.length > 0

  // Determine if thinking indicator should show using the phase-based state machine.
  // This properly handles the "gap" state (awaiting) between tool completion and next action,
  // which was previously causing the turn card to "disappear".
  const isThinking = shouldShowThinkingIndicator(turnPhase, isBuffering)

  return (
    <div className="space-y-1">
      {/* Activity Section - excluded from search highlighting (matches ripgrep behavior) */}
      {hasActivities && (
        <div className="group select-none" data-search-exclude="true">
          {/* Collapsed Header / Toggle */}
          <button type="button"
            onClick={toggleExpanded}
            className={cn(
              "flex items-center gap-2 w-full pl-2.5 pr-1.5 py-1.5 rounded-[8px] text-left",
              SIZE_CONFIG.fontSize,
              "text-muted-foreground",
              "hover:bg-muted/50 transition-colors",
              "focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            )}
          >
            {/* Chevron with rotation animation - aligned with activity row icons */}
            <motion.div
              initial={false}
              animate={{ rotate: isExpanded ? 90 : 0 }}
              transition={{ duration: 0.15, ease: 'easeOut' }}
              className={cn(SIZE_CONFIG.iconSize, "flex items-center justify-center shrink-0")}
            >
              <ChevronRight className={SIZE_CONFIG.iconSize} />
            </motion.div>

            {/* Step count badge */}
            <span className="-ml-0.5 shrink-0 px-1.5 py-0.5 rounded-[4px] bg-background shadow-minimal text-[10px] font-medium tabular-nums">
              {activities.length}
            </span>

            {/* Preview text with crossfade + inline failure count */}
            <span className="relative flex-1 min-w-0 h-5 flex items-center">
              <AnimatePresence initial={false}>
                <motion.span
                  key={previewText}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.2 }}
                  className="absolute inset-0 truncate"
                >
                  {previewText}
                </motion.span>
              </AnimatePresence>
            </span>

            {/* Turn actions menu - use platform override or default */}
            {renderActionsMenu ? renderActionsMenu() : (
              <TurnCardActionsMenu
                onOpenDetails={onOpenDetails}
                onOpenMultiFileDiff={onOpenMultiFileDiff}
                hasEditOrWriteActivities={hasEditOrWriteActivities}
              />
            )}
          </button>

          {/* Expanded Activity List */}
          <AnimatePresence initial={false}>
            {isExpanded && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{
                  height: { duration: 0.25, ease: [0.4, 0, 0.2, 1] },
                  opacity: { duration: 0.15 }
                }}
                className="overflow-hidden"
              >
                {/* Scrollable container when many activities - subtle background for scroll context */}
                {/* ml-[15px] positions the border-l under the chevron */}
                <div
                  ref={activitiesContainerRef}
                  className={cn(
                    "pl-4 pr-2 py-0 space-y-0.5 border-l-2 border-muted ml-[13px]",
                    sortedActivities.length > SIZE_CONFIG.maxVisibleActivities && "rounded-r-md overflow-y-auto scrollbar-hover py-1.5"
                  )}
                  style={{
                    maxHeight: sortedActivities.length > SIZE_CONFIG.maxVisibleActivities
                      ? SIZE_CONFIG.maxVisibleActivities * SIZE_CONFIG.activityRowHeight
                      : undefined
                  }}
                >
                  <AnimatePresence mode="sync">
                  {/* Grouped view for Task subagents */}
                  {groupedActivities ? (
                    groupedActivities.map((item, index) => (
                      isActivityGroup(item) ? (
                        <ActivityGroupRow
                          key={item.parent.id}
                          group={item}
                          expandedGroups={expandedActivityGroups}
                          onExpandedGroupsChange={handleExpandedActivityGroupsChange}
                          onOpenActivityDetails={onOpenActivityDetails}
                          animationIndex={index}
                          sessionFolderPath={sessionFolderPath}
                          displayMode={displayMode}
                        />
                      ) : (
                        <motion.div
                          key={item.id}
                          initial={
                            hasUserToggled.current || hasMounted.current
                              ? { opacity: 0, x: -8 }
                              : false
                          }
                          animate={{ opacity: 1, x: 0 }}
                          transition={{ delay: hasUserToggled.current ? (index < SIZE_CONFIG.staggeredAnimationLimit ? index * 0.03 : SIZE_CONFIG.staggeredAnimationLimit * 0.03) : 0 }}
                        >
                          <ActivityRow
                            activity={item}
                            onOpenDetails={onOpenActivityDetails ? () => onOpenActivityDetails(item) : undefined}
                            sessionFolderPath={sessionFolderPath}
                            displayMode={displayMode}
                          />
                        </motion.div>
                      )
                    ))
                  ) : (
                    /* Flat view for simple tool calls */
                    sortedActivities.map((activity, index) => (
                      <motion.div
                        key={activity.id}
                        initial={
                          hasUserToggled.current || hasMounted.current
                            ? { opacity: 0, x: -8 }
                            : false
                        }
                        animate={{ opacity: 1, x: 0 }}
                        // Only animate on user toggle, not initial mount
                        transition={{ delay: hasUserToggled.current ? (index < SIZE_CONFIG.staggeredAnimationLimit ? index * 0.03 : SIZE_CONFIG.staggeredAnimationLimit * 0.03) : 0 }}
                      >
                        <ActivityRow
                          activity={activity}
                          onOpenDetails={onOpenActivityDetails ? () => onOpenActivityDetails(activity) : undefined}
                          isLastChild={lastChildSet.has(activity.id)}
                          sessionFolderPath={sessionFolderPath}
                          displayMode={displayMode}
                        />
                      </motion.div>
                    ))
                  )}
                  {/* Thinking/Buffering indicator - shown while waiting for response */}
                  {isThinking && (
                    <motion.div
                      key="thinking"
                      initial={{ opacity: 0, x: -8 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{
                        delay: Math.min(sortedActivities.length, SIZE_CONFIG.staggeredAnimationLimit) * 0.03,
                        duration: 0.3,
                        ease: "easeOut"
                      }}
                      className={cn("flex items-center gap-2 py-0.5 text-muted-foreground/70", SIZE_CONFIG.fontSize)}
                    >
                      <Spinner className={SIZE_CONFIG.spinnerSize} />
                      <span>{isBuffering ? 'Preparing response...' : 'Thinking...'}</span>
                    </motion.div>
                  )}
                  </AnimatePresence>
                </div>
                {/* TodoList - inside expanded section */}
                {todos && todos.length > 0 && (
                  <TodoList todos={todos} />
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}

      {/* Standalone thinking indicator - when no activities but still working */}
      {!hasActivities && isThinking && (
        <div className={cn("flex items-center gap-2 px-3 py-1.5 text-muted-foreground", SIZE_CONFIG.fontSize)}>
          <Spinner className={SIZE_CONFIG.spinnerSize} />
          <span>{isBuffering ? 'Preparing response...' : 'Thinking...'}</span>
        </div>
      )}

      {/* Plan Activities - rendered as full ResponseCards, time-sorted with other activities */}
      {planActivities.map((planActivity, index) => (
        <div key={planActivity.id} className={cn("select-text", (hasActivities || index > 0) && "mt-2")}>
          <ResponseCard
            text={planActivity.content || ''}
            isStreaming={false}
            sessionId={sessionId}
            onOpenFile={onOpenFile}
            onOpenUrl={onOpenUrl}
            onPopOut={onPopOut ? () => onPopOut(planActivity.content || '') : undefined}
            variant="plan"
            messageId={planActivity.messageId}
            annotations={planActivity.annotations}
            onAddAnnotation={onAddAnnotation}
            onRemoveAnnotation={onRemoveAnnotation}
            onUpdateAnnotation={onUpdateAnnotation}
            onSaveAndSendFollowUp={onSaveAndSendFollowUp}
            onAccept={onAcceptPlan}
            onAcceptWithCompact={onAcceptPlanWithCompact}
            isLastResponse={isLastResponse && index === planActivities.length - 1}
            compactMode={compactMode}
            onBranch={onBranch ? (options?: { newPanel?: boolean }) => onBranch(planActivity.messageId ?? planActivity.id, options) : undefined}
            sendMessageKey={sendMessageKey}
            hasActiveFollowUpAnnotations={hasActiveFollowUpAnnotations}
            openAnnotationRequest={openAnnotationRequest}
            annotationInteractionMode={annotationInteractionMode}
          />
        </div>
      ))}

      {/* Response Section - only shown when not buffering */}
      {/* Animated version for playground demos */}
      {animateResponse && (
        <AnimatePresence>
          {response && !isBuffering && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, ease: "easeOut" }}
              className={cn("select-text", hasActivities && "mt-2")}
            >
              <ResponseCard
                text={response.text}
                isStreaming={response.isStreaming}
                streamStartTime={response.streamStartTime}
                sessionId={sessionId}
                onOpenFile={onOpenFile}
                onOpenUrl={onOpenUrl}
                onPopOut={onPopOut ? () => onPopOut(response.text) : undefined}
                variant={response.isPlan ? 'plan' : 'response'}
                messageId={response.messageId}
                annotations={response.annotations}
                onAddAnnotation={onAddAnnotation}
                onRemoveAnnotation={onRemoveAnnotation}
                onUpdateAnnotation={onUpdateAnnotation}
                onSaveAndSendFollowUp={onSaveAndSendFollowUp}
                onAccept={onAcceptPlan}
                onAcceptWithCompact={onAcceptPlanWithCompact}
                isLastResponse={isLastResponse}
                compactMode={compactMode}
                onBranch={onBranch && response.messageId ? (options?: { newPanel?: boolean }) => onBranch(response.messageId!, options) : undefined}
                sendMessageKey={sendMessageKey}
                hasActiveFollowUpAnnotations={hasActiveFollowUpAnnotations}
                openAnnotationRequest={openAnnotationRequest}
                annotationInteractionMode={annotationInteractionMode}
              />
            </motion.div>
          )}
        </AnimatePresence>
      )}
      {/* Non-animated version for regular app use */}
      {!animateResponse && response && !isBuffering && (
        <div className={cn("select-text", hasActivities && "mt-2")}>
          <ResponseCard
            text={response.text}
            isStreaming={response.isStreaming}
            streamStartTime={response.streamStartTime}
            sessionId={sessionId}
            onOpenFile={onOpenFile}
            onOpenUrl={onOpenUrl}
            onPopOut={onPopOut ? () => onPopOut(response.text) : undefined}
            variant={response.isPlan ? 'plan' : 'response'}
            messageId={response.messageId}
            annotations={response.annotations}
            onAddAnnotation={onAddAnnotation}
            onRemoveAnnotation={onRemoveAnnotation}
            onUpdateAnnotation={onUpdateAnnotation}
            onSaveAndSendFollowUp={onSaveAndSendFollowUp}
            onAccept={onAcceptPlan}
            onAcceptWithCompact={onAcceptPlanWithCompact}
            isLastResponse={isLastResponse}
            compactMode={compactMode}
            onBranch={onBranch && response.messageId ? (options?: { newPanel?: boolean }) => onBranch(response.messageId!, options) : undefined}
            sendMessageKey={sendMessageKey}
            hasActiveFollowUpAnnotations={hasActiveFollowUpAnnotations}
            openAnnotationRequest={openAnnotationRequest}
            annotationInteractionMode={annotationInteractionMode}
          />
        </div>
      )}
    </div>
  )
}, (prev, next) => {
  // Conservative memoization: only skip re-render for completed, non-streaming turns
  // Active turns (streaming or incomplete) always re-render to show updates

  // Always re-render streaming turns
  if (prev.isStreaming || next.isStreaming) return false

  // Always re-render incomplete turns
  if (!prev.isComplete || !next.isComplete) return false

  // Re-render if expansion state changed
  if (prev.isExpanded !== next.isExpanded) return false
  if (prev.expandedActivityGroups !== next.expandedActivityGroups) return false

  // Re-render if isLastResponse changed (for Accept Plan button visibility)
  if (prev.isLastResponse !== next.isLastResponse) return false

  // Re-render if displayMode changed
  if (prev.displayMode !== next.displayMode) return false

  // Re-render if annotation interaction mode changed (interactive vs tooltip-only)
  if (prev.annotationInteractionMode !== next.annotationInteractionMode) return false

  // Structural comparison for activities — groupMessagesByTurn creates new
  // arrays on every call even when the underlying data hasn't changed.
  if (prev.activities !== next.activities) {
    if (prev.activities.length !== next.activities.length) return false
    for (let i = 0; i < prev.activities.length; i++) {
      const pa = prev.activities[i]!, na = next.activities[i]!
      if (pa.id !== na.id || pa.status !== na.status || pa.content !== na.content) return false
    }
  }

  // Structural comparison for response object.
  if (prev.response !== next.response) {
    if (!prev.response !== !next.response) return false
    if (prev.response && next.response) {
      if (prev.response.text !== next.response.text ||
          prev.response.isStreaming !== next.response.isStreaming ||
          prev.response.messageId !== next.response.messageId ||
          prev.response.annotations?.length !== next.response.annotations?.length) return false
    }
  }

  // Re-render when external annotation-open requests change
  if (prev.openAnnotationRequest !== next.openAnnotationRequest) return false

  // Re-render when active follow-up annotation state changes (plan CTA label)
  if (prev.hasActiveFollowUpAnnotations !== next.hasActiveFollowUpAnnotations) return false

  // For complete, non-streaming turns: skip re-render only when both
  // session and turn identities match. Prevents stale local UI state from
  // leaking across session switches that may reuse turn IDs/components.
  return prev.sessionId === next.sessionId && prev.turnId === next.turnId
})
