import type { ReactNode } from 'react'
import { useMemo, useState, useCallback } from 'react'
import type { Message } from '@weft/core'
import { cn } from '../lib/utils'
import { CHAT_LAYOUT } from '../lib/layout'
import type { PlatformActions } from '../context'
import { TurnCard } from './TurnCard'
import { UserMessageBubble } from './UserMessageBubble'
import { SystemMessage } from './SystemMessage'
import { PermissionRequestCard } from './PermissionRequestCard'
import {
  groupMessagesByTurn,
  getAssistantTurnUiKey,
  type ActivityItem,
} from './turn-utils'
import type { AnnotationInteractionMode } from './turn-types'

export interface ChatTranscriptProps {
  messages: Message[]
  platformActions?: PlatformActions
  className?: string
  onTurnClick?: (turnId: string) => void
  onActivityClick?: (activity: ActivityItem) => void
  defaultExpanded?: boolean
  displayMode?: 'informative' | 'detailed'
  animateResponse?: boolean
  annotationInteractionMode?: AnnotationInteractionMode
  sessionId?: string
  sessionFolderPath?: string
  children?: ReactNode
}

export function ChatTranscript({
  messages,
  platformActions = {},
  className,
  onTurnClick,
  onActivityClick,
  defaultExpanded = false,
  displayMode = 'detailed',
  animateResponse = false,
  annotationInteractionMode = 'tooltip-only',
  sessionId = '',
  sessionFolderPath,
  children,
}: ChatTranscriptProps) {
  const turns = useMemo(() => groupMessagesByTurn(messages), [messages])

  const [expandedTurns, setExpandedTurns] = useState<Set<string>>(() => {
    if (defaultExpanded) {
      return new Set(
        turns
          .map((turn, index) =>
            turn.type === 'assistant' ? getAssistantTurnUiKey(turn, index) : null
          )
          .filter((key): key is string => !!key)
      )
    }
    return new Set()
  })

  const [expandedActivityGroups, setExpandedActivityGroups] = useState<Set<string>>(new Set())

  const handleExpandedChange = useCallback((turnId: string, expanded: boolean) => {
    setExpandedTurns(prev => {
      const next = new Set(prev)
      if (expanded) {
        next.add(turnId)
      } else {
        next.delete(turnId)
      }
      return next
    })
  }, [])

  const handleExpandedActivityGroupsChange = useCallback((groups: Set<string>) => {
    setExpandedActivityGroups(groups)
  }, [])

  const handleOpenActivityDetails = useCallback((activity: ActivityItem) => {
    if (onActivityClick) {
      onActivityClick(activity)
    } else if (platformActions.onOpenActivityDetails) {
      platformActions.onOpenActivityDetails(sessionId, activity.id)
    }
  }, [onActivityClick, platformActions, sessionId])

  const handleOpenTurnDetails = useCallback((turnId: string) => {
    if (onTurnClick) {
      onTurnClick(turnId)
    } else if (platformActions.onOpenTurnDetails) {
      platformActions.onOpenTurnDetails(sessionId, turnId)
    }
  }, [onTurnClick, platformActions, sessionId])

  return (
    <div
      className={cn(
        CHAT_LAYOUT.maxWidth,
        'mx-auto',
        CHAT_LAYOUT.containerPadding,
        CHAT_LAYOUT.messageSpacing,
        'py-6',
        className,
      )}
    >
      {turns.map((turn, index) => {
        if (turn.type === 'user') {
          return (
            <div key={turn.message.id} className={CHAT_LAYOUT.userMessagePadding}>
              <UserMessageBubble
                content={turn.message.content}
                attachments={turn.message.attachments}
                badges={turn.message.badges}
                onUrlClick={platformActions.onOpenUrl}
                onFileClick={platformActions.onOpenFile}
              />
            </div>
          )
        }

        if (turn.type === 'system') {
          const msgType = turn.message.role === 'error' ? 'error' :
                         turn.message.role === 'warning' ? 'warning' :
                         turn.message.role === 'info' ? 'info' : 'system'
          return (
            <SystemMessage
              key={turn.message.id}
              content={turn.message.content}
              type={msgType}
            />
          )
        }

        if (turn.type === 'assistant') {
          const assistantUiKey = getAssistantTurnUiKey(turn, index)
          return (
            <TurnCard
              key={assistantUiKey}
              turnId={turn.turnId}
              activities={turn.activities}
              response={turn.response}
              intent={turn.intent}
              isStreaming={turn.isStreaming}
              isComplete={turn.isComplete}
              isExpanded={expandedTurns.has(assistantUiKey)}
              onExpandedChange={(expanded) => handleExpandedChange(assistantUiKey, expanded)}
              onOpenFile={platformActions.onOpenFile}
              onOpenUrl={platformActions.onOpenUrl}
              onPopOut={platformActions.onOpenMarkdownPreview
                ? (text: string) => { platformActions.onOpenMarkdownPreview!(sessionId, text) }
                : undefined
              }
              onOpenDetails={() => handleOpenTurnDetails(turn.turnId)}
              onOpenActivityDetails={handleOpenActivityDetails}
              todos={turn.todos}
              expandedActivityGroups={expandedActivityGroups}
              onExpandedActivityGroupsChange={handleExpandedActivityGroupsChange}
              hasEditOrWriteActivities={turn.activities.some(a =>
                a.toolName === 'Edit' || a.toolName === 'Write'
              )}
              onOpenMultiFileDiff={platformActions.onOpenMultiFileDiff
                ? () => platformActions.onOpenMultiFileDiff!(sessionId, turn.turnId)
                : undefined
              }
              sessionId={sessionId}
              sessionFolderPath={sessionFolderPath}
              displayMode={displayMode}
              animateResponse={animateResponse}
              annotationInteractionMode={annotationInteractionMode}
            />
          )
        }

        if (turn.type === 'auth-request') {
          return (
            <PermissionRequestCard
              key={turn.message.id}
              requestId={turn.message.authRequestId ?? turn.message.id}
              toolName={turn.message.authSourceName ?? 'Authentication'}
              reason={turn.message.authDescription ?? turn.message.content}
              input={turn.message.authSourceSlug ? { sourceSlug: turn.message.authSourceSlug } : undefined}
              isActive={turn.message.authStatus === 'pending'}
              previousResolution={
                turn.message.authStatus === 'completed' || turn.message.authStatus === 'cancelled'
                  ? {
                      allowed: turn.message.authStatus === 'completed',
                      reason: turn.message.authError,
                    }
                  : undefined
              }
              onAllow={platformActions.onPermissionAllow
                ? (requestId, remember) => platformActions.onPermissionAllow!(requestId, true, remember)
                : undefined
              }
              onDeny={platformActions.onPermissionAllow
                ? (requestId) => platformActions.onPermissionAllow!(requestId, false)
                : undefined
              }
            />
          )
        }

        return null
      })}

      {children}
    </div>
  )
}
