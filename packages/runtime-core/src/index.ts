import type { AgentEvent } from '@weft/core'
import type { PermissionMode } from '@weft/core'
import type {
  TimelineCommandOrigin,
  TimelineEnvelope,
  TimelineFetchRequest,
  TimelineFetchResult,
  TimelineItem,
  TimelinePermissionScope,
} from '@weft/timeline'

export const RUNTIME_KINDS = ['native-sdk', 'app-server', 'compatible-sdk', 'cli-fallback'] as const

export type AgentRuntimeKind = typeof RUNTIME_KINDS[number]

/**
 * Reasoning effort levels accepted by codex `turn/start.effort` (and
 * `thread/start.config.model_reasoning_effort`). Mirrors the protocol's
 * `ReasoningEffort` enum: `none|minimal|low|medium|high|xhigh` plus an
 * arbitrary custom string (codex `Custom(String)`). The `(string & {})`
 * member preserves literal autocomplete while still accepting any string.
 */
export type ModelReasoningEffort =
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | (string & {})

export type AgentRuntimeStatus =
  | 'idle'
  | 'preflighting'
  | 'ready'
  | 'starting'
  | 'running'
  | 'waiting_for_permission'
  | 'turn_completed'
  | 'completed'
  | 'failed'
  | 'disposed'

export type { PermissionMode } from '@weft/core'

/**
 * How a provider's authentication is managed.
 * Provider-neutral auth mode — covers native SDK, app-server, compatible SDK, and CLI fallback.
 */
export type ProviderAuthMode = 'provider-owned' | 'managed' | 'none'

/**
 * Result of probing a provider's auth configuration.
 *
 * For provider-owned auth: checks whether the provider binary reports
 * authentication as configured (e.g. `claude auth status --json` returns
 * `loggedIn: true`, or `codex app-server account/read` returns an account).
 *
 * For managed auth: checks whether required env vars are present.
 * For 'none': no auth required (e.g. fake backend for testing).
 */
export interface ProviderAuthDetection {
  /** Which auth mode this provider uses */
  mode: ProviderAuthMode
  /** Whether auth credentials are available and valid */
  configured: boolean
  /** How auth was detected (e.g. "claude auth status --json", "env vars") */
  source: string
  /** Whether an account was found (provider-owned: from CLI output) */
  accountPresent?: boolean
  /** Whether OpenAI auth is required (Codex-specific) */
  requiresOpenaiAuth?: boolean
  /** Auth method reported by provider (e.g. "oauth", "api_key") */
  method?: string
  /** Provider name reported by CLI (e.g. "anthropic") */
  provider?: string
  /** Error message if auth detection failed */
  error?: string
}

/**
 * Narrowed auth detection for runtime capability reports.
 * Only covers provider-owned auth, which is the SDK-first default.
 */
export interface RuntimeAuthDetection extends ProviderAuthDetection {
  mode: 'provider-owned'
}

export interface RuntimeCandidate {
  kind: AgentRuntimeKind
  available: boolean
  reason?: string
}

export interface RuntimeSelectionOptions {
  provider?: string
  candidates: RuntimeCandidate[]
  preferredRuntime?: AgentRuntimeKind
  allowFallback?: boolean
  fallbackKindOrder?: readonly AgentRuntimeKind[]
}

export interface RuntimeSelection {
  selected?: AgentRuntimeKind
  fallback: boolean
  fallbackReason?: string
  error?: string
}

export interface RuntimeCapabilityReport extends RuntimeSelection {
  provider: string
  candidates: RuntimeCandidate[]
  preferredRuntime?: AgentRuntimeKind
  allowFallback: boolean
  auth: RuntimeAuthDetection
  policyCapabilities: RuntimePolicyCapabilities
  sourceCapabilities: RuntimeSourceCapabilities
  skillCapabilities: RuntimeSkillCapabilities
  automationCapabilities: RuntimeAutomationCapabilities
  hostToolCapabilities: RuntimeHostToolCapabilities
}

