import { mapTimelineEnvelopeToProcessorEvent, processEvent, type SessionState } from '@percena/weft/chat'
import type { PermissionMode } from '@percena/weft'
import type { TimelineEnvelope } from '@percena/weft'
import { createRuntimeClientState } from './runtime-client'
import { isChatTranscriptTimelineEnvelope } from './timeline-transcript'

export type LiveProvider = 'claude' | 'codex'
export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface LiveAttachment {
  id: string
  name: string
  path: string
}

export interface LiveSource {
  slug: string
  name: string
  description: string
}

export interface LiveSessionConfig {
  provider: LiveProvider
  model: string
  reasoningEffort?: ReasoningEffort
  permissionMode: PermissionMode
  cwd: string
  selectedSourceSlugs: string[]
  attachments: LiveAttachment[]
}

export interface LiveSessionRecord {
  id: string
  hostSessionId?: string
  title: string
  createdAt: number
  updatedAt: number
  status: 'draft' | 'connected' | 'running' | 'disconnected' | 'error'
  config: LiveSessionConfig
  timeline: TimelineEnvelope[]
  lastError?: string
}

export interface StoredLiveSessions {
  version: 1
  activeSessionId: string
  sessions: LiveSessionRecord[]
}

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export const LIVE_SESSIONS_STORAGE_KEY = 'weft.demo.live.sessions.v1'

export const AVAILABLE_LIVE_SOURCES: LiveSource[] = [
  { slug: 'workspace-files', name: 'Workspace Files', description: 'Read and inspect files under the selected working folder.' },
  { slug: 'host-tools', name: 'Host Tools', description: 'Use host utility tools exposed by the local Weft server.' },
  { slug: 'automation-events', name: 'Automation Events', description: 'Include scheduler, webhook, and automation timeline context.' },
]

export const MODEL_OPTIONS: Record<LiveProvider, string[]> = {
  codex: ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini'],
  claude: ['claude-sonnet-4-6', 'claude-opus-4-8', 'claude-haiku-4-5-20251001'],
}

export const REASONING_EFFORT_OPTIONS: Record<LiveProvider, Array<{ effort: ReasoningEffort; label: string }>> = {
  codex: [
    { effort: 'low', label: 'Low' },
    { effort: 'medium', label: 'Medium' },
    { effort: 'high', label: 'High' },
    { effort: 'xhigh', label: 'XHigh' },
  ],
  claude: [
    { effort: 'low', label: 'Low' },
    { effort: 'medium', label: 'Medium' },
    { effort: 'high', label: 'High' },
    { effort: 'xhigh', label: 'XHigh' },
    { effort: 'max', label: 'Max' },
  ],
}

export const LIVE_FRAMEWORK_OPTIONS: Array<{ provider: LiveProvider; label: string }> = [
  { provider: 'claude', label: 'Claude Code' },
  { provider: 'codex', label: 'Codex' },
]

export function getLiveFrameworkLabel(provider: LiveProvider): string {
  return LIVE_FRAMEWORK_OPTIONS.find(option => option.provider === provider)?.label ?? provider
}

export function getReasoningEffortOptions(provider: LiveProvider): Array<{ effort: ReasoningEffort; label: string }> {
  return REASONING_EFFORT_OPTIONS[provider]
}

export function defaultLiveSessionConfig(overrides: Partial<LiveSessionConfig> = {}): LiveSessionConfig {
  const provider = overrides.provider ?? 'codex'
  const model = overrides.model ?? MODEL_OPTIONS[provider][0]
  const allowedEfforts = new Set(REASONING_EFFORT_OPTIONS[provider].map(option => option.effort))
  return {
    provider,
    model,
    ...(overrides.reasoningEffort && allowedEfforts.has(overrides.reasoningEffort) ? { reasoningEffort: overrides.reasoningEffort } : {}),
    permissionMode: overrides.permissionMode ?? 'ask',
    cwd: overrides.cwd ?? '/tmp',
    selectedSourceSlugs: overrides.selectedSourceSlugs ?? ['workspace-files'],
    attachments: overrides.attachments ?? [],
  }
}

export function createLiveSessionRecord(input: {
  id: string
  now: number
  title?: string
  config?: Partial<LiveSessionConfig>
}): LiveSessionRecord {
  const config = defaultLiveSessionConfig(input.config)
  return {
    id: input.id,
    title: input.title ?? 'New live session',
    createdAt: input.now,
    updatedAt: input.now,
    status: 'draft',
    config,
    timeline: [],
  }
}

export function loadLiveSessions(storage: StorageLike | undefined, now: number = Date.now()): StoredLiveSessions {
  const fallback = createInitialStoredLiveSessions(now)
  if (!storage) return fallback

  const raw = storage.getItem(LIVE_SESSIONS_STORAGE_KEY)
  if (!raw) return fallback

  try {
    const parsed = JSON.parse(raw) as Partial<StoredLiveSessions>
    if (parsed.version !== 1 || !Array.isArray(parsed.sessions) || parsed.sessions.length === 0) {
      return fallback
    }
    const sessions = parsed.sessions.map((session, index) => normalizeLiveSession(session, now, index))
    const activeSessionId = sessions.some(session => session.id === parsed.activeSessionId)
      ? String(parsed.activeSessionId)
      : sessions[0].id
    return { version: 1, activeSessionId, sessions }
  } catch {
    return fallback
  }
}

