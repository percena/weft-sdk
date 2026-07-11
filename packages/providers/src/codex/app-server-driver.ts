import type {
  ProviderRuntimeDriverInput,
  CodexProviderRuntimeDriver,
} from './index.ts'
import { Buffer } from 'node:buffer'
import type {
  ProviderSourceToolDescriptor,
  PermissionMode,
  RuntimePolicyHook,
  RuntimeToolIntent,
  ToolPolicyDecision,
  ModelReasoningEffort,
} from '@weft/runtime-core'
import {
  mapCodexSandboxModeToSandboxPolicy,
  mapPermissionModeToCodexParams,
} from '@weft/runtime-core'
import { asRecord, stringValue } from '@weft/core'
import { normalizeBaseRuntimeToolIntent } from '../shared/tool-intent.ts'
import type {
  TimelineItem,
  TimelineRawRef,
  TimelineSequencer,
} from '@weft/timeline'

export interface CodexAppServerNotification {
  method: string
  params?: unknown
}

export interface CodexAppServerRequest {
  id: unknown
  method: string
  params?: unknown
}

export interface CodexAppServerClient {
  request<T = unknown>(method: string, params?: unknown): Promise<T>
  onNotification(handler: (notification: CodexAppServerNotification) => void): () => void
  onRequest(handler: (request: CodexAppServerRequest) => Promise<unknown>): () => void
  /** Fired when the connection dies unexpectedly (process crash/exit). */
  onClose?(handler: () => void): () => void
}

export interface CreateCodexAppServerDriverOptions {
  cwd: string
  client: CodexAppServerClient
  threadId?: string
  model?: string
  reasoningEffort?: ModelReasoningEffort
  approvalPolicy?: string
  approvalsReviewer?: string
  sandbox?: string
  policy?: RuntimePolicyHook
  sourceTools?: ProviderSourceToolDescriptor[]
  /** Thread-level overrides sent on `thread/start` (non-experimental). */
  modelProvider?: string
  serviceTier?: string
  baseInstructions?: string
  developerInstructions?: string
  personality?: string
  serviceName?: string
  threadSource?: string
  /** Experimental — requires `capabilities.experimentalApi` on the server. */
  multiAgentMode?: string
}

interface PendingPermission {
  resolve: (response: unknown) => void
  /** 'approval' = command/fileChange (returns {decision}); 'permission' = request_permissions (returns {permissions, scope}) */
  kind: 'approval' | 'permission'
  /** For 'permission' kind: the requested profile echoed back as the granted subset when allowed */
  requestedPermissions?: unknown
}

interface CodexTurnError {
  message: string
  codexErrorInfo?: unknown
  additionalDetails?: string
}

/**
 * Thrown (rejecting the in-flight turn's `sendMessage` promise) when codex
 * reports a failed turn (`turn/completed(status:failed)`) or when the
 * app-server connection dies mid-turn. Carries the structured codex error so
 * callers can inspect `codexErrorInfo` beyond the message.
 */
export class CodexTurnFailureError extends Error {
  readonly codexErrorInfo?: unknown
  readonly additionalDetails?: string
  constructor(error: CodexTurnError) {
    super(error.message)
    this.name = 'CodexTurnFailureError'
    this.codexErrorInfo = error.codexErrorInfo
    this.additionalDetails = error.additionalDetails
  }
}

interface PendingTurn {
  resolve: () => void
  reject: (error: Error) => void
}