export interface CreateRuntimeCapabilityReportOptions extends RuntimeSelectionOptions {
  provider: string
  auth: RuntimeAuthDetection
  extensionCapabilities?: RuntimeExtensionCapabilities
}

export interface AgentRuntimeOptions {
  provider: string
  cwd: string
  sessionId?: string
  model?: string
  reasoningEffort?: ModelReasoningEffort
  permissionMode?: PermissionMode
  authMode?: 'provider-owned'
  preferredRuntime?: AgentRuntimeKind
  allowFallback?: boolean
  executable?: string
  env?: Record<string, string>
  extensions?: RuntimeExtensionContext
}

/**
 * SendMessageOptions — the provider-neutral per-turn options contract.
 *
 * session contract: several fields below are populated by only ONE provider's driver
 * (codex `turn/start.*` params, Claude SDK `Options.*` params) but are surfaced
 * FLAT on this neutral type rather than nested under a provider key. This is
 * an intentional, accepted-as-shared design: app code passes one
 * `SendMessageOptions` object regardless of which provider is selected, and
 * each provider's driver reads only the fields it recognizes — unrecognized
 * fields are ignored (opaque passthrough). Nesting them under
 * `codex: { ... }` / `claude: { ... }` keys would force a provider branch into
 * every call site and would be a breaking change to this public-API type
 * (consumed via `sendMessage(message, options?)` and re-exported by the
 * `@percena/weft*` facade packages). The per-field comments below name the
 * provider whose driver populates each field so the surface stays auditable.
 *
 * The neutral fields (`turnId`, `model`, `reasoningEffort`, `permissionMode`,
 * `commandOrigin`) are honored by every provider.
 */
export interface SendMessageOptions {
  turnId?: string
  model?: string
  reasoningEffort?: ModelReasoningEffort
  permissionMode?: PermissionMode
  commandOrigin?: CommandOrigin
  /**
   * Optional JSON Schema constraining the turn's final assistant message.
   * session contract (accepted-as-shared): consumed by BOTH the codex driver
   * (`turn/start.outputSchema`, mirroring `codex exec --output-schema`) and the
   * Claude driver (mapped to the SDK's `Options.outputFormat` as
   * `{ type: 'json_schema', schema }`). Surfaced flat on the neutral type so app
   * code specifies structured output once regardless of provider.
   */
  outputSchema?: unknown
  /**
   * Per-turn service tier override. session contract (accepted-as-shared): populated by
   * the codex driver (`turn/start.serviceTier`); non-experimental, takes
   * precedence over the thread-level default. Other providers' drivers ignore
   * it. Surfaced flat so app code need not branch on provider.
   */
  serviceTier?: string
  /**
   * Per-turn summary override. session contract (accepted-as-shared): populated by the
   * codex driver (`turn/start.summary`); non-experimental. Other providers
   * ignore it.
   */
  summary?: string
  /**
   * Per-turn personality override. session contract (accepted-as-shared): populated by
   * the codex driver (`turn/start.personality`); non-experimental, takes
   * precedence over the thread-level default. Other providers ignore it.
   */
  personality?: string
  /**
   * Multi-agent orchestration mode. session contract (accepted-as-shared): populated by
   * the codex driver (`turn/start.multiAgentMode`). Experimental — requires
   * `capabilities.experimentalApi` on the server; silently stripped without
   * it. Accepted here for forward compatibility. Other providers ignore it.
   */
  multiAgentMode?: string
  /**
   * Collaboration mode. session contract (accepted-as-shared): populated by the codex
   * driver (`turn/start.collaborationMode`). Experimental — same caveat as
   * `multiAgentMode`. Other providers ignore it.
   */
  collaborationMode?: string
  /**
   * Remote sandbox environments. session contract (accepted-as-shared): populated by the
   * codex driver (`turn/start.environments`); opaque passthrough — the driver
   * forwards the array as-is. Other providers ignore it.
   */
  environments?: unknown[]
  /**
   * Per-turn thinking configuration override. session contract (accepted-as-shared):
   * populated by the Claude driver (forwards to the SDK's `Options.thinking`
   * as-is, opaque). Other providers ignore it.
   */
  thinking?: unknown
  /**
   * Maximum conversation turns for this query. session contract (accepted-as-shared):
   * populated by the Claude driver (forwards to the SDK's `Options.maxTurns`).
   * Other providers ignore it.
   */
  maxTurns?: number
  /**
   * Maximum budget in USD for this query. session contract (accepted-as-shared):
   * populated by the Claude driver (forwards to the SDK's
   * `Options.maxBudgetUsd`). Other providers ignore it.
   */
  maxBudgetUsd?: number
}

