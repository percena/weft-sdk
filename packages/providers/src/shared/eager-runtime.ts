import type {
  AgentRuntime,
  RuntimeCapabilityReport,
  RuntimeExtensionContext,
} from '@weft/runtime-core'
import type { AgentSessionRuntime, CliAgentProvider } from '@weft/cli-runtime'

import { createCliFallbackDriver } from './cli-fallback-driver.ts'
import {
  createProviderRuntimeScaffold,
  type ProviderRuntimeDriver,
} from './runtime-scaffold.ts'

/**
 * Shared wiring for the "eager" providers (claude, codex): a strong runtime
 * (native SDK / app-server) with a `claude -p` / `codex exec` CLI fallback.
 *
 * Both providers had an identical `getDriver` shape — short-circuit an injected
 * driver, build a CLI-fallback driver when that runtime is selected, otherwise
 * build the strong driver — followed by an identical `createProviderRuntimeScaffold`
 * call. This centralises that skeleton; the provider-specific pieces (CLI
 * session construction, strong-driver construction, client ownership / dispose)
 * stay in the caller as the two callbacks below.
 */
export interface EagerProviderRuntimeConfig {
  provider: CliAgentProvider
  report: RuntimeCapabilityReport
  sessionId: string
  epoch?: string
  now?: () => number
  extensions?: RuntimeExtensionContext
  /** Pre-built driver (testing) — short-circuits selection entirely. */
  driver?: ProviderRuntimeDriver
  /** Build the CLI-fallback session when `cli-fallback` is selected. */
  createCliFallbackSession: () => AgentSessionRuntime
  /**
   * Build the strong (native-sdk / app-server) driver. Called only when neither
   * an injected driver nor the CLI fallback applies. Should return `undefined`
   * if its runtime is not the selected one (e.g. selection landed nowhere).
   */
  buildStrongDriver: () => ProviderRuntimeDriver | undefined | Promise<ProviderRuntimeDriver | undefined>
  /** Forwarded to the scaffold (e.g. close an owned app-server client). */
  onDispose?: () => void | Promise<void>
}

export function createEagerProviderRuntime(config: EagerProviderRuntimeConfig): AgentRuntime {
  async function getDriver(): Promise<ProviderRuntimeDriver | undefined> {
    if (config.driver) return config.driver
    if (config.report.selected === 'cli-fallback') {
      return createCliFallbackDriver({
        provider: config.provider,
        session: config.createCliFallbackSession(),
        sessionId: config.sessionId,
        epoch: config.epoch ?? 'default',
        now: config.now,
      })
    }
    return config.buildStrongDriver()
  }

  return createProviderRuntimeScaffold({
    provider: config.provider,
    sessionId: config.sessionId,
    epoch: config.epoch,
    now: config.now,
    report: config.report,
    extensions: config.extensions,
    getDriver,
    onDispose: config.onDispose,
  })
}
