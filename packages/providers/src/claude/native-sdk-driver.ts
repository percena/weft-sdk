import type { ClaudeProviderRuntimeDriver, ProviderRuntimeDriverInput } from './index'
import type {
  PermissionMode,
  PermissionResponseDetail,
  ProviderSourceToolDescriptor,
  RuntimePolicyHook,
  RuntimeToolIntent,
  ToolPolicyDecision,
} from '@weft/runtime-core'
import { sanitizeProviderSourceTools } from '@weft/runtime-core'
import { asRecord, stringValue, booleanValue, numberValue } from '@weft/core'
import { normalizeBaseRuntimeToolIntent } from '../shared/tool-intent.ts'
import type {
  TimelineItem,
  TimelinePermissionResolution,
  TimelineSequencer,
} from '@weft/timeline'

/** SDK-independent structural contracts keep the normal provider entry usable
 * when the optional Claude Agent SDK is absent. The explicit `claude/sdk`
 * subpath exposes the upstream SDK's precise helper types. */
interface Options {
  [key: string]: unknown
  permissionMode?: string
  allowDangerouslySkipPermissions?: boolean
  hooks?: Partial<Record<string, HookCallbackMatcher[]>>
  thinking?: unknown
  outputFormat?: unknown
}
type Query = AsyncIterable<unknown> & Record<string, any>
type SDKMessage = unknown
type ClaudeSdkPermissionMode = string
type EffortLevel = string
type HookEvent = string
interface HookCallbackMatcher {
  matcher?: string
  hooks: Array<(input: unknown, toolUseId?: string) => Promise<HookJSONOutput>>
}
interface HookJSONOutput {
  continue: boolean
  hookSpecificOutput?: Record<string, unknown>
}
interface PermissionResult {
  [key: string]: unknown
  behavior: 'allow' | 'deny'
  toolUseID?: string
  message?: string
  updatedInput?: Record<string, unknown>
}
interface ClaudeSdkCanUseToolContext {
  toolUseID?: string
  title?: string
  displayName?: string
  description?: string
  decisionReason?: string
  agentID?: string
  blockedPath?: string
  suggestions?: unknown
  signal?: AbortSignal
}
type SdkMcpServerConfig = Record<string, unknown>

/**
 * Control methods on the SDK `Query` object that weft exposes to the host.
 * Optional so test fakes only implement what they exercise — the real SDK
 * provider `Query` satisfies this in full.
 *
 * B6 note: several SDK docstrings say these are "only available in streaming
 * input mode". weft sends string prompts (single-prompt mode); on the pinned
 * SDK (v0.3.159) the CLI is nevertheless always spawned with
 * `--input-format stream-json` (string prompts are converted internally), so
 * control methods DO work while a turn's query loop is live — but this relies
 * on SDK implementation detail, not documented contract. Between turns there
 * is no active query and every control call is a silent no-op (see
 * {@link ClaudeNativeSdkControl}).
 */
type ClaudeSdkQueryControl = Partial<
  Pick<
    Query,
    | 'interrupt'
    | 'setModel'
    | 'setPermissionMode'
    | 'setMaxThinkingTokens'
    | 'applyFlagSettings'
    | 'initializationResult'
    | 'supportedCommands'
    | 'supportedModels'
    | 'supportedAgents'
    | 'mcpServerStatus'
    | 'getContextUsage'
    | 'rewindFiles'
    | 'reconnectMcpServer'
    | 'toggleMcpServer'
    | 'setMcpServers'
    | 'stopTask'
    | 'readFile'
    | 'reloadPlugins'
    | 'accountInfo'
    | 'seedReadState'
    | 'backgroundTasks'
    | 'streamInput'
    | 'close'
  >
>

/**
 * The handle returned by `query()`. The SDK's `Query extends
 * AsyncGenerator-like stream and also carries the control methods
 * above; we keep them optional so injected fakes stay lightweight.
 */
export type ClaudeSdkQuery = AsyncIterable<SDKMessage> & ClaudeSdkQueryControl

/**
 * Mid-conversation dynamic control surface that `createClaudeNativeSdkDriver`
 * exposes alongside the base driver contract. Each method delegates to the
 * active SDK `Query` handle.
 *
 * B6 CAVEAT: weft runs one query per turn, so these methods are only live
 * while a turn is in flight. Between turns `activeQuery` is null and every
 * call is a SILENT NO-OP (resolved `undefined` — indistinguishable from
 * success). Callers that need reliable control must invoke these during an
 * active turn, or hold a long-lived streaming-input session (deferred; see
 * the 2026-07-12 architecture review, finding B6).
 *
 * Not surfaced through `AgentRuntime.commands` — advanced hosts hold the driver
 * returned by `createClaudeNativeSdkDriver`.
 */