export type ToolPolicyDecision =
  | { decision: 'allow'; updatedInput?: Record<string, unknown> }
  | { decision: 'ask'; reason: string }
  | { decision: 'deny'; reason: string }
  | { decision: 'defer' }

/**
 * Extra detail a host may attach to a `respondToPermission(allow)` /
 * `respondToPermission(deny)` call, mirroring the Claude Agent SDK
 * `PermissionResultAllow` / `PermissionResultDeny` fields the base
 * `respondToPermission(requestId, allowed, remember?)` signature cannot carry.
 *
 * - `updatedInput` / `updatedPermissions` (allow): rewrite the tool input /
 *   persist a permission rule (SDK `PermissionResultAllow`).
 * - `interrupt` (deny): interrupt the entire query, not just this tool call
 *   (SDK `PermissionResultDeny.interrupt`).
 *
 * Optional and additive — providers that don't support these fields ignore it.
 */
export interface PermissionResponseDetail {
  updatedInput?: Record<string, unknown>
  /** SDK `PermissionUpdate[]` (addRules/replaceRules/setMode/...). Opaque. */
  updatedPermissions?: unknown
  interrupt?: boolean
}

// Codex-specific: ideally in @weft/providers/codex, but cli-runtime (L3) uses
// these and providers (L4) depends on cli-runtime — moving them would
// create a circular dependency. Extract if a shared utility package is added.
export interface CodexPermissionParams {
  approvalPolicy: string
  approvalsReviewer: string
  sandbox: string
}

/**
 * Canonical PermissionMode → Codex permission parameters mapping, shared by
 * the app-server driver (thread/start, turn/start), the host controller, and
 * the CLI fallback runtime. `sandbox` is a Codex `SandboxMode` string as used
 * by `thread/start` and `codex exec --sandbox`.
 *
 * TODO(codex-agentd): move this mapping to the codex agentd adapter when it
 * exists. It belongs there (keyed off canonical `permission_mode`), not in the
 * SDK core — it is kept here only because codex agentd does not exist yet and
 * the app-server driver + cli-runtime still consume it. Resolution gate: once
 * the codex agentd adapter lands (see the codex app-server alignment tracker),
 * delete this function and consume the mapping from the adapter instead.
 */
export function mapPermissionModeToCodexParams(mode: PermissionMode): CodexPermissionParams {
  switch (mode) {
    case 'explore':
      return { approvalPolicy: 'untrusted', approvalsReviewer: 'user', sandbox: 'read-only' }
    case 'auto':
      return { approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: 'danger-full-access' }
    default:
      return { approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'workspace-write' }
  }
}

/**
 * Codex app-server v2 `turn/start` takes a tagged `SandboxPolicy` object,
 * unlike `thread/start` which takes a plain `SandboxMode` string. Variant
 * fields are all serde-defaulted, so the minimal `{ type }` form is valid.
 */
export function mapCodexSandboxModeToSandboxPolicy(sandbox: string): { type: string } {
  if (sandbox === 'read-only') return { type: 'readOnly' }
  if (sandbox === 'danger-full-access') return { type: 'dangerFullAccess' }
  return { type: 'workspaceWrite' }
}

export type RuntimePermissionScope = TimelinePermissionScope

export type RuntimePermissionScopeInput = string | RuntimePermissionScope

