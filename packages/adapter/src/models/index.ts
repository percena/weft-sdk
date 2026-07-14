/**
 * @weft/adapter/models — provider model discovery (workspace-only).
 *
 * Sibling to `@weft/adapter/auth`. Reads local provider config
 * (`~/.claude/settings.json`, `~/.codex/config.toml`) + probes the compatible
 * gateway's `/v1/models`, returning the {@link ProviderModelDiscovery} wire
 * contract that the picker UI consumes.
 *
 * This is the **local (weft-node) path**. The browser path (`@percena/weft` via
 * its flitro transport) fetches the same shape from the Weft server, which
 * probes the tenant's sealed connection server-side. All three sites produce
 * the same `ProviderModelDiscovery` shape — that contract is the merge point.
 *
 * Provider-owned: this module **detects** provider config — it never manages
 * credentials. Tokens are read only to issue a read-only `GET /v1/models`.
 */
import type { ListProviderModelsOptions, ProviderModelDiscovery } from '@weft/runtime-core'
import type { ModelProbeFetcher } from './shared.ts'
import { discoverClaudeModels, readClaudeModelDefaults } from './claude-models.ts'
import { discoverCodexModels, readCodexModelDefaults } from './codex-models.ts'

export type { ListProviderModelsOptions, ProviderModelDiscovery }
export { normalizeReasoningEffort } from '@weft/runtime-core'
export {
  fetchModels,
  uniqueModels,
  mergeWithDefault,
  type ModelProbeFetcher,
} from './shared.ts'
export {
  loadClaudeSettingsEnv,
  discoverClaudeModels,
  readClaudeModelDefaults,
  type ClaudeModelDiscoveryOptions,
} from './claude-models.ts'
export {
  parseCodexConfigToml,
  discoverCodexModels,
  readCodexModelDefaults,
  type CodexModelDiscoveryOptions,
  type ParsedCodexConfig,
} from './codex-models.ts'

/**
 * Options for {@link listProviderModels}. Extends the browser-safe
 * {@link ListProviderModelsOptions} (open `provider: string` + signal) —
 * `@percena/weft-node` is **local-only and claude/codex**, so it narrows
 * `provider` to that closed world here (the shared contract stays open so the
 * general `@percena/weft` — claude/codex/flitro — is not constrained). The
 * local-fs probe's transport-specific surfaces: env / config-dir / codex-dir
 * overrides (testing + sandboxed launch), `offline` (config-only), and
 * `fetchImpl` injection (tests). The return type is always
 * {@link ProviderModelDiscovery} so the picker UI logic is identical across
 * the local (@percena/weft-node) and remote (@percena/weft, via the Weft
 * server) paths.
 */
export interface ListProviderModelsCallOptions extends ListProviderModelsOptions {
  /** @percena/weft-node is local-only + claude/codex; narrowing gives consumers
   * compile-time safety against passing an unsupported local provider (the
   * shared contract's `provider: string` stays open for the general package). */
  provider: 'claude' | 'codex'
  /** Override process.env (testing / sandboxed launch). Replaces process.env
   * outright (no fall-through) so a passed env is authoritative. */
  env?: Record<string, string | undefined>
  /** Override ~/.claude location (testing). */
  configDir?: string
  /** Override ~/.codex location (testing). */
  codexDir?: string
  /** Skip the network probe, only read config (offline). */
  offline?: boolean
  /** Inject fetch (tests). */
  fetchImpl?: ModelProbeFetcher
}

/**
 * Discover the real model list for a provider's compatible API endpoint.
 *
 * The playground hardcodes no model ids — a compatible Anthropic/OpenAI
 * endpoint serves whatever the gateway exposes (e.g. glm-5.2,
 * deepseek-v4-flash, qwen3-max). This probes `GET {base}/v1/models` first;
 * on failure falls back to the provider's own config (env vars for Claude,
 * `~/.codex/config.toml` for Codex). `defaultModel` / `defaultEffort` surface
 * the provider's currently-active values so the picker defaults to what the
 * user is already using.
 *
 * `offline: true` skips the network probe (config-only) so a picker can be
 * populated without blocking on endpoint reachability.
 */
export async function listProviderModels(
  options: ListProviderModelsCallOptions,
): Promise<ProviderModelDiscovery> {
  if (options.provider === 'claude') {
    return discoverClaudeModels({
      env: options.env,
      configDir: options.configDir,
      offline: options.offline,
      signal: options.signal,
      fetchImpl: options.fetchImpl,
    })
  }
  return discoverCodexModels({
    env: options.env,
    codexDir: options.codexDir,
    offline: options.offline,
    signal: options.signal,
    fetchImpl: options.fetchImpl,
  })
}

/**
 * Read only the provider's active default model + effort (no network). For
 * populating a picker default before the gateway probe completes, or for
 * `offline` mode.
 */
export function readProviderModelDefaults(
  provider: 'claude' | 'codex',
  options: { env?: Record<string, string | undefined>; configDir?: string; codexDir?: string } = {},
): { model?: string; reasoningEffort?: string } {
  return provider === 'claude'
    ? readClaudeModelDefaults({ env: options.env, configDir: options.configDir })
    : readCodexModelDefaults({ env: options.env, codexDir: options.codexDir })
}
