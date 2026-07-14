export * from '@weft/providers/factory'

// Provider-owned auth detection — reads local Claude (~/.claude) / Codex
// (app-server account/read) credentials. Feed the result into
// createHostAgentRuntime({ auth }).
export { readClaudeAuth, readCodexAuth } from '@weft/adapter'
export type { ProviderAuthMode, ProviderAuthDetection } from '@weft/adapter'

// Provider-owned model discovery — reads local Claude (~/.claude/settings.json
// env) / Codex (~/.codex/config.toml) config + probes the compatible gateway's
// /v1/models. Returns the ProviderModelDiscovery wire contract the picker UI
// consumes. Sibling to the auth probes above; the same wire contract is
// produced server-side for the browser (@percena/weft) path.
export {
  listProviderModels,
  readProviderModelDefaults,
  type ListProviderModelsOptions,
  type ListProviderModelsCallOptions,
} from '@weft/adapter'
export type { ProviderModelDiscovery, ProviderModelSource } from '@weft/runtime-core'