export type RuntimeToolIntent =
  | { kind: 'bash'; command: string; baseCommand: string }
  | { kind: 'file_write'; path: string; toolName: string }
  | { kind: 'mcp'; name: string }
  | { kind: 'api'; method: string; path: string; url?: string }
  | { kind: 'unknown'; toolName: string }

export interface ToolPolicyRequest {
  toolName: string
  input?: Record<string, unknown>
  toolIntent?: RuntimeToolIntent
  scope?: RuntimePermissionScopeInput
}

export type RuntimePolicyHook = (request: ToolPolicyRequest) => ToolPolicyDecision | Promise<ToolPolicyDecision>

export interface RuntimeFeatureCapabilities {
  supported: boolean
  degraded?: boolean
  reason?: string
}

export interface RuntimePolicyCapabilities extends RuntimeFeatureCapabilities {
  modes: PermissionMode[]
  approvals: boolean
  toolPolicy: boolean
}

export interface RuntimeSourceCapabilities extends RuntimeFeatureCapabilities {
  registry?: boolean
  credentialGateway?: boolean
  mcpTools?: boolean
}

export interface RuntimeSkillCapabilities extends RuntimeFeatureCapabilities {
  registry?: boolean
  activationPlan?: boolean
  scopedPolicy?: boolean
}

export interface RuntimeAutomationCapabilities extends RuntimeFeatureCapabilities {
  eventBus: boolean
  schedulerHost: boolean
  promptAction: boolean
  webhookAction: boolean
}

export interface RuntimeHostToolCapabilities extends RuntimeFeatureCapabilities {
  sessionTools: boolean
  workflowTransitions: boolean
  browserActions: boolean
  metadataWrites: boolean
}

export interface RuntimeExtensionCapabilities {
  policy?: RuntimePolicyCapabilities
  sources?: RuntimeSourceCapabilities
  skills?: RuntimeSkillCapabilities
  automations?: RuntimeAutomationCapabilities
  hostTools?: RuntimeHostToolCapabilities
}

export interface RuntimePolicyExtension {
  mode: PermissionMode
  hook?: RuntimePolicyHook
  degraded?: boolean
}

export interface SourceSelection {
  enabledSourceSlugs: string[]
}

export interface ProviderSourceCredentialRef {
  type: string
  sourceSlug: string
  workspaceId?: string
}

export type ProviderSourceToolDescriptor =
  | {
    kind: 'api-source'
    sourceSlug: string
    baseUrl: string
    authType: string
    defaultHeaders?: Record<string, string>
    credentialRef?: ProviderSourceCredentialRef
    [key: string]: unknown
  }
  | {
    kind: 'local-source'
    sourceSlug: string
    path: string
    format?: string
    [key: string]: unknown
  }
  | {
    kind: 'mcp-server'
    sourceSlug: string
    transport: 'stdio' | 'http' | 'sse'
    url?: string
    command?: string
    args?: string[]
    env?: Record<string, string>
    headers?: Record<string, string>
    credentialRef?: ProviderSourceCredentialRef
    [key: string]: unknown
  }
  | {
    kind: 'in-process'
    sourceSlug: string
    /** In-process MCP server instance (structurally: { name, version, tools[] }) */
    server: unknown
    [key: string]: unknown
  }

export interface SkillSelection {
  activeSkillSlugs: string[]
}

export type CommandOrigin = TimelineCommandOrigin

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

export interface RuntimeExtensionContext {
  policy?: RuntimePolicyExtension
  sources?: SourceSelection
  skills?: SkillSelection
  commandOrigin?: CommandOrigin
  hostServices?: RuntimeHostServices
}

export interface AgentCommandSink {
  sendMessage(message: string, options?: SendMessageOptions): Promise<void>
  abort(reason?: string): Promise<void>
  respondToPermission(
    requestId: string,
    allowed: boolean,
    remember?: boolean,
    detail?: PermissionResponseDetail,
  ): Promise<void>
  resumeTool?(runId: string, resumeData: Record<string, unknown>): Promise<void>
  dispose(): Promise<void>
}

