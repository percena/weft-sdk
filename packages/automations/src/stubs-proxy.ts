/**
 * Stubs Proxy for Automations Package
 *
 * Re-exports shared stub types needed by config/label stubs.
 * These types mirror what's available from @weft/protocol or
 * are locally stubbed since the automations package doesn't depend on the adaptor package.
 */

/**
 * LLM connection type aliases for config stubs.
 */
export type LlmProviderType = 'anthropic' | 'openai';

export type LlmAuthType =
  | 'api_key'
  | 'api_key_with_endpoint'
  | 'oauth'
  | 'bearer_token'
  | 'iam_credentials'
  | 'service_account_file'
  | 'none'
  | 'environment';

export interface LlmConnection {
  slug: string;
  name: string;
  providerType: LlmProviderType;
  authType: LlmAuthType;
  defaultModel: string;
  createdAt: number;
  models?: Array<string | { id: string; contextWindow?: number }>;
}