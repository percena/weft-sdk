/**
 * Config Validators Stub
 *
 * Provides validation types used by automations.
 * Stubbed for OSS extraction — the real validators are in the main app.
 */

export interface ValidationIssue {
  /** File being validated */
  file: string;
  /** Path to the issue within the config */
  path: string;
  /** Human-readable error/warning message */
  message: string;
  /** Issue severity */
  severity: 'error' | 'warning' | 'info';
  /** Optional suggestion for fixing the issue */
  suggestion?: string;
}

export interface ValidationResult {
  /** Whether the config is valid (no errors) */
  valid: boolean;
  /** Error issues (blocking) */
  errors: ValidationIssue[];
  /** Warning issues (non-blocking) */
  warnings: ValidationIssue[];
}