export function createCodexAppServerDriver(
  options: CreateCodexAppServerDriverOptions,
): CodexProviderRuntimeDriver {
  let threadId = options.threadId
  let threadInitialized = false
  let activeSequencer: TimelineSequencer | undefined
  const pendingTurns = new Map<string, PendingTurn>()
  const pendingPermissions = new Map<string, PendingPermission>()
  const turnAliases = new Map<string, string>()
  const commandTurnIds = new Map<string, string>()
  // Provider turn id currently in flight (for abort → turn/interrupt).
  let activeTurnId: string | undefined
  // Provider turn ids that were aborted/interrupted locally. After `abort()`
  // sends `turn/interrupt`, codex may still emit trailing `item/*` and a
  // terminal `turn/completed(interrupted)` for that turn; these are dropped so
  // the timeline is not polluted and no late terminal item is emitted.
  const abortedTurnIds = new Set<string>()
  // Stashed `error` notification payload per turn, used when the terminal
  // `turn/completed(status:failed)` omits `turn.error`.
  const pendingTurnErrors = new Map<string, CodexTurnError>()
  // Latest `thread/tokenUsage/updated` payload per turn, attached to the
  // terminal `turn_completed` item (turn/completed carries no usage itself).
  const tokenUsageByTurn = new Map<string, unknown>()

  const unsubscribeNotification = options.client.onNotification((notification) => {
    if (!activeSequencer) return
    handleNotification(
      notification,
      activeSequencer,
      pendingTurns,
      pendingTurnErrors,
      tokenUsageByTurn,
      turnAliases,
      commandTurnIds,
      abortedTurnIds,
    )
  })

  const unsubscribeRequest = options.client.onRequest(async (request) => {
    if (!activeSequencer) return safeServerRequestResponse(request)
    return handleServerRequest(request, activeSequencer)
  })

  // If the app-server connection dies mid-turn, fail the in-flight turn
  // instead of hanging forever waiting for a turn/completed that will never
  // arrive. Pending requests (e.g. an in-flight turn/start) are already rejected
  // by the client; this covers the wait-on-notification path.
  const unsubscribeClose = options.client.onClose?.(() => handleTransportClosed())

  function handleTransportClosed(): void {
    const turnId = activeTurnId
    // Only fail a turn that is actually still in flight. `activeTurnId` is not
    // reset on normal turn/completed (handleNotification is a top-level fn
    // without closure access), so a connection drop after a turn already
    // completed must not emit a spurious turn_failed.
    if (turnId && activeSequencer && pendingTurns.has(turnId)) {
      activeSequencer.append({
        type: 'turn_failed',
        turnId: timelineTurnId(turnId, turnAliases),
        error: { message: 'Codex app-server connection closed unexpectedly' },
      }, rawRef('transport_closed'))
    }
    const failure = new CodexTurnFailureError({ message: 'Codex app-server connection closed unexpectedly' })
    for (const turn of pendingTurns.values()) turn.reject(failure)
    pendingTurns.clear()
    pendingPermissions.clear()
    pendingTurnErrors.clear()
    tokenUsageByTurn.clear()
    activeTurnId = undefined
  }

  async function handleServerRequest(
    request: CodexAppServerRequest,
    sequencer: TimelineSequencer,
  ): Promise<unknown> {
    if (request.method === 'item/commandExecution/requestApproval') {
      const params = asRecord(request.params)
      const requestId = stringValue(params.approvalId) ?? stringValue(params.itemId) ?? String(request.id)
      const input = {
        command: stringValue(params.command),
        cwd: stringValue(params.cwd),
      }
      const decision = await evaluatePolicy(options.policy, {
        toolName: 'Bash',
        input,
        toolIntent: normalizeRuntimeToolIntent('Bash', input),
        scope: params.itemId ? { type: 'tool-call', callId: String(params.itemId) } : undefined,
      })
      return resolveApprovalDecision({
        requestId,
        toolName: 'Bash',
        input,
        reason: stringValue(params.reason) ?? decisionReason(decision),
        decision,
        sequencer,
      })
    }

    if (request.method === 'item/fileChange/requestApproval') {
      const params = asRecord(request.params)
      const requestId = stringValue(params.approvalId) ?? stringValue(params.itemId) ?? String(request.id)
      const input = { changes: params.changes }
      const decision = await evaluatePolicy(options.policy, {
        toolName: 'fileChange',
        input,
        toolIntent: normalizeRuntimeToolIntent('fileChange', input),
        scope: params.itemId ? { type: 'tool-call', callId: String(params.itemId) } : undefined,
      })
      return resolveApprovalDecision({
        requestId,
        toolName: 'fileChange',
        input,
        reason: stringValue(params.reason) ?? decisionReason(decision),
        decision,
        sequencer,
      })
    }

    if (request.method === 'item/permissions/requestApproval') {
      // `request_permissions` tool / permission-escalation flow. The granted
      // subset of the requested profile is echoed back; anything omitted is
      // treated as denied by codex (README §permissions: "Any permissions
      // omitted from `result.permissions` are treated as denied."). Previously
      // this was hard-coded to grant nothing silently; now it routes through
      // the policy hook and surfaces to the host like other approvals.
      // (Note: the GrantedPermissionProfile wire fields are camelCase —
      // `network`/`fileSystem` — so echoing `requestedPermissions` verbatim is
      // wire-correct; no key remapping is needed.)
      const params = asRecord(request.params)
      const requestId = stringValue(params.itemId) ?? String(request.id)
      const requestedPermissions = params.permissions ?? {}
      const reason = stringValue(params.reason) ?? 'Codex requested additional permissions'
      const toolName = permissionsToolName(params)
      const decision = await evaluatePolicy(options.policy, {
        toolName,
        input: { permissions: requestedPermissions, cwd: stringValue(params.cwd) },
        toolIntent: permissionsToolIntent(params),
        scope: { type: 'tool-call', callId: String(params.itemId ?? request.id) },
      })
      return resolvePermissionApproval({
        requestId,
        toolName,
        requestedPermissions,
        reason,
        decision,
        sequencer,
      })
    }

    if (request.method === 'item/tool/requestUserInput') {
      // No host input channel today — surface the request on the timeline so it
      // is not silent, then return a protocol-valid empty answer map. codex
      // treats this as "no input" and the requesting tool fails gracefully.
      const params = asRecord(request.params)
      sequencer.append({
        type: 'host_state_changed',
        state: {
          kind: 'codex_user_input_requested',
          requestId: stringValue(params.itemId) ?? String(request.id),
          questions: params.questions,
        },
      }, rawRef('server_request'))
      return { answers: {} }
    }

    if (request.method === 'mcpServer/elicitation/request') {
      // No host elicitation channel today — surface the request, then decline.
      // The elicitation details (mode/message/requestedSchema/url) are
      // flattened onto the params top-level by codex (there is no `request`
      // sub-field), so capture them directly.
      const params = asRecord(request.params)
      sequencer.append({
        type: 'host_state_changed',
        state: {
          kind: 'codex_elicitation_requested',
          requestId: String(request.id),
          serverName: stringValue(params.serverName),
          mode: stringValue(params.mode),
          message: stringValue(params.message),
          requestedSchema: params.requestedSchema,
          url: stringValue(params.url),
        },
      }, rawRef('server_request'))
      return { action: 'decline' }
    }

    if (request.method === 'item/tool/call') {
      // DynamicToolCall (host-side tool). weft does not register dynamicTools
      // today (execution bridge deferred), so this is defensive: surface the call, then return a failed no-op
      // DynamicToolCallResponse so codex does not hang on `{}`.
      const params = asRecord(request.params)
      sequencer.append({
        type: 'host_state_changed',
        state: {
          kind: 'codex_dynamic_tool_call',
          requestId: stringValue(params.callId) ?? String(request.id),
          tool: stringValue(params.tool),
          arguments: params.arguments,
        },
      }, rawRef('server_request'))
      return { contentItems: [], success: false }
    }

    if (request.method === 'currentTime/read') {
      return { currentTimeAt: Math.floor(Date.now() / 1000) }
    }

    return safeServerRequestResponse(request)
  }

  function resolveApprovalDecision(args: {
    requestId: string
    toolName: string
    input: Record<string, unknown>
    reason?: string
    decision: ToolPolicyDecision
    sequencer: TimelineSequencer
  }): Promise<unknown> | unknown {
    if (args.decision.decision === 'allow') {
      return { decision: 'accept' }
    }
    if (args.decision.decision === 'deny') {
      args.sequencer.append({
        type: 'permission_resolved',
        requestId: args.requestId,
        resolution: { allowed: false, reason: args.decision.reason },
      })
      return { decision: 'decline' }
    }

    args.sequencer.append({
      type: 'permission_requested',
      request: {
        requestId: args.requestId,
        toolName: args.toolName,
        input: args.input,
        reason: args.reason,
      },
    }, rawRef('server_request'))

    return new Promise(resolve => {
      pendingPermissions.set(args.requestId, { resolve, kind: 'approval' })
    })
  }

  function resolvePermissionApproval(args: {
    requestId: string
    toolName: string
    requestedPermissions: unknown
    reason: string
    decision: ToolPolicyDecision
    sequencer: TimelineSequencer
  }): Promise<unknown> | unknown {
    if (args.decision.decision === 'allow') {
      // Grant exactly the requested subset (codex ignores anything not in the
      // original request, so echoing the request is safe).
      return { permissions: args.requestedPermissions ?? {}, scope: 'turn' }
    }
    if (args.decision.decision === 'deny') {
      args.sequencer.append({
        type: 'permission_resolved',
        requestId: args.requestId,
        resolution: { allowed: false, reason: args.decision.reason },
      })
      return { permissions: {}, scope: 'turn' }
    }

    args.sequencer.append({
      type: 'permission_requested',
      request: {
        requestId: args.requestId,
        toolName: args.toolName,
        input: { permissions: args.requestedPermissions },
        reason: args.reason,
      },
    }, rawRef('server_request'))

    return new Promise(resolve => {
      pendingPermissions.set(args.requestId, {
        resolve,
        kind: 'permission',
        requestedPermissions: args.requestedPermissions,
      })
    })
  }

  return {
    async sendMessage(input: ProviderRuntimeDriverInput, sequencer: TimelineSequencer): Promise<void> {
      activeSequencer = sequencer
      if (!threadInitialized) {
        const configParams = threadStartConfigParams({
          model: input.options?.model ?? options.model,
          reasoningEffort: input.options?.reasoningEffort ?? options.reasoningEffort,
        })
        const permissionParams = threadStartPermissionParams(options)
        const commonTopLevel = threadCommonTopLevelParams(options)
        if (threadId) {
          // Resuming a pre-existing thread (cross-process or within-session).
          // Only the fields that exist on `ThreadResumeParams` are sent —
          // `serviceName`/`threadSource`/`multiAgentMode` are `ThreadStartParams`
          // only (codex ignores unknown fields, but we avoid sending
          // protocol-undefined ones on resume).
          const response = await options.client.request('thread/resume', {
            threadId,
            cwd: options.cwd,
            ...configParams,
            ...permissionParams,
            ...commonTopLevel,
          })
          threadId = readThreadId(response)
        } else {
          const response = await options.client.request('thread/start', {
            cwd: options.cwd,
            ...configParams,
            ...permissionParams,
            ...commonTopLevel,
            ...threadStartOnlyTopLevelParams(options),
          })
          threadId = readThreadId(response)
        }
        threadInitialized = true
      }

      const response = await options.client.request('turn/start', {
        threadId,
        input: [{ type: 'text', text: input.message, text_elements: [] }],
        cwd: options.cwd,
        ...turnStartPermissionParams(input.options?.permissionMode),
        // Per-turn overrides (all non-experimental on turn/start): model,
        // effort (reasoning), outputSchema, serviceTier, summary, personality.
        // These take precedence over the thread-level config set on
        // thread/start and are honored on every turn, including turns after the
        // first (where thread/start is skipped).
        ...turnStartOverrides(input.options, options.model, options.reasoningEffort),
      })
      const providerTurnId = readTurnId(response)
      if (!providerTurnId) return
      const timelineTurnId = input.options?.turnId ?? providerTurnId
      turnAliases.set(providerTurnId, timelineTurnId)
      activeTurnId = providerTurnId
      await new Promise<void>((resolve, reject) => {
        pendingTurns.set(providerTurnId, { resolve, reject })
      })
    },
    async respondToPermission(requestId, allowed, remember): Promise<void> {
      const pending = pendingPermissions.get(requestId)
      if (!pending) return
      pendingPermissions.delete(requestId)
      activeSequencer?.append({
        type: 'permission_resolved',
        requestId,
        resolution: { allowed, remember },
      })
      pending.resolve(buildPermissionResponse(pending, allowed, remember))
    },
    async abort(): Promise<void> {
      // Best-effort: tell codex to stop the in-flight turn. Fire-and-forget so
      // abort stays snappy even if the server is slow to ack (`turn/interrupt`
      // resolves with an empty object).
      const turnId = activeTurnId
      if (threadId && turnId) {
        abortedTurnIds.add(turnId)
        void options.client.request('turn/interrupt', { threadId, turnId }).catch(() => {})
        // Drop per-turn state for the aborted turn so a trailing
        // turn/completed(interrupted) for it is a clean no-op.
        pendingTurnErrors.delete(turnId)
        tokenUsageByTurn.delete(turnId)
        turnAliases.delete(turnId)
      }
      // abort is user-initiated cancellation, not a failure — resolve (do not
      // reject) so callers can distinguish "stopped" from "errored".
      for (const turn of pendingTurns.values()) {
        turn.resolve()
      }
      pendingTurns.clear()
      activeTurnId = undefined
    },
    async dispose(): Promise<void> {
      unsubscribeNotification()
      unsubscribeRequest()
      unsubscribeClose?.()
      pendingPermissions.clear()
      pendingTurns.clear()
    },
  }
}