export interface ClaudeNativeSdkControl {
  setModel(model?: string): Promise<void>
  setPermissionMode(mode: ClaudeSdkPermissionMode): Promise<void>
  setMaxThinkingTokens(tokens: number | null): Promise<void>
  applyFlagSettings(settings: Record<string, unknown>): Promise<void>
  rewindFiles(userMessageId: string, options?: { dryRun?: boolean }): Promise<unknown>
  reconnectMcpServer(serverName: string): Promise<void>
  toggleMcpServer(serverName: string, enabled: boolean): Promise<void>
  setMcpServers(servers: Record<string, SdkMcpServerConfig>): Promise<unknown>
  stopTask(taskId: string): Promise<void>
  readFile(path: string, options?: { maxBytes?: number; encoding?: 'utf-8' | 'base64' }): Promise<unknown> | undefined
  reloadPlugins(): Promise<unknown> | undefined
  accountInfo(): Promise<unknown> | undefined
  seedReadState(path: string, mtime: number): Promise<void> | undefined
  backgroundTasks(toolUseId?: string): Promise<unknown> | undefined
  /** Stream additional user messages into an active query (multi-turn). */
  streamInput(stream: AsyncIterable<unknown>): Promise<void> | undefined
  /** Forcefully close the active query and terminate the subprocess. */
  closeQuery(): void
  /** Live MCP server statuses, or undefined when no turn is in flight. */
  mcpServerStatus(): Promise<unknown> | undefined
  getContextUsage(): Promise<unknown> | undefined
  initializationResult(): Promise<unknown> | undefined
  supportedCommands(): Promise<unknown> | undefined
  supportedModels(): Promise<unknown> | undefined
  supportedAgents(): Promise<unknown> | undefined
  /**
   * A5: the provider (Claude) session id captured from the SDK's init/result
   * messages — the id to persist for cross-process resume
   * (`sdkOptions.resume`). Undefined before the first turn produces one.
   * Also surfaced on the timeline as
   * `host_state_changed { kind: 'provider_session' }`.
   */
  getProviderSessionId(): string | undefined
}

interface ClaudeSdkQueryParams {
  prompt: string | AsyncIterable<unknown>
  options?: Options
}

export type ClaudeSdkQueryRunner = (params: ClaudeSdkQueryParams) => ClaudeSdkQuery

/**
 * SDK option fields that weft manages itself (do not set via `sdkOptions` —
 * they are derived from weft's own config and per-turn input, and would be
 * overwritten by the driver). Everything else in {@link Options} is passed
 * through verbatim from `sdkOptions`, keeping weft aligned with the SDK as it
 * evolves. It is intentionally structural so the SDK remains optional.
 */
export type ClaudeSdkPassthroughOptions = Options

/**
 * A pre-warmed query handle returned by the SDK's `startup()`. When provided,
 * the driver uses `warmQuery.query(prompt)` instead of the top-level `query()`
 * for zero-latency first turn. Consumed on first `sendMessage()`; subsequent
 * turns fall back to the top-level `query()`.
 */
export interface ClaudeSdkWarmQuery {
  query(prompt: string | AsyncIterable<unknown>): ClaudeSdkQuery
  close(): void
}

export interface CreateClaudeNativeSdkDriverOptions {
  cwd: string
  model?: string
  reasoningEffort?: string
  env?: Record<string, string | undefined>
  permissionMode?: PermissionMode
  query?: ClaudeSdkQueryRunner
  loadSdk?: () => Promise<{ query: ClaudeSdkQueryRunner }>
  /**
   * Pre-warmed query handle from `startup()`. When set, the first
   * `sendMessage()` uses this instead of the cold `query()` path. Consumed
   * once — subsequent turns fall through to the normal query runner.
   *
   * **Caveat**: the warm path bypasses `buildQueryOptions` — the driver's
   * `canUseTool`, policy→PreToolUse hook bridge, and `permissionMode`
   * mapping are NOT active on the warm turn. The host must configure
   * equivalent callbacks in the `startup({ options })` call.
   */
  warmQuery?: ClaudeSdkWarmQuery
  policy?: RuntimePolicyHook
  sourceTools?: ProviderSourceToolDescriptor[]
  /**
   * Passthrough for @anthropic-ai/claude-agent-sdk `Options` not otherwise
   * managed by the driver: systemPrompt, tools/allowedTools/disallowedTools,
   * resume/sessionId/continue/forkSession/persistSession, outputFormat,
   * agents/agent/forwardSubagentText, skills/settingSources, thinking,
   * maxTurns/maxBudgetUsd/taskBudget, additionalDirectories/extraArgs,
   * sandbox/plugins/betas, stderr, pathToClaudeCodeExecutable, etc.
   */
  sdkOptions?: ClaudeSdkPassthroughOptions
}

interface PendingPermission {
  resolve: (result: PermissionResult) => void
}

export function createClaudeNativeSdkDriver(
  options: CreateClaudeNativeSdkDriverOptions,
): ClaudeProviderRuntimeDriver & ClaudeNativeSdkControl {
  return new ClaudeNativeSdkDriver(options)
}

class ClaudeNativeSdkDriver implements ClaudeProviderRuntimeDriver {
  private activeQuery: ClaudeSdkQuery | null = null
  private activeSequencer: TimelineSequencer | null = null
  private pendingPermissions = new Map<string, PendingPermission>()
  private turnCounter = 0
  private warmQueryHandle: ClaudeSdkWarmQuery | null = null
  /**
   * A1: provider session id captured from the SDK's `system:init` / `result`
   * messages. From the second turn on it is passed as `Options.resume` so the
   * conversation continues on the same Claude session — previously every
   * `sendMessage` started a brand-new session and the model forgot the
   * conversation. Host-provided `sdkOptions.resume`/`continue`/`forkSession`
   * take precedence (the host owns explicit session management).
   */
  private providerSessionId: string | undefined
  /**
   * Policy decisions cached by the PreToolUse hook so `canUseTool` (which the
   * SDK calls after a hook returns `ask`/`defer`) reuses the same decision
   * instead of re-evaluating the policy. Keyed by `tool_use_id`; consumed and
   * deleted by `handleCanUseTool`.
   */
  private readonly policyDecisions = new Map<string, ToolPolicyDecision>()

  constructor(private readonly options: CreateClaudeNativeSdkDriverOptions) {
    this.warmQueryHandle = options.warmQuery ?? null
  }

