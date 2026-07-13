import type {
  AgentRuntime,
  PermissionMode,
  RuntimeAuthDetection,
  RuntimeCandidate,
  RuntimeExtensionContext,
  RuntimePolicyExtension,
} from '@weft/runtime-core'
import {
  createSourceRuntimeProviderOptions,
  type CreateSourceRuntimeAssemblyPlanOptions,
  type SourceRuntimeProviderOptions,
} from '@weft/sources'
import {
  createClaudeProviderRuntime,
  type ClaudeSdkQueryRunner,
  type ClaudeSdkPassthroughOptions,
} from '../claude/index.ts'
import {
  createCodexProviderRuntime,
  type CodexAppServerClient,
  type CreateCodexAppServerSubprocessClientOptions,
} from '../codex/index.ts'

export {
  detectRuntimeCandidates,
  type DetectRuntimeCandidatesOptions,
  type DetectedRuntimeCandidates,
} from './detect.ts'

// Local-only: the host runtime drives Claude and Codex in-process / as
// subprocesses. Flitro (the remote weftd client) is intentionally NOT a host
// provider here — it ships only in `@percena/weft`'s `./providers/flitro`
// entry. Keeping the union narrow prevents the remote-client runtime from
// leaking into `@percena/weft-node/runtime` (local-only package).
export type HostRuntimeProvider = 'claude' | 'codex'

export interface HostRuntimeClaudeOptions {
  model?: string
  reasoningEffort?: string
  env?: Record<string, string | undefined>
  permissionMode?: PermissionMode
  query?: ClaudeSdkQueryRunner
  loadSdk?: () => Promise<{ query: ClaudeSdkQueryRunner }>
  /** Passthrough for @anthropic-ai/claude-agent-sdk `Options` (systemPrompt,
   * resume/sessionId, outputFormat, agents, skills, thinking, hooks, etc.). */
  sdkOptions?: ClaudeSdkPassthroughOptions
}

export interface HostRuntimeCodexOptions {
  model?: string
  reasoningEffort?: string
  permissionMode?: PermissionMode
  approvalPolicy?: string
  approvalsReviewer?: string
  sandbox?: string
  /** A5: resume a persisted codex thread (`thread/resume` on first turn).
   * Capture it from the timeline's
   * `host_state_changed { kind: 'provider_session' }` item. */
  threadId?: string
  appServerClient?: CodexAppServerClient
  createAppServerClient?: () => Promise<CodexAppServerClient & { close?: () => void }>
  appServerSubprocess?: CreateCodexAppServerSubprocessClientOptions
}

export interface CreateHostAgentRuntimeOptions {
  provider: HostRuntimeProvider
  cwd: string
  model?: string
  reasoningEffort?: string
  sessionId?: string
  epoch?: string
  now?: () => number
  candidates: RuntimeCandidate[]
  auth: RuntimeAuthDetection
  allowFallback?: boolean
  extensions?: RuntimeExtensionContext
  policy?: RuntimePolicyExtension
  sourceRuntime?: CreateSourceRuntimeAssemblyPlanOptions
  claude?: HostRuntimeClaudeOptions
  codex?: HostRuntimeCodexOptions
}

export interface HostAgentRuntimeResult {
  runtime: AgentRuntime
  sourceRuntime?: SourceRuntimeProviderOptions
}

export function createHostAgentRuntime(
  options: CreateHostAgentRuntimeOptions,
): HostAgentRuntimeResult {
  const sourceRuntime = options.sourceRuntime
    ? createSourceRuntimeProviderOptions(options.sourceRuntime)
    : undefined
  const extensions = mergeExtensions(options.extensions, options.policy, sourceRuntime)

  if (options.provider === 'claude') {
    return {
      runtime: createClaudeProviderRuntime({
        cwd: options.cwd,
        sessionId: options.sessionId,
        epoch: options.epoch,
        now: options.now,
        candidates: options.candidates,
        auth: options.auth,
        allowFallback: options.allowFallback,
        extensions,
        // Bridge the integrator's policy hook to the driver. mergeExtensions
        // stores the RuntimePolicyExtension struct at extensions.policy (for
        // capability reporting: mode/degraded); the driver's canUseTool reads a
        // bare RuntimePolicyHook (function) from the top-level `policy` field.
        // Without this bridge the driver sees no policy and auto-allows every
        // tool call (native-sdk-driver evaluatePolicy returns allow when
        // this.options.policy is unset) — the ask/explore permission mode is
        // silently defeated. Regression: always bridge policy.hook to the driver.
        policy: options.policy?.hook,
        sourceTools: sourceRuntime?.sourceTools,
        model: options.claude?.model ?? options.model,
        reasoningEffort: options.claude?.reasoningEffort ?? options.reasoningEffort,
        env: options.claude?.env,
        // B7: the permission mode was dual-tracked — `policy.mode` fed only
        // the capability report while the driver's native mode came solely
        // from `claude.permissionMode`. Setting `policy: { mode: 'explore' }`
        // alone left the SDK in default mode (enforcement resting on the hook)
        // while the report claimed the mode was active. Fall back to
        // `policy.mode` so one channel configures both.
        permissionMode: options.claude?.permissionMode ?? options.policy?.mode,
        query: options.claude?.query,
        loadSdk: options.claude?.loadSdk,
        sdkOptions: options.claude?.sdkOptions,
      }),
      sourceRuntime,
    }
  }

  return {
    runtime: createCodexProviderRuntime({
      cwd: options.cwd,
      sessionId: options.sessionId,
      epoch: options.epoch,
      now: options.now,
      candidates: options.candidates,
      auth: options.auth,
      allowFallback: options.allowFallback,
      extensions,
      // Bridge the integrator's policy hook to the driver (see the claude
      // branch for the full rationale). Codex defaults to 'ask' when no policy
      // is set, but without this bridge the integrator's custom hook is still
      // bypassed. Regression: always bridge policy.hook to the driver.
      policy: options.policy?.hook,
      sourceTools: sourceRuntime?.sourceTools,
      appServerClient: options.codex?.appServerClient,
      createAppServerClient: options.codex?.createAppServerClient,
      model: options.codex?.model ?? options.model,
      reasoningEffort: options.codex?.reasoningEffort ?? options.reasoningEffort,
      // B7: fall back to policy.mode (see the claude branch note).
      permissionMode: options.codex?.permissionMode ?? options.policy?.mode,
      approvalPolicy: options.codex?.approvalPolicy,
      approvalsReviewer: options.codex?.approvalsReviewer,
      sandbox: options.codex?.sandbox,
      threadId: options.codex?.threadId,
      appServerSubprocess: options.codex?.appServerSubprocess,
    }),
    sourceRuntime,
  }
}

function mergeExtensions(
  base: RuntimeExtensionContext | undefined,
  policy: RuntimePolicyExtension | undefined,
  sourceRuntime: SourceRuntimeProviderOptions | undefined,
): RuntimeExtensionContext {
  return {
    ...base,
    ...(policy ? { policy } : {}),
    sources: sourceRuntime?.extensions.sources ?? base?.sources,
  }
}