export interface AgentEventStream {
  connect(
    onEvent: (event: AgentEvent) => void,
    onError?: (error: Error) => void,
    onClose?: () => void,
  ): void
  disconnect(): void
  isConnected(): boolean
}

export interface AgentTimelineStream {
  connect(
    onEvent: (event: TimelineEnvelope) => void,
    onError?: (error: Error) => void,
    onClose?: () => void,
  ): void
  disconnect(): void
  isConnected(): boolean
}

export interface AgentRuntimeState {
  status: AgentRuntimeStatus
  acceptedMessages: string[]
  queuedMessages: string[]
  lastError?: string
  waitingPermissionRequestId?: string
}

export type RuntimeAction =
  | { type: 'preflight_start' }
  | { type: 'preflight_ok' }
  | { type: 'preflight_error'; error: string }
  | { type: 'starting' }
  | { type: 'send_message'; message: string }
  | { type: 'permission_request'; requestId: string }
  | { type: 'permission_response' }
  | { type: 'turn_completed' }
  | { type: 'complete' }
  | { type: 'abort'; reason?: string }
  | { type: 'error'; error: string }
  | { type: 'dispose' }
  | {
      type: 'replay_reconcile'
      /**
       * The status implied by the LAST terminal marker in a replayed-history
       * batch (session contract). `ready` for a final turn_completed/turn_interrupted,
       * `failed` for a final turn_failed, `waiting_for_permission` (+ requestId)
       * for an unresolved permission_requested, `running` for a final
       * permission_resolved (turn resumed).
       */
      status: AgentRuntimeStatus
      requestId?: string
      /**
       * SDK-R-4: optional error message carried when reconciling to `failed`
       * (from a replayed `turn_failed`). Without this the UI shows a failed
       * status with no `lastError` message.
       */
      error?: string
    }

export const initialRuntimeState: AgentRuntimeState = {
  status: 'idle',
  acceptedMessages: [],
  queuedMessages: [],
}

/**
 * Canonical state machine reducer for AgentRuntime lifecycle.
 *
 * Transitions follow the architecture spec:
 *   idle → preflighting → ready → starting → running
 *   running → waiting_for_permission → running
 *   running → turn_completed → ready
 *   running → ready (via complete with empty queue)
 *   any → failed / disposed
 *   any non-disposed → ready (via abort)
 *
 * `send_message` while running enqueues (session manager semantics).
 * `complete` drains the queue: if a queued message exists, it is
 * immediately accepted and the state stays running.
 */