  async sendMessage(input: ProviderRuntimeDriverInput, sequencer: TimelineSequencer): Promise<void> {
    const turnId = input.options?.turnId ?? `claude-turn-${++this.turnCounter}`
    this.activeSequencer = sequencer
    sequencer.append({ type: 'turn_started', turnId }, { providerEventType: 'claude-sdk:send_message' })
    // A4: record the user's message on the canonical timeline. The SDK never
    // echoes the prompt back, so without this a claude session's replayed
    // timeline (fetchTimeline) contains assistant/tool items but no user
    // prompts — asymmetric with codex, which emits `userMessage` items.
    sequencer.append({
      type: 'user_message',
      text: input.message,
      messageId: `${turnId}-user`,
      turnId,
    }, { providerEventType: 'claude-sdk:send_message' })

    try {
      let query: ClaudeSdkQuery
      const warm = this.warmQueryHandle
      if (warm) {
        this.warmQueryHandle = null
        query = warm.query(input.message)
      } else {
        const queryRunner = await this.getQueryRunner()
        query = queryRunner({
          prompt: input.message,
          options: this.buildQueryOptions(input, sequencer),
        })
      }
      this.activeQuery = query

      for await (const message of query) {
        this.projectSdkMessage(message, turnId, sequencer)
      }
    } catch (error) {
      sequencer.append({
        type: 'turn_failed',
        turnId,
        error: { message: error instanceof Error ? error.message : String(error) },
      }, { providerEventType: 'claude-sdk:error' })
      throw error
    } finally {
      this.activeQuery = null
      this.activeSequencer = null
      // Hygiene: drop any unconsumed policy decisions (an ask/defer hook whose
      // canUseTool never ran — e.g. the turn aborted mid-tool). tool_use_ids are
      // unique per turn, so this just bounds the map's growth across turns.
      this.policyDecisions.clear()
    }
  }

  /**
   * Merge SDK options in precedence order:
   *   static sdkOptions (host config)
   *   < driver-managed fields (cwd/model/effort/env/streaming/mcp) >
   *   < per-turn overrides from SendMessageOptions >
   * Driver-managed fields override sdkOptions when explicitly set. Fields
   * without a weft-level value (e.g. permissionMode when none is configured)
   * fall through to sdkOptions so the host's SDK-native setting is preserved.
   */
  private buildQueryOptions(input: ProviderRuntimeDriverInput, sequencer: TimelineSequencer): Options {
    const perTurn = input.options
    const permissionMapping = mapPermissionMode(perTurn?.permissionMode ?? this.options.permissionMode)

    // A1: continue the provider session across turns. Unless the host manages
    // sessions explicitly (sdkOptions.resume / continue / forkSession /
    // sessionId, or persistSession is false), resume the session id captured
    // from the previous turn's init/result messages so multi-turn
    // conversations keep their context.
    const sdkSession = this.options.sdkOptions
    const hostManagesSession = Boolean(
      sdkSession?.resume || sdkSession?.continue || sdkSession?.forkSession
      || sdkSession?.sessionId || sdkSession?.persistSession === false,
    )
    const resumeOptions = this.providerSessionId && !hostManagesSession
      ? { resume: this.providerSessionId }
      : {}

    // B2: provider-namespaced per-turn passthrough. Spread early (right after
    // sdkOptions) so driver-managed fields always win; driver-owned callbacks
    // (hooks/canUseTool) are also re-asserted after it.
    const perTurnClaude = (perTurn?.providerOptions?.claude ?? {}) as Partial<Options>

    // Merge sdkOptions.mcpServers (e.g. in-process 'sdk' type) with source-tool-
    // derived mcpServers. Source tools take precedence (managed path); sdkOptions
    // entries are preserved rather than overwritten.
    const sourceMcp = mapClaudeMcpServers(this.options.sourceTools)
    const sdkMcp = this.options.sdkOptions?.mcpServers as Record<string, SdkMcpServerConfig> | undefined
    const mergedMcp = (sourceMcp || sdkMcp)
      ? { ...(sdkMcp ?? {}), ...(sourceMcp ?? {}) }
      : undefined

    return {
      ...this.options.sdkOptions,
      ...perTurnClaude,
      cwd: this.options.cwd,
      model: perTurn?.model ?? this.options.model ?? this.options.sdkOptions?.model,
      effort: (perTurn?.reasoningEffort ?? this.options.reasoningEffort ?? this.options.sdkOptions?.effort) as EffortLevel | undefined,
      env: this.options.env ?? this.options.sdkOptions?.env,
      includePartialMessages: true,
      includeHookEvents: true,
      ...(mergedMcp ? { mcpServers: mergedMcp } : {}),
      ...permissionMapping,
      ...mapPerTurnOutputFormat(perTurn?.outputSchema),
      ...(perTurn?.thinking !== undefined ? { thinking: perTurn.thinking as Options['thinking'] } : {}),
      ...(perTurn?.maxTurns !== undefined ? { maxTurns: perTurn.maxTurns } : {}),
      ...(perTurn?.maxBudgetUsd !== undefined ? { maxBudgetUsd: perTurn.maxBudgetUsd } : {}),
      ...resumeOptions,
      ...this.buildHooks(sequencer),
      canUseTool: (toolName: string, toolInput: Record<string, unknown>, context: ClaudeSdkCanUseToolContext) =>
        this.handleCanUseTool(toolName, toolInput, context, sequencer),
    }
  }

