/**
 * Mode Types and Constants
 *
 * Pure types and UI configuration for permission modes.
 * Note: This file imports zod for schema definitions.
 * Type-only imports (PermissionMode, PermissionModeCanonical) have no runtime cost.
 */

import { z } from 'zod';

// ============================================================
// Permission Mode Types
// ============================================================

/**
 * Available permission modes.
 *
 * Canonical wire/session-state values — the SDK's internal mode names match the
 * canonical wire names, so the SDK↔weftd↔agentd contract exchanges these
 * exact strings as `permission_mode`:
 * - explore  -> read-only (writes denied)
 * - ask      -> ask before each side-effecting op
 * - auto     -> auto-approve
 */
export type PermissionMode = 'explore' | 'ask' | 'auto';

/**
 * Order of modes for cycling with SHIFT+TAB
 */
export const PERMISSION_MODE_ORDER: PermissionMode[] = ['explore', 'ask', 'auto'];

/**
 * Parse user-facing mode names into a {@link PermissionMode}.
 *
 * Accepts the canonical values explore/ask/auto (case-insensitive). Anything
 * else returns null so persisted configs/sessions with unrecognized modes are
 * rejected rather than silently mis-mapped.
 */
export function parsePermissionMode(mode: string): PermissionMode | null {
  const normalized = mode.trim().toLowerCase();

  if (normalized === 'explore') return 'explore';
  if (normalized === 'ask') return 'ask';
  if (normalized === 'auto') return 'auto';

  return null;
}

// ============================================================
// Permissions Config Types (Browser-safe Zod schemas)
// ============================================================

/**
 * API endpoint rule - method + path pattern
 */
const ApiEndpointRuleSchema = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']),
  path: z.string().describe('Regex pattern for API path'),
  comment: z.string().optional(),
});

export type ApiEndpointRule = z.infer<typeof ApiEndpointRuleSchema>;

/**
 * Pattern with optional comment
 */
const PatternSchema = z.union([
  z.string(),
  z.object({
    pattern: z.string(),
    comment: z.string().optional(),
  }),
]);

/**
 * Command-specific block hint for clearer Explore-mode rejection messages.
 */
const BlockedCommandHintSchema = z.object({
  /** Command name (normalized lowercase base command, e.g. "printf") */
  command: z.string(),
  /** Primary reason shown when command is blocked */
  reason: z.string(),
  /** Additional policy/risk context */
  context: z.string().optional(),
  /** Suggested alternatives or next actions */
  tryInstead: z.array(z.string()).optional(),
  /** Concrete example command */
  example: z.string().optional(),
  /** Apply this hint only when the command does NOT match this regex */
  whenNotMatching: z.string().optional(),
});

export type BlockedCommandHintRule = z.infer<typeof BlockedCommandHintSchema>;

/**
 * Permissions JSON configuration schema
 *
 * Note: Core write tools (Write, Edit, MultiEdit, NotebookEdit) are hardcoded in
 * EXPLORE_MODE_CONFIG and always blocked in Explore mode. The blockedTools field
 * allows users to block additional tools beyond these defaults.
 */
export const PermissionsConfigSchema = z.object({
  /** Version date for migration (ISO format: "2026-02-07") */
  version: z.string().optional(),
  /** Bash command patterns to allow (regex strings) */
  allowedBashPatterns: z.array(PatternSchema).optional(),
  /** MCP tool patterns to allow (regex strings) */
  allowedMcpPatterns: z.array(PatternSchema).optional(),
  /** API endpoint rules - method + path pattern */
  allowedApiEndpoints: z.array(ApiEndpointRuleSchema).optional(),
  /** File paths to allow writes in Explore mode (glob patterns) */
  allowedWritePaths: z.array(PatternSchema).optional(),
  /** Additional tools to block (extends the hardcoded defaults) */
  blockedTools: z.array(PatternSchema).optional(),
  /** Command-specific hint messages for blocked Bash commands */
  blockedCommandHints: z.array(BlockedCommandHintSchema).optional(),
});

export type PermissionsConfigFile = z.infer<typeof PermissionsConfigSchema>;

// ============================================================
// Mode Config Types
// ============================================================

/**
 * Compiled API endpoint rule for runtime checking
 */
export interface CompiledApiEndpointRule {
  method: string;
  pathPattern: RegExp;
}

/**
 * Compiled bash pattern with metadata for error messages.
 * Stores the original pattern string and comment alongside the compiled RegExp
 * so we can provide helpful error messages when commands don't match.
 */
export interface CompiledBashPattern {
  /** Compiled regex for matching */
  regex: RegExp;
  /** Original pattern string (for error messages) */
  source: string;
  /** Human-readable comment explaining what this pattern allows */
  comment?: string;
}

/**
 * Runtime command-specific hint for blocked Bash commands.
 */
export interface CompiledBlockedCommandHint {
  /** Base command token (lowercase), e.g. "printf" */
  command: string;
  reason: string;
  context?: string;
  tryInstead?: string[];
  example?: string;
  /** Optional condition: hint applies only when command does NOT match this regex */
  whenNotMatching?: string;
  whenNotMatchingRegex?: RegExp;
}

