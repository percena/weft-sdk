import type {
  TimelineEnvelope,
  TimelineItem,
} from '@weft/timeline'
import type {
  CommandOrigin,
  RuntimePolicyHook,
  ToolPolicyDecision,
} from './contract.ts'

/**
 * Host session-tool bridge — the request/receipt DTOs a host wires into
 * `RuntimeExtensionContext.hostServices.sessionTools`, plus the
 * `invokeSessionTool` executor that runs a bridge callback under the policy
 * hook and appends host_state_changed audit items to the timeline.
 *
 * This module is the single source of truth for the host-tool surface;
 * `@weft/host-services` re-exports these types instead of mirroring them.
 */

export interface SubmitPlanRequest {
  sessionId?: string
  planRef: string
  origin?: CommandOrigin
}

export interface SubmitPlanReceipt {
  accepted: boolean
  planRef?: string
  reason?: string
}

export interface SourceAuthRequest {
  sessionId?: string
  sourceSlug: string
  reason?: string
}

export interface SourceAuthReceipt {
  ok: boolean
  sourceSlug: string
  reason?: string
}

export interface SourceActivationRequest {
  sessionId?: string
  sourceSlug: string
}

export interface SourceActivationReceipt {
  ok: boolean
  sourceSlug: string
  availability?: 'immediate' | 'next-turn'
  reason?: string
}

export interface BrowserActionRequest {
  sessionId?: string
  action: string
  input?: unknown
}

export interface BrowserActionReceipt {
  ok: boolean
  result?: unknown
  reason?: string
}

export interface SpawnSessionRequest {
  parentSessionId?: string
  prompt: string
  model?: string
  commandOrigin?: CommandOrigin
}

export interface SpawnSessionReceipt {
  sessionId: string
}

export interface InterSessionMessageRequest {
  sessionId: string
  message: string
  attachments?: Array<{ path: string; name?: string }>
  commandOrigin?: CommandOrigin
}

export interface CommandReceipt {
  ok: boolean
  commandId?: string
  reason?: string
}

export interface SessionMetadataPatch {
  sessionId?: string
  labels?: string[]
  status?: string
  flagged?: boolean
  topic?: string
}

export interface SessionMetadataSnapshot {
  sessionId?: string
  labels?: string[]
  status?: string
  flagged?: boolean
  topic?: string
}

export interface SessionListRequest {
  status?: string
  labels?: string[]
  limit?: number
}

export interface SessionListResult {
  sessions: SessionMetadataSnapshot[]
}

export interface LlmToolRequest {
  prompt: string
  model?: string
  commandOrigin?: CommandOrigin
}

export interface LlmToolResult {
  text: string
  model?: string
  usage?: unknown
}

// ── Sources CRUD ─────────────────────────────────────────

export interface ListSourcesRequest {
  sessionId?: string
  enabledOnly?: boolean
}

export interface SourceSummary {
  slug: string
  name: string
  provider: string
  type: string
  enabled: boolean
  isAuthenticated?: boolean
  connectionStatus?: string
  tagline?: string
}

export interface ListSourcesResult {
  sources: SourceSummary[]
}

export interface GetSourceRequest {
  sessionId?: string
  sourceSlug: string
}

export interface GetSourceResult {
  source: SourceSummary & {
    createdAt?: number
    updatedAt?: number
    mcp?: Record<string, unknown>
    api?: Record<string, unknown>
    local?: Record<string, unknown>
  }
}

export interface CreateSourceRequest {
  sessionId?: string
  name: string
  provider: string
  type: string
  mcp?: Record<string, unknown>
  api?: Record<string, unknown>
  local?: Record<string, unknown>
  icon?: string
  enabled?: boolean
}

export interface CreateSourceResult {
  ok: boolean
  source?: SourceSummary
  reason?: string
}

export interface UpdateSourceRequest {
  sessionId?: string
  sourceSlug: string
  enabled?: boolean
  name?: string
  icon?: string
  tagline?: string
}

export interface UpdateSourceResult {
  ok: boolean
  source?: SourceSummary
  reason?: string
}

export interface DeleteSourceRequest {
  sessionId?: string
  sourceSlug: string
}

export interface DeleteSourceResult {
  ok: boolean
  sourceSlug: string
  reason?: string
}

// ── Skills CRUD ──────────────────────────────────────────

export interface ListSkillsRequest {
  sessionId?: string
}

export interface SkillSummary {
  slug: string
  name: string
  description: string
  source: string
  icon?: string
  globs?: string[]
  requiredSources?: string[]
}

export interface ListSkillsResult {
  skills: SkillSummary[]
}

export interface GetSkillRequest {
  sessionId?: string
  skillSlug: string
}

export interface GetSkillResult {
  skill: SkillSummary & {
    content: string
    alwaysAllow?: string[]
  }
}

export interface CreateSkillRequest {
  sessionId?: string
  slug: string
  name: string
  description: string
  content: string
  globs?: string[]
  alwaysAllow?: string[]
  icon?: string
  requiredSources?: string[]
}