function threadStartPermissionParams(
  options: Pick<CreateCodexAppServerDriverOptions, 'approvalPolicy' | 'approvalsReviewer' | 'sandbox'>,
): Record<string, unknown> {
  return {
    ...(options.approvalPolicy ? { approvalPolicy: options.approvalPolicy } : {}),
    ...(options.approvalsReviewer ? { approvalsReviewer: options.approvalsReviewer } : {}),
    ...(options.sandbox ? { sandbox: options.sandbox } : {}),
  }
}

/**
 * Per-turn overrides for `turn/start` (model, reasoning effort, output schema,
 * service tier, summary, personality — all non-experimental). Only included
 * when the caller or driver options provide a value, so the thread-level config
 * remains the default when nothing is specified.
 */
function turnStartOverrides(
  options: ProviderRuntimeDriverInput['options'],
  fallbackModel?: string,
  fallbackEffort?: ModelReasoningEffort,
): Record<string, unknown> {
  const model = options?.model ?? fallbackModel
  const effort = options?.reasoningEffort ?? fallbackEffort
  const outputSchema = options?.outputSchema
  const overrides: Record<string, unknown> = {}
  if (model) overrides.model = model
  if (effort) overrides.effort = effort
  if (outputSchema !== undefined) overrides.outputSchema = outputSchema
  if (options?.serviceTier) overrides.serviceTier = options.serviceTier
  if (options?.summary) overrides.summary = options.summary
  if (options?.personality) overrides.personality = options.personality
  if (options?.multiAgentMode) overrides.multiAgentMode = options.multiAgentMode
  if (options?.collaborationMode) overrides.collaborationMode = options.collaborationMode
  if (options?.environments) overrides.environments = options.environments
  return overrides
}

