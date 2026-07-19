import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  TurnCard,
  UserMessageBubble,
  PermissionRequestCard,
  type ActivityItem,
  type Turn,
} from '@percena/weft-node/chat'
import { processEvent, type ChatEvent, type SessionState } from '@percena/weft-node/chat'
import type { PermissionMode } from '@percena/weft-node'
import {
  DEMO_EVENTS,
  DEMO_SESSION_ID,
  DEMO_TIMELINE,
  DEMO_USER_PROMPT,
  createDemoSessionState,
  getDemoTurns,
} from './demo-session'
import type { TimelineEnvelope } from '@percena/weft-node'
import { RuntimeClient, } from './runtime-client'
import { getDesktopApi } from '../shared/ipc-contract'
import { getModelOverride } from './demo-overrides'
import {
  AVAILABLE_LIVE_SOURCES,
  LIVE_FRAMEWORK_OPTIONS,
  getReasoningEffortOptions,
  appendLiveTimeline,
  buildSessionStateFromTimeline,
  createLiveAttachments,
  createLiveSessionRecord,
  loadLiveSessions,
  saveLiveSessions,
  titleFromMessage,
  updateLiveSession,
  upsertLiveSession,
  type LiveProvider,
  type ReasoningEffort,
  type LiveSessionRecord,
  type StoredLiveSessions,
} from './live-session-store'

type Mode = 'fixture' | 'live'
type TimelineDetailKind = 'permission' | 'runtime' | 'source' | 'tool'
type FilePickerMode = 'files' | 'folder'

interface HostFileSystemEntry {
  name: string
  path: string
  type: 'file' | 'directory'
  size?: number
}

interface HostFileSystemListing {
  currentPath: string
  parentPath: string | null
  entries: HostFileSystemEntry[]
}

interface TimelineDetailItem {
  id: string
  kind: TimelineDetailKind
  title: string
  summary?: string
  status?: string
  timestamp: number
  detail: unknown
  envelope: TimelineEnvelope
}

function describeEvent(event: ChatEvent): string {
  switch (event.type) {
    case 'user_message':
      return 'user_message: accepted prompt'
    case 'text_delta':
      return `text_delta: "${event.delta.replace(/\s+/g, ' ').trim()}"`
    case 'text_complete':
      return 'text_complete: final response committed'
    case 'tool_start':
      return `tool_start: ${event.toolName}`
    case 'tool_result':
      return `tool_result: ${event.toolName ?? event.toolUseId}`
    case 'task_progress':
      return `task_progress: ${event.elapsedSeconds}s`
    case 'complete':
      return 'complete: run finished'
    default:
      return event.type
  }
}

function describeTimelineDetail(detail: TimelineDetailItem): string {
  return `${detail.kind}: ${detail.title}`
}

function createTimelineDetailItems(timeline: TimelineEnvelope[]): TimelineDetailItem[] {
  return timeline.flatMap<TimelineDetailItem>((envelope) => {
    const id = `${envelope.epoch}:${envelope.seq}:${envelope.item.type}`
    const { item } = envelope

    switch (item.type) {
      case 'permission_requested':
        return [{
          id,
          kind: 'permission' as const,
          title: `Permission requested: ${item.request.toolName}`,
          summary: item.request.reason,
          status: 'requested',
          timestamp: envelope.timestamp,
          detail: item.request,
          envelope,
        } satisfies TimelineDetailItem]
      case 'permission_resolved':
        return [{
          id,
          kind: 'permission' as const,
          title: `Permission ${item.resolution.allowed ? 'allowed' : 'denied'}`,
          summary: item.resolution.reason,
          status: item.resolution.allowed ? 'allowed' : 'denied',
          timestamp: envelope.timestamp,
          detail: item.resolution,
          envelope,
        } satisfies TimelineDetailItem]
      case 'runtime_capability_report':
        return [{
          id,
          kind: 'runtime' as const,
          title: 'Runtime capability report',
          summary: extractStatus(item.report),
          timestamp: envelope.timestamp,
          detail: item.report,
          envelope,
        } satisfies TimelineDetailItem]
      case 'runtime_fallback':
        return [{
          id,
          kind: 'runtime' as const,
          title: `Runtime fallback: ${item.to}`,
          summary: item.reason,
          status: 'degraded',
          timestamp: envelope.timestamp,
          detail: item,
          envelope,
        } satisfies TimelineDetailItem]
      case 'source_state_changed':
        return [{
          id,
          kind: 'source' as const,
          title: `Source state changed: ${extractDisplayName(item.source, 'source')}`,
          summary: extractStatus(item.source),
          timestamp: envelope.timestamp,
          detail: item.source,
          envelope,
        } satisfies TimelineDetailItem]
      case 'tool_call':
        return [{
          id,
          kind: 'tool' as const,
          title: `Tool call: ${item.name}`,
          summary: item.status,
          status: item.status,
          timestamp: envelope.timestamp,
          detail: item.detail,
          envelope,
        } satisfies TimelineDetailItem]
      case 'tool_result':
        return [{
          id,
          kind: 'tool' as const,
          title: `Tool result: ${item.callId}`,
          status: item.isError ? 'failed' : 'completed',
          timestamp: envelope.timestamp,
          detail: item.result,
          envelope,
        } satisfies TimelineDetailItem]
      default:
        return []
    }
  })
}

function extractDisplayName(value: unknown, fallback: string): string {
  if (!value || typeof value !== 'object') return fallback
  const record = value as Record<string, unknown>
  for (const key of ['sourceSlug', 'name', 'id', 'kind']) {
    if (typeof record[key] === 'string') return record[key]
  }
  return fallback
}

function extractStatus(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  for (const key of ['status', 'selected', 'reason']) {
    if (typeof record[key] === 'string') return record[key]
  }
  return undefined
}

function ActivityInspector({
  activity,
  onClose,
}: {
  activity: ActivityItem | null
  onClose?: () => void
}) {
  if (!activity) {
    return (
      <div className="rounded-[8px] bg-background shadow-minimal p-4 text-[13px] text-muted-foreground">
        Select an activity from the turn card to inspect its input and output.
      </div>
    )
  }

  return (
    <div className="rounded-[8px] bg-background shadow-minimal overflow-hidden">
      <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <div className="truncate text-[13px] font-medium text-foreground">{activity.displayName ?? activity.toolName ?? 'Activity'}</div>
          <div className="mt-1 text-[12px] text-muted-foreground">{activity.intent ?? activity.status ?? 'unknown'}</div>
        </div>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="rounded-[6px] px-2 py-1 text-[12px] text-muted-foreground transition hover:bg-foreground/[0.06] hover:text-foreground"
            aria-label="Close activity details"
          >
            Close
          </button>
        )}
      </div>
      <div className="space-y-4 p-4">
        {activity.toolInput && (
          <div>
            <div className="mb-2 text-[12px] font-medium text-muted-foreground">Input</div>
            <pre className="max-h-[220px] overflow-auto rounded-[6px] bg-foreground/[0.04] p-3 text-[12px] leading-relaxed text-foreground">
              {JSON.stringify(activity.toolInput, null, 2)}
            </pre>
          </div>
        )}
        {(activity.content || activity.error) && (
          <div>
            <div className="mb-2 text-[12px] font-medium text-muted-foreground">
              {activity.error ? 'Error' : 'Output'}
            </div>
            <pre className="max-h-[260px] overflow-auto whitespace-pre-wrap rounded-[6px] bg-foreground/[0.04] p-3 text-[12px] leading-relaxed text-foreground">
              {activity.error ?? activity.content}
            </pre>
          </div>
        )}
      </div>
    </div>
  )
}

