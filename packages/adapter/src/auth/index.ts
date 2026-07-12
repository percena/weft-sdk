/**
 * @weft/adapter — Authentication Module
 *
 * Provider-owned auth strategy:
 * - Claude Code: delegates auth to the local `claude` binary
 * - Codex: delegates auth to `codex app-server` (account/read)
 *
 * Weft does NOT implement separate OAuth flows for providers.
 * Provider auth is detected, not managed.
 */

// Provider-owned auth types
export type { ProviderAuthMode, ProviderAuthDetection } from "@weft/runtime-core";
export type { BackendInitResult, PostInitResult, ProviderRuntimeDefinition } from "./provider-auth.ts";

// Claude Code auth detection
export {
  readClaudeAuth,
  createSanitizedClaudeEnvironment,
  claudeAuthMissingMessage,
} from "./claude-auth.ts";

// Codex auth detection
export {
  readCodexAuth,
  codexAuthFromResult,
  codexAuthMissingMessage,
  assertCodexAuthConfigured,
} from "./codex-auth.ts";
