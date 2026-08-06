import type { PermissionMode } from '@weft/core'
import type { AgentEvent } from '@weft/core'
import type {
  TimelineCommandOrigin,
  TimelineEnvelope,
  TimelineFetchRequest,
  TimelineFetchResult,
  TimelinePermissionScope,
} from '@weft/timeline'
import type { AgentRuntimeState } from './state.ts'
import type { RuntimeHostServices } from './host-tools.ts'

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

/**
 * Runtime lifecycle status.
 *
 * Note: `completed` is @deprecated — the canonical reducer never produces it
 * (turn completion lands on `turn_completed` → `ready`). It is retained in the
 * union for wire/back-compat with hosts that stored serialized states; do not
 * branch on it in new code.
 */
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

/**
 * Where a discovered model list came from. Produced identically by every
 * deployment site (weft-node local-fs probe, server-side probe, browser
 * remote fetch) so the picker / auto-heal UI logic is shared.
 *
 *  - 'gateway': GET {base}/v1/models on the endpoint succeeded (live list)
 *  - 'config': read from local/stored config — NOT probed (claude settings.json
 *    env, codex config.toml `model`, the server's stored connection models). A
 *    static fallback the picker treats the same regardless of provider.
 *  - 'none': nothing discoverable; the picker stays empty and turns send no
 *    model (the runtime uses its own default)
 *
 * Provider-agnostic: there is no per-provider 'env' value — whether a provider's
 * default came from an env block or a config file is a provider-implementation
 * detail, not a picker concern, so all static fallbacks collapse to 'config'.
 */
export type ProviderModelSource = 'gateway' | 'config' | 'none'

/**
 * A provider's discovered model list + its active defaults.
 *
 * The single wire contract produced by all three discovery sites (weft-node
 * local fs, the server, browser remote). The picker defaults to
 * {@link defaultModel} and the effort picker to {@link defaultEffort}; a stale
 * persisted model id not in {@link models} auto-heals to `defaultModel`.
 * `defaultEffort` is normalized where possible — unknown values pass through
 * (codex `Custom(String)` is protocol-legal, see {@link ModelReasoningEffort}).
 */
export interface ProviderModelDiscovery {
  /** Discovered model ids (deduped). Empty = nothing discoverable. */
  models: string[]
  /** Where the list came from. */
  source: ProviderModelSource
  /** The provider's currently-active model (ANTHROPIC_MODEL / codex config
   * `model` / the server's connection default). The picker defaults to this. */
  defaultModel?: string
  /** The provider's active reasoning effort (CLAUDE_CODE_EFFORT_LEVEL / codex
   * config `model_reasoning_effort` / the server's connection default). */
  defaultEffort?: string
  /** Resolved base URL (debugging / capability report). */
  baseUrl?: string
}

/**
 * Common options for a model-discovery probe. Transport-specific surfaces
 * (weft-node `env`/`offline`, browser `connectionID`/`fetchImpl`) extend this;
 * the return type is always {@link ProviderModelDiscovery}.
 *
 * `provider` is an **open string**, matching weft's `provider: string`
 * convention (`RuntimeCapabilityReport`, `AgentRuntimeOptions`). The shared
 * contract is imported by the general `@percena/weft` (claude / codex / flitro),
 * so it must not close over a fixed provider set. `@percena/weft-node` — local
 * only, claude/codex — narrows it in its own `ListProviderModelsCallOptions`.
 */
export interface ListProviderModelsOptions {
  provider: string
  /** Abort the gateway probe. */
  signal?: AbortSignal
}

