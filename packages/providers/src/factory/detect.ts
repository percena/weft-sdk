import { readClaudeAuth, readCodexAuth } from '@weft/adapter/auth'
import type { ProviderAuthDetection } from '@weft/adapter/auth'
import type { RuntimeAuthDetection, RuntimeCandidate } from '@weft/runtime-core'
import { execFile } from 'node:child_process'
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

/**
 * PI-8: probe whether the codex binary is invocable by spawning
 * `<executable> --version`.  Returns true when the process starts
 * (regardless of exit code), false on ENOENT.
 *
 * This is separate from `readCodexAuth` because that probe spawns
 * `codex app-server` and performs JSON-RPC — it conflates "binary missing"
 * with "auth/server failure", making both report `configured: false` with
 * a truthy `error`.  The independent `--version` check lets us set
 * `cliAvailable` (for `codex exec` fallback) without tying it to
 * app-server health.
 */
async function probeCodexBinary(
  executable: string,
  env: Record<string, string>,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    execFile(executable, ['--version'], { env, timeout: 5_000 }, (err) => {
      if (!err) {
        resolve(true)
        return
      }
      // ENOENT means the binary was not found on disk.  Any other
      // outcome (non-zero exit, timeout, signal) proves it exists.
      resolve((err as NodeJS.ErrnoException).code !== 'ENOENT')
    })
  })
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

  // PI-8: resolve executable + env up front so the binary probe and the
  // auth probe use the same binary path.
  const resolvedEnv = options.env ?? Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
  const codexBin = options.executable ?? resolvedEnv.WEFT_CODEX_EXECUTABLE ?? 'codex'

  const [binaryExists, auth] = await Promise.all([
    probeCodexBinary(codexBin, resolvedEnv),
    readCodexAuth(options.executable, options.env, options.requestTimeoutMs),
  ])
  // The codex probe spawns `codex app-server` and issues `account/read` —
  // success proves both the binary and the app-server surface work.
  const appServerAvailable = !auth.error
  // PI-8: CLI fallback (`codex exec`) only needs the binary, not a working
  // app-server.  The old check `!auth.error || auth.configured` was a no-op
  // (all codex error paths set configured:false), so CLI availability was
  // incorrectly tied to app-server health.  The independent `--version`
  // probe checks binary existence without depending on auth/server state.
  const cliAvailable = binaryExists
  return {
    candidates: createCodexRuntimeCandidates({
      appServerAvailable,
      nativeSdkAvailable: false,
      cliFallbackAvailable: cliAvailable,
      appServerReason: appServerAvailable ? undefined : auth.error,
      cliFallbackReason: cliAvailable ? undefined : auth.error,
    }),
    auth: narrowAuth(auth),
  }
}
