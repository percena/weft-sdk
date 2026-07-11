export type InMemoryCommandOrigin =
  | { type: 'user'; id?: string }
  | { type: 'automation'; id: string }
  | { type: 'scheduler'; id?: string }
  | { type: 'host'; id?: string }
  | { type: 'replay'; id?: string }
  | { type: 'system'; id?: string }

export interface InMemorySubmitPlanRequest {
  sessionId?: string
  planRef: string
  origin?: InMemoryCommandOrigin
}

export interface InMemoryBrowserActionRequest {
  sessionId?: string
  action: string
  input?: unknown
}

export interface InMemorySpawnSessionRequest {
  parentSessionId?: string
  prompt: string
  model?: string
  commandOrigin?: InMemoryCommandOrigin
}

export interface InMemoryInterSessionMessageRequest {
  sessionId: string
  message: string
  attachments?: Array<{ path: string; name?: string }>
  commandOrigin?: InMemoryCommandOrigin
}

export interface InMemorySessionMetadataPatch {
  sessionId?: string
  labels?: string[]
  status?: string
  flagged?: boolean
  topic?: string
}

export interface InMemorySessionMetadataSnapshot {
  sessionId?: string
  labels?: string[]
  status?: string
  flagged?: boolean
  topic?: string
}

export interface InMemorySessionListRequest {
  status?: string
  labels?: string[]
  limit?: number
}

export interface InMemoryLlmToolRequest {
  prompt: string
  model?: string
  commandOrigin?: InMemoryCommandOrigin
}

export interface InMemoryLlmToolResult {
  text: string
  model?: string
  usage?: unknown
}

export interface InMemorySourceSummary {
  slug: string
  name: string
  provider: string
  type: string
  enabled: boolean
  isAuthenticated?: boolean
  connectionStatus?: string
  tagline?: string
}

export interface InMemorySkillSummary {
  slug: string
  name: string
  description: string
  source: string
  icon?: string
  globs?: string[]
  requiredSources?: string[]
}

export interface InMemoryScheduleSummary {
  schedulerId: string
  workspaceId: string
  cron: string
  timezone: string
}

export interface InMemorySessionToolBridge {
  submitPlan(request: InMemorySubmitPlanRequest): Promise<{
    accepted: boolean
    planRef?: string
    reason?: string
  }>
  runBrowserAction(request: InMemoryBrowserActionRequest): Promise<{
    ok: boolean
    result?: unknown
    reason?: string
  }>
  spawnSession(request: InMemorySpawnSessionRequest): Promise<{ sessionId: string }>
  sendSessionMessage(request: InMemoryInterSessionMessageRequest): Promise<{
    ok: boolean
    commandId?: string
    reason?: string
  }>
  updateSessionMetadata(request: InMemorySessionMetadataPatch): Promise<InMemorySessionMetadataSnapshot>
  listSessions(request: InMemorySessionListRequest): Promise<{ sessions: InMemorySessionMetadataSnapshot[] }>
  queryLlm?(request: InMemoryLlmToolRequest): Promise<InMemoryLlmToolResult>

  // Sources CRUD
  listSources(request: { sessionId?: string; enabledOnly?: boolean }): Promise<{ sources: InMemorySourceSummary[] }>
  getSource(request: { sessionId?: string; sourceSlug: string }): Promise<{ source: InMemorySourceSummary }>
  createSource(request: { sessionId?: string; name: string; provider: string; type: string; enabled?: boolean }): Promise<{ ok: boolean; source?: InMemorySourceSummary; reason?: string }>
  updateSource(request: { sessionId?: string; sourceSlug: string; name?: string; enabled?: boolean }): Promise<{ ok: boolean; source?: InMemorySourceSummary; reason?: string }>
  deleteSource(request: { sessionId?: string; sourceSlug: string }): Promise<{ ok: boolean; sourceSlug: string; reason?: string }>

