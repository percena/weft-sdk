/**
 * Permissions Configuration Stub
 *
 * Stub implementation for permissions configuration.
 * The real implementation reads permissions.json files and validates
 * them with Zod schemas. This stub provides empty defaults.
 */

import type { PermissionMode } from './mode-manager.ts';
import type {
  CompiledBashPattern,
  CompiledApiEndpointRule,
  CompiledBlockedCommandHint,
  PermissionPaths,
} from './mode-types.ts';

export interface PermissionsContext {
  permissionMode: PermissionMode;
  allowedBashPatterns: CompiledBashPattern[];
  allowedWritePaths: string[];
  blockedCommands: CompiledBlockedCommandHint[];
  apiEndpointRules: CompiledApiEndpointRule[];
}

export interface MergedPermissionsConfig extends PermissionsContext {
  sourceConfigs: Record<string, PermissionsContext>;

  /**
   * Read-only Bash command patterns with metadata for helpful error messages.
   * Merged from ModeConfig to satisfy ToolCheckConfig union type.
   */
  readOnlyBashPatterns: CompiledBashPattern[];

  /**
   * Command-specific hints shown when blocked Bash commands are rejected.
   */
  blockedCommandHints?: CompiledBlockedCommandHint[];

  /**
   * Read-only MCP patterns (tools matching these are allowed).
   */
  readOnlyMcpPatterns: RegExp[];

  /**
   * Fine-grained API endpoint rules (method + path pattern).
   */
  allowedApiEndpoints: CompiledApiEndpointRule[];

  /**
   * Tools that are always blocked in explore mode.
   */
  blockedTools: Set<string>;

  /**
   * User-friendly name for the current mode.
   */
  displayName: string;

  /**
   * Keyboard shortcut hint.
   */
  shortcutHint: string;

  /**
   * Paths to permission files for actionable error messages.
   */
  permissionPaths?: PermissionPaths;
}

/**
 * Stub: returns an empty permissions context with ModeConfig-compatible defaults.
 */
export function getMergedPermissionsConfig(
  _workspaceRootPath: string,
  permissionMode: PermissionMode,
): MergedPermissionsConfig {
  return {
    permissionMode,
    allowedBashPatterns: [],
    allowedWritePaths: [],
    blockedCommands: [],
    apiEndpointRules: [],
    sourceConfigs: {},
    // ModeConfig-compatible properties (empty defaults)
    readOnlyBashPatterns: [],
    blockedCommandHints: [],
    readOnlyMcpPatterns: [],
    allowedApiEndpoints: [],
    blockedTools: new Set(),
    displayName: permissionMode === 'explore' ? 'Explore' : permissionMode === 'ask' ? 'Ask' : 'Auto',
    shortcutHint: 'SHIFT+TAB',
  };
}

/**
 * Stub: permissions config cache (no-op).
 */
export const permissionsConfigCache = {
  get: (): MergedPermissionsConfig | null => null,
  set: (): void => {},
  clear: (): void => {},
};