/**
 * Stub Types for External Dependencies
 *
 * Provides simplified stub interfaces/types for dependencies that were
 * external to the upstream monorepo and are NOT being extracted
 * into the Weft package. These stubs satisfy TypeScript imports
 * without pulling in heavy implementation modules.
 *
 * Categories of stubs:
 * - Heavy infrastructure: McpClientPool, SourceManager, AutomationSystem
 *   (these have complex implementations that aren't needed in the adaptor)
 * - Config types: LlmConnection, LlmConnectionType, ModelProvider, etc.
 *   (these are used as type annotations; the adaptor doesn't own config)
 * - Domain types: AuthRequest, FileAttachment, RecoveryMessage, AbortReason
 *   (some are available from @weft/core, others are stubbed here)
 */

// ============================================================
// Heavy Infrastructure Stubs
// ============================================================

/**
 * Stub for McpClientPool — the MCP client pool manager.
 * The real implementation manages MCP source connections in the main process.
 * In the adaptor package, this is just a type annotation that gets passed through.
 */
export type McpClientPool = {}

/**
 * Stub for SourceManager — the source configuration manager.
 * The real implementation handles source activation/deactivation and config.
 * In the adaptor package, this is just a type annotation that gets passed through.
 */
export type SourceManager = {}

/**
 * Stub for AutomationSystem — the workspace automation system.
 * The real implementation manages user-defined automations (automations.json).
 * In the adaptor package, this is just a type annotation that gets passed through.
 */
export type AutomationSystem = {}

// ============================================================
// LLM Connection Config Stubs
// ============================================================

/**
 * Authentication type for LLM connections.
 * Determines how credentials are retrieved and passed to backends.
 */
export type LlmAuthType =
  | 'api_key'
  | 'api_key_with_endpoint'
  | 'oauth'
  | 'bearer_token'
  | 'iam_credentials'
  | 'service_account_file'
  | 'none'
  | 'environment';

/**
 * Provider type for LLM connections.
 * Includes compatibility variants and cloud providers.
 */
export type LlmProviderType =
  | 'anthropic'
  | 'openai';

/**
 * Legacy LLM connection type (deprecated, replaced by LlmProviderType).
 */
export type LlmConnectionType =
  | 'anthropic'
  | 'openai'
  | 'openai-compat';

/**
 * Custom endpoint configuration for OpenAI-compatible providers.
 */
export interface CustomEndpointConfig {
  /** API protocol type */
  api: string;
  /** Whether the endpoint supports image inputs */
  supportsImages?: boolean;
}

/**
 * LLM connection configuration.
 * Stored in config.json and used for credential routing and model selection.
 */
export interface LlmConnection {
  /** Unique slug identifier */
  slug: string;
  /** User-visible name */
  name: string;
  /** Provider type (determines SDK selection) */
  providerType: LlmProviderType;
  /** Authentication mechanism */
  authType: LlmAuthType;
  /** Default model ID for this connection */
  defaultModel: string;
  /** Creation timestamp */
  createdAt: number;
  /** Custom endpoint for compatibility providers */
  customEndpoint?: CustomEndpointConfig;
  /** Base URL override */
  baseUrl?: string;
  /** Available models list */
  models?: Array<string | { id: string; contextWindow?: number; supportsImages?: boolean }>;
  /** Legacy type field (deprecated) */
  type?: LlmConnectionType;
}

// ============================================================
// Model Config Stubs
// ============================================================

/**
 * Model provider identifier.
 * Maps to the SDK/backend that handles the model.
 */
export type ModelProvider = 'anthropic' | 'openai' | 'copilot';

/**
 * Default model ID when no model is specified.
 */
export const DEFAULT_MODEL = 'claude-sonnet-4-6';

/**
 * Model definition for model selectors and discovery.
 */
export interface ModelDefinition {
  id: string;
  name: string;
  shortName: string;
  description: string;
  provider: ModelProvider;
  contextWindow: number;
  supportsThinking?: boolean;
}

/**
 * Model fetch result from provider discovery APIs.
 */
export interface ModelFetchResult {
  models: ModelDefinition[];
}

// ============================================================
// Domain Type Stubs
// ============================================================

/**
 * File attachment for chat messages.
 * Supports images, documents, and other files sent alongside text.
 */
export interface FileAttachment {
  /** File path (absolute or relative to workspace) */
  path: string;
  /** MIME type (e.g., 'image/png', 'text/plain') */
  mimeType?: string;
  /** Original filename for display */
  name?: string;
}

/**
 * Auth request for source/tool authentication.
 * Passed through callbacks to the session layer.
 */
export interface AuthRequest {
  /** Source or tool requesting auth */
  sourceSlug: string;
  /** Auth type required */
  authType: string;
  /** Human-readable description */
  message: string;
}

/**
 * Recovery message for session recovery context.
 * Used when aborting/restarting sessions.
 */
export interface RecoveryMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Abort reason enum for session lifecycle.
 * Determines how and why a session was interrupted.
 */
export enum AbortReason {
  /** User manually stopped the session */
  UserStop = 'user_stop',
  /** Agent redirected to a new message */
  Redirect = 'redirect',
  /** Session being torn down (app shutdown) */
  Teardown = 'teardown',
  /** Internal error requiring restart */
  InternalError = 'internal_error',
  /** Handoff to UI for permission/auth prompt */
  Handoff = 'handoff',
}

