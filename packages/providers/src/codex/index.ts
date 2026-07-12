import {
  createRuntimeCapabilityReport,
  mapPermissionModeToCodexParams,
  type AgentRuntime,
  type RuntimeAuthDetection,
  type RuntimeCandidate,
  type RuntimeCapabilityReport,
  type RuntimeExtensionContext,
  type RuntimePolicyHook,
  type ProviderSourceToolDescriptor,
  type PermissionMode,
  type ModelReasoningEffort,
} from '@weft/runtime-core'
import {
  createCliAgentSession,
  type AgentSessionRuntime,
} from '@weft/cli-runtime'

import { createStandardExtensionCapabilities } from '../shared/capability-helpers.ts'
import { createEagerProviderRuntime } from '../shared/eager-runtime.ts'
import type { ProviderRuntimeDriver, } from '../shared/runtime-scaffold.ts'

import {
  createCodexAppServerDriver,
  type CodexAppServerClient,
} from './app-server-driver.ts'
import {
  createCodexAppServerSubprocessClient,
  type CreateCodexAppServerSubprocessClientOptions,
} from './app-server-client.ts'

export * from './app-server-driver.ts'
export * from './app-server-client.ts'

export interface CreateCodexRuntimeCandidatesOptions {
  appServerAvailable: boolean
  nativeSdkAvailable: boolean
  cliFallbackAvailable: boolean
  appServerReason?: string
  nativeSdkReason?: string
  cliFallbackReason?: string
}

export interface CreateCodexRuntimeCapabilityReportOptions {
  candidates: RuntimeCandidate[]
  auth: RuntimeAuthDetection
  allowFallback?: boolean
  extensions?: RuntimeExtensionContext
}

export type CodexProviderRuntimeDriver = ProviderRuntimeDriver