/**
 * Thread-level fields common to BOTH `thread/start` and `thread/resume`
 * (modelProvider/serviceTier/baseInstructions/developerInstructions/personality).
 * Only included when the driver options provide a value. Per-turn overrides on
 * `turn/start` take precedence over these.
 */
function threadCommonTopLevelParams(
  options: Pick<
    CreateCodexAppServerDriverOptions,
    | 'modelProvider'
    | 'serviceTier'
    | 'baseInstructions'
    | 'developerInstructions'
    | 'personality'
  >,
): Record<string, unknown> {
  const params: Record<string, unknown> = {}
  if (options.modelProvider) params.modelProvider = options.modelProvider
  if (options.serviceTier) params.serviceTier = options.serviceTier
  if (options.baseInstructions) params.baseInstructions = options.baseInstructions
  if (options.developerInstructions) params.developerInstructions = options.developerInstructions
  if (options.personality) params.personality = options.personality
  return params
}

/**
 * Fields that exist on `ThreadStartParams` but NOT on `ThreadResumeParams`
 * (serviceName/threadSource/multiAgentMode). codex does not enable
 * `deny_unknown_fields`, so sending these on resume would be silently dropped —
 * but we only send them on `thread/start` to stay protocol-accurate.
 * (`multiAgentMode` is experimental and additionally requires
 * `capabilities.experimentalApi`, which is not advertised — see app-server-client.)
 */
function threadStartOnlyTopLevelParams(
  options: Pick<
    CreateCodexAppServerDriverOptions,
    'serviceName' | 'threadSource' | 'multiAgentMode'
  >,
): Record<string, unknown> {
  const params: Record<string, unknown> = {}
  if (options.serviceName) params.serviceName = options.serviceName
  if (options.threadSource) params.threadSource = options.threadSource
  if (options.multiAgentMode) params.multiAgentMode = options.multiAgentMode
  return params
}

function turnStartPermissionParams(permissionMode: PermissionMode | undefined): Record<string, unknown> {
  const params = permissionMode ? mapPermissionModeToCodexParams(permissionMode) : undefined
  return params
    ? {
      approvalPolicy: params.approvalPolicy,
      approvalsReviewer: params.approvalsReviewer,
      sandboxPolicy: mapCodexSandboxModeToSandboxPolicy(params.sandbox),
    }
    : {}
}

function threadStartConfigParams(
  options: {
    model?: string
    reasoningEffort?: string
  },
): { config?: Record<string, unknown> } {
  // NOTE: source tools are NOT registered here. codex ignores an arbitrary
  // `config.weftSources` key (it only reads config.model and
  // config.model_reasoning_effort). Real client-tool registration requires
  // `thread/start.dynamicTools` (experimental, needs
  // `initialize.capabilities.experimentalApi`) plus an `item/tool/call`
  // execution bridge — future work. Until then, sourceTools accepted by the
  // driver are not wired into the app-server turn.
  const config: Record<string, unknown> = {}
  if (options.model) config.model = options.model
  if (options.reasoningEffort) config.model_reasoning_effort = options.reasoningEffort
  if (Object.keys(config).length === 0) return {}
  return {
    config,
  }
}

function normalizeRuntimeToolIntent(
  toolName: string,
  input: Record<string, unknown>,
): RuntimeToolIntent {
  // --- Codex-specific tool intent ---
  if (toolName === 'fileChange') {
    return {
      kind: 'file_write',
      toolName,
      path: pathFromFileChanges(input.changes),
    }
  }

  // --- Common intents (Bash, MCP, unknown fallback) ---
  return normalizeBaseRuntimeToolIntent(toolName, input)
}

