/**
 * @weft/protocol
 *
 * Session event DTOs and RPC channel definitions.
 */

export type { PermissionMode, ApiEndpointRule, BlockedCommandHintRule, PermissionsConfigFile, CompiledApiEndpointRule, CompiledBashPattern, CompiledBlockedCommandHint, MismatchAnalysis, PermissionPaths, ModeConfig } from './mode-types.ts';
export { PERMISSION_MODE_ORDER, parsePermissionMode, PermissionsConfigSchema, EXPLORE_MODE_CONFIG, PERMISSION_MODE_CONFIG } from './mode-types.ts';
export type { ThinkingLevel, ThinkingLevelDefinition } from './thinking-levels.ts';
export { THINKING_LEVELS, THINKING_LEVEL_IDS, DEFAULT_THINKING_LEVEL, THINKING_TO_EFFORT, getThinkingTokens, getThinkingLevelNameKey, isValidThinkingLevel, normalizeThinkingLevel } from './thinking-levels.ts';

// Protocol DTOs
export type {
  // Session & lifecycle
  SessionEvent,
  Session as ProtocolSession,
  CreateSessionOptions,
  SessionCommand,
  // SessionStatus omitted — conflicts with core/types SessionStatus union; dto version is just `string`
  BuiltInStatusId,
  RemoteSessionTransferPayload,
  ImportRemoteSessionTransferResult,
  PermissionModeState,
  SendMessageOptions,
  NewChatActionParams,
  // Permission & credential
  // PermissionRequest renamed to avoid conflict with core/types base PermissionRequest
  PermissionRequest as SessionPermissionRequest,
  PermissionResponseOptions,
  CredentialRequest,
  CredentialResponse,
  AuthRequest,
  // Directory & file
  DirectoryListingResult,
  FileAttachment,
  SessionFile,
  FileSearchResult,
  // LLM connection
  LlmConnectionSetup,
  TestLlmConnectionParams,
  TestLlmConnectionResult,
  // Source / skill
  SkillFile,
  OAuthResult,
  McpValidationResult,
  McpToolWithPermission,
  McpToolsResult,
  // Search
  SessionSearchMatch,
  SessionSearchResult,
  // Result types
  UnreadSummary,
  ShareResult,
  RefreshTitleResult,
  // Plan
  Plan,
  PlanStep,
  // System
  GitBashStatus,
  UpdateInfo,
  // Workspace
  WorkspaceSettings,
  // Auth result
  ClaudeOAuthResult,
  // Automation
  TestAutomationAction,
  TestAutomationPayload,
  TestAutomationActionResult,
  TestAutomationResult,
  // Window / browser
  WindowCloseRequestSource,
  WindowCloseRequest,
  BrowserInstanceInfo,
  DeepLinkNavigation,
} from './dto.ts';
export { RPC_CHANNELS } from './channels.ts';
export type { BroadcastEventMap } from './events.ts';