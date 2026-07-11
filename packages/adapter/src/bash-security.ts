/// <reference path="../types/incr-regex-package.d.ts" />

import { debug } from './utils/debug.ts';
import type { ModeConfig, CompiledBashPattern, CompiledBlockedCommandHint, MismatchAnalysis } from './mode-types.ts';
import type { MergedPermissionsConfig } from './permissions-config.ts';

// Import incr-regex-package for smart pattern mismatch diagnostics
// This library allows character-by-character matching to find WHERE a regex match failed
import { IREGEX, } from 'incr-regex-package';

// ============================================================
// Tool Blocking Logic (Centralized)
// ============================================================

/**
 * Config type that works with both ModeConfig and MergedPermissionsConfig
 */
export type ToolCheckConfig = ModeConfig | MergedPermissionsConfig;

/**
 * Dangerous control characters that could cause issues at lower levels.
 *
 * Note: Newlines and carriage returns are NOT blocked because bash-parser
 * correctly handles them as command separators, and the AST validation
 * checks each command individually. Only null bytes are blocked as they
 * could cause issues with C bindings and string handling.
 */
const DANGEROUS_CONTROL_CHARS = new Set([
  '\x00',  // Null byte - can truncate strings in some contexts
]);

/**
 * Check if a command contains dangerous control characters.
 *
 * @param command - The bash command to check
 * @returns true if command contains dangerous control chars, false if safe
 */
export function hasDangerousControlChars(command: string): boolean {
  for (const char of command) {
    if (DANGEROUS_CONTROL_CHARS.has(char)) {
      debug(`[Mode] Dangerous control character detected (code ${char.charCodeAt(0)}) in command`);
      return true;
    }
  }
  return false;
}

/**
 * Check if a command contains dangerous command/process substitution patterns.
 *
 * Detects:
 * - Command substitution: $(...) or `...` (backticks)
 * - Process substitution: <(...) or >(...)
 *
 * These are dangerous because they execute arbitrary commands:
 * - `ls $(rm -rf /)` - the rm runs during argument expansion
 * - `echo "$(cat /etc/passwd)"` - executes even inside double quotes
 * - `cat <(curl http://evil.com)` - process substitution runs curl
 *
 * Note: Single-quoted strings are safe: `echo '$(rm)'` is literal text
 *
 * @param command - The bash command to check
 * @returns true if command contains dangerous substitution, false if safe
 */
export function hasDangerousSubstitution(command: string): boolean {
  let inSingleQuote = false;
  let escaped = false;

  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    const nextChar = command[i + 1];

    // Handle escape sequences (only outside single quotes)
    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === '\\' && !inSingleQuote) {
      escaped = true;
      continue;
    }

    // Track single quote state (double quotes don't protect against substitution)
    if (char === "'" && !escaped) {
      inSingleQuote = !inSingleQuote;
      continue;
    }

    // Only check for dangerous patterns outside single quotes
    if (!inSingleQuote) {
      // Command substitution: $(
      if (char === '$' && nextChar === '(') {
        debug(`[Mode] Command substitution $() detected in: ${command}`);
        return true;
      }

      // Backtick command substitution
      if (char === '`') {
        debug(`[Mode] Backtick substitution detected in: ${command}`);
        return true;
      }

      // Process substitution: <( or >(
      if ((char === '<' || char === '>') && nextChar === '(') {
        debug(`[Mode] Process substitution detected in: ${command}`);
        return true;
      }
    }
  }

  return false;
}

// ============================================================
// Bash Rejection Reasons (Detailed error messages)
// ============================================================

/**
 * Pattern info for error messages - shows what patterns might have matched
 */
export interface RelevantPatternInfo {
  source: string;
  comment?: string;
}

/**
 * Detailed reason why a bash command was rejected in Explore mode.
 * Used to provide helpful error messages that explain exactly what was blocked and why.
 */
export type BashRejectionReason =
  | { type: 'control_char'; char: string; charCode: number; explanation: string }
  | { type: 'no_safe_pattern'; command: string; relevantPatterns: RelevantPatternInfo[]; mismatchAnalysis?: MismatchAnalysis; commandHint?: CompiledBlockedCommandHint }
  | { type: 'dangerous_operator'; operator: string; operatorType: 'chain' | 'redirect'; explanation: string }
  | { type: 'dangerous_substitution'; pattern: string; explanation: string }
  | { type: 'parse_error'; error: string }
  // New AST-based rejection types (from bash-validator)
  | { type: 'pipeline'; explanation: string }
  | { type: 'redirect'; op: string; explanation: string }
  | { type: 'command_expansion'; explanation: string }
  | { type: 'process_substitution'; explanation: string }
  | { type: 'parameter_expansion'; explanation: string }
  | { type: 'env_assignment'; explanation: string }
  | { type: 'unsafe_command'; command: string; explanation: string }
  | { type: 'compound_partial_fail'; failedCommands: string[]; passedCommands: string[] };

/**
 * Human-readable explanations for control characters.
 */