export function reduceRuntimeState(
  state: AgentRuntimeState = initialRuntimeState,
  action: RuntimeAction,
): AgentRuntimeState {
  switch (action.type) {
    case 'preflight_start':
      return { ...state, status: 'preflighting', lastError: undefined }

    case 'preflight_ok':
      return { ...state, status: 'ready', lastError: undefined }

    case 'preflight_error':
      return { ...state, status: 'failed', lastError: action.error }

    case 'starting':
      if (state.status === 'ready' || state.status === 'idle') {
        return { ...state, status: 'starting' }
      }
      return state

    case 'send_message':
      // session contract: a `send_message` must not silently resurrect a terminal state.
      // Previously the generic else-branch accepted ANY non-running/non-waiting
      // status (including `failed` and `disposed`) → `running`, so a send from
      // `failed` quietly un-failed the runtime and a send from `disposed`
      // re-animated a torn-down one. Terminal states require an explicit reset
      // (`abort` → `ready`) first; the scaffold's `sendMessage` does exactly
      // that before dispatching `send_message`, so the live retry-after-error
      // UX is preserved while the reducer stays guarded. This does NOT affect
      // the X-C `replay_reconcile` path (a separate action that sets status
      // unconditionally) — `send_message` is never dispatched in replay mode.
      if (state.status === 'running' || state.status === 'waiting_for_permission') {
        return {
          ...state,
          queuedMessages: [...state.queuedMessages, action.message],
        }
      }
      if (state.status === 'failed' || state.status === 'disposed') {
        // Terminal: drop the message rather than resurrect. The live send path
        // (scaffold.sendMessage) dispatches `abort` first when it detects
        // `failed`, so this no-op only fires if a caller bypasses the scaffold
        // (defense-in-depth).
        return state
      }
      return {
        ...state,
        status: 'running',
        acceptedMessages: [...state.acceptedMessages, action.message],
      }

    case 'permission_request':
      return {
        ...state,
        status: 'waiting_for_permission',
        waitingPermissionRequestId: action.requestId,
      }

    case 'permission_response':
      return {
        ...state,
        status: 'running',
        waitingPermissionRequestId: undefined,
      }

    case 'turn_completed':
      if (state.status === 'running') {
        return { ...state, status: 'turn_completed' }
      }
      return state

    case 'complete': {
      // A `complete` signal (sendMessage resolved) must not clobber a terminal
      // failed/disposed state. A driver may emit `turn_failed` and then resolve,
      // which dispatches `error` (→ failed) followed by `complete`; without this
      // guard the `complete` would incorrectly reset to ready.
      if (state.status === 'failed' || state.status === 'disposed') {
        return state
      }
      if (state.status === 'turn_completed') {
        const [nextMessage, ...remaining] = state.queuedMessages
        if (nextMessage) {
          return {
            ...state,
            status: 'running',
            acceptedMessages: [...state.acceptedMessages, nextMessage],
            queuedMessages: remaining,
          }
        }
        return { ...state, status: 'ready' }
      }

      const [nextMessage, ...remaining] = state.queuedMessages
      if (nextMessage) {
        return {
          ...state,
          status: 'running',
          acceptedMessages: [...state.acceptedMessages, nextMessage],
          queuedMessages: remaining,
        }
      }
      return { ...state, status: 'ready' }
    }

    case 'abort':
      return {
        ...state,
        status: 'ready',
        lastError: action.reason,
        queuedMessages: [],
        waitingPermissionRequestId: undefined,
      }

    case 'error':
      return { ...state, status: 'failed', lastError: action.error }

    case 'dispose':
      return {
        ...state,
        status: 'disposed',
        queuedMessages: [],
        waitingPermissionRequestId: undefined,
      }

    case 'replay_reconcile':
      // session contract: dispatched ONLY by the scaffold's replay-mode state sync after a
      // replayed-history batch (a reconnect/restart replay under a new epoch).
      // It UNCONDITIONALLY sets the status to the terminal marker implied by
      // the replayed history, bypassing the guarded live transitions. Without
      // it, a replayed `turn_failed` (→ error → failed) wedges: a later
      // replayed `turn_completed` is a no-op from `failed` (the reducer guards
      // `turn_completed` to `running`), so the terminal marker does NOT win.
      // `replay_reconcile` overwrites unconditionally, so the LAST terminal
      // marker wins. The live path never dispatches this — its per-item
      // dispatches are unchanged, so the live state machine is NOT regressed.
      // SDK-R-4: clear the reducer-visible queue on reconcile — the scaffold's
      // pendingQueue is the source of truth for drained sends, and a rotation
      // invalidates queued messages from the pre-rotation turn. Without this
      // the reducer's queuedMessages could disagree with the scaffold's
      // pendingQueue after a rotation (replay-driven ingest never drains).
      // Carry an optional `error` so a reconciled-to-failed status surfaces a
      // message (previously failed-with-no-lastError).
      return {
        ...state,
        status: action.status,
        waitingPermissionRequestId: action.requestId,
        queuedMessages: [],
        ...(action.status === 'failed' && action.error !== undefined
          ? { lastError: action.error }
          : {}),
      }

    default:
      // SDK-R-5: an unrecognized action makes the reducer return `undefined`
      // without a default, and every subsequent `getState().status` throws. TS
      // exhaustiveness protects same-version builds, but a consumer wiring a
      // custom action (or a stale dist receiving a newer action) would
      // hard-crash instead of no-op. Return state unchanged for unknown actions.
      return state
  }
}

