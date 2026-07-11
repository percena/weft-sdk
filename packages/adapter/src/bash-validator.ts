/**
 * Bash Command Validator Stub
 *
 * Stub implementation for bash command validation.
 * The real implementation uses bash-parser AST analysis.
 * This stub provides the exported types and simple pass-through validation.
 */

import type { CompiledBashPattern } from './mode-types.ts';

export interface BashValidationResult {
  allowed: boolean;
  reason?: BashValidationReason;
  subcommandResults?: SubcommandResult[];
}

export interface SubcommandResult {
  command: string;
  allowed: boolean;
  reason?: string;
}

export type BashValidationReason =
  | { type: 'pipeline'; explanation: string }
  | { type: 'redirect'; op: string; explanation: string }
  | { type: 'command_expansion'; explanation: string }
  | { type: 'process_substitution'; explanation: string }
  | { type: 'parameter_expansion'; explanation: string }
  | { type: 'env_assignment'; explanation: string }
  | { type: 'unsafe_command'; command: string; explanation: string }
  | { type: 'compound_partial_fail'; failedCommands: string[]; passedCommands: string[] }
  | { type: 'parse_error'; error: string }
  | { type: 'background_execution'; explanation: string };

/**
 * Control character detection result.
 */
export interface ControlCharResult {
  char: string;
  explanation: string;
}

/**
 * Validate a bash command against allowed patterns.
 * Stub: always returns allowed=true (no validation in the extracted package).
 */
export function validateBashCommand(
  _command: string,
  _patterns: CompiledBashPattern[],
): BashValidationResult {
  return { allowed: true };
}

/**
 * Check if a command has control characters.
 * Stub: always returns false (no control character detection in the extracted package).
 */
export function hasControlCharacters(_command: string): ControlCharResult | false {
  return false;
}