function LiveActivityDetailsPanel({
  activity,
  onClose,
}: {
  activity: ActivityItem | null
  onClose: () => void
}) {
  if (!activity) return null

  return (
    <div className="fixed bottom-4 right-4 z-40 w-[min(520px,calc(100vw-32px))] max-h-[72vh] overflow-hidden rounded-[10px] border border-border bg-background shadow-modal-small">
      <ActivityInspector activity={activity} onClose={onClose} />
    </div>
  )
}

function TimelineDetailInspector({ detail }: { detail: TimelineDetailItem | null }) {
  if (!detail) {
    return (
      <div className="rounded-[8px] bg-background shadow-minimal p-4 text-[13px] text-muted-foreground">
        Select a runtime detail to inspect permissions, fallback, source, skill, automation, or host state.
      </div>
    )
  }

  return (
    <div className="rounded-[8px] bg-background shadow-minimal overflow-hidden">
      <div className="border-b border-border px-4 py-3">
        <div className="text-[13px] font-medium text-foreground">{detail.title}</div>
        <div className="mt-1 text-[12px] text-muted-foreground">
          {detail.summary ?? detail.status ?? detail.kind}
        </div>
      </div>
      <div className="p-4">
        <pre className="max-h-[260px] overflow-auto whitespace-pre-wrap rounded-[6px] bg-foreground/[0.04] p-3 text-[12px] leading-relaxed text-foreground">
          {JSON.stringify(detail.detail, null, 2)}
        </pre>
      </div>
    </div>
  )
}