const CONTROL_CHAR_EXPLANATIONS: Record<string, string> = {
  '\n': 'newline acts as command separator in bash (e.g., `safe\\ndangerous` runs both)',
  '\r': 'carriage return can act as command separator',
  '\x00': 'null byte can truncate strings and cause unexpected behavior',
};

/**
 * Find the first dangerous control character in a command.
 * Returns details about the character if found, null otherwise.
 */
function _findDangerousControlChar(command: string): { char: string; charCode: number; explanation: string } | null {
  for (const char of command) {
    if (DANGEROUS_CONTROL_CHARS.has(char)) {
      const charCode = char.charCodeAt(0);
      const displayChar = char === '\n' ? '\\n' : char === '\r' ? '\\r' : char === '\x00' ? '\\0' : `\\x${charCode.toString(16).padStart(2, '0')}`;
      const explanation = CONTROL_CHAR_EXPLANATIONS[char] ?? `control character (code ${charCode}) can cause unexpected behavior`;
      return { char: displayChar, charCode, explanation };
    }
  }
  return null;
}

/**
 * Find dangerous command/process substitution in a command.
 * Returns details about the pattern if found, null otherwise.
 */
function _findDangerousSubstitution(command: string): { pattern: string; explanation: string } | null {
  let inSingleQuote = false;
  let escaped = false;

  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    const nextChar = command[i + 1];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === '\\' && !inSingleQuote) {
      escaped = true;
      continue;
    }

    if (char === "'" && !escaped) {
      inSingleQuote = !inSingleQuote;
      continue;
    }

    if (!inSingleQuote) {
      if (char === '$' && nextChar === '(') {
        return {
          pattern: '$()',
          explanation: 'command substitution executes embedded commands during expansion (e.g., `ls $(rm -rf /)`)',
        };
      }

      if (char === '`') {
        return {
          pattern: '`...`',
          explanation: 'backtick substitution executes embedded commands (e.g., `echo \\`rm -rf /\\``)',
        };
      }

      if (char === '<' && nextChar === '(') {
        return {
          pattern: '<()',
          explanation: 'process substitution executes commands and provides output as a file (e.g., `cat <(curl evil.com)`)',
        };
      }

      if (char === '>' && nextChar === '(') {
        return {
          pattern: '>()',
          explanation: 'process substitution executes commands with input from a file descriptor',
        };
      }
    }
  }

  return null;
}

/**
 * Find patterns that might be relevant to the attempted command.
 * Extracts the first word (command name) and finds patterns containing it.
 * This helps provide actionable error messages when a command is blocked.
 *
 * For example, if the command is "git -C /path status", this will find
 * the git pattern and show the agent what format is expected.
 */
export function findRelevantPatterns(command: string, patterns: CompiledBashPattern[]): RelevantPatternInfo[] {
  // Extract the first word (command name) from the command
  const firstWord = command.trim().split(/\s+/)[0]?.toLowerCase();
  if (!firstWord) return [];

  // Find patterns whose source contains the command name
  // This catches patterns like "^git\s+(status|log|...)" when command starts with "git"
  const relevant: RelevantPatternInfo[] = [];

  for (const pattern of patterns) {
    // Check if the pattern source contains the command name
    // Use case-insensitive matching and look for the command at word boundaries
    const sourceLower = pattern.source.toLowerCase();
    if (
      sourceLower.includes(firstWord) ||
      sourceLower.startsWith(`^${firstWord}`)
    ) {
      relevant.push({
        source: pattern.source,
        comment: pattern.comment,
      });
    }
  }

  // Limit to top 3 most relevant patterns to avoid overwhelming the agent
  return relevant.slice(0, 3);
}

/**
 * Resolve command-specific hint for blocked bash commands.
 * Uses exact base-command match and optional whenNotMatching condition.
 */
export function findBlockedCommandHint(command: string, config: ToolCheckConfig): CompiledBlockedCommandHint | undefined {
  const hints = config.blockedCommandHints ?? [];
  if (hints.length === 0) return undefined;

  const firstToken = command.trim().split(/\s+/)[0]?.toLowerCase();
  if (!firstToken) return undefined;
  const baseCommand = firstToken.split('/').pop() ?? firstToken;

  for (const hint of hints) {
    if (hint.command !== baseCommand) continue;

    // If a condition is provided, hint applies only when command does NOT match it
    if (hint.whenNotMatchingRegex?.test(command)) {
      continue;
    }

    return hint;
  }

  return undefined;
}

/**
 * Analyze WHY a command didn't match any pattern using incremental regex matching.
 * Uses incr-regex-package to find exactly WHERE in the command matching stopped,
 * which helps generate actionable error messages.
 *
 * For example, if the command is "git -C /path status" and the pattern is
 * "^git\s+(status|log|diff)", this will detect that matching stopped at "-C"
 * and suggest running from within the repo directory instead.
 */
