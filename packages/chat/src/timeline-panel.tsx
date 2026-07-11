/**
 * TimelineAgentChatPanel - Timeline-based interactive chat panel
 *
 * Uses the timeline-driven session model (TimelineAgentChatSessionModel)
 * for rendering turns, permission prompts, and runtime detail inspection.
 * This is the Stage 2 upgrade over the event-based AgentChatPanel,
 * designed to work with AgentRuntime from @weft/runtime-core.
 */

import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AssistantTurnCard,
  ActivityDetailsPanel,
  UserMessageBubble,
  PermissionRequestCard,
  PermissionModeMenu,
  PendingIndicator,
  type ActivityItem,
  type PlatformActions,
} from '@weft/ui'
import type { AgentRuntime, PermissionMode, RuntimeCapabilityReport } from '@weft/runtime-core'
import {
  useTimelineAgentChatSession,
  createTimelineDetailItems,
  type TimelineDetailItem,
} from './use-agent-chat-session.ts'
import { findActivePermissionRequest } from './find-permission-request-utils.ts'

export interface TimelineAgentChatPanelProps {
  /** Agent runtime instance from runtime-core */
  runtime: AgentRuntime
  /** Workspace identifier */
  workspaceId?: string
  /** Workspace display name */
  workspaceName?: string
  /** Platform actions for file/URL handling */
  platformActions?: PlatformActions
  /** Placeholder text for the input area */
  placeholder?: string
  /** Whether to show the runtime status bar */
  showStatusBar?: boolean
  /** Whether to show the runtime detail sidebar panel */
  showDetailPanel?: boolean
  /** Additional className */
  className?: string
}

function summarizeCapability(report: RuntimeCapabilityReport | null): string {
  // No report yet (the capability preflight runs lazily on the first
  // sendMessage, not at bootstrap) → idle, NOT a connection failure. The
  // connection state is conveyed by the status dot (Connected/Reconnecting/
  // Not connected) to its left; returning '' here avoids a misleading
  // "Not connected" while idle.
  if (!report) return ''
  const parts: string[] = []
  if (report.selected) parts.push(report.selected)
  if (report.fallback) parts.push('fallback')
  if (report.auth?.configured) parts.push('auth ✓')
  else parts.push('auth ✗')
  return parts.join(' · ')
}