function pathFromFileChanges(changes: unknown): string {
  if (!Array.isArray(changes)) return ''
  const firstChange = asRecord(changes[0])
  return stringValue(firstChange.path) ?? stringValue(firstChange.filePath) ?? ''
}

async function evaluatePolicy(
  policy: RuntimePolicyHook | undefined,
  request: Parameters<RuntimePolicyHook>[0],
): Promise<ToolPolicyDecision> {
  return policy?.(request) ?? { decision: 'ask', reason: 'Codex app-server requested approval' }
}

function handleNotification(
  notification: CodexAppServerNotification,
  sequencer: TimelineSequencer,
  pendingTurns: Map<string, PendingTurn>,
  pendingTurnErrors: Map<string, CodexTurnError>,
  tokenUsageByTurn: Map<string, unknown>,
  turnAliases: Map<string, string>,
  commandTurnIds: Map<string, string>,
  abortedTurnIds: Set<string>,
): void {
  const params = asRecord(notification.params)
  // Drop any notification attributed to a turn we aborted locally. After
  // `turn/interrupt`, codex may still emit trailing `item/*` and a terminal
  // `turn/completed(interrupted)` for that turn; filtering keeps the timeline
  // clean and prevents a late terminal item from clobbering the abort. The
  // terminal `turn/completed` also stops tracking the turn (bounding the set
  // so it does not grow across aborts).
  const notifTurnId = stringValue(params.turnId) ?? readTurnId(params)
  if (notifTurnId && abortedTurnIds.has(notifTurnId)) {
    if (notification.method === 'turn/completed') abortedTurnIds.delete(notifTurnId)
    return
  }

  if (notification.method === 'turn/started') {
    const providerTurnId = readTurnId(params)
    if (providerTurnId) {
      append(sequencer, { type: 'turn_started', turnId: timelineTurnId(providerTurnId, turnAliases) }, notification.method)
    }
    return
  }

  if (notification.method === 'item/agentMessage/delta') {
    const providerTurnId = String(params.turnId ?? 'codex-turn')
    append(sequencer, {
      type: 'assistant_message_delta',
      text: String(params.delta ?? ''),
      messageId: String(params.itemId ?? 'codex-message'),
      turnId: timelineTurnId(providerTurnId, turnAliases),
    }, notification.method)
    return
  }

  if (notification.method === 'item/reasoning/summaryTextDelta'
    || notification.method === 'item/reasoning/textDelta'
    || notification.method === 'item/plan/delta') {
    // Stream reasoning/plan text as it arrives, instead of only surfacing the
    // final item on item/completed. `item/plan/delta` and the reasoning delta
    // notifications share the same `{ delta }` streaming shape.
    // (Note: `item/reasoning/summaryPartAdded` is intentionally NOT here — it
    // carries only `{ summaryIndex }` with no text; the summary text arrives
    // via separate `summaryTextDelta` notifications.)
    const providerTurnId = String(params.turnId ?? 'codex-turn')
    const text = stringValue(params.delta) ?? stringValue(params.text) ?? outputDeltaText(params)
    if (!text) return
    append(sequencer, {
      type: 'reasoning_delta',
      text,
      messageId: String(params.itemId ?? 'codex-reasoning'),
      turnId: timelineTurnId(providerTurnId, turnAliases),
    }, notification.method)
    return
  }

  if (notification.method === 'item/started') {
    const item = asRecord(params.item)
    const providerTurnId = String(params.turnId ?? 'codex-turn')
    const turnId = timelineTurnId(providerTurnId, turnAliases)
    const timelineItem = toolCallFromThreadItem(item, turnId)
    if (timelineItem?.type === 'tool_call') commandTurnIds.set(timelineItem.callId, turnId)
    if (timelineItem) append(sequencer, timelineItem, notification.method)
    return
  }

  if (notification.method === 'item/commandExecution/outputDelta'
    || notification.method === 'item/mcpToolCall/progress'
    || notification.method === 'item/fileChange/patchUpdated') {
    // Streaming progress for an in-flight tool call. Map to tool_output_delta
    // using the item id (callId) tracked from item/started.
    const callId = stringValue(params.itemId) ?? stringValue(params.callId) ?? stringValue(params.id)
    if (!callId) return
    const providerTurnId = String(params.turnId ?? 'codex-turn')
    const turnId = params.turnId ? timelineTurnId(providerTurnId, turnAliases) : (commandTurnIds.get(callId) ?? timelineTurnId(providerTurnId, turnAliases))
    commandTurnIds.set(callId, turnId)
    // `outputDeltaText` returns '' (not undefined) when no delta/text/output/
    // chunk is present, so use `||` — not `??` — to fall through to the
    // method-specific payloads: `message` for mcpToolCall/progress and
    // `changes` for fileChange/patchUpdated (neither carries a `delta` field).
    const text = outputDeltaText(params)
      || stringValue(params.message)
      || (params.changes ? JSON.stringify(params.changes) : '')
    if (!text) return
    append(sequencer, {
      type: 'tool_output_delta',
      callId,
      text,
      stream: stringValue(params.stream),
      turnId,
    }, notification.method)
    return
  }

  if (notification.method === 'command/exec/outputDelta') {
    // Base64-encoded output for a streaming `command/exec` request
    // (connection-scoped processId). Surface as a tool_output_delta using the
    // processId as the callId.
    const callId = stringValue(params.processId)
    if (!callId) return
    const text = outputDeltaText(params)
    if (!text) return
    append(sequencer, {
      type: 'tool_output_delta',
      callId,
      text,
      stream: stringValue(params.stream),
    }, notification.method)
    return
  }

  if (notification.method === 'thread/status/changed') {
    append(sequencer, {
      type: 'session_status',
      status: stringValue(params.status) ?? 'unknown',
    }, notification.method)
    return
  }

  if (notification.method === 'model/rerouted') {
    const providerTurnId = stringValue(params.turnId)
    append(sequencer, {
      type: 'host_state_changed',
      state: {
        kind: 'codex_model_rerouted',
        threadId: stringValue(params.threadId),
        turnId: providerTurnId ? timelineTurnId(providerTurnId, turnAliases) : undefined,
        fromModel: stringValue(params.fromModel),
        toModel: stringValue(params.toModel),
        reason: stringValue(params.reason),
      },
    }, notification.method)
    return
  }

  if (notification.method === 'warning') {
    const message = stringValue(params.message)
    if (!message) return
    append(sequencer, {
      type: 'host_state_changed',
      state: {
        kind: 'codex_warning',
        threadId: stringValue(params.threadId),
        message,
      },
    }, notification.method)
    return
  }

  // Intentionally not surfaced to the timeline — documented no-ops rather than
  // dropped silently.
  //
  // Turn-level: turn/plan/updated (structured plan-step update; streaming text
  // is covered by item/plan/delta), turn/diff/updated, turn/moderationMetadata.
  //
  // Item-level: item/reasoning/summaryPartAdded (carries only summaryIndex; text
  // arrives via summaryTextDelta), item/commandExecution/terminalInteraction,
  // item/autoApprovalReview/started, item/autoApprovalReview/completed,
  // item/fileChange/outputDelta (deprecated, superseded by patchUpdated),
  // rawResponseItem/completed.
  //
  // Model: model/verification, model/safetyBuffering/updated.
  //
  // Thread lifecycle: thread/name/updated, thread/goal/updated,
  // thread/goal/cleared, thread/settings/updated, thread/archived,
  // thread/unarchived, thread/deleted, thread/closed, thread/compacted,
  // thread/started, thread/memoryMode/set.
  //
  // Account: account/updated, account/rateLimits/updated,
  // account/login/completed.
  //
  // Other: serverRequest/resolved, guardianWarning, deprecationNotice,
  // configWarning, skills/changed, hook/started, hook/completed,
  // app/list/updated, fs/changed, mcpServer/oauthLogin/completed,
  // mcpServer/startupStatus/updated, remoteControl/status/changed.
  //
  // Experimental (require capabilities.experimentalApi): process/outputDelta,
  // process/exited, thread/realtime/*.

  if (notification.method === 'item/completed') {
    const item = asRecord(params.item)
    const providerTurnId = String(params.turnId ?? 'codex-turn')
    const completedItems = completedTimelineItemsFromThreadItem(item, timelineTurnId(providerTurnId, turnAliases))
    for (const item of completedItems) {
      append(sequencer, item, notification.method)
      if (item.type === 'tool_result') commandTurnIds.delete(item.callId)
    }
    return
  }

  if (notification.method === 'thread/tokenUsage/updated') {
    // Stash the latest token-usage payload for this turn; attached to the
    // terminal turn_completed item (turn/completed itself carries no usage).
    const providerTurnId = stringValue(params.turnId) ?? readTurnId(params)
    if (providerTurnId && params.tokenUsage !== undefined) {
      tokenUsageByTurn.set(providerTurnId, params.tokenUsage)
    }
    return
  }

  if (notification.method === 'error') {
    // Mid-turn error. `willRetry:true` is transient (codex retries, turn
    // continues) — ignore it. Otherwise stash the payload; the terminal
    // `turn/completed(status:failed)` emits the `turn_failed` timeline item.
    const errorPayload = readTurnError(params.error)
    if (!errorPayload || params.willRetry) return
    const providerTurnId = stringValue(params.turnId) ?? readTurnId(params)
    if (providerTurnId) pendingTurnErrors.set(providerTurnId, errorPayload)
    return
  }

  if (notification.method === 'turn/completed') {
    const providerTurnId = readTurnId(params)
    if (!providerTurnId) return
    const turn = asRecord(params.turn)
    const status = stringValue(turn.status) ?? 'completed'
    const timelineTurn = timelineTurnId(providerTurnId, turnAliases)
    if (status === 'failed') {
      const errorPayload = readTurnError(turn.error)
        ?? pendingTurnErrors.get(providerTurnId)
        ?? { message: 'Codex turn failed' }
      append(sequencer, {
        type: 'turn_failed',
        turnId: timelineTurn,
        error: errorPayload,
      }, notification.method)
      finalizeTurn(providerTurnId, pendingTurnErrors, tokenUsageByTurn, pendingTurns, turnAliases, true, errorPayload)
    } else if (status === 'interrupted') {
      // Server-initiated interrupt (a user abort is filtered above as an
      // aborted turn). The turn ended without failure; surface a distinct
      // interrupted marker and resolve the pending turn.
      append(sequencer, { type: 'turn_interrupted', turnId: timelineTurn }, notification.method)
      finalizeTurn(providerTurnId, pendingTurnErrors, tokenUsageByTurn, pendingTurns, turnAliases, false)
    } else {
      // completed | inProgress — the turn ended normally.
      const usage = tokenUsageByTurn.get(providerTurnId)
      append(sequencer, {
        type: 'turn_completed',
        turnId: timelineTurn,
        ...(usage !== undefined ? { usage } : {}),
      }, notification.method)
      finalizeTurn(providerTurnId, pendingTurnErrors, tokenUsageByTurn, pendingTurns, turnAliases, false)
    }
  }
}