  /**
   * Merge host-provided `sdkOptions.hooks` with a weft-`policy`→PreToolUse
   * bridge. The PreToolUse hook runs *before* `canUseTool`: it can `allow`
   * (optionally with `updatedInput`), `deny`, or `defer`/`ask` to let
   * `canUseTool` own the blocking interactive prompt. The hook caches its
   * decision by `tool_use_id` so `canUseTool` reuses it instead of
   * re-evaluating the policy.
   *
   * When the host also registers PreToolUse hooks, theirs run first; the
   * policy bridge runs last. Other hook events are passed through verbatim.
   */
  private buildHooks(_sequencer: TimelineSequencer): Pick<Options, 'hooks'> {
    const userHooks = this.options.sdkOptions?.hooks as Partial<Record<HookEvent, HookCallbackMatcher[]>> | undefined
    const policyHook: HookCallbackMatcher | null = this.options.policy
      ? {
          // Omit `matcher` so the hook matches ALL tools. The SDK treats an
          // absent matcher as match-all (safest across SDK versions).
          hooks: [(hookInput, toolUseId) => this.handlePreToolUseHook(hookInput, toolUseId)],
        }
      : null

    if (!userHooks && !policyHook) return {}

    const mergedPreToolUse: HookCallbackMatcher[] = [
      ...(userHooks?.PreToolUse ?? []),
      ...(policyHook ? [policyHook] : []),
    ]
    const { PreToolUse: _dropped, ...restUserHooks } = userHooks ?? {}
    return {
      hooks: {
        ...(restUserHooks as Partial<Record<HookEvent, HookCallbackMatcher[]>>),
        ...(mergedPreToolUse.length > 0 ? { PreToolUse: mergedPreToolUse } : {}),
      },
    }
  }