  // Skills CRUD
  listSkills(request: { sessionId?: string }): Promise<{ skills: InMemorySkillSummary[] }>
  getSkill(request: { sessionId?: string; skillSlug: string }): Promise<{ skill: InMemorySkillSummary & { content: string; alwaysAllow?: string[] } }>
  createSkill(request: { sessionId?: string; slug: string; name: string; description: string; content: string }): Promise<{ ok: boolean; skill?: InMemorySkillSummary; reason?: string }>
  updateSkill(request: { sessionId?: string; skillSlug: string; name?: string; description?: string; content?: string }): Promise<{ ok: boolean; skill?: InMemorySkillSummary; reason?: string }>
  deleteSkill(request: { sessionId?: string; skillSlug: string }): Promise<{ ok: boolean; skillSlug: string; reason?: string }>

  // Automations Config
  getAutomationsConfig(request: { sessionId?: string }): Promise<{ config: Record<string, unknown> | null; configPath: string }>
  updateAutomationsConfig(request: { sessionId?: string; config: Record<string, unknown> }): Promise<{ ok: boolean; automationCount?: number; errors?: string[] }>

  // Scheduler
  listSchedules(request: { sessionId?: string }): Promise<{ schedules: InMemoryScheduleSummary[] }>
  startSchedule(request: { sessionId?: string; schedulerId: string; workspaceId: string; cron: string; timezone: string }): Promise<{ schedulerId: string; state: 'started' | 'stopped'; timestamp: number }>
  stopSchedule(request: { sessionId?: string; schedulerId: string }): Promise<{ ok: boolean; schedulerId: string; state?: 'stopped'; reason?: string }>
}

export interface InMemoryPlanSubmissionRecord {
  sessionId?: string
  planRef: string
  origin?: InMemoryCommandOrigin
  submittedAt: number
}

export interface InMemoryBrowserActionRecord {
  sessionId?: string
  action: string
  input?: unknown
  recordedAt: number
}

export interface InMemorySessionMessageRecord {
  sessionId: string
  message: string
  attachments?: Array<{ path: string; name?: string }>
  commandOrigin?: InMemoryCommandOrigin
  commandId: string
  sentAt: number
}

export interface InMemorySpawnedSessionRecord {
  sessionId: string
  parentSessionId?: string
  prompt: string
  model?: string
  commandOrigin?: InMemoryCommandOrigin
  createdAt: number
}

export interface InMemoryResourceOperationRecord {
  op: string
  request: unknown
  ts: number
}

export interface InMemorySessionToolBridgeSnapshot {
  sessions: InMemorySessionMetadataSnapshot[]
  plans: InMemoryPlanSubmissionRecord[]
  browserActions: InMemoryBrowserActionRecord[]
  messages: InMemorySessionMessageRecord[]
  spawnedSessions: InMemorySpawnedSessionRecord[]
  sourceOperations: InMemoryResourceOperationRecord[]
  skillOperations: InMemoryResourceOperationRecord[]
  automationConfigOperations: InMemoryResourceOperationRecord[]
  scheduleOperations: InMemoryResourceOperationRecord[]
}

export interface InMemorySessionToolBridgeOptions {
  now?: () => number
  nextSessionId?: () => string
  queryLlm?: (request: InMemoryLlmToolRequest) => Promise<InMemoryLlmToolResult>
}

export interface InMemorySessionToolBridgeHost {
  bridge: InMemorySessionToolBridge
  getSnapshot(): InMemorySessionToolBridgeSnapshot
}