export interface AgentRuntime {
  readonly sessionId: string
  readonly provider: string
  readonly runtimeKind: AgentRuntimeKind
  readonly events: AgentTimelineStream
  readonly commands: AgentCommandSink
  preflight(): Promise<RuntimeCapabilityReport>
  fetchTimeline(request: TimelineFetchRequest): Promise<TimelineFetchResult>
  getState(): AgentRuntimeState
  /**
   * session contract: clear replay-suppression mode after a replayed-history batch (a
   * reconnect/restart replay under a new epoch) so live state dispatching
   * resumes. Optional — providers without replay-suppression leave it
   * undefined (the chat hook calls it optionally). No-op when not in replay.
   */
  armReplay?(): void
}

export function createRuntimeExtensionContext(
  context: RuntimeExtensionContext = {},
): RuntimeExtensionContext {
  return {
    policy: context.policy,
    sources: context.sources
      ? { enabledSourceSlugs: unique(context.sources.enabledSourceSlugs) }
      : undefined,
    skills: context.skills
      ? { activeSkillSlugs: unique(context.skills.activeSkillSlugs) }
      : undefined,
    commandOrigin: context.commandOrigin,
    hostServices: context.hostServices,
  }
}

export function sanitizeProviderSourceTools(
  sourceTools: ProviderSourceToolDescriptor[] | undefined,
): ProviderSourceToolDescriptor[] {
  if (!sourceTools || sourceTools.length === 0) return []

  const sanitized: ProviderSourceToolDescriptor[] = []
  for (const sourceTool of sourceTools) {
    if (sourceTool.kind === 'api-source') {
      const defaultHeaders = sourceTool.defaultHeaders
        ? copyNonCredentialStringRecord(sourceTool.defaultHeaders)
        : undefined
      sanitized.push({
        kind: 'api-source',
        sourceSlug: sourceTool.sourceSlug,
        baseUrl: sourceTool.baseUrl,
        authType: sourceTool.authType,
        ...(defaultHeaders && Object.keys(defaultHeaders).length > 0 ? { defaultHeaders } : {}),
        ...(sourceTool.credentialRef ? { credentialRef: sanitizeSourceCredentialRef(sourceTool.credentialRef) } : {}),
      })
      continue
    }

    if (sourceTool.kind === 'local-source') {
      sanitized.push({
        kind: 'local-source',
        sourceSlug: sourceTool.sourceSlug,
        path: sourceTool.path,
        ...(sourceTool.format ? { format: sourceTool.format } : {}),
      })
      continue
    }

    if (sourceTool.kind === 'mcp-server') {
      const env = sourceTool.env ? copyNonCredentialStringRecord(sourceTool.env) : undefined
      const headers = sourceTool.headers ? copyNonCredentialStringRecord(sourceTool.headers) : undefined
      sanitized.push({
        kind: 'mcp-server',
        sourceSlug: sourceTool.sourceSlug,
        transport: sourceTool.transport,
        ...(sourceTool.url ? { url: sourceTool.url } : {}),
        ...(sourceTool.command ? { command: sourceTool.command } : {}),
        ...(sourceTool.args ? { args: sourceTool.args.filter(value => typeof value === 'string') } : {}),
        ...(env && Object.keys(env).length > 0 ? { env } : {}),
        ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
        ...(sourceTool.credentialRef ? { credentialRef: sanitizeSourceCredentialRef(sourceTool.credentialRef) } : {}),
      })
      continue
    }

    if (sourceTool.kind === 'in-process') {
      sanitized.push({
        kind: 'in-process',
        sourceSlug: sourceTool.sourceSlug,
        server: sourceTool.server,
      })
    }
  }

  return sanitized
}

let sessionToolRequestCounter = 0

export async function invokeSessionTool(
  options: InvokeSessionToolOptions,
): Promise<SessionToolInvocationReceipt> {
  const requestId = `session-tool-${++sessionToolRequestCounter}`
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

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

function sanitizeSourceCredentialRef(
  credentialRef: ProviderSourceCredentialRef,
): ProviderSourceCredentialRef {
  return {
    type: credentialRef.type,
    sourceSlug: credentialRef.sourceSlug,
    ...(credentialRef.workspaceId ? { workspaceId: credentialRef.workspaceId } : {}),
  }
}

function copyStringRecord(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record).filter((entry): entry is [string, string] =>
      typeof entry[0] === 'string' && typeof entry[1] === 'string'),
  )
}