/**
 * Analysis of why a command didn't match a pattern.
 * Used by incr-regex-package to provide detailed diagnostics showing
 * exactly WHERE matching failed and what was expected.
 */
export interface MismatchAnalysis {
  /** How much of the command matched before failure */
  matchedPrefix: string;
  /** Character position where matching stopped */
  failedAtPosition: number;
  /** The token/word that caused the mismatch */
  failedToken: string;
  /** The pattern that got closest to matching */
  bestMatchPattern?: {
    source: string;
    comment?: string;
  };
  /** Actionable suggestion for the user/agent */
  suggestion?: string;
}

/**
 * Paths to permissions configuration files.
 * Used in error messages to guide the agent on how to customize permissions.
 */
export interface PermissionPaths {
  /** Path to workspace-level permissions.json */
  workspacePath: string;
  /** Path to app-level default.json */
  appDefaultPath: string;
  /** Path to permissions documentation */
  docsPath: string;
}

/**
 * Explore mode configuration - defines behavior for read-only mode
 */
export interface ModeConfig {
  /** Tools that are always blocked in explore mode (Write, Edit, etc.) - hardcoded, not configurable */
  blockedTools: Set<string>;
  /** Read-only Bash command patterns with metadata for helpful error messages */
  readOnlyBashPatterns: CompiledBashPattern[];
  /** Command-specific hints shown when blocked Bash commands are rejected */
  blockedCommandHints?: CompiledBlockedCommandHint[];
  /** Read-only MCP patterns (tools matching these are allowed) */
  readOnlyMcpPatterns: RegExp[];
  /** Fine-grained API endpoint rules (method + path pattern) */
  allowedApiEndpoints: CompiledApiEndpointRule[];
  /** File paths allowed for writes in Explore mode (glob patterns) */
  allowedWritePaths?: string[];
  /** User-friendly name */
  displayName: string;
  /** Keyboard shortcut hint */
  shortcutHint: string;
  /** Paths to permission files for actionable error messages */
  permissionPaths?: PermissionPaths;
}

// ============================================================
// Explore Mode Configuration (Browser-safe - pure data)
// ============================================================

/**
 * Minimal fallback configuration for explore mode.
 *
 * The actual patterns are loaded from ~/.weft/permissions/default.json
 * at runtime by PermissionsConfigCache. This fallback ensures the app works
 * even if the JSON file is missing or invalid.
 *
 * To customize allowed commands, edit ~/.weft/permissions/default.json
 */
export const EXPLORE_MODE_CONFIG: ModeConfig = {
  // Tools that are always blocked (no read-only variant) - these are hardcoded
  // as they represent fundamental write operations that should never be allowed
  // in Explore mode regardless of user configuration
  blockedTools: new Set([
    'Write',
    'Edit',
    'MultiEdit',
    'NotebookEdit',
  ]),
  // Empty fallbacks - actual patterns loaded from default.json
  // If default.json is missing, no bash commands will be auto-allowed in Explore mode
  readOnlyBashPatterns: [],
  blockedCommandHints: [],
  readOnlyMcpPatterns: [],
  allowedApiEndpoints: [],
  displayName: 'Explore',
  shortcutHint: 'SHIFT+TAB',
};

/**
 * Display configuration for each mode
 */
export const PERMISSION_MODE_CONFIG: Record<PermissionMode, {
  displayName: string;
  shortName: string;
  description: string;
  /** SVG path data for the icon (viewBox 0 0 24 24, stroke-based) */
  svgPath: string;
  /** Tailwind color classes for consistent theming */
  colorClass: {
    /** Text color class (e.g., 'text-info') */
    text: string;
    /** Background color class (e.g., 'bg-info') */
    bg: string;
    /** Border color class (e.g., 'border-info') */
    border: string;
  };
}> = {
  'explore': {
    displayName: 'Explore',
    shortName: 'Explore',
    description: 'Read-only exploration. Blocks writes, never prompts.',
    // Compass icon from Lucide
    svgPath: 'M16.24 7.76l-1.804 5.411a2 2 0 0 1-1.265 1.265L7.76 16.24l1.804-5.411a2 2 0 0 1 1.265-1.265z M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z',
    colorClass: {
      text: 'text-foreground/60',
      bg: 'bg-foreground/60',
      border: 'border-foreground/60',
    },
  },
  'ask': {
    displayName: 'Ask to Edit',
    shortName: 'Ask',
    description: 'Prompts before making edits.',
    // Info icon from Lucide
    svgPath: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM12 8v4m0 4h.01',
    colorClass: {
      text: 'text-info',
      bg: 'bg-info',
      border: 'border-info',
    },
  },
  'auto': {
    displayName: 'Auto',
    shortName: 'Auto',
    description: 'Automatic execution, no prompts.',
    // Repeat icon from Lucide (loop)
    svgPath: 'm17 1 4 4-4 4M3 11V9a4 4 0 0 1 4-4h14M7 23l-4-4 4-4M21 13v2a4 4 0 0 1-4 4H3',
    colorClass: {
      text: 'text-accent',
      bg: 'bg-accent',
      border: 'border-accent',
    },
  },
};