export function saveLiveSessions(storage: StorageLike | undefined, state: StoredLiveSessions): void {
  if (!storage) return
  storage.setItem(LIVE_SESSIONS_STORAGE_KEY, JSON.stringify(state))
}

export function upsertLiveSession(
  state: StoredLiveSessions,
  session: LiveSessionRecord,
  activeSessionId: string = state.activeSessionId,
): StoredLiveSessions {
  const sessions = state.sessions.some(item => item.id === session.id)
    ? state.sessions.map(item => item.id === session.id ? session : item)
    : [session, ...state.sessions]
  return { version: 1, activeSessionId, sessions }
}

export function updateLiveSession(
  state: StoredLiveSessions,
  sessionId: string,
  updater: (session: LiveSessionRecord) => LiveSessionRecord,
): StoredLiveSessions {
  return {
    ...state,
    sessions: state.sessions.map(session => session.id === sessionId ? updater(session) : session),
  }
}

export function appendLiveTimeline(
  session: LiveSessionRecord,
  timeline: TimelineEnvelope[],
  now: number = Date.now(),
): LiveSessionRecord {
  const byKey = new Map<string, TimelineEnvelope>()
  for (const envelope of [...session.timeline, ...timeline]) {
    byKey.set(`${envelope.epoch}:${envelope.seq}`, envelope)
  }
  return {
    ...session,
    timeline: [...byKey.values()].sort((left, right) => {
      if (left.epoch !== right.epoch) return left.epoch.localeCompare(right.epoch)
      return left.seq - right.seq
    }),
    updatedAt: now,
  }
}

export function titleFromMessage(message: string): string {
  const normalized = message.trim().replace(/\s+/g, ' ')
  if (!normalized) return 'New live session'
  return normalized.length > 44 ? `${normalized.slice(0, 41)}...` : normalized
}

export function createLiveAttachments(paths: string[], now: number = Date.now()): LiveAttachment[] {
  return paths.map((path, index) => ({
    id: `attachment-${now}-${index}`,
    name: path.split(/[\\/]/).filter(Boolean).at(-1) ?? path,
    path,
  }))
}

export function buildSessionStateFromTimeline(session: LiveSessionRecord): SessionState {
  return session.timeline.filter(isChatTranscriptTimelineEnvelope).reduce((state, envelope) => {
    return processEvent(state, mapTimelineEnvelopeToProcessorEvent(envelope)).state
  }, createRuntimeClientState(session.id, 'demo-workspace', 'Demo Workspace'))
}

function createInitialStoredLiveSessions(now: number): StoredLiveSessions {
  const session = createLiveSessionRecord({ id: `live-${now}`, now })
  return { version: 1, activeSessionId: session.id, sessions: [session] }
}

function normalizeLiveSession(
  session: Partial<LiveSessionRecord>,
  now: number,
  index: number,
): LiveSessionRecord {
  const id = typeof session.id === 'string' && session.id ? session.id : `live-${now}-${index}`
  const config = defaultLiveSessionConfig(session.config ?? {})
  const timeline = Array.isArray(session.timeline) ? session.timeline : []
  const status = reconcilePersistedStatus(
    isLiveSessionStatus(session.status) ? session.status : 'draft',
    timeline,
  )
  return {
    id,
    ...(typeof session.hostSessionId === 'string' ? { hostSessionId: session.hostSessionId } : {}),
    title: typeof session.title === 'string' && session.title ? session.title : 'New live session',
    createdAt: typeof session.createdAt === 'number' ? session.createdAt : now,
    updatedAt: typeof session.updatedAt === 'number' ? session.updatedAt : now,
    status,
    config,
    timeline,
    ...(typeof session.lastError === 'string' ? { lastError: session.lastError } : {}),
  }
}

function isLiveSessionStatus(value: unknown): value is LiveSessionRecord['status'] {
  return value === 'draft' ||
    value === 'connected' ||
    value === 'running' ||
    value === 'disconnected' ||
    value === 'error'
}

function reconcilePersistedStatus(
  status: LiveSessionRecord['status'],
  timeline: TimelineEnvelope[],
): LiveSessionRecord['status'] {
  if (status !== 'running') return status
  const lastItem = timeline.at(-1)?.item
  if (!lastItem) return status
  if (lastItem.type === 'turn_completed' || lastItem.type === 'assistant_message') {
    return 'disconnected'
  }
  if (lastItem.type === 'session_status' && (lastItem.status === 'ready' || lastItem.status === 'completed')) {
    return 'disconnected'
  }
  return status
}
