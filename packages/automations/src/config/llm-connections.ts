/**
 * Config LLM Connections Stub
 *
 * Provides default model lists for LLM connections.
 * Stubbed for OSS extraction — the real config is in the main app.
 */

import type { ModelDefinition } from './models.ts';

/**
 * Get default models for a connection based on provider type.
 * Stub: returns an empty array.
 */
export function getDefaultModelsForConnection(
  _providerType: string,
): ModelDefinition[] {
  return [];
}