export function analyzePatternMismatch(command: string, patterns: CompiledBashPattern[]): MismatchAnalysis | null {
  const trimmedCommand = command.trim();
  if (!trimmedCommand) return null;

  // Find the pattern that matches the longest prefix of the command
  // This gives us the "best match" to analyze
  let bestMatch: {
    matchedCount: number;
    matchedPrefix: string;
    pattern: CompiledBashPattern;
  } | null = null;

  for (const pattern of patterns) {
    try {
      // Simplify the pattern for incr-regex: remove anchors and word boundaries
      // which aren't supported by the incremental matching library.
      // This is fine since we only use it for diagnostic purposes.
      const simplifiedPattern = pattern.source
        .replace(/^\^/, '')     // Remove start anchor
        .replace(/\$$/g, '')    // Remove end anchor
        .replace(/\\b/g, '');   // Remove word boundaries

      // Create incremental regex matcher from the simplified pattern
      // IREGEX is a class that takes a regex pattern string in its constructor
      const incr = new IREGEX(simplifiedPattern);

      // Use matchStr to process the entire command and get match info
      // Returns [success, charCount, matchedString]
      const [_success, charCount, matchedStr] = incr.matchStr(trimmedCommand);

      // Track the pattern that matched the most characters (best partial match)
      if (charCount > 0 && (!bestMatch || charCount > bestMatch.matchedCount)) {
        bestMatch = {
          matchedCount: charCount,
          matchedPrefix: matchedStr || trimmedCommand.substring(0, charCount),
          pattern,
        };
      }
    } catch {
    }
  }

  // If no pattern matched anything, return null (unknown command)
  if (!bestMatch || bestMatch.matchedCount === 0) {
    return null;
  }

  // Analyze what token caused the mismatch
  const failedPosition = bestMatch.matchedCount;
  const remainingCommand = trimmedCommand.substring(failedPosition).trim();
  const failedToken = remainingCommand.split(/\s+/)[0] || '';

  // Generate a helpful suggestion based on what we found
  const suggestion = generateMismatchSuggestion(
    trimmedCommand,
    bestMatch.matchedPrefix,
    failedToken,
    bestMatch.pattern
  );

  return {
    matchedPrefix: bestMatch.matchedPrefix,
    failedAtPosition: failedPosition,
    failedToken,
    bestMatchPattern: {
      source: bestMatch.pattern.source,
      comment: bestMatch.pattern.comment,
    },
    suggestion,
  };
}

/**
 * Generate an actionable suggestion based on pattern mismatch analysis.
 * Looks for common patterns like flags before subcommands in git/gh/docker.
 */
export function generateMismatchSuggestion(
  command: string,
  _matchedPrefix: string,
  failedToken: string,
  pattern: CompiledBashPattern
): string | undefined {
  const firstWord = command.split(/\s+/)[0]?.toLowerCase();

  // Detect "flags before subcommand" pattern for git, gh, docker, kubectl
  const commandsWithSubcommands = ['git', 'gh', 'docker', 'kubectl', 'npm', 'yarn', 'cargo'];
  if (
    commandsWithSubcommands.includes(firstWord || '') &&
    failedToken.startsWith('-')
  ) {
    // The command has a flag where a subcommand was expected
    // Try to find the actual subcommand later in the command
    const words = command.split(/\s+/);
    const subcommandCandidates = words.slice(1).filter(w => !w.startsWith('-') && !w.includes('/'));

    if (subcommandCandidates.length > 0) {
      const likelySubcommand = subcommandCandidates[0];
      return `The pattern expects \`${firstWord} <subcommand>\` directly, but found flag \`${failedToken}\` first. ` +
        `Try running from within the target directory, or use: \`${firstWord} ${likelySubcommand} ...\``;
    }

    return `The pattern expects a subcommand after \`${firstWord}\`, but found flag \`${failedToken}\`. ` +
      `Run from the target directory or switch to Ask/Execute mode.`;
  }

  // Detect possible typos in subcommands using simple heuristics
  // (Check if failedToken is close to any word in the pattern)
  if (pattern.comment && !failedToken.startsWith('-')) {
    // Extract subcommand options from pattern comment if present
    // e.g., "Git read-only operations: view status, history, branches, diffs"
    const commentLower = pattern.comment.toLowerCase();
    const failedTokenLower = failedToken.toLowerCase();

    // Check for common subcommand names in the comment
    const commonSubcommands = ['status', 'log', 'diff', 'show', 'branch', 'list', 'view', 'get', 'describe'];
    for (const sub of commonSubcommands) {
      // Simple Levenshtein-ish check: if token is within 2 chars of a known subcommand
      if (
        commentLower.includes(sub) &&
        Math.abs(failedTokenLower.length - sub.length) <= 2 &&
        failedTokenLower !== sub
      ) {
        // Check if first 2 chars match (simple typo detection)
        if (failedTokenLower.substring(0, 2) === sub.substring(0, 2)) {
          return `Did you mean \`${firstWord} ${sub}\` instead of \`${firstWord} ${failedToken}\`?`;
        }
      }
    }
  }

  // Generic fallback
  return undefined;
}
