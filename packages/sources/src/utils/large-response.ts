/**
 * Large Response Guard — Stub for OSS extraction.
 *
 * Handles binary detection, large response saving, and optional summarization.
 * Stub: returns null (no guard applied) so responses pass through as-is.
 */

import type { SummarizeCallback } from '../api-tools.ts';

export interface GuardLargeResultOptions {
  sessionPath: string;
  toolName: string;
  input?: Record<string, unknown>;
  intent?: string;
  summarize?: SummarizeCallback;
}

/**
 * Guard a large response buffer.
 * Stub: returns null, meaning the response passes through as-is text.
 */
export async function guardLargeResult(
  _buffer: Buffer,
  _options: GuardLargeResultOptions,
): Promise<string | null> {
  // Stub: no guard applied
  return null;
}