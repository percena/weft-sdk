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
import {
  createFlitroProviderRuntime,
  type WeftHttpClientOptions,
} from '../flitro/index.ts'

export type HostRuntimeProvider = 'claude' | 'codex' | 'flitro'

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
  appServerClient?: CodexAppServerClient
  createAppServerClient?: () => Promise<CodexAppServerClient & { close?: () => void }>
  appServerSubprocess?: CreateCodexAppServerSubprocessClientOptions
}

export interface HostRuntimeFlitroOptions {
  server: WeftHttpClientOptions
  model?: string
  skillNames?: string[]
  mcpServerNames?: string[]
  permissionMode?: PermissionMode
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
  flitro?: HostRuntimeFlitroOptions
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
        permissionMode: options.claude?.permissionMode,
        query: options.claude?.query,
        loadSdk: options.claude?.loadSdk,
        sdkOptions: options.claude?.sdkOptions,
      }),
      sourceRuntime,
    }
  }

  if (options.provider === 'flitro') {
    if (!options.flitro?.server) {
      throw new Error('createHostAgentRuntime: flitro.server is required for provider="flitro"')
    }
    if (!options.sessionId) {
      throw new Error('createHostAgentRuntime: sessionId is required for provider="flitro"')
    }
    return {
      runtime: createFlitroProviderRuntime({
        server: options.flitro.server,
        sessionId: options.sessionId,
        epoch: options.epoch,
        now: options.now,
        candidates: options.candidates,
        auth: options.auth,
        allowFallback: options.allowFallback,
        extensions,
        model: options.flitro.model ?? options.model,
        skillNames: options.flitro.skillNames,
        mcpServerNames: options.flitro.mcpServerNames,
        sourceTools: sourceRuntime?.sourceTools,
        permissionMode: options.flitro?.permissionMode,
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
      permissionMode: options.codex?.permissionMode,
      approvalPolicy: options.codex?.approvalPolicy,
      approvalsReviewer: options.codex?.approvalsReviewer,
      sandbox: options.codex?.sandbox,
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