function copyNonCredentialStringRecord(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(copyStringRecord(record)).filter(([key]) => !isCredentialKey(key)),
  )
}

function isCredentialKey(key: string): boolean {
  const normalized = key.toLowerCase()
  return normalized === 'authorization' ||
    normalized === 'proxy-authorization' ||
    normalized === 'cookie' ||
    normalized === 'set-cookie' ||
    normalized.includes('api-key') ||
    normalized.includes('apikey') ||
    normalized.includes('token') ||
    normalized.includes('secret') ||
    normalized.includes('password')
}

function findCandidate(candidates: RuntimeCandidate[], kind: AgentRuntimeKind): RuntimeCandidate | undefined {
  return candidates.find(candidate => candidate.kind === kind)
}

function firstAvailableCandidate(candidates: RuntimeCandidate[], fallbackKindOrder?: readonly AgentRuntimeKind[]): RuntimeCandidate | undefined {
  for (const kind of (fallbackKindOrder ?? RUNTIME_KINDS)) {
    const candidate = findCandidate(candidates, kind)
    if (candidate?.available) return candidate
  }
  return undefined
}

export function selectRuntimeCandidate(options: RuntimeSelectionOptions): RuntimeSelection {
  const preferred = options.preferredRuntime
    ? findCandidate(options.candidates, options.preferredRuntime)
    : undefined

  if (preferred?.available) {
    return { selected: preferred.kind, fallback: false }
  }

  if (preferred && options.allowFallback !== true) {
    return {
      fallback: false,
      error: preferred.reason ?? `${preferred.kind} runtime is unavailable`,
    }
  }

  const selected = firstAvailableCandidate(options.candidates, options.fallbackKindOrder)
  if (!selected) {
    return {
      fallback: false,
      error: options.candidates.map(candidate => candidate.reason).filter(Boolean).join('; ') ||
        'No runtime candidates are available',
    }
  }

  const fallback = Boolean(preferred && selected.kind !== preferred.kind)
  return {
    selected: selected.kind,
    fallback,
    fallbackReason: fallback
      ? preferred?.reason ?? `${preferred?.kind ?? 'preferred'} runtime is unavailable`
      : undefined,
  }
}

export function createRuntimeCapabilityReport(
  options: CreateRuntimeCapabilityReportOptions,
): RuntimeCapabilityReport {
  const selection = selectRuntimeCandidate(options)
  const extensionCapabilities = normalizeExtensionCapabilities(options.extensionCapabilities)
  return {
    provider: options.provider,
    candidates: options.candidates,
    preferredRuntime: options.preferredRuntime,
    allowFallback: options.allowFallback === true,
    auth: options.auth,
    ...extensionCapabilities,
    ...selection,
  }
}

function normalizeExtensionCapabilities(
  capabilities: RuntimeExtensionCapabilities = {},
): Pick<RuntimeCapabilityReport,
  'policyCapabilities' |
  'sourceCapabilities' |
  'skillCapabilities' |
  'automationCapabilities' |
  'hostToolCapabilities'
> {
  return {
    policyCapabilities: capabilities.policy ?? {
      supported: false,
      modes: [],
      approvals: false,
      toolPolicy: false,
    },
    sourceCapabilities: capabilities.sources ?? {
      supported: false,
    },
    skillCapabilities: capabilities.skills ?? {
      supported: false,
    },
    automationCapabilities: capabilities.automations ?? {
      supported: false,
      eventBus: false,
      schedulerHost: false,
      promptAction: false,
      webhookAction: false,
    },
    hostToolCapabilities: capabilities.hostTools ?? {
      supported: false,
      sessionTools: false,
      workflowTransitions: false,
      browserActions: false,
      metadataWrites: false,
    },
  }
}
