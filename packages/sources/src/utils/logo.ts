/**
 * Logo Utility Stub
 *
 * Provides logo URL derivation and high-quality logo fetching for sources.
 * Stubbed for OSS extraction — the real implementation uses service discovery
 * and favicon/logo APIs to automatically source icons.
 */

import type { CreateSourceInput } from '../types.ts';

/**
 * Derive a service URL from source creation input.
 * Attempts to extract a base URL from MCP config, API config, etc.
 * Stub: returns undefined (no service discovery in OSS package).
 */
export function deriveServiceUrl(_input: CreateSourceInput): string | undefined {
  return undefined;
}

/**
 * Get a high-quality logo URL for a service.
 * Uses favicon/logo APIs to find the best available icon.
 * Stub: returns undefined (no logo API access in OSS package).
 */
export async function getHighQualityLogoUrl(_serviceUrl: string, _provider?: string): Promise<string | undefined> {
  return undefined;
}