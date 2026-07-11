/**
 * Credential Types — Stub for OSS extraction.
 *
 * Defines types for credential storage and lookup.
 */

export interface CredentialId {
  type: 'source_oauth' | 'source_bearer' | 'source_apikey' | 'source_basic';
  workspaceId: string;
  sourceId: string;
}

export interface StoredCredential {
  value: string;
  refreshToken?: string;
  expiresAt?: number;
  clientId?: string;
  clientSecret?: string;
  tokenType?: string;
}