/** Clean up per-turn maps and settle the pending turn (resolve or reject). */
function finalizeTurn(
  providerTurnId: string,
  pendingTurnErrors: Map<string, CodexTurnError>,
  tokenUsageByTurn: Map<string, unknown>,
  pendingTurns: Map<string, PendingTurn>,
  turnAliases: Map<string, string>,
  reject: boolean,
  errorPayload?: CodexTurnError,
): void {
  pendingTurnErrors.delete(providerTurnId)
  tokenUsageByTurn.delete(providerTurnId)
  const pending = pendingTurns.get(providerTurnId)
  if (pending) {
    if (reject && errorPayload) pending.reject(new CodexTurnFailureError(errorPayload))
    else pending.resolve()
  }
  pendingTurns.delete(providerTurnId)
  turnAliases.delete(providerTurnId)
}

function timelineTurnId(providerTurnId: string, turnAliases: Map<string, string>): string {
  return turnAliases.get(providerTurnId) ?? providerTurnId
}

function toolCallFromThreadItem(item: Record<string, unknown>, turnId: string): TimelineItem | undefined {
  if (item.type === 'commandExecution') {
    return {
      type: 'tool_call',
      callId: String(item.id ?? 'command'),
      name: 'commandExecution',
      status: 'running',
      detail: {
        command: item.command,
        cwd: item.cwd,
        commandActions: item.commandActions,
      },
      turnId,
    }
  }
  if (item.type === 'mcpToolCall') {
    return {
      type: 'tool_call',
      callId: String(item.id ?? 'mcp'),
      name: `${String(item.server ?? 'mcp')}.${String(item.tool ?? 'tool')}`,
      status: 'running',
      detail: item.arguments,
      turnId,
    }
  }
  if (item.type === 'dynamicToolCall') {
    return {
      type: 'tool_call',
      callId: String(item.id ?? 'dynamic'),
      name: `${String(item.namespace ?? 'dynamic')}.${String(item.tool ?? 'tool')}`,
      status: 'running',
      detail: item.arguments,
      turnId,
    }
  }
  if (item.type === 'fileChange') {
    return {
      type: 'tool_call',
      callId: String(item.id ?? 'file-change'),
      name: 'fileChange',
      status: 'running',
      detail: item.changes,
      turnId,
    }
  }
  if (item.type === 'webSearch') {
    return {
      type: 'tool_call',
      callId: String(item.id ?? 'web-search'),
      name: 'webSearch',
      status: 'running',
      detail: { query: item.query, action: item.action },
      turnId,
    }
  }
  if (item.type === 'collabAgentToolCall') {
    // Multi-agent collab tool (spawnAgent/sendInput/resumeAgent/wait/closeAgent).
    return {
      type: 'tool_call',
      callId: String(item.id ?? 'collab'),
      name: `collab.${String(item.tool ?? 'tool')}`,
      status: 'running',
      detail: { prompt: item.prompt, model: item.model, receiverThreadIds: item.receiverThreadIds },
      turnId,
    }
  }
  if (item.type === 'imageGeneration') {
    return {
      type: 'tool_call',
      callId: String(item.id ?? 'image-gen'),
      name: 'imageGeneration',
      status: 'running',
      detail: { revisedPrompt: item.revisedPrompt, savedPath: item.savedPath },
      turnId,
    }
  }
  if (item.type === 'contextCompaction') {
    return { type: 'compaction_started' }
  }
  // Intentionally not mapped to a tool_call (no begin/end pair or purely
  // informational): hookPrompt (internal prompt fragment), subAgentActivity,
  // imageView (passive image view), sleep (delay), enteredReviewMode /
  // exitedReviewMode. These are surfaced via item/completed below only where
  // useful; otherwise they fall through here as `undefined`.
  return undefined
}