export interface CreateSkillResult {
  ok: boolean
  skill?: SkillSummary
  reason?: string
}

export interface UpdateSkillRequest {
  sessionId?: string
  skillSlug: string
  name?: string
  description?: string
  content?: string
  globs?: string[]
  alwaysAllow?: string[]
  icon?: string
  requiredSources?: string[]
}

export interface UpdateSkillResult {
  ok: boolean
  skill?: SkillSummary
  reason?: string
}

export interface DeleteSkillRequest {
  sessionId?: string
  skillSlug: string
}

export interface DeleteSkillResult {
  ok: boolean
  skillSlug: string
  reason?: string
}

// ── Automations Config ───────────────────────────────────

export interface GetAutomationsConfigRequest {
  sessionId?: string
}

export interface GetAutomationsConfigResult {
  config: Record<string, unknown> | null
  configPath: string
}

export interface UpdateAutomationsConfigRequest {
  sessionId?: string
  config: Record<string, unknown>
}

export interface UpdateAutomationsConfigResult {
  ok: boolean
  automationCount?: number
  errors?: string[]
}

// ── Scheduler Management ─────────────────────────────────

export interface ListSchedulesRequest {
  sessionId?: string
}

export interface ScheduleSummary {
  schedulerId: string
  workspaceId: string
  cron: string
  timezone: string
}

export interface ListSchedulesResult {
  schedules: ScheduleSummary[]
}

export interface StartScheduleRequest {
  sessionId?: string
  schedulerId: string
  workspaceId: string
  cron: string
  timezone: string
}

export interface StartScheduleResult {
  schedulerId: string
  state: 'started' | 'stopped'
  timestamp: number
}

export interface StopScheduleRequest {
  sessionId?: string
  schedulerId: string
}

export interface StopScheduleResult {
  ok: boolean
  schedulerId: string
  state?: 'stopped'
  reason?: string
}

export interface SessionToolBridge {
  submitPlan?(request: SubmitPlanRequest): Promise<SubmitPlanReceipt>
  requestSourceAuth?(request: SourceAuthRequest): Promise<SourceAuthReceipt>
  activateSource?(request: SourceActivationRequest): Promise<SourceActivationReceipt>
  runBrowserAction?(request: BrowserActionRequest): Promise<BrowserActionReceipt>
  spawnSession?(request: SpawnSessionRequest): Promise<SpawnSessionReceipt>
  sendSessionMessage?(request: InterSessionMessageRequest): Promise<CommandReceipt>
  updateSessionMetadata?(request: SessionMetadataPatch): Promise<SessionMetadataSnapshot>
  listSessions?(request: SessionListRequest): Promise<SessionListResult>
  queryLlm?(request: LlmToolRequest): Promise<LlmToolResult>

  // Sources CRUD
  listSources?(request: ListSourcesRequest): Promise<ListSourcesResult>
  getSource?(request: GetSourceRequest): Promise<GetSourceResult>
  createSource?(request: CreateSourceRequest): Promise<CreateSourceResult>
  updateSource?(request: UpdateSourceRequest): Promise<UpdateSourceResult>
  deleteSource?(request: DeleteSourceRequest): Promise<DeleteSourceResult>

  // Skills CRUD
  listSkills?(request: ListSkillsRequest): Promise<ListSkillsResult>
  getSkill?(request: GetSkillRequest): Promise<GetSkillResult>
  createSkill?(request: CreateSkillRequest): Promise<CreateSkillResult>
  updateSkill?(request: UpdateSkillRequest): Promise<UpdateSkillResult>
  deleteSkill?(request: DeleteSkillRequest): Promise<DeleteSkillResult>

  // Automations Config
  getAutomationsConfig?(request: GetAutomationsConfigRequest): Promise<GetAutomationsConfigResult>
  updateAutomationsConfig?(request: UpdateAutomationsConfigRequest): Promise<UpdateAutomationsConfigResult>

  // Scheduler
  listSchedules?(request: ListSchedulesRequest): Promise<ListSchedulesResult>
  startSchedule?(request: StartScheduleRequest): Promise<StartScheduleResult>
  stopSchedule?(request: StopScheduleRequest): Promise<StopScheduleResult>
}

export type SessionToolName = keyof SessionToolBridge

export type SessionToolRequest =
  | SubmitPlanRequest
  | SourceAuthRequest
  | SourceActivationRequest
  | BrowserActionRequest
  | SpawnSessionRequest
  | InterSessionMessageRequest
  | SessionMetadataPatch
  | SessionListRequest
  | LlmToolRequest
  | ListSourcesRequest
  | GetSourceRequest
  | CreateSourceRequest
  | UpdateSourceRequest
  | DeleteSourceRequest
  | ListSkillsRequest
  | GetSkillRequest
  | CreateSkillRequest
  | UpdateSkillRequest
  | DeleteSkillRequest
  | GetAutomationsConfigRequest
  | UpdateAutomationsConfigRequest
  | ListSchedulesRequest
  | StartScheduleRequest
  | StopScheduleRequest