export function createInMemorySessionToolBridge(
  options: InMemorySessionToolBridgeOptions = {},
): InMemorySessionToolBridgeHost {
  const now = options.now ?? Date.now
  const sessions = new Map<string, InMemorySessionMetadataSnapshot>()
  const plans: InMemoryPlanSubmissionRecord[] = []
  const browserActions: InMemoryBrowserActionRecord[] = []
  const messages: InMemorySessionMessageRecord[] = []
  const spawnedSessions: InMemorySpawnedSessionRecord[] = []
  const sourceOperations: InMemoryResourceOperationRecord[] = []
  const skillOperations: InMemoryResourceOperationRecord[] = []
  const automationConfigOperations: InMemoryResourceOperationRecord[] = []
  const scheduleOperations: InMemoryResourceOperationRecord[] = []
  let generatedSessionCounter = 0
  let messageCounter = 0

  function ensureSession(sessionId: string | undefined): InMemorySessionMetadataSnapshot {
    const id = sessionId ?? 'default'
    const existing = sessions.get(id)
    if (existing) return existing
    const created = { sessionId: id }
    sessions.set(id, created)
    return created
  }

  function nextSessionId(): string {
    return options.nextSessionId?.() ?? `session-${++generatedSessionCounter}`
  }

  const bridge: InMemorySessionToolBridge = {
    async submitPlan(request) {
      ensureSession(request.sessionId)
      plans.push({
        sessionId: request.sessionId,
        planRef: request.planRef,
        ...(request.origin ? { origin: request.origin } : {}),
        submittedAt: now(),
      })
      return { accepted: true, planRef: request.planRef }
    },

    async runBrowserAction(request) {
      const record: InMemoryBrowserActionRecord = {
        sessionId: request.sessionId,
        action: request.action,
        ...(request.input !== undefined ? { input: request.input } : {}),
        recordedAt: now(),
      }
      ensureSession(request.sessionId)
      browserActions.push(record)
      return {
        ok: true,
        result: {
          action: record.action,
          ...(record.input !== undefined ? { input: record.input } : {}),
          recordedAt: record.recordedAt,
        },
      }
    },

    async spawnSession(request) {
      const sessionId = nextSessionId()
      const record: InMemorySpawnedSessionRecord = {
        sessionId,
        ...(request.parentSessionId ? { parentSessionId: request.parentSessionId } : {}),
        prompt: request.prompt,
        ...(request.model ? { model: request.model } : {}),
        ...(request.commandOrigin ? { commandOrigin: request.commandOrigin } : {}),
        createdAt: now(),
      }
      spawnedSessions.push(record)
      sessions.set(sessionId, {
        sessionId,
        topic: request.prompt,
        status: 'created',
      })
      return { sessionId }
    },

    async sendSessionMessage(request) {
      ensureSession(request.sessionId)
      const commandId = `message:${++messageCounter}`
      messages.push({
        sessionId: request.sessionId,
        message: request.message,
        ...(request.attachments ? { attachments: cloneAttachments(request.attachments) } : {}),
        ...(request.commandOrigin ? { commandOrigin: request.commandOrigin } : {}),
        commandId,
        sentAt: now(),
      })
      return { ok: true, commandId }
    },

    async updateSessionMetadata(request) {
      const sessionId = request.sessionId ?? 'default'
      const current = ensureSession(sessionId)
      const next: InMemorySessionMetadataSnapshot = {
        ...current,
        sessionId,
        ...(request.labels ? { labels: uniqueSorted(request.labels) } : {}),
        ...(request.status ? { status: request.status } : {}),
        ...(request.flagged !== undefined ? { flagged: request.flagged } : {}),
        ...(request.topic ? { topic: request.topic } : {}),
      }
      sessions.set(sessionId, next)
      return cloneSession(next)
    },

    async listSessions(request) {
      const labels = request.labels ?? []
      const filtered = [...sessions.values()]
        .filter(session => !request.status || session.status === request.status)
        .filter(session => labels.every(label => session.labels?.includes(label)))
        .sort((left, right) => String(left.sessionId ?? '').localeCompare(String(right.sessionId ?? '')))
        .slice(0, request.limit ?? Number.POSITIVE_INFINITY)
        .map(cloneSession)
      return { sessions: filtered }
    },

    // Sources CRUD (in-memory recording stubs)
    async listSources(request) {
      sourceOperations.push({ op: 'listSources', request, ts: now() })
      return { sources: [] }
    },
    async getSource(request) {
      sourceOperations.push({ op: 'getSource', request, ts: now() })
      return { source: { slug: request.sourceSlug, name: request.sourceSlug, provider: 'stub', type: 'api', enabled: true } }
    },
    async createSource(request) {
      sourceOperations.push({ op: 'createSource', request, ts: now() })
      return { ok: true, source: { slug: request.name.toLowerCase().replace(/\s+/g, '-'), name: request.name, provider: request.provider, type: request.type, enabled: request.enabled ?? true } }
    },
    async updateSource(request) {
      sourceOperations.push({ op: 'updateSource', request, ts: now() })
      return { ok: true, source: { slug: request.sourceSlug, name: request.name ?? request.sourceSlug, provider: 'stub', type: 'api', enabled: request.enabled ?? true } }
    },
    async deleteSource(request) {
      sourceOperations.push({ op: 'deleteSource', request, ts: now() })
      return { ok: true, sourceSlug: request.sourceSlug }
    },

    // Skills CRUD (in-memory recording stubs)
    async listSkills(request) {
      skillOperations.push({ op: 'listSkills', request, ts: now() })
      return { skills: [] }
    },
    async getSkill(request) {
      skillOperations.push({ op: 'getSkill', request, ts: now() })
      return { skill: { slug: request.skillSlug, name: request.skillSlug, description: 'stub', source: 'workspace', content: '' } }
    },
    async createSkill(request) {
      skillOperations.push({ op: 'createSkill', request, ts: now() })
      return { ok: true, skill: { slug: request.slug, name: request.name, description: request.description, source: 'workspace' } }
    },
    async updateSkill(request) {
      skillOperations.push({ op: 'updateSkill', request, ts: now() })
      return { ok: true, skill: { slug: request.skillSlug, name: request.name ?? request.skillSlug, description: request.description ?? 'stub', source: 'workspace' } }
    },
    async deleteSkill(request) {
      skillOperations.push({ op: 'deleteSkill', request, ts: now() })
      return { ok: true, skillSlug: request.skillSlug }
    },

    // Automations Config (in-memory recording stubs)
    async getAutomationsConfig(request) {
      automationConfigOperations.push({ op: 'getAutomationsConfig', request, ts: now() })
      return { config: null, configPath: '/stub/automations.json' }
    },
    async updateAutomationsConfig(request) {
      automationConfigOperations.push({ op: 'updateAutomationsConfig', request, ts: now() })
      return { ok: true, automationCount: 0, errors: [] }
    },

    // Scheduler (in-memory recording stubs)
    async listSchedules(request) {
      scheduleOperations.push({ op: 'listSchedules', request, ts: now() })
      return { schedules: [] }
    },
    async startSchedule(request) {
      scheduleOperations.push({ op: 'startSchedule', request, ts: now() })
      return { schedulerId: request.schedulerId, state: 'started' as const, timestamp: now() }
    },
    async stopSchedule(request) {
      scheduleOperations.push({ op: 'stopSchedule', request, ts: now() })
      return { ok: true, schedulerId: request.schedulerId, state: 'stopped' as const }
    },

    ...(options.queryLlm
      ? {
          async queryLlm(request) {
            return options.queryLlm!(request)
          },
        }
      : {}),
  }

  return {
    bridge,
    getSnapshot() {
      return {
        sessions: [...sessions.values()].map(cloneSession),
        plans: plans.map(plan => ({ ...plan })),
        browserActions: browserActions.map(action => ({ ...action })),
        messages: messages.map(message => ({
          ...message,
          ...(message.attachments ? { attachments: cloneAttachments(message.attachments) } : {}),
        })),
        spawnedSessions: spawnedSessions.map(session => ({ ...session })),
        sourceOperations: sourceOperations.map(op => ({ ...op })),
        skillOperations: skillOperations.map(op => ({ ...op })),
        automationConfigOperations: automationConfigOperations.map(op => ({ ...op })),
        scheduleOperations: scheduleOperations.map(op => ({ ...op })),
      }
    },
  }
}

function cloneSession(session: InMemorySessionMetadataSnapshot): InMemorySessionMetadataSnapshot {
  return {
    ...session,
    ...(session.labels ? { labels: [...session.labels] } : {}),
  }
}

function cloneAttachments(
  attachments: Array<{ path: string; name?: string }>,
): Array<{ path: string; name?: string }> {
  return attachments.map(attachment => ({ ...attachment }))
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort()
}
