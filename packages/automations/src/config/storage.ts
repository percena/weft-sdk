/**
 * Config Storage Stub
 *
 * Provides LLM connection lookup used by automations validation.
 * Stubbed for OSS extraction — the real config storage is in the main app.
 */

import type { LlmConnection } from '../stubs-proxy.ts';

/**
 * Get an LLM connection by slug.
 * Stub: returns null (no connections in OSS package).
 */
export function getLlmConnection(_slug: string): LlmConnection | null {
  return null;
}