export interface SessionToolTimelineRef {
  epoch: string
  seq: number
}

export interface SessionToolInvocationReceipt {
  ok: boolean
  requestId: string
  toolName: SessionToolName
  origin?: CommandOrigin
  policyDecision: ToolPolicyDecision
  result?: unknown
  reason?: string
  timelineRefs: SessionToolTimelineRef[]
}

export interface InvokeSessionToolOptions {
  sessionId: string
  toolName: SessionToolName
  request: SessionToolRequest
  bridge: SessionToolBridge
  policy?: RuntimePolicyHook
  commandOrigin?: CommandOrigin
  appendTimeline?: (item: TimelineItem) => TimelineEnvelope
}

export interface RuntimeHostServices {
  sessionTools?: SessionToolBridge
}

// Process-unique prefix so request ids stay unique across restarts and across
// concurrently running hosts (a bare module-level counter produced
// `session-tool-N` ids that collide between processes).
const sessionToolRequestPrefix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
let sessionToolRequestCounter = 0

export async function invokeSessionTool(
  options: InvokeSessionToolOptions,
): Promise<SessionToolInvocationReceipt> {
  const requestId = `session-tool-${sessionToolRequestPrefix}-${++sessionToolRequestCounter}`
  const origin = originFromSessionToolRequest(options.request) ?? options.commandOrigin
  const policyDecision = await evaluateSessionToolPolicy(options, requestId)
  const timelineRefs: SessionToolTimelineRef[] = []

  const append = (item: TimelineItem) => {
    const envelope = options.appendTimeline?.(item)
    if (envelope) {
      timelineRefs.push({ epoch: envelope.epoch, seq: envelope.seq })
    }
  }

  if (policyDecision.decision !== 'allow') {
    const reason = policyDecision.decision === 'defer'
      ? 'deferred by policy'
      : policyDecision.reason
    append({
      type: 'host_state_changed',
      state: {
        kind: 'host_tool_denied',
        requestId,
        toolName: options.toolName,
        reason,
      },
    })
    return {
      ok: false,
      requestId,
      toolName: options.toolName,
      origin,
      policyDecision,
      reason,
      timelineRefs,
    }
  }

  append({
    type: 'host_state_changed',
    state: {
      kind: 'host_tool_invoked',
      requestId,
      toolName: options.toolName,
      ...(origin ? { origin } : {}),
    },
  })

  const callback = options.bridge[options.toolName] as ((request: SessionToolRequest) => Promise<unknown>) | undefined
  if (!callback) {
    const reason = `Session tool bridge callback is not registered: ${String(options.toolName)}`
    append({
      type: 'host_state_changed',
      state: {
        kind: 'host_tool_result',
        requestId,
        toolName: options.toolName,
        ok: false,
        reason,
      },
    })
    return {
      ok: false,
      requestId,
      toolName: options.toolName,
      origin,
      policyDecision,
      reason,
      timelineRefs,
    }
  }

  try {
    const result = await callback(options.request)
    append({
      type: 'host_state_changed',
      state: {
        kind: 'host_tool_result',
        requestId,
        toolName: options.toolName,
        ok: true,
      },
    })
    return {
      ok: true,
      requestId,
      toolName: options.toolName,
      origin,
      policyDecision,
      result,
      timelineRefs,
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    append({
      type: 'host_state_changed',
      state: {
        kind: 'host_tool_result',
        requestId,
        toolName: options.toolName,
        ok: false,
        reason,
      },
    })
    return {
      ok: false,
      requestId,
      toolName: options.toolName,
      origin,
      policyDecision,
      reason,
      timelineRefs,
    }
  }
}

async function evaluateSessionToolPolicy(
  options: InvokeSessionToolOptions,
  _requestId: string,
): Promise<ToolPolicyDecision> {
  if (!options.policy) return { decision: 'allow' }
  return options.policy({
    toolName: `host.${String(options.toolName)}`,
    input: recordFromSessionToolRequest(options.request),
    toolIntent: { kind: 'unknown', toolName: `host.${String(options.toolName)}` },
    scope: { type: 'session', sessionId: options.sessionId },
  })
}

function originFromSessionToolRequest(request: SessionToolRequest): CommandOrigin | undefined {
  const record = recordFromSessionToolRequest(request)
  const origin = record.origin ?? record.commandOrigin
  return isCommandOrigin(origin) ? origin : undefined
}

function recordFromSessionToolRequest(request: SessionToolRequest): Record<string, unknown> {
  return request && typeof request === 'object' ? { ...request as Record<string, unknown> } : {}
}

function isCommandOrigin(value: unknown): value is CommandOrigin {
  if (!value || typeof value !== 'object') return false
  const type = (value as { type?: unknown }).type
  return type === 'user'
    || type === 'automation'
    || type === 'scheduler'
    || type === 'host'
    || type === 'replay'
    || type === 'system'
}
