import { debug } from './utils/debug.ts';
import type { PermissionMode } from './mode-types.ts';
import { EXPLORE_MODE_CONFIG } from './mode-types.ts';
import type { ToolCheckConfig } from './bash-security.ts';
import { getBashRejectionReason, formatBashRejectionMessage } from './bash-validation.ts';
import { extractBashWriteTarget, looksLikePotentialWrite, getPathHint } from './write-detection.ts';
import { matchesAllowedWritePath, isPathWithinDirectory } from './path-helpers.ts';
import { getSessionSafeAllowedToolNames } from './session-tools-stub.ts';
import { FEATURE_FLAGS } from './stubs.ts';
import { isBrowserToolNameOrAlias } from './browser-tool-names.ts';
import type { PermissionsContext } from './permissions-config.ts';
import { extractPowerShellWriteTarget } from './powershell-validator.ts';

/**
 * Check if an MCP tool is read-only using the given config
 */
function isReadOnlyMcpToolWithConfig(toolName: string, config: ToolCheckConfig): boolean {
  return config.readOnlyMcpPatterns.some(pattern => pattern.test(toolName));
}

/**
 * Check if an API call is allowed using the given config
 * Checks fine-grained endpoint rules (method + path pattern)
 */
function isApiCallAllowedWithConfig(method: string, path: string | undefined, config: ToolCheckConfig): boolean {
  const upperMethod = method.toUpperCase();

  // GET is always allowed
  if (upperMethod === 'GET') return true;

  // Check fine-grained endpoint rules (if path is available)
  if (path && config.allowedApiEndpoints) {
    for (const rule of config.allowedApiEndpoints) {
      if (rule.method === upperMethod && rule.pathPattern.test(path)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Check if an API endpoint is allowed based on permissions context.
 * Used in 'ask' mode to auto-allow whitelisted API endpoints from permissions.json.
 *
 * @param method - HTTP method (GET, POST, etc.)
 * @param path - API endpoint path
 * @param permissionsContext - Context for loading custom permissions
 * @returns true if endpoint is allowed (GET or matches allowedApiEndpoints rules)
 */
export function isApiEndpointAllowed(
  method: string,
  path: string | undefined,
  permissionsContext?: PermissionsContext
): boolean {
  let config: ToolCheckConfig;

  if (permissionsContext) {
    // Lazy import to avoid circular dependency
    const { permissionsConfigCache } = require('./permissions-config.ts');
    config = permissionsConfigCache.getMergedConfig(permissionsContext);
  } else {
    config = EXPLORE_MODE_CONFIG;
  }

  return isApiCallAllowedWithConfig(method, path, config);
}

/**
 * Tools that are always allowed in any mode (read-only by nature)
 */
const ALWAYS_ALLOWED_TOOLS = new Set([
  'Read', 'Glob', 'Grep',           // File reading
  'Task', 'TaskOutput',             // Agent orchestration
  'WebFetch', 'WebSearch',          // Web research
  'TodoWrite',                      // Task tracking
  'SubmitPlan',                     // Plan submission
  'LSP',                            // Language server (read-only)
  // Browser automation tool (canonical wrapper)
  'browser_tool',
]);

/**
 * Result type for tool permission checks
 */
export type ToolCheckResult =
  | { allowed: true; requiresPermission?: false }
  | { allowed: true; requiresPermission: true; description: string }
  | { allowed: false; reason: string };

/**
 * Centralized check: should a tool be allowed based on permission mode?
 *
 * This is the single source of truth for tool permissions.
 * Returns different results based on the permission mode:
 * - 'explore': Block writes entirely (no prompting)
 * - 'ask': Allow but may require permission for dangerous operations
 * - 'auto': Allow everything
 */
export function shouldAllowToolInMode(
  toolName: string,
  toolInput: unknown,
  mode: PermissionMode,
  options?: {
    plansFolderPath?: string;
    dataFolderPath?: string;
    permissionsContext?: PermissionsContext;
  }
): ToolCheckResult {
  // Get config: merged custom if context provided, otherwise defaults
  let config: ToolCheckConfig;

  if (options?.permissionsContext) {
    // Lazy import to avoid circular dependency
    const { permissionsConfigCache } = require('./permissions-config.ts');
    config = permissionsConfigCache.getMergedConfig(options.permissionsContext);
  } else {
    config = EXPLORE_MODE_CONFIG;
  }

  // In 'auto' mode, all tools are allowed (no restrictions)
  if (mode === 'auto') {
    return { allowed: true };
  }

  // In 'ask' mode, all tools are allowed (user will be prompted for confirmation)
  if (mode === 'ask') {
    return { allowed: true };
  }

  // Explore mode: check against read-only allowlist

  // Always-allowed tools (read-only by nature)
  if (ALWAYS_ALLOWED_TOOLS.has(toolName)) {
    return { allowed: true };
  }

  // Check if tool name ends with an always-allowed tool (for MCP variants like mcp__plan__SubmitPlan)
  for (const allowedTool of ALWAYS_ALLOWED_TOOLS) {
    if (toolName.endsWith(`__${allowedTool}`)) {
      return { allowed: true };
    }
  }

  // Browser tool aliases (legacy browser_open/browser_snapshot/...)
  // are normalized centrally to avoid drift across permission checks.
  if (isBrowserToolNameOrAlias(toolName)) {
    return { allowed: true };
  }

  // Handle Bash - check if command is read-only
  // Uses detailed rejection reasons to provide helpful error messages
  if (toolName === 'Bash') {
    const input = toolInput as Record<string, unknown> | null;
    const command = input?.command;
    if (typeof command === 'string') {
      const rejection = getBashRejectionReason(command, config);
      if (!rejection) {
        // Command is safe - no rejection reason means it passed all checks
        return { allowed: true };
      }

      // Plans/data folder exception for bash/PowerShell writes.
      // Bash uses redirects: /bin/zsh -lc "cat <<'EOF' > /path/to/plans/file.md..."
      // PowerShell uses: @(...) | Out-File -FilePath 'C:\path\to\plans\file.md'
      // Only run this branch for likely write attempts to avoid false positives.
      const likelyWriteAttempt =
        (rejection.type === 'dangerous_operator' && rejection.operatorType === 'redirect') ||
        looksLikePotentialWrite(command);

      if (likelyWriteAttempt && (options?.plansFolderPath || options?.dataFolderPath)) {
        const targetPath = extractBashWriteTarget(command) ?? extractPowerShellWriteTarget(command);
        if (targetPath) {
          // Check plans folder with robust path containment (prevents sibling-prefix bypasses)
          if (options?.plansFolderPath && isPathWithinDirectory(targetPath, options.plansFolderPath)) {
            debug(`[Mode] Allowing write to plans folder: ${targetPath}`);
            return { allowed: true };
          }

          // Check data folder with robust path containment
          if (options?.dataFolderPath && isPathWithinDirectory(targetPath, options.dataFolderPath)) {
            debug(`[Mode] Allowing write to data folder: ${targetPath}`);
            return { allowed: true };
          }

          // Target path extracted but not in any allowed folder - give specific error with helpful hint
          debug(`[Mode] Write target "${targetPath}" is not in plans or data folder`);
          const pathHint = options?.plansFolderPath ? getPathHint(targetPath, options.plansFolderPath, options?.dataFolderPath) : null;
          const lines = [
            `Write blocked (Explore mode) - target not in allowed folders:`,
            ``,
            `  Target: ${targetPath}`,
          ];
          if (options?.plansFolderPath) {
            lines.push(`  Plans:  ${options.plansFolderPath}`);
          }
          if (options?.dataFolderPath) {
            lines.push(`  Data:   ${options.dataFolderPath}`);
          }
          if (pathHint) {
            lines.push(``, pathHint);
          }
          const plansHint = options?.plansFolderPath ? `For plans, write to: ${options.plansFolderPath}` : null;
          const dataHint = options?.dataFolderPath ? `For data output, write to: ${options.dataFolderPath}` : null;
          lines.push(
            ``,
            `Allowed paths in Explore mode:`,
            ...[plansHint, dataHint].filter(Boolean).map(p => `• ${p}`),
            `• Or ask the user to switch to Ask or Auto mode (${config.shortcutHint}) to enable writes anywhere`
          );
          return {
            allowed: false,
            reason: lines.join('\n'),
          };
        }
      }

      // Return detailed error message explaining exactly why the command was blocked
      return {
        allowed: false,
        reason: formatBashRejectionMessage(rejection, config),
      };
    }
    // No command provided - block with generic message
    return {
      allowed: false,
      reason: `Bash command is missing or invalid. Switch to Ask or Allow All mode (${config.shortcutHint}) to run it.`,
    };
  }

  // Handle Write/Edit/MultiEdit/NotebookEdit - allow if targeting plans folder or allowedWritePaths
  if (toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit' || toolName === 'NotebookEdit') {
    const input = toolInput as Record<string, unknown> | null;
    const filePath = (input?.file_path ?? input?.notebook_path) as string | undefined;

    if (filePath) {
      // Check plans folder exception
      if (options?.plansFolderPath) {
        debug(`[Mode] Checking plans folder exception: path="${filePath}", plansDir="${options.plansFolderPath}"`);
        if (isPathWithinDirectory(filePath, options.plansFolderPath)) {
          debug(`[Mode] Allowing ${toolName} to plans folder`);
          return { allowed: true };
        }
      }

      // Check data folder exception
      if (options?.dataFolderPath && isPathWithinDirectory(filePath, options.dataFolderPath)) {
        debug(`[Mode] Allowing ${toolName} to data folder`);
        return { allowed: true };
      }

      // Check allowedWritePaths from permissions config
      if (config.allowedWritePaths && config.allowedWritePaths.length > 0) {
        if (matchesAllowedWritePath(filePath, config.allowedWritePaths)) {
          debug(`[Mode] Allowing ${toolName} via allowedWritePaths`);
          return { allowed: true };
        }
      }

      // Not in plans/data folder and not in allowedWritePaths - provide detailed rejection
      if (options?.plansFolderPath || options?.dataFolderPath) {
        debug(`[Mode] ${toolName} target "${filePath}" not in allowed folders or allowedWritePaths`);
        const pathHint = options?.plansFolderPath ? getPathHint(filePath, options.plansFolderPath, options?.dataFolderPath) : null;
        const lines = [
          `${toolName} blocked (Explore mode) - target not in allowed folders:`,
          ``,
          `  Target: ${filePath}`,
        ];
        if (options?.plansFolderPath) {
          lines.push(`  Plans:  ${options.plansFolderPath}`);
        }
        if (options?.dataFolderPath) {
          lines.push(`  Data:   ${options.dataFolderPath}`);
        }
        if (pathHint) {
          lines.push(``, pathHint);
        }
        const plansHint = options?.plansFolderPath ? `For plans, write to: ${options.plansFolderPath}` : null;
        const dataHint = options?.dataFolderPath ? `For data output, write to: ${options.dataFolderPath}` : null;
        lines.push(
          ``,
          `Allowed paths in Explore mode:`,
          ...[plansHint, dataHint].filter(Boolean).map(p => `• ${p}`),
          `• Or ask the user to switch to Ask or Auto mode (${config.shortcutHint}) to enable writes anywhere`
        );
        return {
          allowed: false,
          reason: lines.join('\n'),
        };
      }
    }
  }

  // Blocked tools (Write, Edit, MultiEdit, NotebookEdit)
  if (config.blockedTools.has(toolName)) {
    return {
      allowed: false,
      reason: getBlockReasonWithConfig(toolName, config)
    };
  }

  // Handle MCP tools - allow read-only, block write operations
  if (toolName.startsWith('mcp__')) {
    // Always allow documentation tools (read-only, always available)
    if (toolName.startsWith('mcp__weft-docs__') || toolName.startsWith('mcp__agent-docs__')) {
      return { allowed: true };
    }

    // Handle session-scoped tools - derive safe-mode behavior from canonical session-tools-core metadata
    if (toolName.startsWith('mcp__session__')) {
      const safeAllowedSessionTools = getSessionSafeAllowedToolNames({
        prefix: 'mcp__session__',
        includeDeveloperFeedback: FEATURE_FLAGS.developerFeedback,
      });

      if (safeAllowedSessionTools.has(toolName)) {
        return { allowed: true };
      }

      // Write/auth/admin session tools - blocked in Explore mode
      return {
        allowed: false,
        reason: `Session configuration changes are blocked in ${config.displayName}. Switch to Ask or Allow All mode (${config.shortcutHint}) to create, update, or delete sources and agents.`
      };
    }

    // Handle API tools exposed via MCP (mcp__<source>__api_<name>)
    // These need endpoint-level permission checks, not just MCP read-only patterns
    if (toolName.includes('__api_')) {
      const input = toolInput as Record<string, unknown> | null;
      const method = (input?.method as string) || 'GET';
      const path = input?.path as string | undefined;
      if (isApiCallAllowedWithConfig(method, path, config)) {
        return { allowed: true };
      }
      return {
        allowed: false,
        reason: `API ${method} ${path ?? ''} is blocked in ${config.displayName}. Switch to Ask or Allow All mode (${config.shortcutHint}) to make changes.`
      };
    }

    if (isReadOnlyMcpToolWithConfig(toolName, config)) {
      return { allowed: true };
    }
    return {
      allowed: false,
      reason: `MCP write operations are blocked in ${config.displayName}. Switch to Ask or Allow All mode (${config.shortcutHint}) to make changes.`
    };
  }

  // Handle API tools - allow GET, block mutations unless endpoint is whitelisted
  if (toolName.startsWith('api_')) {
    const input = toolInput as Record<string, unknown> | null;
    const method = (input?.method as string) || 'GET';
    const path = input?.path as string | undefined;
    if (isApiCallAllowedWithConfig(method, path, config)) {
      return { allowed: true };
    }
    return {
      allowed: false,
      reason: `API ${method} ${path ?? ''} is blocked in ${config.displayName}. Switch to Ask or Allow All mode (${config.shortcutHint}) to make changes.`
    };
  }

  // Default: allow other tools not explicitly handled
  return { allowed: true };
}

/**
 * Get a user-friendly message explaining why a tool is blocked (using config)
 */
function getBlockReasonWithConfig(toolName: string, config: ToolCheckConfig): string {
  const displayName = config.displayName;
  const shortcut = config.shortcutHint;

  if (toolName === 'Bash') {
    return `Bash commands are blocked in ${displayName}. Switch to Ask or Allow All mode (${shortcut}) to run commands.`;
  }
  if (toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit') {
    return `File modifications are blocked in ${displayName}. Switch to Ask or Allow All mode (${shortcut}) to make changes.`;
  }
  if (toolName.startsWith('mcp__')) {
    return `MCP write operations are blocked in ${displayName}. Switch to Ask or Allow All mode (${shortcut}) to make changes.`;
  }
  if (toolName.startsWith('api_')) {
    return `API mutations are blocked in ${displayName}. Switch to Ask or Allow All mode (${shortcut}) to make changes.`;
  }
  return `${toolName} is blocked in ${displayName}. Switch to Ask or Allow All mode (${shortcut}) to use this tool.`;
}

/**
 * Create a hook return value that blocks a tool.
 * Returns the correct SDK format for PreToolUse hook blocking.
 *
 * The reason is prefixed with "[ERROR]" so the Codex model can distinguish
 * blocked tool calls from successful ones. See the detailed comment on
 * errorResponse() in packages/session-tools-core/src/response.ts for the
 * full explanation of the OpenAI Responses API limitation.
 *
 * @param reason - The reason for blocking (from shouldAllowToolInMode)
 */
export function blockWithReason(reason: string) {
  return {
    continue: false,
    decision: 'block' as const,
    reason: `[ERROR] ${reason}`,
  };
}