export interface CreateCodexProviderRuntimeOptions extends CreateCodexRuntimeCapabilityReportOptions {
  cwd: string
  sessionId?: string
  /**
   * A5: resume a pre-existing codex thread across processes. Pass the thread
   * id captured from a previous run (surfaced on the timeline as
   * `host_state_changed { kind: 'provider_session' }`, or via the driver's
   * `getProviderThreadId()`); the first turn then issues `thread/resume`
   * instead of `thread/start`.
   */
  threadId?: string
  epoch?: string
  now?: () => number
  model?: string
  reasoningEffort?: ModelReasoningEffort
  permissionMode?: PermissionMode
  approvalPolicy?: string
  approvalsReviewer?: string
  sandbox?: string
  policy?: RuntimePolicyHook
  sourceTools?: ProviderSourceToolDescriptor[]
  appServerClient?: CodexAppServerClient
  createAppServerClient?: () => Promise<CodexAppServerClient & { close?: () => void }>
  appServerSubprocess?: CreateCodexAppServerSubprocessClientOptions
  executable?: string
  env?: Record<string, string>
  createCliFallbackSession?: () => AgentSessionRuntime
  extensions?: RuntimeExtensionContext
  driver?: CodexProviderRuntimeDriver
  /** Non-experimental thread-level overrides sent on `thread/start`. */
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

export function createCodexRuntimeCandidates(
  options: CreateCodexRuntimeCandidatesOptions,
): RuntimeCandidate[] {
  // `native-sdk` is reported but never selectable for codex: there is no
  // in-process codex runtime today, so even when a caller passes
  // `nativeSdkAvailable: true` it is reported as unavailable (and excluded
  // from `fallbackKindOrder` below) to prevent selection landing on a runtime
  // whose `sendMessage` would always throw. The `nativeSdkAvailable` option is
  // accepted for signature compatibility but does not make it selectable.
  return [
    {
      kind: 'app-server',
      available: options.appServerAvailable,
      reason: options.appServerAvailable ? undefined : options.appServerReason ?? 'Codex app-server is unavailable',
    },
    {
      kind: 'native-sdk',
      available: false,
      reason: options.nativeSdkReason ?? 'Codex native SDK runtime is not yet implemented; use app-server or cli-fallback',
    },
    {
      kind: 'cli-fallback',
      available: options.cliFallbackAvailable,
      reason: options.cliFallbackAvailable ? undefined : options.cliFallbackReason ?? 'codex exec is unavailable',
    },
  ]
}

export function createCodexRuntimeCapabilityReport(
  options: CreateCodexRuntimeCapabilityReportOptions,
): RuntimeCapabilityReport {
  const appServerAvailable = options.candidates.some(candidate => candidate.kind === 'app-server' && candidate.available)
  const nativeAvailable = options.candidates.some(candidate => candidate.kind === 'native-sdk' && candidate.available)
  const strongRuntimeAvailable = appServerAvailable || nativeAvailable

  return createRuntimeCapabilityReport({
    provider: 'codex',
    candidates: options.candidates,
    preferredRuntime: 'app-server',
    // `native-sdk` is intentionally omitted: it is never selectable for codex
    // (see createCodexRuntimeCandidates), so it must never be picked as a
    // fallback. Selection falls through app-server → compatible-sdk → cli-fallback.
    fallbackKindOrder: ['app-server', 'compatible-sdk', 'cli-fallback'],
    allowFallback: options.allowFallback,
    auth: options.auth,
    extensionCapabilities: createStandardExtensionCapabilities({
      strong: strongRuntimeAvailable,
      extensions: options.extensions,
      policyReasonWeak: 'codex exec fallback cannot complete app-server approval callbacks',
      sources: {
        // Source tool descriptors are accepted by the driver but NOT executed
        // via `thread/start.dynamicTools` — the host-side execution bridge is
        // deferred. Mark the capability
        // `degraded` whenever it would otherwise look fully supported (i.e. when
        // app-server is available) so callers do not over-trust it. Inject
        // sources via host-side MCP until the dynamicTools bridge lands.
        degradedWhenStrong: true,
        reasonStrong: 'Source tools are accepted but not yet executed via app-server dynamicTools; inject via host-side MCP',
        reasonWeak: 'Source tools require app-server, SDK, or host MCP wiring',
      },
      skillsReasonWeak: 'Skill activation is degraded in CLI fallback',
      automations: { reasonWeak: 'Automation hooks are degraded in CLI fallback' },
    }),
  })
}

export function createCodexProviderRuntime(
  options: CreateCodexProviderRuntimeOptions,
): AgentRuntime {
  const report = createCodexRuntimeCapabilityReport(options)
  let ownedAppServerClient: (CodexAppServerClient & { close?: () => void }) | undefined

  return createEagerProviderRuntime({
    provider: 'codex',
    report,
    sessionId: options.sessionId ?? 'codex-session',
    epoch: options.epoch,
    now: options.now,
    extensions: options.extensions,
    driver: options.driver,
    createCliFallbackSession: () => options.createCliFallbackSession?.() ?? createCliAgentSession({
      provider: 'codex',
      cwd: options.cwd,
      sessionId: options.sessionId,
      model: options.model,
      reasoningEffort: options.reasoningEffort,
      permissionMode: options.permissionMode,
      executable: options.executable,
      env: options.env,
    }),
    buildStrongDriver: async () => {
      // native-sdk is unreachable for codex (always unavailable + excluded from
      // fallbackKindOrder); only app-server builds a strong driver.
      if (report.selected !== 'app-server') return undefined
      const client = options.appServerClient
        ?? await (options.createAppServerClient?.()
          ?? createCodexAppServerSubprocessClient(options.appServerSubprocess))
      if (!options.appServerClient) {
        ownedAppServerClient = client
      }
      // B7: `permissionMode` previously configured only the CLI fallback; the
      // app-server thread-level params came solely from the explicit
      // approvalPolicy/sandbox options. Derive them from the canonical mode
      // when not explicitly provided, so one channel drives both runtimes.
      const modeParams = options.permissionMode
        ? mapPermissionModeToCodexParams(options.permissionMode)
        : undefined
      return createCodexAppServerDriver({
        cwd: options.cwd,
        client,
        threadId: options.threadId,
        model: options.model,
        reasoningEffort: options.reasoningEffort,
        approvalPolicy: options.approvalPolicy ?? modeParams?.approvalPolicy,
        approvalsReviewer: options.approvalsReviewer ?? modeParams?.approvalsReviewer,
        sandbox: options.sandbox ?? modeParams?.sandbox,
        policy: options.policy,
        sourceTools: options.sourceTools,
        modelProvider: options.modelProvider,
        serviceTier: options.serviceTier,
        baseInstructions: options.baseInstructions,
        developerInstructions: options.developerInstructions,
        personality: options.personality,
        serviceName: options.serviceName,
        threadSource: options.threadSource,
        multiAgentMode: options.multiAgentMode,
      })
    },
    onDispose: () => ownedAppServerClient?.close?.(),
  })
}

export type { ProviderRuntimeDriverInput } from '../shared/runtime-scaffold.ts'