/**
 * Normalize a raw reasoning-effort value to a {@link ModelReasoningEffort}
 * string, or undefined. Trims + lowercases and passes through any slug-shaped
 * value (`/^[a-z0-9][a-z0-9_-]*$/`); non-slug garbage (spaces / special chars)
 * a picker gate should never forward as `reasoning_effort` → undefined.
 * Empty/whitespace → undefined. Never throws.
 *
 * Provider-agnostic: it does NOT carry any provider's effort ladder (no
 * baked known-set). codex `Custom(String)` is a slug and passes through; the
 * well-known values (none/minimal/low/medium/high/xhigh/max) are slugs too, so
 * they pass through unchanged. Each provider validates against its own enum at
 * the send boundary, not here.
 *
 * Shared across weft-node, the server (re-implemented server-side), and picker
 * UIs so the "is this effort even shaped like an effort?" gate is identical
 * everywhere.
 */
export function normalizeReasoningEffort(value: string | undefined | null): string | undefined {
  if (value == null) return undefined
  const v = String(value).trim().toLowerCase()
  if (!v) return undefined
  // Provider-agnostic slug gate: a well-formed effort id passes through (codex
  // Custom, claude max, the standard ladder all are slugs); malformed input
  // like "high reasoning" is dropped. No provider-specific known-set here.
  return /^[a-z0-9][a-z0-9_-]*$/.test(v) ? v : undefined
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
 * Per-provider namespaced passthrough for per-turn options the neutral
 * contract does not model. Preferred over the deprecated flat fields on
 * {@link SendMessageOptions}: adding a provider knob here does not change the
 * neutral public type, and a host that sets an option for the wrong provider
 * gets an explicit namespace mismatch instead of a silent ignore.
 *
 * Drivers read their own namespace with precedence over the deprecated flat
 * fields (e.g. `providerOptions.claude.maxTurns` wins over
 * `SendMessageOptions.maxTurns`).
 */
export interface ProviderSendMessageOptions {
  /** Claude Agent SDK per-turn `Options` overrides (thinking, maxTurns,
   * maxBudgetUsd, …). Forwarded opaquely by the claude driver. */
  claude?: Record<string, unknown>
  /** Codex `turn/start` per-turn params (serviceTier, summary, personality,
   * multiAgentMode, collaborationMode, environments, …). Forwarded opaquely
   * by the codex driver. */
  codex?: Record<string, unknown>
}

/**
 * RunBudget — limits a provider run may enforce (steps, tokens, wall-time).
 * Honored by the Flitro driver (serialized to `max_steps`/`max_tokens`/
 * `max_wall_time_sec` on the wire). Other providers may ignore it.
 */
export interface RunBudget {
  maxSteps?: number
  maxTokens?: number
  maxWallTimeSec?: number
}

/**
 * SendMessageOptions — the provider-neutral per-turn options contract.
 *
 * The neutral fields (`turnId`, `model`, `reasoningEffort`, `permissionMode`,
 * `commandOrigin`, `outputSchema`, `budget`) are honored where supported —
 * `budget` is honored by the Flitro driver ONLY; the claude/codex drivers
 * have no budget handling and silently ignore it (see {@link RunBudget}).
 *
 * Provider-specific per-turn options belong in {@link providerOptions}
 * (`providerOptions.claude` / `providerOptions.codex`). The remaining flat
 * provider-specific fields below are RETAINED FOR BACK-COMPAT and deprecated:
 * they are populated by only one provider's driver and silently ignored by the
 * others — which is dangerous for budget/permission-class fields (e.g.
 * `maxBudgetUsd` set on a codex session buys no budget protection and no
 * error). Drivers give `providerOptions` precedence over these flat fields.
 */
export interface SendMessageOptions {
  turnId?: string
  model?: string
  reasoningEffort?: ModelReasoningEffort
  permissionMode?: PermissionMode
  commandOrigin?: CommandOrigin
  /** Run budget (steps/tokens/wall-time). Honored by the Flitro driver;
   *  other providers may ignore it. Per-message wins over session default. */
  budget?: RunBudget
  /**
   * Optional JSON Schema constraining the turn's final assistant message.
   * Neutral: consumed by BOTH the codex driver (`turn/start.outputSchema`,
   * mirroring `codex exec --output-schema`) and the Claude driver (mapped to
   * the SDK's `Options.outputFormat` as `{ type: 'json_schema', schema }`).
   */
  outputSchema?: unknown
  /** Provider-namespaced per-turn options. Preferred over the deprecated flat
   * fields below. */
  providerOptions?: ProviderSendMessageOptions
  /** @deprecated Use `providerOptions.codex.serviceTier`. Codex-only
   * (`turn/start.serviceTier`); other providers silently ignore it. */
  serviceTier?: string
  /** @deprecated Use `providerOptions.codex.summary`. Codex-only
   * (`turn/start.summary`); other providers silently ignore it. */
  summary?: string
  /** @deprecated Use `providerOptions.codex.personality`. Codex-only
   * (`turn/start.personality`); other providers silently ignore it. */
  personality?: string
  /** @deprecated Use `providerOptions.codex.multiAgentMode`. Codex-only,
   * experimental (requires `capabilities.experimentalApi`). */
  multiAgentMode?: string
  /** @deprecated Use `providerOptions.codex.collaborationMode`. Codex-only,
   * experimental. */
  collaborationMode?: string
  /** @deprecated Use `providerOptions.codex.environments`. Codex-only, opaque
   * passthrough. */
  environments?: unknown[]
  /** @deprecated Use `providerOptions.claude.thinking`. Claude-only (SDK
   * `Options.thinking`); other providers silently ignore it. */
  thinking?: unknown
  /** @deprecated Use `providerOptions.claude.maxTurns`. Claude-only (SDK
   * `Options.maxTurns`); other providers silently ignore it. */
  maxTurns?: number
  /** @deprecated Use `providerOptions.claude.maxBudgetUsd`. Claude-only (SDK
   * `Options.maxBudgetUsd`). WARNING: silently ignored by other providers —
   * setting it on a codex session provides no budget protection. */
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
 *   (SDK `PermissionResultDeny.interrupt`; codex maps it to the `cancel`
 *   approval decision, which interrupts the turn).
 *
 * Optional and additive — providers that don't support these fields ignore it.
 */
export interface PermissionResponseDetail {
  updatedInput?: Record<string, unknown>
  /** SDK `PermissionUpdate[]` (addRules/replaceRules/setMode/...). Opaque. */
  updatedPermissions?: unknown
  interrupt?: boolean
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

export interface RuntimeExtensionContext {
  policy?: RuntimePolicyExtension
  sources?: SourceSelection
  skills?: SkillSelection
  commandOrigin?: CommandOrigin
  hostServices?: RuntimeHostServices
}

export interface AgentCommandSink {
  /**
   * Send a user message to the agent.
   *
   * PROMISE SEMANTICS (contract): the returned promise resolves when the
   * message has been ACCEPTED by the runtime — not necessarily when the turn
   * finishes. Concretely:
   * - Deferred (replica) runtimes (e.g. Flitro SSE) with no active turn resolve
   *   once the server accepts the message (create-run / enqueue), and REJECT if
   *   that immediate accept fails (e.g. HTTP 409 `llm_connection_unusable`).
   *   When a turn is already active, the runtime accepts the message into its
   *   local queue and the promise resolves immediately; the later server
   *   accept (or failure) is observable through the timeline when that queued
   *   message drains. Turn completion is always observable via
   *   `turn_completed` / `turn_failed`, not the promise.
   * - Eager (local-producer) runtimes (claude native SDK, codex app-server,
   *   CLI fallback) currently resolve when the WHOLE TURN completes — awaiting
   *   the promise can take minutes. If a turn is already running, the message
   *   is queued and the promise resolves on accept (queue), with the actual
   *   send happening after the current turn completes.
   * Hosts that need turn-completion signals MUST watch the timeline
   * (`turn_completed` / `turn_failed` / `turn_interrupted`), not the promise.
   */
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