function AssistantTurnCard({
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

function ChatTranscript({
  mode,
  sessionId,
  turns,
  showPendingAssistant,
  onInspectActivity,
}: {
  mode: Mode
  sessionId: string
  turns: Turn[]
  showPendingAssistant?: boolean
  onInspectActivity: (activity: ActivityItem) => void
}) {
  const { visibleTurns, shouldShowPendingIndicator } = useMemo(() => {
    const lastTurn = turns.at(-1)
    if (!showPendingAssistant) return { visibleTurns: turns, shouldShowPendingIndicator: false }
    if (
      lastTurn?.type === 'assistant' &&
      lastTurn.activities.length === 0 &&
      !lastTurn.response &&
      lastTurn.isStreaming
    ) {
      return { visibleTurns: turns.slice(0, -1), shouldShowPendingIndicator: true }
    }
    return { visibleTurns: turns, shouldShowPendingIndicator: lastTurn?.type === 'user' }
  }, [showPendingAssistant, turns])

  return (
    <div className="mx-auto flex w-full max-w-[760px] flex-col gap-4 px-4 py-6">
      {visibleTurns.length === 0 && (
        <div className="rounded-[8px] bg-background shadow-minimal p-5 text-[13px] text-muted-foreground">
          {mode === 'fixture'
            ? 'Press Start to stream a mock agent run through the same processor and turn-card UI.'
            : 'Start the local agent and send a message to begin a turn.'}
        </div>
      )}

      {visibleTurns.map((turn, index) => {
        if (turn.type === 'user') {
          return (
            <div key={turn.message.id} className="flex justify-end py-1">
              <UserMessageBubble content={turn.message.content} />
            </div>
          )
        }

        if (turn.type === 'assistant') {
          return (
            <AssistantTurnCard
              key={`${turn.turnId}-${turn.timestamp}`}
              sessionId={sessionId}
              turn={turn}
              isLast={index === visibleTurns.length - 1}
              onInspectActivity={onInspectActivity}
            />
          )
        }

        return null
      })}
      {shouldShowPendingIndicator && (
        <div className="flex items-center gap-2 px-3 py-1.5 text-[13px] text-muted-foreground">
          <span className="h-2 w-2 animate-pulse rounded-full bg-muted-foreground/70" />
          <span>Thinking...</span>
        </div>
      )}
    </div>
  )
}

function LiveSessionSidebar({
  sessions,
  activeSessionId,
  onNewSession,
  onSelectSession,
}: {
  sessions: LiveSessionRecord[]
  activeSessionId: string
  onNewSession: () => void
  onSelectSession: (sessionId: string) => void
}) {
  return (
    <aside className="border-r border-border bg-background/80 p-3 max-lg:hidden">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="text-[13px] font-semibold text-foreground">Chats</div>
        <button
          type="button"
          onClick={onNewSession}
          className="rounded-[7px] bg-accent px-3 py-1.5 text-[12px] font-medium text-background shadow-minimal transition hover:opacity-90"
        >
          New
        </button>
      </div>
      <div className="space-y-1">
        {sessions.map(session => (
          <button
            key={session.id}
            type="button"
            onClick={() => onSelectSession(session.id)}
            className={`block w-full rounded-[8px] px-3 py-2.5 text-left transition ${
              session.id === activeSessionId
                ? 'bg-foreground/[0.08] text-foreground'
                : 'text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground'
            }`}
          >
            <div className="truncate text-[13px] font-medium">{session.title}</div>
            <div className="mt-1 flex items-center justify-between gap-2 text-[11px]">
              <span className="truncate">{session.config.model}</span>
              <span className={session.status === 'running' ? 'text-green-400' : 'text-foreground/40'}>
                {session.status}
              </span>
            </div>
          </button>
        ))}
      </div>
    </aside>
  )
}

const PERMISSION_OPTIONS: Array<{
  mode: PermissionMode
  label: string
  description: string
  icon: string
}> = [
  { mode: 'explore', label: 'Explore', description: 'Read-only planning and inspection.', icon: '◎' },
  { mode: 'ask', label: 'Ask', description: 'Review changes before execution.', icon: 'ⓘ' },
  { mode: 'auto', label: 'Auto', description: 'Allow edits and commands in this session.', icon: '⇄' },
]

function getPermissionOption(mode: PermissionMode) {
  return PERMISSION_OPTIONS.find(option => option.mode === mode) ?? PERMISSION_OPTIONS[1]
}

function getShortPath(path: string): string {
  const trimmed = path.trim()
  if (!trimmed) return 'Work in Folder'
  const parts = trimmed.split(/[\\/]/).filter(Boolean)
  return parts.at(-1) ?? trimmed
}

function FilePickerDialog({
  mode,
  selectedAttachmentPaths,
  onClose,
  onSelectFolder,
  onSelectFiles,
}: {
  mode: FilePickerMode
  selectedAttachmentPaths: string[]
  onClose: () => void
  onSelectFolder: (path: string) => void
  onSelectFiles: (paths: string[]) => void
}) {
  const [listing, setListing] = useState<HostFileSystemListing | null>(null)
  const [currentPath, setCurrentPath] = useState<string | null>(null)
  const [selectedFiles, setSelectedFiles] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const existingPaths = useMemo(() => new Set(selectedAttachmentPaths), [selectedAttachmentPaths])

  useEffect(() => {
    let cancelled = true
    const api = getDesktopApi()
    if (!api) {
      setError('Desktop runtime bridge unavailable.')
      setLoading(false)
      return
    }
    cancelled = false
    setLoading(true)
    setError(null)
    api.fsBrowse(currentPath ?? undefined)
      .then(data => {
        if (cancelled) return
        setListing(data)
        setSelectedFiles(files => files.filter(path => data.entries.some(entry => entry.path === path)))
        if (data.reason) setError(data.reason)
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [currentPath])

  const pendingFiles = selectedFiles.filter(path => !existingPaths.has(path))

  const toggleFile = (path: string) => {
    setSelectedFiles(files => files.includes(path)
      ? files.filter(item => item !== path)
      : [...files, path])
  }

  const dialogTitle = mode === 'folder' ? 'Work in folder' : 'Attach files'

  if (typeof document === 'undefined') return null

  return createPortal(
    <div className="dark fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4 text-foreground backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={dialogTitle}
        className="flex h-[min(720px,82vh)] w-full max-w-[760px] flex-col overflow-hidden rounded-[10px] border border-border bg-background shadow-modal-small"
      >
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium text-foreground">{dialogTitle}</div>
            <div className="mt-0.5 truncate text-[11px] text-muted-foreground" title={listing?.currentPath ?? 'Home'}>
              {listing?.currentPath ?? 'Home'}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="h-8 w-8 rounded-[7px] text-[15px] text-muted-foreground transition hover:bg-foreground/[0.05] hover:text-foreground"
            aria-label="Close file picker"
          >
            ×
          </button>
        </div>

        <div className="flex items-center gap-2 border-b border-border/60 px-4 py-2.5">
          <button
            type="button"
            onClick={() => listing?.parentPath && setCurrentPath(listing.parentPath)}
            disabled={!listing?.parentPath}
            className="h-7 rounded-[6px] px-2 text-[12px] text-muted-foreground transition hover:bg-foreground/[0.05] hover:text-foreground disabled:opacity-35"
          >
            ↑ Up
          </button>
          <button
            type="button"
            onClick={() => setCurrentPath(null)}
            className="h-7 rounded-[6px] px-2 text-[12px] text-muted-foreground transition hover:bg-foreground/[0.05] hover:text-foreground"
          >
            Home
          </button>
          <div className="min-w-0 flex-1 truncate rounded-[6px] bg-foreground/[0.035] px-2 py-1.5 text-[11px] text-muted-foreground">
            {listing?.currentPath ?? 'Home'}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {loading && (
            <div className="px-2 py-8 text-center text-[12px] text-muted-foreground">Loading...</div>
          )}
          {!loading && error && (
            <div className="rounded-[7px] bg-red-500/10 px-3 py-2 text-[12px] text-red-300">{error}</div>
          )}
          {!loading && !error && listing && listing.entries.length === 0 && (
            <div className="px-2 py-8 text-center text-[12px] text-muted-foreground">No files in this folder.</div>
          )}
          {!loading && !error && listing?.entries.map(entry => {
            const isSelected = selectedFiles.includes(entry.path)
            const alreadyAttached = existingPaths.has(entry.path)
            const disabled = mode === 'folder' && entry.type === 'file'
            return (
              <button
                key={entry.path}
                type="button"
                disabled={disabled}
                onClick={() => {
                  if (entry.type === 'directory') {
                    setCurrentPath(entry.path)
                    return
                  }
                  if (mode === 'files' && !alreadyAttached) toggleFile(entry.path)
                }}
                className={`flex h-9 w-full items-center gap-2 rounded-[7px] px-2 text-left text-[12px] transition ${
                  isSelected
                    ? 'bg-foreground/[0.08] text-foreground'
                    : disabled
                      ? 'text-muted-foreground/35'
                      : 'text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground'
                }`}
                title={entry.path}
              >
                <span className="w-4 text-center">
                  {entry.type === 'directory' ? '⌂' : mode === 'folder' ? '·' : alreadyAttached ? '✓' : isSelected ? '●' : '○'}
                </span>
                <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                {entry.type === 'file' && typeof entry.size === 'number' && (
                  <span className="text-[11px] opacity-60">{formatFileSize(entry.size)}</span>
                )}
              </button>
            )
          })}
        </div>

        <div className="flex min-h-12 items-center gap-2 border-t border-border px-4 py-2.5">
          <div className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
            {mode === 'folder'
              ? listing?.currentPath ?? 'Home'
              : pendingFiles.length > 0
                ? `${pendingFiles.length} selected`
                : 'No files selected'}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="h-8 rounded-[7px] border border-border px-3 text-[12px] text-muted-foreground transition hover:bg-foreground/[0.05] hover:text-foreground"
          >
            Cancel
          </button>
          {mode === 'folder' ? (
            <button
              type="button"
              onClick={() => listing && onSelectFolder(listing.currentPath)}
              disabled={!listing}
              className="h-8 rounded-[7px] bg-foreground px-3 text-[12px] font-medium text-background transition hover:opacity-90 disabled:opacity-40"
            >
              Choose Folder
            </button>
          ) : (
            <button
              type="button"
              onClick={() => onSelectFiles(pendingFiles)}
              disabled={pendingFiles.length === 0}
              className="h-8 rounded-[7px] bg-foreground px-3 text-[12px] font-medium text-background transition hover:opacity-90 disabled:opacity-40"
            >
              Add Selected
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}

function formatFileSize(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

function LiveComposer({
  input,
  connected,
  reconnecting,
  session,
  modelOptions,
  onInputChange,
  onSend,
  onConnect,
  onConfigChange,
  onAddAttachments,
  onRemoveAttachment,
  onToggleSource,
}: {
  input: string
  connected: boolean
  reconnecting: boolean
  session: LiveSessionRecord
  /** Discovered model ids for the active provider (empty = nothing discoverable, turns send no model). */
  modelOptions: string[]
  onInputChange: (value: string) => void
  onSend: () => void
  onConnect: (pendingMessage?: string) => void
  onConfigChange: (patch: Partial<LiveSessionRecord['config']>) => void
  onAddAttachments: (paths: string[]) => void
  onRemoveAttachment: (attachmentId: string) => void
  onToggleSource: (slug: string) => void
}) {
  const [showSources, setShowSources] = useState(false)
  const [showPermissionMenu, setShowPermissionMenu] = useState(false)
  const [filePickerMode, setFilePickerMode] = useState<FilePickerMode | null>(null)
  const canSend = connected && input.trim().length > 0
  // Active model first (the one the user is currently using), then the rest
  // alphabetically so the picker defaults to the in-use model and remaining
  // choices are easy to scan. No generic "Default" entry — the active model
  // IS the default and is sent explicitly (it always works against the gateway).
  const providerModels = useMemo(() => {
    const active = session.config.model
    const rest = modelOptions.filter(model => model !== active).sort((a, b) => a.localeCompare(b))
    return active ? [active, ...rest] : rest
  }, [modelOptions, session.config.model])
  const effortOptions = getReasoningEffortOptions(session.config.provider)
  const permission = getPermissionOption(session.config.permissionMode)
  const selectedSources = AVAILABLE_LIVE_SOURCES.filter(source =>
    session.config.selectedSourceSlugs.includes(source.slug)
  )
  const selectedSourceLabel = selectedSources.length === 0
    ? 'Choose Sources'
    : selectedSources.length === 1
      ? selectedSources[0].name
      : `${selectedSources.length} Sources`

  const setProvider = (provider: LiveProvider) => {
    // Switching provider resets model + effort; the listModels discovery effect
    // (App.tsx) refills both with the new provider's currently-active model
    // and effort (ANTHROPIC_MODEL/CLAUDE_CODE_EFFORT_LEVEL or codex config
    // equivalents), rather than carrying over the previous provider's values.
    onConfigChange({
      provider,
      model: '',
      reasoningEffort: undefined,
    })
  }

  const togglePermissionMenu = () => {
    setShowPermissionMenu(value => !value)
    setShowSources(false)
    setFilePickerMode(null)
  }

  const toggleSourcesMenu = () => {
    setShowSources(value => !value)
    setShowPermissionMenu(false)
    setFilePickerMode(null)
  }

  const openFolderPicker = () => {
    setFilePickerMode('folder')
    setShowPermissionMenu(false)
    setShowSources(false)
  }

  const openAttachmentPicker = () => {
    setFilePickerMode('files')
    setShowPermissionMenu(false)
    setShowSources(false)
  }

  return (
    <div className="border-t border-border bg-background/90 px-4 py-3 backdrop-blur">
      <div className="mx-auto w-full max-w-[880px]">
        <form
          onSubmit={(event) => {
            event.preventDefault()
            if (connected) onSend()
            else onConnect(input.trim() || undefined)
          }}
          className="relative"
        >
          {showPermissionMenu && (
            <div className="absolute bottom-[calc(100%+40px)] left-0 z-20 w-[204px] rounded-[9px] border border-border bg-background p-1.5 shadow-modal-small">
              <input
                type="text"
                placeholder="Search commands..."
                className="mb-1 h-8 w-full rounded-[7px] bg-transparent px-2 text-[12px] text-foreground outline-none placeholder:text-muted-foreground"
                aria-label="Search permission modes"
              />
              <div className="space-y-0.5">
                {PERMISSION_OPTIONS.map(option => (
                  <button
                    key={option.mode}
                    type="button"
                    onClick={() => {
                      onConfigChange({ permissionMode: option.mode })
                      setShowPermissionMenu(false)
                    }}
                    className={`flex h-8 w-full items-center gap-2 rounded-[6px] px-2 text-left text-[12px] transition ${
                      option.mode === session.config.permissionMode
                        ? 'bg-foreground/[0.08] text-foreground'
                        : 'text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground'
                    }`}
                  >
                    <span className="w-4 text-center text-[12px]">{option.icon}</span>
                    <span className="flex-1">{option.label}</span>
                    {option.mode === session.config.permissionMode && (
                      <span aria-hidden="true" className="text-[12px] text-foreground">●</span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="mb-2 flex items-center gap-1.5">
            <button
              type="button"
              aria-haspopup="menu"
              aria-expanded={showPermissionMenu}
              onClick={togglePermissionMenu}
              className="inline-flex h-8 items-center gap-1.5 rounded-[7px] border border-border bg-foreground/[0.035] px-2.5 text-[12px] text-foreground transition hover:bg-foreground/[0.06]"
            >
              <span className="text-muted-foreground">{permission.icon}</span>
              <span>{permission.label}</span>
              <span className="text-muted-foreground">⌄</span>
            </button>

            <div className="relative">
              <button
                type="button"
                aria-haspopup="menu"
                aria-expanded={showSources}
                onClick={toggleSourcesMenu}
                className="inline-flex h-8 max-w-[210px] items-center gap-1.5 rounded-[7px] border border-border bg-foreground/[0.035] px-2.5 text-[12px] text-muted-foreground transition hover:bg-foreground/[0.06] hover:text-foreground"
              >
                <span>▣</span>
                <span className="truncate">{selectedSourceLabel}</span>
                <span>⌄</span>
              </button>
              {showSources && (
                <div className="absolute bottom-[calc(100%+8px)] left-0 z-20 w-[292px] rounded-[9px] border border-border bg-background p-1.5 shadow-modal-small">
                  {AVAILABLE_LIVE_SOURCES.map(source => {
                    const selected = session.config.selectedSourceSlugs.includes(source.slug)
                    return (
                      <button
                        key={source.slug}
                        type="button"
                        onClick={() => onToggleSource(source.slug)}
                        className={`flex w-full items-start gap-2 rounded-[7px] px-2 py-2 text-left transition ${
                          selected
                            ? 'bg-foreground/[0.08] text-foreground'
                            : 'text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground'
                        }`}
                      >
                        <span className={`mt-1 h-2 w-2 rounded-full ${selected ? 'bg-accent' : 'bg-foreground/20'}`} />
                        <span className="min-w-0 flex-1">
                          <span className="block text-[12px] font-medium">{source.name}</span>
                          <span className="mt-0.5 line-clamp-2 block text-[11px] leading-snug opacity-70">{source.description}</span>
                        </span>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>

            <button
              type="button"
              aria-haspopup="dialog"
              aria-expanded={filePickerMode === 'folder'}
              onClick={openFolderPicker}
              className="inline-flex h-8 max-w-[190px] items-center gap-1.5 rounded-[7px] border border-border bg-foreground/[0.035] px-2.5 text-[12px] text-muted-foreground transition hover:bg-foreground/[0.06] hover:text-foreground"
              title={session.config.cwd}
            >
              <span>⌂</span>
              <span className="truncate">{getShortPath(session.config.cwd)}</span>
              <span>⌄</span>
            </button>
          </div>

          <div className="overflow-hidden rounded-[12px] border border-border bg-background shadow-minimal">
            {session.config.attachments.length > 0 && (
              <div className="flex gap-2 overflow-x-auto border-b border-border/60 px-3 py-2">
                {session.config.attachments.map(attachment => (
                  <button
                    key={attachment.id}
                    type="button"
                    onClick={() => onRemoveAttachment(attachment.id)}
                    className="inline-flex h-8 max-w-[180px] shrink-0 items-center gap-1.5 rounded-[7px] bg-foreground/[0.05] px-2 text-[11px] text-muted-foreground transition hover:text-foreground"
                    title={`Remove ${attachment.path}`}
                  >
                    <span className="truncate">{attachment.name}</span>
                    <span>×</span>
                  </button>
                ))}
              </div>
            )}

            <textarea
              value={input}
              onChange={(event) => onInputChange(event.target.value)}
              placeholder={connected ? 'Send a message to the agent...' : 'Start the local agent to begin...'}
              rows={3}
              className="max-h-[180px] min-h-[88px] w-full resize-none bg-transparent px-4 py-3 text-[13px] leading-relaxed text-foreground outline-none placeholder:text-muted-foreground"
            />

            <div className="flex min-h-10 items-center gap-2 border-t border-border/60 px-2 py-2">
              <div className="relative">
                <button
                  type="button"
                  aria-haspopup="dialog"
                  aria-expanded={filePickerMode === 'files'}
                  onClick={openAttachmentPicker}
                  className="inline-flex h-8 items-center gap-1.5 rounded-[7px] px-2.5 text-[12px] text-muted-foreground transition hover:bg-foreground/[0.05] hover:text-foreground"
                >
                  <span>⌕</span>
                  <span>{session.config.attachments.length > 0 ? `Attach Files · ${session.config.attachments.length}` : 'Attach Files'}</span>
                </button>
              </div>

              <div className="flex-1" />

              <label className="relative inline-flex h-8 items-center rounded-[7px] text-[12px] text-muted-foreground transition hover:bg-foreground/[0.05] hover:text-foreground">
                <span className="pointer-events-none absolute left-2">⌘</span>
                <select
                  aria-label="Framework"
                  value={session.config.provider}
                  onChange={(event) => setProvider(event.target.value as LiveProvider)}
                  className="h-8 appearance-none rounded-[7px] bg-transparent pl-7 pr-6 text-[12px] text-foreground outline-none"
                >
                  {LIVE_FRAMEWORK_OPTIONS.map(option => (
                    <option key={option.provider} value={option.provider}>{option.label}</option>
                  ))}
                </select>
                <span className="pointer-events-none absolute right-2 text-muted-foreground">⌄</span>
              </label>

              <label className="relative inline-flex h-8 items-center rounded-[7px] text-[12px] text-muted-foreground transition hover:bg-foreground/[0.05] hover:text-foreground">
                <select
                  aria-label="Model"
                  value={session.config.model}
                  onChange={(event) => onConfigChange({ model: event.target.value })}
                  className="h-8 max-w-[168px] appearance-none rounded-[7px] bg-transparent pl-2 pr-6 text-[12px] text-foreground outline-none"
                >
                  {/* Active model first, then the rest alphabetically (see
                      providerModels). The selected value is the user's current
                      model — sent explicitly, which always works against the
                      compatible endpoint. */}
                  {providerModels.map(model => (
                    <option key={model} value={model}>{model}</option>
                  ))}
                </select>
                <span className="pointer-events-none absolute right-2 text-muted-foreground">⌄</span>
              </label>

              <label className="relative inline-flex h-8 items-center rounded-[7px] text-[12px] text-muted-foreground transition hover:bg-foreground/[0.05] hover:text-foreground">
                <select
                  aria-label="Effort"
                  value={session.config.reasoningEffort ?? ''}
                  onChange={(event) => onConfigChange({
                    reasoningEffort: event.target.value ? event.target.value as ReasoningEffort : undefined,
                  })}
                  className="h-8 max-w-[118px] appearance-none rounded-[7px] bg-transparent pl-2 pr-6 text-[12px] text-foreground outline-none"
                >
                  <option value="">Config</option>
                  {effortOptions.map(option => (
                    <option key={option.effort} value={option.effort}>{option.label}</option>
                  ))}
                </select>
                <span className="pointer-events-none absolute right-2 text-muted-foreground">⌄</span>
              </label>

              <button
                type="submit"
                disabled={connected ? !canSend : reconnecting}
                className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-foreground text-background shadow-minimal transition hover:opacity-90 disabled:opacity-40"
                title={connected ? 'Send message' : 'Start local agent'}
                aria-label={connected ? 'Send message' : 'Start local agent'}
              >
                {reconnecting ? '…' : '↑'}
              </button>
            </div>
          </div>
        </form>
      </div>
      {filePickerMode && (
        <FilePickerDialog
          mode={filePickerMode}
          selectedAttachmentPaths={session.config.attachments.map(attachment => attachment.path)}
          onClose={() => setFilePickerMode(null)}
          onSelectFolder={(path) => {
            onConfigChange({ cwd: path })
            setFilePickerMode(null)
          }}
          onSelectFiles={(paths) => {
            onAddAttachments(paths)
            setFilePickerMode(null)
          }}
        />
      )}
    </div>
  )
}

/** Display string for a Live-mode rejection (never blank). */
function liveErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message
  if (typeof err === 'string' && err) return err
  if (err && typeof err === 'object' && 'message' in err) {
    const message = (err as { message?: unknown }).message
    if (typeof message === 'string' && message) return message
  }
  if (err !== null && err !== undefined) {
    const s = String(err)
    if (s && s !== '[object Object]') return s
  }
  return 'turn failed'
}

export default function App() {
  const [mode, setMode] = useState<Mode>('fixture')

  // ===== Fixture mode state =====
  const fixtureEventIndexRef = useRef(0)
  const fixtureTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const fixtureAutoStartedRef = useRef(false)

  const [fixtureSessionState, setFixtureSessionState] = useState<SessionState>(() => createDemoSessionState())
  const [fixtureIsPlaying, setFixtureIsPlaying] = useState(false)
  const [fixtureEventIndex, setFixtureEventIndex] = useState(0)
  const [fixtureEventLog, setFixtureEventLog] = useState<string[]>([])
  const [selectedActivity, setSelectedActivity] = useState<ActivityItem | null>(null)
  const [selectedTimelineDetail, setSelectedTimelineDetail] = useState<TimelineDetailItem | null>(null)

  // ===== Live mode state =====
  const [liveStore, setLiveStore] = useState<StoredLiveSessions>(() => {
    const initial = loadLiveSessions(typeof window === 'undefined' ? undefined : window.localStorage)
    const params = typeof window === 'undefined' ? new URLSearchParams() : new URLSearchParams(window.location.search)
    const provider = params.get('provider')
    const cwd = params.get('cwd')
    if (provider !== 'claude' && provider !== 'codex' && !cwd) return initial
    return updateLiveSession(initial, initial.activeSessionId, session => ({
      ...session,
      config: {
        ...session.config,
        ...(provider === 'claude' || provider === 'codex' ? { provider, model: '' } : {}),
        ...(cwd ? { cwd } : {}),
      },
    }))
  })
  const [liveSessionState, setLiveSessionState] = useState<SessionState | null>(null)
  const [liveTimeline, setLiveTimeline] = useState<TimelineEnvelope[]>([])
  const [liveConnected, setLiveConnected] = useState(false)
  const [liveReconnecting, setLiveReconnecting] = useState(false)
  const [_liveHasGap, setLiveHasGap] = useState(false)
  const [liveError, setLiveError] = useState<string | null>(null)
  const [liveInput, setLiveInput] = useState('')
  const [liveModelOptions, setLiveModelOptions] = useState<Record<LiveProvider, string[]>>({ claude: [], codex: [] })
  const runtimeClientRef = useRef<RuntimeClient | null>(null)
  const activeLiveSessionRef = useRef<LiveSessionRecord | null>(null)

  const activeLiveSession = useMemo(() => {
    return liveStore.sessions.find(session => session.id === liveStore.activeSessionId) ?? liveStore.sessions[0]
  }, [liveStore])

  useEffect(() => {
    saveLiveSessions(typeof window === 'undefined' ? undefined : window.localStorage, liveStore)
  }, [liveStore])

  useEffect(() => {
    activeLiveSessionRef.current = activeLiveSession ?? null
  }, [activeLiveSession])

  // Resolve the model list + default effort for the active provider. A demo
  // override (VITE_DEMO_MODELS_<PROVIDER> / VITE_DEMO_EFFORTS_<PROVIDER>) wins
  // for the picker; otherwise the list falls back to SDK discovery
  // (listModels → compatible gateway). SDK discovery is still fetched when an
  // override is set, so the effort picker can default to the SDK-detected
  // `defaultEffort`. Refetched whenever the live session's provider changes.
  useEffect(() => {
    if (mode !== 'live' || !activeLiveSession) return
    const provider = activeLiveSession.config.provider
    let cancelled = false
    void (async () => {
      const api = getDesktopApi()
      if (!api) return
      const modelOverride = getModelOverride(provider)
      // A demo override's list + default are known without SDK discovery, so
      // apply them up front: the picker shows the curated list and the first
      // turn uses the curated default even if discovery later fails. SDK
      // discovery below only refines the effort default (and is the fallback
      // when no override is set).
      if (modelOverride) {
        setLiveModelOptions(prev => ({ ...prev, [provider]: modelOverride.models }))
        const current = activeLiveSessionRef.current
        if (current && current.config.provider === provider) {
          const currentModel = current.config.model ?? ''
          const modelInvalid = !currentModel || !modelOverride.models.includes(currentModel)
          const wantModel = modelInvalid ? (modelOverride.defaultModel ?? '') : currentModel
          if (wantModel !== currentModel) {
            setLiveStore(prev => updateLiveSession(prev, current.id, session => ({
              ...session,
              config: { ...session.config, model: wantModel },
            })))
          }
        }
      }
      try {
        const result = await api.listModels(provider)
        if (cancelled) return
        // Picker list: demo override wins, else SDK-discovered models.
        const pickerModels = modelOverride?.models ?? result.models
        setLiveModelOptions(prev => ({ ...prev, [provider]: pickerModels }))
        // Default the picker to the user's currently-active model + effort
        // rather than a generic "Default". On first load (model/effort unset)
        // or when a stale persisted model id isn't in the picker list, fall
        // back to the demo override default, else the SDK default model
        // (ANTHROPIC_MODEL / config.toml `model` / CLAUDE_CODE_EFFORT_LEVEL /
        // config effort). When an override is set this is idempotent — the
        // override default was already applied above.
        const current = activeLiveSessionRef.current
        if (!current || current.config.provider !== provider) return
        const currentModel = current.config.model ?? ''
        const modelInvalid = !currentModel || !pickerModels.includes(currentModel)
        const fallbackModel = modelOverride?.defaultModel ?? result.defaultModel
        const wantModel = modelInvalid
          ? (fallbackModel && pickerModels.includes(fallbackModel)
            ? fallbackModel
            : (pickerModels[0] ?? ''))
          : currentModel
        const currentEffort = current.config.reasoningEffort
        const wantEffort = (currentEffort == null && result.defaultEffort
          && getReasoningEffortOptions(provider).some(option => option.effort === result.defaultEffort))
          ? (result.defaultEffort as ReasoningEffort)
          : currentEffort
        if (wantModel !== currentModel || wantEffort !== currentEffort) {
          setLiveStore(prev => updateLiveSession(prev, current.id, session => ({
            ...session,
            config: {
              ...session.config,
              model: wantModel,
              ...(wantEffort != null ? { reasoningEffort: wantEffort } : {}),
            },
          })))
        }
      } catch {
        // discovery failed — the demo override (if set) was applied above and
        // stays in the picker; otherwise the picker stays empty. Turns still
        // send the active model.
      }
    })()
    return () => { cancelled = true }
  }, [mode, activeLiveSession?.config.provider])

  useEffect(() => {
    if (!activeLiveSession) return
    setLiveSessionState(buildSessionStateFromTimeline(activeLiveSession))
    setLiveTimeline(activeLiveSession.timeline)
    setLiveConnected(false)
    setLiveReconnecting(false)
    setLiveHasGap(false)
    setLiveError(activeLiveSession.lastError ?? null)
    setSelectedActivity(null)
    setSelectedTimelineDetail(null)
  }, [activeLiveSession?.id, activeLiveSession.lastError, activeLiveSession.timeline, activeLiveSession])

  // ===== Derived state =====
  const turns = useMemo(() => {
    if (mode === 'live' && liveSessionState) {
      return getDemoTurns(liveSessionState)
    }
    return getDemoTurns(fixtureSessionState)
  }, [mode, liveSessionState, fixtureSessionState])

  const transcriptSessionId = mode === 'live'
    ? activeLiveSession?.id ?? 'live'
    : DEMO_SESSION_ID

  const timelineDetails = useMemo(() => {
    if (mode === 'live') {
      return createTimelineDetailItems(liveTimeline)
    }
    return createTimelineDetailItems(DEMO_TIMELINE.slice(0, fixtureEventIndex))
  }, [mode, liveTimeline, fixtureEventIndex])

  const progress = mode === 'fixture' ? Math.round((fixtureEventIndex / DEMO_EVENTS.length) * 100) : 0

  // ===== Fixture mode handlers =====
  const clearFixtureTimer = useCallback(() => {
    if (fixtureTimerRef.current) {
      clearInterval(fixtureTimerRef.current)
      fixtureTimerRef.current = null
    }
  }, [])

  const playNextFixtureEvent = useCallback(() => {
    const event = DEMO_EVENTS[fixtureEventIndexRef.current]
    if (!event) {
      clearFixtureTimer()
      setFixtureIsPlaying(false)
      return
    }

    setFixtureSessionState(prev => processEvent(prev, event).state)
    setFixtureEventLog(prev => [...prev, describeEvent(event)])
    fixtureEventIndexRef.current += 1
    setFixtureEventIndex(fixtureEventIndexRef.current)
  }, [clearFixtureTimer])

  const startFixtureDemo = useCallback(() => {
    clearFixtureTimer()
    fixtureEventIndexRef.current = 0
    setFixtureSessionState(createDemoSessionState())
    setFixtureEventIndex(0)
    setFixtureEventLog([])
    setSelectedActivity(null)
    setSelectedTimelineDetail(null)
    setFixtureIsPlaying(true)
    fixtureTimerRef.current = setInterval(playNextFixtureEvent, 420)
    playNextFixtureEvent()
  }, [clearFixtureTimer, playNextFixtureEvent])

  const stopFixtureDemo = useCallback(() => {
    clearFixtureTimer()
    setFixtureIsPlaying(false)
  }, [clearFixtureTimer])

  useEffect(() => clearFixtureTimer, [clearFixtureTimer])

  useEffect(() => {
    if (fixtureAutoStartedRef.current) return
    if (new URLSearchParams(window.location.search).get('autoplay') === '1') {
      fixtureAutoStartedRef.current = true
      startFixtureDemo()
    }
  }, [startFixtureDemo])

  // ===== Live mode handlers =====
  const patchActiveLiveSession = useCallback((updater: (session: LiveSessionRecord) => LiveSessionRecord) => {
    const sessionId = liveStore.activeSessionId
    setLiveStore(prev => updateLiveSession(prev, sessionId, updater))
  }, [liveStore.activeSessionId])

  const updateActiveLiveConfig = useCallback((patch: Partial<LiveSessionRecord['config']>) => {
    patchActiveLiveSession(session => ({
      ...session,
      updatedAt: Date.now(),
      config: {
        ...session.config,
        ...patch,
      },
    }))
  }, [patchActiveLiveSession])

  const startLocalAgent = useCallback((pendingMessage?: string) => {
    const session = activeLiveSessionRef.current
    if (!session) return
    runtimeClientRef.current?.disconnect()
    const client = new RuntimeClient({
      sessionId: session.id,
    })
    const localSessionId = session.id

    client.onStateChange((state) => {
      setLiveSessionState(state.sessionState)
      setLiveTimeline(state.timeline)
      setLiveConnected(state.isConnected)
      setLiveReconnecting(state.isReconnecting)
      setLiveHasGap(state.hasGap)
      setLiveError(state.error)
      setLiveStore(prev => updateLiveSession(prev, localSessionId, current => ({
        ...appendLiveTimeline(current, state.timeline),
        status: state.error ? 'error' : state.isRunning ? 'running' : state.isConnected ? 'connected' : 'disconnected',
        lastError: state.error ?? undefined,
      })))
    })

    runtimeClientRef.current = client
    setLiveError(null)
    patchActiveLiveSession(current => ({
      ...current,
      status: 'connected',
      lastError: undefined,
      updatedAt: Date.now(),
    }))
    void client.connectLiveSession({
      provider: session.config.provider,
      cwd: session.config.cwd,
      model: session.config.model,
      reasoningEffort: session.config.reasoningEffort,
      permissionMode: session.config.permissionMode,
      sourceSlugs: session.config.selectedSourceSlugs,
      attachments: session.config.attachments.map(({ path, name }) => ({ path, name })),
    })
      .then(async () => {
        // The form submit when not connected passes the already-typed message
        // through so the user's first ↑ click both connects AND sends — without
        // this, the typed text would be silently dropped (the agent would show
        // "connected" with no turn, looking like Live mode is broken).
        //
        // Stale guard before ANY shared mutation: a Disconnect or a newer
        // Connect may have replaced this client while startSession awaited.
        // Without the check we would clear the composer, stamp `running` on a
        // session that no longer owns this client, and IPC-send into a runtime
        // that a newer start may have just registered under the same id.
        if (runtimeClientRef.current !== client) return
        if (!pendingMessage) return
        setLiveInput('')
        setLiveStore(prev => updateLiveSession(prev, localSessionId, current => ({
          ...current,
          status: 'running',
          lastError: undefined,
          updatedAt: Date.now(),
        })))
        try {
          await client.sendMessage(pendingMessage, {
            model: session.config.model,
            reasoningEffort: session.config.reasoningEffort,
            permissionMode: session.config.permissionMode,
            cwd: session.config.cwd,
            sourceSlugs: session.config.selectedSourceSlugs,
            attachments: session.config.attachments.map(({ path, name }) => ({ path, name })),
          })
        } catch (sendErr) {
          // Connect succeeded — this is a TURN failure, not a connect failure.
          // Keep the session connected (Disconnect stays available, retry is a
          // plain resend), exactly like a failure on any later message in
          // sendLiveMessage. Tearing the runtime down here would force a full
          // reconnect for a transient provider error.
          // RuntimeClient mirrors the rejection (and turn_failed envelopes)
          // into state.error so the subsequent onStateChange cannot wipe this
          // banner with a null error.
          if (runtimeClientRef.current !== client) return
          const message = liveErrorMessage(sendErr)
          setLiveError(message)
          setLiveStore(prev => updateLiveSession(prev, localSessionId, current => ({
            ...current,
            status: 'error',
            lastError: message,
            updatedAt: Date.now(),
          })))
        }
      })
      .catch((err: unknown) => {
        // A stale attempt (a newer connect or an explicit disconnect replaced
        // this client) must not touch shared state: its listeners were already
        // removed by that replacement, and issuing another IPC DISCONNECT for
        // the shared session id would be queued AFTER the newer runtime's
        // START and dispose it.
        if (runtimeClientRef.current !== client) return
        // Full teardown of the failed connect, not just dropping the ref:
        // without disconnect() the main-process runtime could keep running
        // (burning provider credit) while the Disconnect button is gone.
        // disconnect() also removes the client's ipcRenderer subscriptions so
        // repeated failed attempts don't accumulate listeners.
        client.disconnect()
        runtimeClientRef.current = null
        setLiveConnected(false)
        setLiveReconnecting(false)
        const message = liveErrorMessage(err)
        setLiveError(message)
        setLiveStore(prev => updateLiveSession(prev, localSessionId, current => ({
          ...current,
          status: 'error',
          lastError: message,
          updatedAt: Date.now(),
        })))
      })
  }, [patchActiveLiveSession])

  const disconnectLocalAgent = useCallback(() => {
    const sessionId = activeLiveSessionRef.current?.id
    runtimeClientRef.current?.disconnect()
    runtimeClientRef.current = null
    setLiveSessionState(null)
    setLiveTimeline([])
    setLiveConnected(false)
    setLiveReconnecting(false)
    setLiveHasGap(false)
    setLiveError(null)
    if (sessionId) {
      setLiveStore(prev => updateLiveSession(prev, sessionId, current => ({
        ...current,
        status: current.status === 'draft' ? 'draft' : 'disconnected',
        updatedAt: Date.now(),
      })))
    }
  }, [])

  const sendLiveMessage = useCallback(async () => {
    const session = activeLiveSessionRef.current
    if (!session || !liveInput.trim() || !runtimeClientRef.current) return
    const message = liveInput.trim()
    setLiveInput('')
    setLiveStore(prev => updateLiveSession(prev, session.id, current => ({
      ...current,
      title: current.title === 'New live session' ? titleFromMessage(message) : current.title,
      status: 'running',
      lastError: undefined,
      updatedAt: Date.now(),
    })))
    const client = runtimeClientRef.current
    client.sendMessage(message, {
      model: session.config.model,
      reasoningEffort: session.config.reasoningEffort,
      permissionMode: session.config.permissionMode,
      cwd: session.config.cwd,
      sourceSlugs: session.config.selectedSourceSlugs,
      attachments: session.config.attachments.map(({ path, name }) => ({ path, name })),
    }).catch((err: unknown) => {
      // Same keep-connected turn-failure path as the first-send catch: do not
      // stamp error chrome onto a session whose client was replaced mid-send.
      if (runtimeClientRef.current !== client) return
      const text = liveErrorMessage(err)
      setLiveError(text)
      setLiveStore(prev => updateLiveSession(prev, session.id, current => ({
        ...current,
        status: 'error',
        lastError: text,
        updatedAt: Date.now(),
      })))
    })
  }, [liveInput])

  const createNewLiveSession = useCallback(() => {
    disconnectLocalAgent()
    const now = Date.now()
    const next = createLiveSessionRecord({
      id: `live-${now}`,
      now,
      config: activeLiveSessionRef.current?.config,
    })
    setLiveStore(prev => upsertLiveSession(prev, next, next.id))
    setLiveInput('')
  }, [disconnectLocalAgent])

  const selectLiveSession = useCallback((sessionId: string) => {
    if (sessionId === activeLiveSessionRef.current?.id) return
    disconnectLocalAgent()
    setLiveStore(prev => ({ ...prev, activeSessionId: sessionId }))
    setLiveInput('')
  }, [disconnectLocalAgent])

  const addLiveAttachments = useCallback((paths: string[]) => {
    if (paths.length === 0) return
    const attachments = createLiveAttachments(paths)
    patchActiveLiveSession(session => ({
      ...session,
      updatedAt: Date.now(),
      config: {
        ...session.config,
        attachments: [...session.config.attachments, ...attachments],
      },
    }))
  }, [patchActiveLiveSession])

  const removeLiveAttachment = useCallback((attachmentId: string) => {
    patchActiveLiveSession(session => ({
      ...session,
      updatedAt: Date.now(),
      config: {
        ...session.config,
        attachments: session.config.attachments.filter(attachment => attachment.id !== attachmentId),
      },
    }))
  }, [patchActiveLiveSession])

  const toggleLiveSource = useCallback((slug: string) => {
    patchActiveLiveSession(session => {
      const selected = session.config.selectedSourceSlugs.includes(slug)
      return {
        ...session,
        updatedAt: Date.now(),
        config: {
          ...session.config,
          selectedSourceSlugs: selected
            ? session.config.selectedSourceSlugs.filter(item => item !== slug)
            : [...session.config.selectedSourceSlugs, slug],
        },
      }
    })
  }, [patchActiveLiveSession])

  const switchMode = useCallback((newMode: Mode) => {
    if (newMode === 'fixture') {
      disconnectLocalAgent()
    }
    setMode(newMode)
  }, [disconnectLocalAgent])

  return (
    <main className="dark min-h-screen bg-foreground-2 text-foreground">
      <div className={`grid min-h-screen ${mode === 'live' ? 'grid-cols-[280px_minmax(0,1fr)]' : 'grid-cols-[minmax(0,1fr)_360px]'} max-lg:grid-cols-1`}>
        {mode === 'live' && activeLiveSession && (
          <LiveSessionSidebar
            sessions={liveStore.sessions}
            activeSessionId={activeLiveSession.id}
            onNewSession={createNewLiveSession}
            onSelectSession={selectLiveSession}
          />
        )}
        <section className="flex min-h-screen flex-col">
          <header className="border-b border-border bg-background/70 px-6 py-4 backdrop-blur">
            <div className="mx-auto flex max-w-[920px] items-center justify-between gap-4">
              <div>
                <h1 className="text-[18px] font-semibold tracking-normal">
                  {mode === 'live' && activeLiveSession ? activeLiveSession.title : 'Weft Chat Panel Demo'}
                </h1>
                <p className="mt-1 text-[13px] text-muted-foreground">
                  {mode === 'fixture'
                    ? 'Mock events are rendered through processor state and Weft turn cards.'
                    : liveConnected
                      ? 'Local agent connected — send a message to start a turn.'
                      : 'Start the local agent (Claude or Codex) to run a turn on this machine.'}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {mode === 'fixture' ? (
                  <>
                    <button
                      type="button"
                      onClick={fixtureIsPlaying ? stopFixtureDemo : startFixtureDemo}
                      className="rounded-[7px] bg-accent px-3 py-2 text-[13px] font-medium text-background shadow-minimal transition hover:opacity-90"
                    >
                      {fixtureIsPlaying ? 'Stop' : 'Start'}
                    </button>
                    <button
                      type="button"
                      onClick={startFixtureDemo}
                      className="rounded-[7px] bg-background px-3 py-2 text-[13px] text-foreground shadow-minimal transition hover:bg-foreground/[0.05]"
                    >
                      Restart
                    </button>
                  </>
                ) : (
                  liveConnected ? (
                    <>
                      {activeLiveSession?.status === 'running' && (
                        <button
                          type="button"
                          onClick={() => runtimeClientRef.current?.abort('user stopped the turn')}
                          className="rounded-[7px] bg-background px-3 py-2 text-[13px] text-foreground shadow-minimal transition hover:bg-foreground/[0.05]"
                        >
                          Stop
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={disconnectLocalAgent}
                        className="rounded-[7px] bg-background px-3 py-2 text-[13px] text-foreground shadow-minimal transition hover:bg-foreground/[0.05]"
                      >
                        Disconnect
                      </button>
                    </>
                  ) : (
                      <button
                        type="button"
                        onClick={() => startLocalAgent()}
                        className="rounded-[7px] bg-accent px-3 py-2 text-[13px] font-medium text-background shadow-minimal transition hover:opacity-90"
                      >
                        Connect
                      </button>
                    )
                )}
                {mode === 'live' && activeLiveSession && (
                  <button
                    type="button"
                    onClick={createNewLiveSession}
                    className="hidden rounded-[7px] bg-background px-3 py-2 text-[13px] text-foreground shadow-minimal transition hover:bg-foreground/[0.05] max-lg:inline-block"
                  >
                    New Chat
                  </button>
                )}
                <div className="flex rounded-[7px] bg-background shadow-minimal">
                  <button
                    type="button"
                    onClick={() => switchMode('fixture')}
                    className={`rounded-[7px] px-3 py-2 text-[13px] transition ${mode === 'fixture' ? 'bg-accent text-background font-medium' : 'text-muted-foreground hover:text-foreground'}`}
                  >
                    Fixture
                  </button>
                  <button
                    type="button"
                    onClick={() => switchMode('live')}
                    className={`rounded-[7px] px-3 py-2 text-[13px] transition ${mode === 'live' ? 'bg-accent text-background font-medium' : 'text-muted-foreground hover:text-foreground'}`}
                  >
                    Live
                  </button>
                </div>
              </div>
            </div>
          </header>

          <div className="flex-1 overflow-y-auto">
            <ChatTranscript
              mode={mode}
              sessionId={transcriptSessionId}
              turns={turns}
              showPendingAssistant={mode === 'live' && activeLiveSession?.status === 'running'}
              onInspectActivity={setSelectedActivity}
            />
            {mode === 'live' && liveError && (
              <div className="mx-auto max-w-[760px] px-4 py-3">
                <div className="rounded-[7px] bg-foreground/[0.04] px-3 py-2 text-[12px] text-red-400">
                  {liveError}
                </div>
              </div>
            )}
          </div>

          {mode === 'live' && activeLiveSession && (
            <LiveComposer
              input={liveInput}
              connected={liveConnected}
              reconnecting={liveReconnecting}
              session={activeLiveSession}
              modelOptions={liveModelOptions[activeLiveSession.config.provider]}
              onInputChange={setLiveInput}
              onSend={sendLiveMessage}
              onConnect={startLocalAgent}
              onConfigChange={updateActiveLiveConfig}
              onAddAttachments={addLiveAttachments}
              onRemoveAttachment={removeLiveAttachment}
              onToggleSource={toggleLiveSource}
            />
          )}

          {mode === 'live' && (
            <LiveActivityDetailsPanel
              activity={selectedActivity}
              onClose={() => setSelectedActivity(null)}
            />
          )}

          {mode === 'live' && liveSessionState?.pendingPermissionRequests && liveSessionState.pendingPermissionRequests.length > 0 && (
            <div className="fixed bottom-20 left-1/2 z-40 w-[min(520px,calc(100vw-32px))] -translate-x-1/2 space-y-2">
              {liveSessionState.pendingPermissionRequests.map(req => (
                <div key={req.requestId} className="overflow-hidden rounded-[10px] border border-border bg-background shadow-modal-small">
                  <PermissionRequestCard
                    requestId={req.requestId}
                    toolName={req.toolName}
                    reason={req.description ?? req.reason}
                    input={req.command ? { command: req.command } : undefined}
                    onAllow={(id, remember) => runtimeClientRef.current?.respondToPermission(id, true, remember)}
                    onDeny={(id) => runtimeClientRef.current?.respondToPermission(id, false)}
                  />
                </div>
              ))}
            </div>
          )}
        </section>

        {mode === 'fixture' && (
        <aside className="border-l border-border bg-background/70 p-4 max-lg:border-l-0 max-lg:border-t">
          <div className="sticky top-4 space-y-4">
            <div className="rounded-[8px] bg-background shadow-minimal p-4">
              <div className="text-[12px] font-medium uppercase text-muted-foreground">Prompt</div>
              <div className="mt-2 text-[13px] leading-relaxed">{DEMO_USER_PROMPT}</div>
              <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-foreground/[0.08]">
                <div
                  className="h-full rounded-full bg-accent transition-all"
                  style={{ width: `${progress}%` }}
                />
              </div>
              <div className="mt-2 text-[12px] text-muted-foreground">
                {fixtureEventIndex}/{DEMO_EVENTS.length} events
              </div>
            </div>

            <ActivityInspector activity={selectedActivity} />

            <div className="rounded-[8px] bg-background shadow-minimal p-4">
              <div className="text-[12px] font-medium uppercase text-muted-foreground">Runtime Details</div>
              <div className="mt-3 max-h-[220px] space-y-1 overflow-auto text-[12px] leading-relaxed">
                {timelineDetails.length === 0 ? (
                  <div className="text-muted-foreground">No runtime details yet.</div>
                ) : timelineDetails.map(detail => (
                  <button
                    key={detail.id}
                    type="button"
                    onClick={() => setSelectedTimelineDetail(detail)}
                    className="block w-full rounded-[6px] px-2 py-1.5 text-left text-muted-foreground transition hover:bg-foreground/[0.05] hover:text-foreground"
                    title={describeTimelineDetail(detail)}
                  >
                    <span className="text-foreground/40">{String(detail.envelope.seq).padStart(2, '0')}</span> {detail.title}
                  </button>
                ))}
              </div>
            </div>

            <TimelineDetailInspector detail={selectedTimelineDetail} />

            <div className="rounded-[8px] bg-background shadow-minimal p-4">
              <div className="text-[12px] font-medium uppercase text-muted-foreground">Event Log</div>
              <div className="mt-3 max-h-[260px] space-y-1 overflow-auto font-mono text-[11px] leading-relaxed text-muted-foreground">
                {fixtureEventLog.length === 0 ? (
                  <div>No events yet.</div>
                ) : fixtureEventLog.map((entry, index) => (
                  <div key={`${entry}-${index}`}>
                    <span className="text-foreground/40">{String(index + 1).padStart(2, '0')}</span> {entry}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </aside>
        )}
      </div>
    </main>
  )
}