/**
 * Loaded source configuration.
 * Represents an MCP or API source that has been activated for a session.
 */
export interface LoadedSource {
  /** Source slug identifier */
  slug: string;
  /** Source display name */
  name: string;
  /** Whether the source is currently active */
  isActive: boolean;
  /** Source type */
  type: 'mcp' | 'api';
  /** Source-specific configuration */
  config?: Record<string, unknown>;
}

/**
 * Credential manager for LLM and source credentials.
 * The real implementation handles secure credential storage.
 * Stubbed here as an interface for type annotations.
 */
export interface CredentialManager {
  getLlmApiKey(slug: string): Promise<string | null>;
  setLlmApiKey(slug: string, key: string): Promise<void>;
  deleteLlmApiKey(slug: string): Promise<void>;
  hasLlmCredentials(slug: string, authType: LlmAuthType, providerType: LlmProviderType): Promise<boolean>;
}

/**
 * Validation error for LLM connection configuration.
 */
export type LlmValidationResult = {
  success: boolean;
  error?: string;
};

// ============================================================
// Feature Flags Stub
// ============================================================

/**
 * Feature flags for controlling optional behavior.
 * Stub: all flags disabled by default in the extracted package.
 */
export const FEATURE_FLAGS = {
  developerFeedback: false,
  richToolDescriptions: true,
  extendedPromptCache: false,
  enable1MContext: false,
} as const;

// ============================================================
// Options Stub
// ============================================================

/**
 * Set the path to the Claude Code executable.
 * Stub: no-op in the extracted package (runtime resolver handles this).
 */
export function setPathToClaudeCodeExecutable(_path: string): void {
  // No-op stub — runtime resolver handles path configuration
}

// ============================================================
// LLM Validation Stubs
// ============================================================

/**
 * Parse a validation error message into a user-friendly string.
 * Stub: returns the raw error message.
 */
export function parseValidationError(error: string): string {
  return error;
}

/**
 * Validate an Anthropic connection configuration.
 * Stub: returns success without actual validation.
 */
export async function validateAnthropicConnection(_args: {
  model: string;
  apiKey?: string;
  oauthToken?: string;
  baseUrl?: string;
}): Promise<{ success: boolean; error?: string }> {
  // Stub: no actual validation in the extracted package
  return { success: true };
}

/**
 * Validate a provider-auth combination.
 * Stub: returns true for all combinations.
 */
export function isValidProviderAuthCombination(
  _providerType: LlmProviderType,
  _authType: LlmAuthType,
): boolean {
  // Stub: allow all combinations
  return true;
}

/**
 * Get the provider for a model ID.
 * Stub: returns undefined (model routing is handled externally).
 */
export function getModelProvider(model: string): ModelProvider | undefined {
  if (model.startsWith('claude-')) return 'anthropic';
  if (model.startsWith('gpt-') || model.startsWith('o1') || model.startsWith('o3') || model.startsWith('o4')) return 'openai';
  return undefined;
}

/**
 * Get the context window size for a model.
 * Stub: returns a reasonable default.
 */
export function getModelContextWindow(model: string): number | undefined {
  if (model.includes('opus')) return 200_000;
  if (model.includes('sonnet')) return 200_000;
  if (model.includes('haiku')) return 200_000;
  return 200_000;
}

// ============================================================
// Credential Manager Stub
// ============================================================

/**
 * Get the credential manager singleton.
 * Stub: returns a no-op implementation.
 */
export function getCredentialManager(): CredentialManager {
  return {
    getLlmApiKey: async () => null,
    setLlmApiKey: async () => {},
    deleteLlmApiKey: async () => {},
    hasLlmCredentials: async () => false,
  };
}

// ============================================================
// LLM Connection Storage Stubs
// ============================================================

/**
 * Get an LLM connection by slug.
 * Stub: returns null.
 */
export function getLlmConnection(_slug: string): LlmConnection | null {
  return null;
}

/**
 * Get the default LLM connection slug.
 * Stub: returns undefined.
 */
export function getDefaultLlmConnection(): string | undefined {
  return undefined;
}

// ============================================================
// Session Config Stub
// ============================================================

/**
 * Session configuration type.
 * Alias for the Session type from @weft/core, representing
 * the configuration needed to resume or identify a session.
 */
export interface SessionConfig {
  id: string;
  workspaceRootPath: string;
  createdAt: number;
  lastUsedAt: number;
}

// ============================================================
// Provider Metadata Stub
// ============================================================

/**
 * Provider metadata for error context.
 */
export interface ProviderInfo {
  name: string;
  statusPageUrl?: string;
  dashboardUrl?: string;
}

/**
 * Get provider metadata for error messages.
 * Stub: returns null.
 */
export function getProviderMetadata(
  _providerType: string,
): ProviderInfo | null {
  return null;
}

// ============================================================
// Base Agent Spawn Session Stubs
// ============================================================

/**
 * Request to spawn a new session from the agent.
 */
export interface SpawnSessionRequest {
  /** The prompt/context for the new session */
  prompt: string;
  /** The parent session ID */
  parentSessionId: string;
  /** Optional model override */
  model?: string;
}

/**
 * Result of spawning a new session.
 */
export interface SpawnSessionResult {
  /** The new session ID */
  sessionId: string;
  /** Whether the spawn was successful */
  success: boolean;
}