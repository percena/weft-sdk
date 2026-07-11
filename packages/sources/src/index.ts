/**
 * @weft/sources
 *
 * MCP Source management.
 */

export type {
  FolderSourceConfig as SourceConfig,
  ApiConfig,
  ApiOAuthConfig as OAuthConfig,
  LoadedSource,
  SourceBrand,
  SourceConnectionStatus as SourceHealthStatus,
  SourceMcpAuthType,
} from './types.ts';
export { getBuiltinSources } from './builtin-sources.ts';
export {
  createSourceActivationPlan,
  type CreateSourceActivationPlanOptions,
  type SourceActivationPlan,
  type SourceActivationStatus,
  type SourceStateSnapshot,
} from './activation.ts';
export {
  createSourceToolAssemblyPlan,
  type CreateSourceToolAssemblyPlanOptions,
  type SourceCredentialRef,
  type SourceCredentialRefType,
  type SourceToolAssemblyPlan,
  type SourceToolDescriptor,
} from './assembly.ts';
export {
  createSourceRuntimeAssemblyPlan,
  type CreateSourceRuntimeAssemblyPlanOptions,
  type SourceRuntimeAssemblyPlan,
} from './runtime-assembly.ts';
export {
  createSourceRuntimeProviderOptions,
  type SourceRuntimeCapabilityDegradation,
  type SourceRuntimeProviderOptions,
} from './runtime-provider-options.ts';
export {
  validateSourceConfig,
  type ValidationIssue as SourceValidationIssue,
  type ValidationResult as SourceValidationResult,
} from './config/validators.ts';

// Source auth — provider-owned detection interface + host OAuth injection
export type {
  SourceOAuthProvider,
  SourceOAuthOptions,
  SourceProviderAuthStatus,
} from './auth/provider-owned.ts';
export { StubSourceOAuthProvider, providerAuthToSourceStatus } from './auth/provider-owned.ts';
export { SourceCredentialManager } from './credential-manager.ts';
export type { AuthResult, BasicAuthCredential, MultiHeaderCredential, ApiCredential } from './credential-manager.ts';
export { isMultiHeaderCredential } from './credential-manager.ts';

// Credential storage — encrypted backend + types
export type { CredentialId, StoredCredential, CredentialManager } from './credentials/index.ts';
export {
  EncryptedCredentialBackend,
  InMemoryCredentialManager,
  getCredentialManager,
  resetCredentialManager,
  getMachineId,
} from './credentials/index.ts';
export type { CreateCredentialManagerOptions } from './credentials/index.ts';

// Source storage — CRUD operations
export type { CreateSourceInput } from './types.ts';
export {
  loadAllSources,
  loadSourceConfig,
  saveSourceConfig,
  loadSource,
  createSource,
  deleteSource,
  sourceExists,
} from './storage.ts';
