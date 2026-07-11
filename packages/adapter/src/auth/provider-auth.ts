/**
 * Provider-Owned Authentication Types
 *
 * Supplementary types specific to the adapter migration layer. The canonical
 * ProviderAuthMode/ProviderAuthDetection definitions live in @weft/runtime-core
 * (imported here for use by ProviderRuntimeDefinition).
 */

import type { ProviderAuthMode, ProviderAuthDetection } from '@weft/runtime-core'

/**
 * Result of backend initialization regarding auth.
 *
 * `authInjected: false` means the provider manages its own auth
 * and Weft did not inject any credentials.
 * `authInjected: true` means Weft supplied credentials
 * (only for managed backends).
 */
export interface BackendInitResult {
  /** Whether Weft injected credentials into the backend */
  authInjected: boolean
  /** Optional warning to surface in UI */
  authWarning?: string
}

/**
 * Provider runtime definition in the registry.
 * Maps a provider ID to its backend kind and auth mode.
 */
export interface ProviderRuntimeDefinition {
  /** Unique provider identifier (e.g. "claude-code", "codex") */
  providerId: string
  /** Human-readable label */
  label: string
  /** Which backend kind to instantiate */
  preferredBackendKind: string
  /** Fallback backend kinds if preferred is unavailable */
  fallbackBackendKinds?: string[]
  /** npm packages required by this provider */
  requiredPackages?: string[]
  /** Binary commands required on PATH */
  requiredBinaries?: string[]
  /** How this provider's auth is managed */
  authMode: ProviderAuthMode
}