function completedTimelineItemsFromThreadItem(item: Record<string, unknown>, turnId: string): TimelineItem[] {
  if (item.type === 'userMessage') {
    // UserMessage.content is a Vec<UserInput>; join the text entries. (Image/
    // Skill/Mention entries carry no plain text to surface here.)
    const content = Array.isArray(item.content) ? item.content : []
    const text = content
      .map((entry: unknown) => {
        const record = asRecord(entry)
        return record.type === 'text' || record.type === undefined
          ? stringValue(record.text)
          : undefined
      })
      .filter((line): line is string => Boolean(line))
      .join('\n')
    return [{
      type: 'user_message',
      text,
      messageId: String(item.id ?? 'codex-user-message'),
      turnId,
    }]
  }
  if (item.type === 'agentMessage') {
    return [{
      type: 'assistant_message',
      text: String(item.text ?? ''),
      messageId: String(item.id ?? 'codex-message'),
      turnId,
    }]
  }
  if (item.type === 'reasoning') {
    const content = Array.isArray(item.content) ? item.content.join('\n') : ''
    return [{
      type: 'reasoning',
      text: content,
      messageId: String(item.id ?? 'codex-reasoning'),
      turnId,
    }]
  }
  if (item.type === 'commandExecution') {
    return [{
      type: 'tool_result',
      callId: String(item.id ?? 'command'),
      result: item.aggregatedOutput ?? '',
      isError: item.exitCode !== undefined && item.exitCode !== null && item.exitCode !== 0,
      turnId,
    }]
  }
  if (item.type === 'mcpToolCall') {
    return [{
      type: 'tool_result',
      callId: String(item.id ?? 'mcp'),
      result: item.error ?? item.result,
      isError: Boolean(item.error),
      turnId,
    }]
  }
  if (item.type === 'dynamicToolCall') {
    return [{
      type: 'tool_result',
      callId: String(item.id ?? 'dynamic'),
      result: item.contentItems,
      isError: item.success === false,
      turnId,
    }]
  }
  if (item.type === 'fileChange') {
    return [{
      type: 'tool_result',
      callId: String(item.id ?? 'file-change'),
      result: item.changes,
      isError: item.status === 'failed',
      turnId,
    }]
  }
  if (item.type === 'webSearch') {
    return [{
      type: 'tool_result',
      callId: String(item.id ?? 'web-search'),
      result: { query: item.query, action: item.action },
      isError: false,
      turnId,
    }]
  }
  if (item.type === 'collabAgentToolCall') {
    return [{
      type: 'tool_result',
      callId: String(item.id ?? 'collab'),
      result: { prompt: item.prompt, agentsStates: item.agentsStates },
      isError: String(item.status ?? '') === 'failed',
      turnId,
    }]
  }
  if (item.type === 'imageGeneration') {
    return [{
      type: 'tool_result',
      callId: String(item.id ?? 'image-gen'),
      result: { revisedPrompt: item.revisedPrompt, result: item.result, savedPath: item.savedPath },
      isError: String(item.status ?? '') === 'failed',
      turnId,
    }]
  }
  if (item.type === 'contextCompaction') {
    return [{ type: 'compaction_boundary' }]
  }
  if (item.type === 'plan') {
    // The plan item carries the agent's plan text; surface it as reasoning so
    // it is visible in the timeline before the final assistant message.
    return [{
      type: 'reasoning',
      text: String(item.text ?? ''),
      messageId: String(item.id ?? 'codex-plan'),
      turnId,
    }]
  }
  // Intentionally not surfaced as a completed item: hookPrompt, subAgentActivity,
  // imageView, sleep, enteredReviewMode, exitedReviewMode — low-value or purely
  // informational; surfaced (if at all) as host_state_changed elsewhere. Falls
  // through to `[]` so item/completed does not emit a spurious entry.
  return []
}

