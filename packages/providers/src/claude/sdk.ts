/**
 * Optional Claude Agent SDK utilities.
 *
 * Import this explicit subpath only when `@anthropic-ai/claude-agent-sdk` is
 * installed. The normal `@weft/providers/claude` entry intentionally avoids a
 * value import so Codex-only and Claude CLI-fallback hosts remain loadable.
 */
export {
  type SessionStore,
  type SDKSessionInfo,
  type SessionMessage,
  InMemorySessionStore,
  listSessions,
  getSessionInfo,
  getSessionMessages,
  deleteSession,
  forkSession,
  renameSession,
  tagSession,
  importSessionToStore,
  getSubagentMessages,
  listSubagents,
  createSdkMcpServer,
  tool,
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
} from '@anthropic-ai/claude-agent-sdk'

export type {
  Options,
  Query,
  SDKMessage,
  CanUseTool,
  EffortLevel,
  HookEvent,
  HookCallbackMatcher,
  HookJSONOutput,
  PermissionMode,
  PermissionResult,
  McpServerConfig,
} from '@anthropic-ai/claude-agent-sdk'
