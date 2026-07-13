import {
  createRuntimeCapabilityReport,
  type AgentRuntime,
  type RuntimeAuthDetection,
  type RuntimeCandidate,
  type RuntimeCapabilityReport,
  type RuntimeExtensionContext,
  type RuntimePolicyHook,
  type ProviderSourceToolDescriptor,
  type PermissionMode,
} from '@weft/runtime-core'
import {
  createCliAgentSession,
  type AgentSessionRuntime,
} from '@weft/cli-runtime'

import { createStandardExtensionCapabilities } from '../shared/capability-helpers.ts'
import { createEagerProviderRuntime } from '../shared/eager-runtime.ts'
import type { ProviderRuntimeDriver, } from '../shared/runtime-scaffold.ts'

import {
  createClaudeNativeSdkDriver,
  type ClaudeSdkQueryRunner,
  type ClaudeSdkPassthroughOptions,
  type ClaudeSdkWarmQuery,
} from './native-sdk-driver.ts'

export * from './native-sdk-driver.ts'

export interface CreateClaudeRuntimeCandidatesOptions {
  nativeSdkAvailable: boolean
  cliFallbackAvailable: boolean
  nativeSdkReason?: string
  cliFallbackReason?: string
}

export interface CreateClaudeRuntimeCapabilityReportOptions {
  candidates: RuntimeCandidate[]
  auth: RuntimeAuthDetection
  allowFallback?: boolean
  extensions?: RuntimeExtensionContext
}

export type ClaudeProviderRuntimeDriver = ProviderRuntimeDriver

export interface CreateClaudeProviderRuntimeOptions extends CreateClaudeRuntimeCapabilityReportOptions {
  cwd: string
  sessionId?: string
  epoch?: string
  now?: () => number
  model?: string
  reasoningEffort?: string
  env?: Record<string, string | undefined>
  permissionMode?: PermissionMode
  policy?: RuntimePolicyHook
  sourceTools?: ProviderSourceToolDescriptor[]
  query?: ClaudeSdkQueryRunner
  loadSdk?: () => Promise<{ query: ClaudeSdkQueryRunner }>
  /**
   * Pre-warmed query handle from the SDK's `startup()`. When set, the first
   * `sendMessage()` uses this for zero-latency first turn, then falls back
   * to the normal `query()` path for subsequent turns.
   *
   * **Caveat**: the warm path bypasses the driver's `canUseTool` / policy
   * hook bridge / `permissionMode` mapping. The host must configure
   * equivalent callbacks in the `startup({ options })` call.
   */
  warmQuery?: ClaudeSdkWarmQuery
  executable?: string
  createCliFallbackSession?: () => AgentSessionRuntime
  extensions?: RuntimeExtensionContext
  driver?: ClaudeProviderRuntimeDriver
  /**
   * Passthrough for @anthropic-ai/claude-agent-sdk `Options` not managed by the
   * driver (systemPrompt, resume/sessionId, outputFormat, agents, skills,
   * settingSources, thinking, maxTurns/maxBudgetUsd, hooks, stderr, etc.).
   * See ClaudeSdkPassthroughOptions.
   */
  sdkOptions?: ClaudeSdkPassthroughOptions
}

export function createClaudeRuntimeCandidates(
  options: CreateClaudeRuntimeCandidatesOptions,
): RuntimeCandidate[] {
  return [
    {
      kind: 'native-sdk',
      available: options.nativeSdkAvailable,
      reason: options.nativeSdkAvailable ? undefined : options.nativeSdkReason ?? 'Claude Agent SDK is unavailable',
    },
    {
      kind: 'cli-fallback',
      available: options.cliFallbackAvailable,
      reason: options.cliFallbackAvailable ? undefined : options.cliFallbackReason ?? 'claude -p is unavailable',
    },
  ]
}

export function createClaudeRuntimeCapabilityReport(
  options: CreateClaudeRuntimeCapabilityReportOptions,
): RuntimeCapabilityReport {
  const nativeAvailable = options.candidates.some(candidate => candidate.kind === 'native-sdk' && candidate.available)

  return createRuntimeCapabilityReport({
    provider: 'claude',
    candidates: options.candidates,
    preferredRuntime: 'native-sdk',
    allowFallback: options.allowFallback,
    auth: options.auth,
    extensionCapabilities: createStandardExtensionCapabilities({
      strong: nativeAvailable,
      extensions: options.extensions,
      policyReasonWeak: 'CLI fallback cannot complete provider-native permission callbacks',
      sources: { reasonWeak: 'Source tools require native SDK or host MCP wiring' },
      skillsReasonWeak: 'Skill activation is degraded in CLI fallback',
      automations: { reasonWeak: 'Automation hooks are degraded in CLI fallback' },
    }),
  })
}

export function createClaudeProviderRuntime(
  options: CreateClaudeProviderRuntimeOptions,
): AgentRuntime {
  const report = createClaudeRuntimeCapabilityReport(options)

  return createEagerProviderRuntime({
    provider: 'claude',
    report,
    sessionId: options.sessionId ?? 'claude-session',
    epoch: options.epoch,
    now: options.now,
    extensions: options.extensions,
    driver: options.driver,
    createCliFallbackSession: () => options.createCliFallbackSession?.() ?? createCliAgentSession({
      provider: 'claude',
      cwd: options.cwd,
      sessionId: options.sessionId,
      model: options.model,
      thinkingLevel: options.reasoningEffort,
      permissionMode: options.permissionMode,
      executable: options.executable,
      env: cleanEnv(options.env),
    }),
    buildStrongDriver: () => {
      if (report.selected !== 'native-sdk') return undefined
      return createClaudeNativeSdkDriver({
        cwd: options.cwd,
        model: options.model,
        reasoningEffort: options.reasoningEffort,
        env: options.env,
        permissionMode: options.permissionMode,
        policy: options.policy,
        sourceTools: options.sourceTools,
        query: options.query,
        loadSdk: options.loadSdk,
        warmQuery: options.warmQuery,
        sdkOptions: options.sdkOptions,
      })
    },
  })
}

function cleanEnv(env: Record<string, string | undefined> | undefined): Record<string, string> | undefined {
  if (!env) return undefined
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
}

export type { ProviderRuntimeDriverInput } from '../shared/runtime-scaffold.ts'
