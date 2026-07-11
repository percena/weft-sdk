/**
 * Config Models Stub
 *
 * Provides model definition types used by automations.
 * Stubbed for OSS extraction — the real model config is in the main app.
 */


/**
 * Model definition for model selectors and discovery.
 */
export interface ModelDefinition {
  id: string;
  name: string;
  shortName: string;
  description: string;
  provider: string;
  contextWindow: number;
  supportsThinking?: boolean;
}