export function TimelineAgentChatPanel({
  runtime,
  workspaceId = 'local-workspace',
  workspaceName = 'Local Workspace',
  platformActions,
  placeholder = 'Message agent',
  showStatusBar = true,
  showDetailPanel = false,
  className,
}: TimelineAgentChatPanelProps) {
  const chat = useTimelineAgentChatSession({ runtime, workspaceId, workspaceName })
  const [draft, setDraft] = useState('')
  const [selectedActivity, setSelectedActivity] = useState<ActivityItem | null>(null)
  const [_selectedDetail, setSelectedDetail] = useState<TimelineDetailItem | null>(null)
  // Tool-approval policy for outgoing messages. Defaults to "ask" so the agent
  // pauses for confirmation before each tool call; the user can switch to
  // silent auto-execute. Applied per message, so changing it never reconnects.
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('ask')
  const [isPermMenuOpen, setIsPermMenuOpen] = useState(false)

  const runtimeState = runtime.getState()
  const isWaitingPermission = runtimeState.status === 'waiting_for_permission'
  const waitingRequestId = runtimeState.waitingPermissionRequestId

  const { visibleTurns, showPendingIndicator } = useMemo(() => {
    const lastTurn = chat.turns.at(-1)
    if (!chat.isConnected && !chat.isReconnecting) return { visibleTurns: chat.turns, showPendingIndicator: false }
    if (
      lastTurn?.type === 'assistant' &&
      lastTurn.activities.length === 0 &&
      !lastTurn.response &&
      lastTurn.isStreaming
    ) {
      return { visibleTurns: chat.turns.slice(0, -1), showPendingIndicator: true }
    }
    if (lastTurn?.type === 'user') return { visibleTurns: chat.turns, showPendingIndicator: true }
    return { visibleTurns: chat.turns, showPendingIndicator: false }
  }, [chat.turns, chat.isConnected, chat.isReconnecting])

  const permissionRequest = useMemo(() => {
    if (!isWaitingPermission || !waitingRequestId) return null
    return findActivePermissionRequest(chat.timeline)
  }, [isWaitingPermission, waitingRequestId, chat.timeline])

  // Timeline detail items for the sidebar
  const detailItems = useMemo(
    () => createTimelineDetailItems(chat.timeline),
    [chat.timeline],
  )

  const scrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [])

  // Message submit handler
  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const message = draft.trim()
    if (!message) return
    setDraft('')
    try {
      await chat.sendMessage(message, { permissionMode })
    } catch {
      // useTimelineAgentChatSession owns the visible error state
    }
  }

  const handlePermissionAllow = useCallback((requestId: string, remember?: boolean) => {
    void chat.respondToPermission(requestId, true, remember)
  }, [chat])

  const handlePermissionDeny = useCallback((requestId: string) => {
    void chat.respondToPermission(requestId, false)
  }, [chat])

  return (
    <div className={`flex flex-col h-full ${className ?? ''}`}>
      {/* Runtime status bar.
          The "Connection" reflects the weftd backend LINK, not the SSE event
          stream. Idle (no active run) is NOT "Not connected": the session is
          bootstrapped + the link is fine → show "Connected" (+ "idle"). The SSE
          transport only flips isConnected on the first EVENT, so it is false
          while idle — don't let that read as "Not connected". "Not connected"
          appears ONLY on a real transport failure (the runtime errored, e.g.
          the SSE gave up after max reconnects) or pre-bootstrap. */}
      {showStatusBar && (
        <div className="shrink-0 border-b border-border bg-background/70 px-4 py-2 backdrop-blur">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
              {(() => {
                const hasSession = !!runtime.sessionId
                const failed = !!chat.error
                // The "Connection" reflects the weftd backend LINK, not the
                // SSE event stream. A bootstrapped session with no hard
                // failure (chat.error = terminal SSE give-up) is "Connected" —
                // even while the SSE transport is mid-reconnect (isReconnecting),
                // which is a transport detail, not a broken link. "Not
                // connected" appears ONLY on a real failure or pre-bootstrap.
                const connectionOk = hasSession && !failed
                const label = failed
                  ? 'Not connected'
                  : connectionOk
                    ? 'Connected'
                    : chat.isReconnecting
                      ? 'Reconnecting'
                      : 'Not connected'
                // Green dot ONLY when truly connected — "Reconnecting" shows a
                // muted ○ (it's trying, not yet connected), so it doesn't read as
                // "Connected" while the link is still being established.
                const dot = connectionOk
                return (
                  <>
                    <span className={dot ? 'text-green-500' : 'text-muted-foreground'}>
                      {dot ? '●' : '○'}
                    </span>
                    <span>{label}</span>
                    <span className={isWaitingPermission ? 'text-yellow-500' : chat.isRunning ? 'text-green-500' : ''}>
                      {isWaitingPermission ? ' ◉ Awaiting approval' : chat.isRunning ? ' ● Running' : connectionOk ? ' idle' : ''}
                    </span>
                  </>
                )
              })()}
            </div>
            <div className="text-[12px] text-muted-foreground">
              {chat.hasGap && <span className="text-yellow-500">⚠ Gap detected · </span>}
              {summarizeCapability(chat.capabilityReport)}
            </div>
          </div>
        </div>
      )}

      {/* Error banner */}
      {chat.error && (
        <div className="shrink-0 border-b border-border bg-red-500/[0.08] px-4 py-2 text-[13px] text-red-600">
          {chat.error.message}
        </div>
      )}

      {/* Main content area */}
      <div className="flex-1 min-h-0 overflow-y-auto" ref={scrollRef}>
        <div className="mx-auto max-w-[760px] flex flex-col gap-4 px-4 py-6">
          {/* Empty state */}
          {visibleTurns.length === 0 && !chat.isRunning && !isWaitingPermission && !showPendingIndicator && (
            <div className="rounded-[8px] bg-background shadow-minimal p-5 text-[13px] text-muted-foreground">
              Send a message to start an agent session.
            </div>
          )}

          {/* Turn cards */}
          {visibleTurns.map((turn, index) => {
            if (turn.type === 'user') {
              return (
                <div key={`user-${turn.message.id}`} className="flex justify-end py-1">
                  <UserMessageBubble content={turn.message.content} />
                </div>
              )
            }

            if (turn.type === 'assistant') {
              return (
                <AssistantTurnCard
                  key={`assistant-${turn.turnId}`}
                  sessionId={workspaceId}
                  turn={turn}
                  isLast={index === visibleTurns.length - 1}
                  onInspectActivity={setSelectedActivity}
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
                  isActive={turn.message.authStatus === 'pending'}
                  onAllow={platformActions?.onPermissionAllow
                    ? (requestId, remember) => platformActions!.onPermissionAllow!(requestId, true, remember)
                    : undefined
                  }
                  onDeny={platformActions?.onPermissionAllow
                    ? (requestId) => platformActions!.onPermissionAllow!(requestId, false)
                    : undefined
                  }
                />
              )
            }

            return null
          })}

          {/* Pending indicator — waiting for assistant response */}
          {showPendingIndicator && (
            <PendingIndicator isReconnecting={chat.isReconnecting} />
          )}

          {/* Inline permission request (from runtime state + timeline) */}
          {isWaitingPermission && permissionRequest && (
            <PermissionRequestCard
              requestId={permissionRequest.requestId}
              toolName={permissionRequest.toolName}
              input={permissionRequest.input}
              reason={permissionRequest.reason}
              scope={permissionRequest.scope}
              isActive={true}
              onAllow={handlePermissionAllow}
              onDeny={handlePermissionDeny}
            />
          )}

          {/* Permission request fallback when we know the ID but don't have details */}
          {isWaitingPermission && !permissionRequest && waitingRequestId && (
            <PermissionRequestCard
              requestId={waitingRequestId}
              toolName="Tool approval required"
              reason="The agent is requesting approval to proceed."
              isActive={true}
              onAllow={handlePermissionAllow}
              onDeny={handlePermissionDeny}
            />
          )}
        </div>
      </div>

      {/* Runtime detail sidebar panel (optional) */}
      {showDetailPanel && (
        <div className="shrink-0 border-t border-border bg-background/70 max-h-[260px] overflow-y-auto">
          <div className="px-4 py-3 space-y-2">
            <div className="text-[12px] font-medium uppercase text-muted-foreground">Runtime Details</div>
            {detailItems.length === 0 ? (
              <div className="text-[12px] text-muted-foreground">No runtime details yet.</div>
            ) : detailItems.slice(-10).map(item => (
              <button
                key={item.id}
                type="button"
                onClick={() => setSelectedDetail(item)}
                className="block w-full rounded-[6px] px-2 py-1.5 text-left text-[12px] text-muted-foreground transition hover:bg-foreground/[0.05] hover:text-foreground"
              >
                {item.title}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Input area */}
      <div className="shrink-0 border-t border-border">
        <form onSubmit={handleSubmit} className="flex flex-col gap-2 p-3">
          <div className="flex gap-2">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.currentTarget.value)}
              placeholder={placeholder}
              rows={2}
              className="min-h-10 flex-1 resize-none rounded-[7px] border border-border bg-background px-3 py-2 text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-accent"
            />
            <button
              type="submit"
              disabled={!draft.trim() || chat.isRunning || isWaitingPermission}
              className="h-10 rounded-[7px] bg-accent px-3 text-[13px] font-medium text-background shadow-minimal transition hover:opacity-90 disabled:opacity-40"
            >
              Send
            </button>
            {chat.isRunning && (
              <button
                type="button"
                onClick={() => void chat.abort()}
                className="h-10 rounded-[7px] bg-foreground/[0.06] px-3 text-[13px] text-foreground transition hover:bg-foreground/[0.1]"
              >
                Stop
              </button>
            )}
          </div>
          <PermissionModeMenu
            value={permissionMode}
            onChange={setPermissionMode}
            onClose={() => setIsPermMenuOpen(false)}
            isOpen={isPermMenuOpen}
            onToggle={() => setIsPermMenuOpen(o => !o)}
          />
        </form>
      </div>

      {/* Step detail popup — the same inspector the web app uses */}
      <ActivityDetailsPanel
        activity={selectedActivity}
        onClose={() => setSelectedActivity(null)}
      />
    </div>
  )
}