function outputDeltaText(params: Record<string, unknown>): string {
  for (const key of ['delta', 'text', 'output', 'chunk']) {
    const value = stringValue(params[key])
    if (value) return value
  }
  const deltaBase64 = stringValue(params.deltaBase64)
  if (!deltaBase64) return ''
  return decodeBase64Text(deltaBase64)
}

function decodeBase64Text(value: string): string {
  try {
    return Buffer.from(value, 'base64').toString('utf8')
  } catch {
    return ''
  }
}

function append(sequencer: TimelineSequencer, item: TimelineItem, providerEventType: string): void {
  sequencer.append(item, rawRef(providerEventType))
}

function rawRef(providerEventType: string): TimelineRawRef {
  return { providerEventType }
}

function decisionReason(decision: ToolPolicyDecision): string | undefined {
  return decision.decision === 'ask' || decision.decision === 'deny'
    ? decision.reason
    : undefined
}

function readThreadId(response: unknown): string {
  const record = asRecord(response)
  const thread = asRecord(record.thread)
  const id = stringValue(thread.id) ?? stringValue(record.threadId)
  if (!id) throw new Error('Codex app-server did not return a thread id')
  return id
}

function readTurnId(response: unknown): string | undefined {
  const record = asRecord(response)
  const turn = asRecord(record.turn)
  return stringValue(turn.id) ?? stringValue(record.turnId)
}

function safeServerRequestResponse(request: CodexAppServerRequest): unknown {
  switch (request.method) {
    case 'item/commandExecution/requestApproval':
      return { decision: 'decline' }
    case 'item/fileChange/requestApproval':
      return { decision: 'decline' }
    case 'item/permissions/requestApproval':
      // Deny all requested permissions (omitted = denied per the protocol).
      // The GrantedPermissionProfile wire fields are camelCase
      // (`network`/`fileSystem`); returning an empty `permissions` object
      // denies everything without asserting any particular key casing.
      return { permissions: {}, scope: 'turn' }
    case 'item/tool/requestUserInput':
      // No host input channel today — return an empty answer map rather than
      // `{}`, which codex treats as a malformed ToolRequestUserInputResponse.
      return { answers: {} }
    case 'mcpServer/elicitation/request':
      return { action: 'decline' }
    case 'item/tool/call':
      // DynamicToolCall (host-side tool). Weft does not register dynamicTools
      // today, so this is defensive; return a failed no-op DynamicToolCallResponse.
      return { contentItems: [], success: false }
    case 'currentTime/read':
      return { currentTimeAt: Math.floor(Date.now() / 1000) }
    case 'account/chatgptAuthTokens/refresh':
      throw new Error('ChatGPT auth token refresh is not supported by this client')
    case 'attestation/generate':
      throw new Error('Client attestation generation is not supported by this client')
    default:
      return {}
  }
}

function buildPermissionResponse(pending: PendingPermission, allowed: boolean, remember?: boolean): unknown {
  if (pending.kind === 'permission') {
    return allowed
      ? { permissions: pending.requestedPermissions ?? {}, scope: remember ? 'session' : 'turn' }
      : { permissions: {}, scope: 'turn' }
  }
  return { decision: allowed ? (remember ? 'acceptForSession' : 'accept') : 'decline' }
}

function readTurnError(value: unknown): CodexTurnError | undefined {
  const record = asRecord(value)
  const message = stringValue(record.message)
  if (!message) return undefined
  return {
    message,
    ...(record.codexErrorInfo !== undefined ? { codexErrorInfo: record.codexErrorInfo } : {}),
    ...(stringValue(record.additionalDetails) ? { additionalDetails: stringValue(record.additionalDetails) } : {}),
  }
}

function permissionsToolName(params: Record<string, unknown>): string {
  const permissions = asRecord(params.permissions)
  if (permissions.network) return 'network'
  if (permissions.file_system ?? permissions.fileSystem) return 'file_system'
  return 'permissions'
}

function permissionsToolIntent(params: Record<string, unknown>): RuntimeToolIntent {
  const name = permissionsToolName(params)
  if (name === 'network') return { kind: 'api', method: 'connect', path: '' }
  if (name === 'file_system') return { kind: 'file_write', path: '', toolName: name }
  return { kind: 'unknown', toolName: name }
}