  /**
   * PreToolUse hook callback: bridge a weft `RuntimePolicyHook` decision to the
   * SDK `HookJSONOutput` shape. `allow`/`deny` short-circuit `canUseTool`;
   * `ask`/`defer` return `defer` so `canUseTool` runs the interactive prompt
   * (the hook itself cannot block for user input). The decision is cached so
   * `canUseTool` doesn't re-evaluate the policy.
   */
  private async handlePreToolUseHook(
    hookInput: unknown,
    toolUseId: string | undefined,
  ): Promise<HookJSONOutput> {
    const input = asRecord(hookInput)
    if (stringValue(input.hook_event_name) !== 'PreToolUse' || !this.options.policy || !toolUseId) {
      return { continue: true }
    }

    const toolName = stringValue(input.tool_name) ?? 'unknown'
    const toolInput = (input.tool_input ?? {}) as Record<string, unknown>
    const decision = await this.options.policy({
      toolName,
      input: toolInput,
      toolIntent: normalizeRuntimeToolIntent(toolName, toolInput),
      scope: { type: 'tool-call', callId: toolUseId },
    })

    switch (decision.decision) {
      case 'allow':
        return {
          continue: true,
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow',
            ...(decision.updatedInput ? { updatedInput: decision.updatedInput } : {}),
          },
        }
      case 'deny':
        return {
          continue: true,
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: decision.reason,
          },
        }
      case 'ask':
      case 'defer':
        // Delegate the blocking UI to canUseTool (reuse the cached decision so
        // the policy runs once per tool call). Only cached here — allow/deny
        // short-circuit canUseTool, so there is no consumer to clean them up.
        this.policyDecisions.set(toolUseId, decision)
        return {
          continue: true,
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'defer',
            ...(decision.decision === 'ask' ? { permissionDecisionReason: decision.reason } : {}),
          },
        }
      default: {
        const _exhaustive: never = decision
        return _exhaustive
      }
    }
  }

  async abort(reason?: string): Promise<void> {
    // Prefer the SDK's streaming interrupt (cooperative); fall back to closing
    // the async iterator. Both leave the query loop.
    if (this.activeQuery?.interrupt) {
      await this.activeQuery.interrupt()
      return
    }
    await this.closeActiveQuery()
    if (this.activeSequencer) {
      this.activeSequencer.append({
        type: 'session_status',
        status: reason ? `aborted: ${reason}` : 'aborted',
      }, { providerEventType: 'claude-sdk:abort' })
    }
  }

  async respondToPermission(
    requestId: string,
    allowed: boolean,
    remember?: boolean,
    detail?: PermissionResponseDetail,
  ): Promise<void> {
    const pending = this.pendingPermissions.get(requestId)
    if (!pending) return

    this.pendingPermissions.delete(requestId)
    const resolution: TimelinePermissionResolution = {
      allowed,
      remember,
      ...(detail?.interrupt ? { reason: 'interrupt' } : {}),
    }
    this.activeSequencer?.append({
      type: 'permission_resolved',
      requestId,
      resolution,
    }, { providerEventType: 'claude-sdk:permission_response' })

    pending.resolve(allowed
      ? {
          behavior: 'allow',
          toolUseID: requestId,
          // decisionClassification drives the SDK's own persistence:
          // user_permanent writes the grant to settings, user_temporary is
          // session-scoped. Equivalent to returning updatedPermissions with a
          // session-scoped allow rule, without us rebuilding the rule shape.
          decisionClassification: remember ? 'user_permanent' : 'user_temporary',
          ...(detail?.updatedInput ? { updatedInput: detail.updatedInput } : {}),
          ...(detail?.updatedPermissions ? { updatedPermissions: detail.updatedPermissions as never } : {}),
        }
      : {
          behavior: 'deny',
          message: 'Permission denied by user',
          toolUseID: requestId,
          decisionClassification: 'user_reject',
          ...(detail?.interrupt ? { interrupt: true } : {}),
        })
  }

  async dispose(): Promise<void> {
    if (this.warmQueryHandle) {
      this.warmQueryHandle.close()
      this.warmQueryHandle = null
    }
    await this.closeActiveQuery()
    for (const [requestId, pending] of this.pendingPermissions) {
      pending.resolve({ behavior: 'deny', message: 'Runtime disposed', toolUseID: requestId })
    }
    this.pendingPermissions.clear()
  }

  /** End the active query's async iterator (cooperative close). */
  private async closeActiveQuery(): Promise<void> {
    const iterator = this.activeQuery?.[Symbol.asyncIterator]()
    await iterator?.return?.()
  }

  // ============================================================
  // Dynamic control — delegate to the active SDK Query handle.
  // Available mid-conversation while a turn's query loop is live.
  // ============================================================

  async setModel(model?: string): Promise<void> {
    await this.activeQuery?.setModel?.(model)
  }

  async setPermissionMode(mode: ClaudeSdkPermissionMode): Promise<void> {
    await this.activeQuery?.setPermissionMode?.(mode)
  }

  async setMaxThinkingTokens(tokens: number | null): Promise<void> {
    await this.activeQuery?.setMaxThinkingTokens?.(tokens)
  }

  async applyFlagSettings(settings: Record<string, unknown>): Promise<void> {
    await this.activeQuery?.applyFlagSettings?.(settings as never)
  }

  async rewindFiles(userMessageId: string, options?: { dryRun?: boolean }): Promise<unknown> {
    // Forward `options` only when provided so the SDK receives the exact arity
    // the caller used (a trailing `undefined` shows up in call recordings).
    return options !== undefined
      ? this.activeQuery?.rewindFiles?.(userMessageId, options as never)
      : this.activeQuery?.rewindFiles?.(userMessageId)
  }

  async reconnectMcpServer(serverName: string): Promise<void> {
    await this.activeQuery?.reconnectMcpServer?.(serverName)
  }

  async toggleMcpServer(serverName: string, enabled: boolean): Promise<void> {
    await this.activeQuery?.toggleMcpServer?.(serverName, enabled)
  }

  async stopTask(taskId: string): Promise<void> {
    await this.activeQuery?.stopTask?.(taskId)
  }

  async setMcpServers(servers: Record<string, SdkMcpServerConfig>): Promise<unknown> {
    return this.activeQuery?.setMcpServers?.(servers)
  }

  readFile(path: string, options?: { maxBytes?: number; encoding?: 'utf-8' | 'base64' }) {
    return options !== undefined
      ? this.activeQuery?.readFile?.(path, options as never)
      : this.activeQuery?.readFile?.(path)
  }

  reloadPlugins() {
    return this.activeQuery?.reloadPlugins?.()
  }

  accountInfo() {
    return this.activeQuery?.accountInfo?.()
  }

  seedReadState(path: string, mtime: number) {
    return this.activeQuery?.seedReadState?.(path, mtime)
  }

  backgroundTasks(toolUseId?: string) {
    return this.activeQuery?.backgroundTasks?.(toolUseId)
  }

  mcpServerStatus() {
    return this.activeQuery?.mcpServerStatus?.()
  }

  getContextUsage() {
    return this.activeQuery?.getContextUsage?.()
  }

  initializationResult() {
    return this.activeQuery?.initializationResult?.()
  }

  supportedCommands() {
    return this.activeQuery?.supportedCommands?.()
  }

  supportedModels() {
    return this.activeQuery?.supportedModels?.()
  }

  supportedAgents() {
    return this.activeQuery?.supportedAgents?.()
  }

  streamInput(stream: AsyncIterable<unknown>) {
    return this.activeQuery?.streamInput?.(stream as never)
  }

  closeQuery() {
    this.activeQuery?.close?.()
  }

  getProviderSessionId(): string | undefined {
    return this.providerSessionId
  }

  private async getQueryRunner(): Promise<ClaudeSdkQueryRunner> {
    if (this.options.query) return this.options.query
    const sdk = this.options.loadSdk
      ? await this.options.loadSdk()
      : await import('@anthropic-ai/claude-agent-sdk') as { query: ClaudeSdkQueryRunner }
    return sdk.query
  }

  private async handleCanUseTool(
    toolName: string,
    input: Record<string, unknown>,
    context: ClaudeSdkCanUseToolContext,
    sequencer: TimelineSequencer,
  ): Promise<PermissionResult> {
    const requestId = context.toolUseID || `${toolName}-${this.pendingPermissions.size + 1}`
    // Reuse the decision the PreToolUse hook already made (if a policy is
    // bridged), so the policy runs once per tool call instead of twice.
    const cached = this.policyDecisions.get(requestId)
    if (cached) this.policyDecisions.delete(requestId)
    const policyDecision = cached ?? await this.evaluatePolicy(toolName, input, requestId)

    if (policyDecision.decision === 'allow') {
      return {
        behavior: 'allow',
        toolUseID: requestId,
        ...(policyDecision.updatedInput ? { updatedInput: policyDecision.updatedInput } : {}),
      }
    }

    if (policyDecision.decision === 'deny') {
      sequencer.append({
        type: 'permission_resolved',
        requestId,
        resolution: { allowed: false, reason: policyDecision.reason },
      }, { providerEventType: 'claude-sdk:permission_denied' })
      return { behavior: 'deny', message: policyDecision.reason, toolUseID: requestId }
    }

    sequencer.append({
      type: 'permission_requested',
      request: {
        requestId,
        toolName,
        input,
        reason: policyDecision.decision === 'ask' ? policyDecision.reason : undefined,
        // Surface SDK-provided permission context (title/displayName/description
        // help the host render a meaningful prompt) so it isn't silently dropped.
        title: context.title,
        displayName: context.displayName,
        description: context.description,
        decisionReason: context.decisionReason,
        agentId: context.agentID,
        blockedPath: context.blockedPath,
        suggestions: context.suggestions as unknown[] | undefined,
      },
    }, { providerEventType: 'claude-sdk:can_use_tool' })

    return new Promise<PermissionResult>((resolve) => {
      this.pendingPermissions.set(requestId, { resolve })
      context.signal?.addEventListener('abort', () => {
        if (!this.pendingPermissions.delete(requestId)) return
        resolve({ behavior: 'deny', message: 'Permission request aborted', toolUseID: requestId })
      }, { once: true })
    })
  }

  private async evaluatePolicy(
    toolName: string,
    input: Record<string, unknown>,
    requestId: string,
  ): Promise<ToolPolicyDecision> {
    if (!this.options.policy) return { decision: 'allow' }
    return this.options.policy({
      toolName,
      input,
      toolIntent: normalizeRuntimeToolIntent(toolName, input),
      scope: { type: 'tool-call', callId: requestId },
    })
  }

  private projectSdkMessage(
    message: SDKMessage,
    turnId: string,
    sequencer: TimelineSequencer,
  ): void {
    const record = asRecord(message)
    const type = stringValue(record.type)
    if (!type) return

    // A1/A5: capture the provider session id (present on `system:init` and
    // `result`). Used for auto-resume on the next turn, and surfaced on the
    // timeline so hosts can persist it for cross-process resume.
    const sessionId = stringValue(record.session_id)
    if (sessionId && sessionId !== this.providerSessionId) {
      this.providerSessionId = sessionId
      sequencer.append({
        type: 'host_state_changed',
        state: {
          kind: 'provider_session',
          provider: 'claude',
          providerSessionId: sessionId,
        },
      }, { providerEventType: 'claude-sdk:session_id' })
    }

    if (type === 'stream_event') {
      for (const item of projectStreamEvent(record, turnId)) {
        sequencer.append(item, { providerEventType: 'claude-sdk:stream_event' })
      }
      return
    }

    if (type === 'assistant') {
      for (const item of projectAssistantMessage(record, turnId)) {
        sequencer.append(item, { providerEventType: 'claude-sdk:assistant' })
      }
      return
    }

    if (type === 'user') {
      for (const item of projectUserMessage(record, turnId)) {
        sequencer.append(item, { providerEventType: 'claude-sdk:user' })
      }
      return
    }

    if (type === 'result') {
      sequencer.append(projectResultMessage(record, turnId), { providerEventType: 'claude-sdk:result' })
      return
    }

    // Top-level message types not nested under `system`.
    if (type === 'tool_progress') {
      const item = projectToolProgress(record, turnId)
      if (item) sequencer.append(item, { providerEventType: 'claude-sdk:tool_progress' })
      return
    }

    if (type === 'auth_status') {
      sequencer.append(projectAuthStatus(record), { providerEventType: 'claude-sdk:auth_status' })
      return
    }

    if (type === 'prompt_suggestion' || type === 'tool_use_summary') {
      // Informational; no canonical timeline item yet. Forward as session status
      // so the host can observe without a silent drop.
      sequencer.append(
        { type: 'session_status', status: type },
        { providerEventType: `claude-sdk:${type}` },
      )
      return
    }

    // Rate-limit transitions (allowed → allowed_warning → rejected). Top-level
    // `SDKRateLimitEvent`, not nested under `system` — surface structured so the
    // host can warn/back off instead of a silent drop.
    if (type === 'rate_limit_event') {
      sequencer.append(
        { type: 'rate_limit', info: record.rate_limit_info ?? record, turnId },
        { providerEventType: 'claude-sdk:rate_limit_event' },
      )
      return
    }

    // `SDKUserMessageReplay` (emitted with `extra_args.replay-user-messages`,
    // used alongside `rewind_files`) projects like an ordinary user message.
    if (type === 'user_message_replay') {
      for (const item of projectUserMessage(record, turnId)) {
        sequencer.append(item, { providerEventType: 'claude-sdk:user_message_replay' })
      }
      return
    }

    if (type === 'system') {
      const item = projectSystemMessage(record, turnId)
      if (item) {
        const subtype = stringValue(record.subtype) ?? 'unknown'
        sequencer.append(item, { providerEventType: `claude-sdk:system:${subtype}` })
      }
      return
    }
  }
}

