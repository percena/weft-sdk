import { readClaudeAuth, readCodexAuth } from '@weft/adapter/auth'
import type { ProviderAuthDetection } from '@weft/adapter/auth'
import type { RuntimeAuthDetection, RuntimeCandidate } from '@weft/runtime-core'
import { createClaudeRuntimeCandidates } from '../claude/index.ts'
import { createCodexRuntimeCandidates } from '../codex/index.ts'

/**
 * B5: one-stop preflight detection for the desktop host factory.
 *
 * ARCHITECTURE.md promises "`preflighting` — detecting SDK/CLI/app-server
 * capability and provider-owned auth", but `createHostAgentRuntime` requires
 * the caller to hand in prebuilt `candidates` + `auth`, and the probes lived
 * un-assembled in `@weft/adapter/auth`. This helper performs the actual
 * detection so a host can do:
 *
 * ```ts
 * const detected = await detectRuntimeCandidates({ provider: 'claude' })
 * const { runtime } = createHostAgentRuntime({ provider: 'claude', cwd, ...detected })
 * ```
 */
export interface DetectRuntimeCandidatesOptions {
  provider: 'claude' | 'codex'
  /** Override the provider binary (defaults to PATH lookup / WEFT_*_EXECUTABLE). */
  executable?: string
  env?: Record<string, string>
  /** Codex only: app-server account/read probe timeout. */
  requestTimeoutMs?: number
  /**
   * Claude only: override the SDK availability probe (defaults to a dynamic
   * `import('@anthropic-ai/claude-agent-sdk')`). Injectable for tests.
   */
  probeClaudeSdk?: () => Promise<boolean>
}

export interface DetectedRuntimeCandidates {
  candidates: RuntimeCandidate[]
  auth: RuntimeAuthDetection
}

async function defaultProbeClaudeSdk(): Promise<boolean> {
  try {
    await import('@anthropic-ai/claude-agent-sdk')
    return true
  } catch {
    return false
  }
}

function narrowAuth(auth: ProviderAuthDetection): RuntimeAuthDetection {
  // Both probes always report provider-owned auth; the narrow keeps the
  // capability-report type honest without a cast at every call site.
  return { ...auth, mode: 'provider-owned' }
}

export async function detectRuntimeCandidates(
  options: DetectRuntimeCandidatesOptions,
): Promise<DetectedRuntimeCandidates> {
  if (options.provider === 'claude') {
    const [sdkAvailable, auth] = await Promise.all([
      (options.probeClaudeSdk ?? defaultProbeClaudeSdk)(),
      readClaudeAuth(options.executable, options.env),
    ])
    // The auth probe doubles as the CLI availability check: it runs the
    // `claude` binary, so a probe that produced a result (even "not logged
    // in") proves the binary is invocable; a spawn failure sets auth.error.
    const cliAvailable = !auth.error || auth.configured
    return {
      candidates: createClaudeRuntimeCandidates({
        nativeSdkAvailable: sdkAvailable,
        cliFallbackAvailable: cliAvailable,
        nativeSdkReason: sdkAvailable ? undefined : '@anthropic-ai/claude-agent-sdk is not installed',
        cliFallbackReason: cliAvailable ? undefined : auth.error,
      }),
      auth: narrowAuth(auth),
    }
  }

  const auth = await readCodexAuth(options.executable, options.env, options.requestTimeoutMs)
  // The codex probe spawns `codex app-server` and issues `account/read` —
  // success proves both the binary and the app-server surface work.
  const appServerAvailable = !auth.error
  return {
    candidates: createCodexRuntimeCandidates({
      appServerAvailable,
      nativeSdkAvailable: false,
      cliFallbackAvailable: appServerAvailable,
      appServerReason: appServerAvailable ? undefined : auth.error,
      cliFallbackReason: appServerAvailable ? undefined : auth.error,
    }),
    auth: narrowAuth(auth),
  }
}
