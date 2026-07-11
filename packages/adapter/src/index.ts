/**
 * Agent Backend Abstraction Layer
 *
 * Shared infrastructure for AI agent providers (Claude, Codex, Flitro).
 * Provider-specific runtime implementations live in @weft/providers.
 */

// Core types
export type {
  AgentBackend,
  CoreBackendConfig,
  BackendConfig,
  BackendHostRuntimeContext,
  PermissionCallback,
  PlanCallback,
  AuthCallback,
  SourceChangeCallback,
  SourceActivationCallback,
  ChatOptions,
  RecoveryMessage,
  SdkMcpServerConfig,
  LlmAuthType,
  LlmProviderType,
  PostInitResult,
} from './types.ts';

// Enums need to be exported as values, not just types
export { AbortReason } from './types.ts';

// Auth module — provider-owned detection (Claude/Codex)
export type { ProviderAuthMode, ProviderAuthDetection } from '@weft/runtime-core';
export type { BackendInitResult, ProviderRuntimeDefinition } from './auth/provider-auth.ts';
export {
  readClaudeAuth,
  createSanitizedClaudeEnvironment,
  claudeAuthMissingMessage,
} from './auth/claude-auth.ts';
export {
  readCodexAuth,
  codexAuthFromResult,
  codexAuthMissingMessage,
  assertCodexAuthConfigured,
} from './auth/codex-auth.ts';

// Shared infrastructure — base classes and utilities consumed by provider packages
export { EventQueue } from './event-queue.ts';
export type { AgentError } from './errors.ts';
export { parseError, isBillingError, canAutoRetry } from './errors.ts';
export {
  ToolIndex,
  extractToolStarts,
  extractToolResults,
  isParentTaskTool,
  serializeResult,
  isToolResultError,
  type ContentBlock,
} from './tool-matching.ts';
export { createLogger } from './utils/debug.ts';