// Re-exported via ./index for host composition.


// ============================================================
// Mapping helpers
// ============================================================

function mapPermissionMode(mode: PermissionMode | undefined): Pick<Options, 'permissionMode' | 'allowDangerouslySkipPermissions'> {
  if (mode === 'explore') return { permissionMode: 'plan' }
  if (mode === 'auto') return { permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true }
  if (mode === 'ask') return { permissionMode: 'default' }
  // No weft-level mode → don't override sdkOptions.permissionMode. The SDK
  // defaults to 'default' when neither weft nor sdkOptions sets the field.
  return {}
}

/**
 * Per-turn structured output. weft's SendMessageOptions.outputSchema (already
 * used by the codex path) maps to Claude's outputFormat json_schema.
 */
function mapPerTurnOutputFormat(outputSchema: unknown): Pick<Options, 'outputFormat'> {
  if (!outputSchema || typeof outputSchema !== 'object') return {}
  return { outputFormat: { type: 'json_schema', schema: outputSchema as Record<string, unknown> } }
}

function mapClaudeMcpServers(
  sourceTools: ProviderSourceToolDescriptor[] | undefined,
): Record<string, SdkMcpServerConfig> | undefined {
  const servers: Record<string, SdkMcpServerConfig> = {}

  for (const sourceTool of sanitizeProviderSourceTools(sourceTools)) {
    if (sourceTool.kind !== 'mcp-server') {
      // 'api-source' and 'local-source' are not MCP servers.
      // 'in-process' servers need a real MCP SDK Server instance and should
      // be passed via sdkOptions.mcpServers (type: 'sdk') directly.
      continue
    }

    if (sourceTool.transport === 'stdio' && sourceTool.command) {
      servers[sourceTool.sourceSlug] = {
        type: 'stdio',
        command: sourceTool.command,
        ...(sourceTool.args ? { args: sourceTool.args } : {}),
        ...(sourceTool.env ? { env: sourceTool.env } : {}),
      }
      continue
    }

    if ((sourceTool.transport === 'http' || sourceTool.transport === 'sse') && sourceTool.url) {
      servers[sourceTool.sourceSlug] = {
        type: sourceTool.transport,
        url: sourceTool.url,
        ...(sourceTool.headers ? { headers: sourceTool.headers } : {}),
      }
    }
  }

  return Object.keys(servers).length > 0 ? servers : undefined
}

