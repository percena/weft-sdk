export * from '@weft/providers/factory'

// Provider-owned auth detection — reads local Claude (~/.claude) / Codex
// (app-server account/read) credentials. Feed the result into
// createHostAgentRuntime({ auth }).
export { readClaudeAuth, readCodexAuth } from '@weft/adapter'
export type { ProviderAuthMode, ProviderAuthDetection } from '@weft/adapter'