function normalizeRuntimeToolIntent(
  toolName: string,
  input: Record<string, unknown>,
): RuntimeToolIntent {
  // --- Claude-specific tool intents ---
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(toolName)) {
    return {
      kind: 'file_write',
      toolName,
      path: String(input.file_path ?? input.path ?? ''),
    }
  }

  if (toolName === 'API') {
    const url = input.url ? String(input.url) : undefined
    return {
      kind: 'api',
      method: String(input.method ?? 'GET').toUpperCase(),
      path: pathFromUrl(url ?? String(input.path ?? '/')),
      ...(url ? { url } : {}),
    }
  }

  // --- Common intents (Bash, MCP, unknown fallback) ---
  return normalizeBaseRuntimeToolIntent(toolName, input)
}

function pathFromUrl(value: string): string {
  try {
    return new URL(value).pathname
  } catch {
    return value.startsWith('/') ? value : `/${value}`
  }
}

// ============================================================
// Projection helpers
// ============================================================

function projectStreamEvent(record: Record<string, unknown>, turnId: string): TimelineItem[] {
  const event = asRecord(record.event)
  const messageId = stringValue(record.uuid) ?? `${turnId}-partial`

  // content_block_start with tool_use: emit tool_call immediately for real-time
  // tool activity (input arrives empty here; the full input comes on the later
  // assistant message, which the index dedups via emittedToolUseIds).
  if (event.type === 'content_block_start') {
    const block = asRecord(event.content_block)
    if (block.type === 'tool_use') {
      return [{
        type: 'tool_call',
        callId: stringValue(block.id) ?? `${messageId}-tool`,
        name: stringValue(block.name) ?? 'unknown',
        status: 'running',
        detail: (block.input ?? {}) as Record<string, unknown>,
        turnId,
      }]
    }
    return []
  }

  if (event.type !== 'content_block_delta') return []
  const delta = asRecord(event.delta)

  if (delta.type === 'text_delta') {
    return [{
      type: 'assistant_message_delta',
      text: stringValue(delta.text) ?? '',
      messageId,
      turnId,
    }]
  }

  if (delta.type === 'thinking_delta') {
    return [{
      type: 'reasoning_delta',
      text: stringValue(delta.thinking) ?? stringValue(delta.text) ?? '',
      messageId,
      turnId,
    }]
  }

  return []
}

function projectAssistantMessage(record: Record<string, unknown>, turnId: string): TimelineItem[] {
  const message = asRecord(record.message)
  const messageId = stringValue(record.uuid) ?? stringValue(message.id) ?? `${turnId}-assistant`
  const content = Array.isArray(message.content) ? message.content : []
  const items: TimelineItem[] = []

  for (const block of content) {
    const contentBlock = asRecord(block)
    if (contentBlock.type === 'text') {
      items.push({
        type: 'assistant_message',
        text: stringValue(contentBlock.text) ?? '',
        messageId,
        turnId,
      })
    } else if (contentBlock.type === 'thinking') {
      items.push({
        type: 'reasoning',
        text: stringValue(contentBlock.thinking) ?? stringValue(contentBlock.text) ?? '',
        messageId,
        turnId,
      })
    } else if (contentBlock.type === 'tool_use' || contentBlock.type === 'server_tool_use') {
      // `server_tool_use` (advisor / web_search / web_fetch / code_execution
      // etc.) executes server-side — the caller never returns a result, but it
      // still drives a tool_call so the UI can show the invocation.
      items.push({
        type: 'tool_call',
        callId: stringValue(contentBlock.id) ?? `${messageId}-tool-${items.length}`,
        name: stringValue(contentBlock.name) ?? 'unknown',
        status: 'running',
        detail: contentBlock.input,
        turnId,
      })
    } else if (contentBlock.type === 'advisor_tool_result') {
      // Server-side tool result for an advisor call (no matching tool_use the
      // caller must answer) — surface as a completed tool_result so the output
      // isn't silently dropped.
      items.push({
        type: 'tool_result',
        callId: stringValue(contentBlock.tool_use_id) ?? `${messageId}-advisor-${items.length}`,
        result: contentBlock.content,
        turnId,
      })
    }
  }

  return items
}

function projectUserMessage(record: Record<string, unknown>, turnId: string): TimelineItem[] {
  const message = asRecord(record.message)
  const content = Array.isArray(message.content) ? message.content : []
  const items: TimelineItem[] = []

  for (const block of content) {
    const contentBlock = asRecord(block)
    if (contentBlock.type !== 'tool_result') continue
    items.push({
      type: 'tool_result',
      callId: stringValue(contentBlock.tool_use_id) ?? 'unknown',
      result: normalizeToolResult(contentBlock.content),
      isError: booleanValue(contentBlock.is_error),
      turnId,
    })
  }

  return items
}

function projectResultMessage(record: Record<string, unknown>, turnId: string): TimelineItem {
  const subtype = stringValue(record.subtype)
  const structuredOutput = record.structured_output
  // Common ResultMessage metadata surfaced on both success and failure so the
  // host can observe cost / duration / turn count / deferred tool use / API
  // error status / session id without a silent drop (SDK `ResultMessage`).
  const meta = {
    ...(typeof record.total_cost_usd === 'number' ? { costUsd: record.total_cost_usd } : {}),
    ...(typeof record.duration_ms === 'number' ? { durationMs: record.duration_ms } : {}),
    ...(typeof record.duration_api_ms === 'number' ? { durationApiMs: record.duration_api_ms } : {}),
    ...(typeof record.num_turns === 'number' ? { numTurns: record.num_turns } : {}),
    ...(typeof record.result === 'string' ? { result: record.result } : {}),
    ...(typeof record.session_id === 'string' ? { sessionId: record.session_id } : {}),
    // JS SDK uses camelCase `modelUsage` (Python reads it from `modelUsage` too).
    ...(record.modelUsage !== undefined ? { modelUsage: record.modelUsage } : {}),
    ...(record.permission_denials !== undefined ? { permissionDenials: record.permission_denials } : {}),
    ...(typeof record.api_error_status === 'number' ? { apiErrorStatus: record.api_error_status } : {}),
    ...(record.deferred_tool_use !== undefined ? { deferredToolUse: record.deferred_tool_use } : {}),
    ...(typeof record.ttft_ms === 'number' ? { ttftMs: record.ttft_ms } : {}),
    ...(typeof record.terminal_reason === 'string' ? { terminalReason: record.terminal_reason } : {}),
    ...(typeof record.fast_mode_state === 'string' ? { fastModeState: record.fast_mode_state } : {}),
    ...(record.origin !== undefined ? { origin: record.origin } : {}),
  }

  if (subtype === 'success') {
    return {
      type: 'turn_completed',
      turnId,
      usage: record.usage,
      ...meta,
      ...(structuredOutput !== undefined ? { structuredOutput } : {}),
    }
  }

  return {
    type: 'turn_failed',
    turnId,
    error: {
      subtype,
      errors: record.errors,
      stopReason: record.stop_reason,
      ...meta,
    },
  }
}

/** Top-level `tool_progress` (SDKToolProgressMessage) → live tool progress. */
function projectToolProgress(record: Record<string, unknown>, turnId: string): TimelineItem | undefined {
  const elapsed = numberValue(record.elapsed_time_seconds) ?? numberValue(record.elapsedTimeSeconds)
  const toolUseId = stringValue(record.tool_use_id) ?? stringValue(record.toolUseId)
  if (toolUseId === undefined) return undefined
  return {
    type: 'tool_call',
    callId: toolUseId,
    name: stringValue(record.tool_name) ?? stringValue(record.toolName) ?? 'unknown',
    status: 'running',
    detail: { ...(elapsed !== undefined ? { elapsedSeconds: elapsed } : {}) },
    turnId,
  }
}

/** `auth_status` → surface as a session status (never silently drop). */
function projectAuthStatus(record: Record<string, unknown>): TimelineItem {
  const error = stringValue(record.error)
  if (error) {
    return { type: 'session_status', status: `auth_error: ${error}` }
  }
  const status = stringValue(record.status)
  return { type: 'session_status', status: `auth: ${status ?? 'unknown'}` }
}

/**
 * `system` messages: map the subtypes weft cares about to canonical timeline
 * items. Forward-compat: unrecognized subtypes fall through to `session_status`
 * (with the raw subtype name) so newer CLI subtypes are observable, never a
 * silent drop.
 */
function projectSystemMessage(record: Record<string, unknown>, turnId: string): TimelineItem | undefined {
  const subtype = stringValue(record.subtype)
  if (subtype === 'status') {
    return { type: 'session_status', status: stringValue(record.status) ?? 'unknown' }
  }
  if (subtype === 'session_state_changed') {
    return { type: 'session_status', status: stringValue(record.state) ?? 'unknown' }
  }
  if (subtype === 'permission_denied') {
    return {
      type: 'permission_resolved',
      requestId: stringValue(record.tool_use_id) ?? 'unknown',
      resolution: {
        allowed: false,
        reason: stringValue(record.decision_reason) ?? stringValue(record.message),
      },
    }
  }
  if (subtype === 'compact_boundary') {
    return { type: 'compaction_boundary' }
  }

  // Task lifecycle. These describe *background* Task-tool subagents — NOT the
  // main turn — so they must NOT be projected as `turn_completed` (that would
  // falsely signal the main turn finished). Map them to a dedicated `task_event`
  // item so the host can render nested task progress without losing the
  // distinction (SDK `TaskStarted/Progress/Updated/NotificationMessage`).
  if (subtype === 'task_started' || subtype === 'task_progress' || subtype === 'task_updated' || subtype === 'task_notification') {
    const phase = subtype === 'task_started' ? 'started'
      : subtype === 'task_progress' ? 'progress'
      : subtype === 'task_updated' ? 'updated'
      : 'notification'
    const status = subtype === 'task_updated'
      ? stringValue(asRecord(record.patch).status) ?? stringValue(record.status)
      : stringValue(record.status)
    return {
      type: 'task_event',
      taskId: stringValue(record.task_id) ?? 'task',
      phase,
      ...(status !== undefined ? { status } : {}),
      ...(typeof record.description === 'string' ? { description: record.description } : {}),
      ...(record.usage !== undefined ? { usage: record.usage } : {}),
      ...(subtype === 'task_updated' && record.patch !== undefined ? { detail: record.patch } : {}),
      turnId,
    }
  }

  if (subtype === 'hook_started' || subtype === 'hook_progress' || subtype === 'hook_response') {
    return { type: 'session_status', status: `hook:${subtype}` }
  }
  if (subtype === 'api_retry') {
    return { type: 'session_status', status: 'api_retry' }
  }

  // Remaining observed subtypes (memory_recall, notification, elicitation_complete,
  // files_persisted, plugin_install, local_command_output, thinking_tokens,
  // mirror_error) carry no canonical weft item yet — forward as `session_status`
  // so the host can observe them rather than dropping silently.
  if (subtype) {
    return { type: 'session_status', status: subtype }
  }
  return undefined
}

function normalizeToolResult(content: unknown): unknown {
  if (!Array.isArray(content)) return content
  return content.map((item) => {
    const record = asRecord(item)
    return record.type === 'text' ? stringValue(record.text) ?? '' : record
  }).join('\n')
}
