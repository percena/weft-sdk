/**
 * Source Auth — Provider-Owned Detection Interface
 *
 * Weft does NOT implement separate OAuth flows for providers
 * (Claude, Codex). Provider auth is detected and delegated, not managed.
 *
 * This module provides:
 * 1. Detection interface for source-level auth (MCP bearer/basic/apikey)
 * 2. Provider auth delegation — forwards to @weft/runtime-core auth types
 *    for Claude/Codex/Copilot provider-level detection
 *
 * Source-level OAuth (Google, Slack, Microsoft) for MCP/API sources
 * remains in this package but requires host application injection.
 * The host app provides the actual OAuth callback server implementation.
 */

import type { ProviderAuthMode, ProviderAuthDetection } from "@weft/runtime-core";

// ============================================================
// Source-Level Auth Types
// ============================================================

/**
 * Auth session context for source OAuth flows.
 * Used by host application to track which session/workspace initiated auth.
 */
export interface OAuthSessionContext {
  sessionId: string;
  workspaceId: string;
}

/**
 * Result of a source authentication attempt.
 *
 * On success, the host app can either:
 * 1. Return token data here → Weft's SourceCredentialManager saves it
 * 2. Save tokens directly via SourceCredentialManager.save() → return success only
 *
 * Option 1 is simpler; Option 2 gives the host app full control over storage.
 * Both approaches work — Weft handles either case.
 */
export interface SourceAuthResult {
  /** Whether auth was successful */
  success: boolean;
  /** Error message if auth failed */
  error?: string;
  /** Email address obtained during auth (if available) */
  email?: string;
  /** Access token (host app may return it for Weft to save) */
  accessToken?: string;
  /** Refresh token (host app may return it for Weft to save) */
  refreshToken?: string;
  /** Token expiry timestamp in ms since epoch (host app may return it) */
  expiresAt?: number;
}

// ============================================================
// Provider Auth Delegation
// ============================================================

/**
 * Provider auth detection result for source-level usage.
 * Wraps the runtime-core ProviderAuthDetection for source credential routing.
 */
export interface SourceProviderAuthStatus {
  /** Which auth mode the provider uses */
  mode: ProviderAuthMode;
  /** Whether the provider's auth is configured */
  configured: boolean;
  /** Human-readable description of auth state */
  description: string;
}

/**
 * Convert ProviderAuthDetection from runtime-core to a source-friendly status.
 */
export function providerAuthToSourceStatus(
  detection: ProviderAuthDetection,
): SourceProviderAuthStatus {
  if (detection.mode === "provider-owned") {
    return {
      mode: detection.mode,
      configured: detection.configured,
      description: detection.configured
        ? `Provider auth configured (${detection.method ?? "unknown method"})`
        : detection.error ?? "Provider auth not configured",
    };
  }

  if (detection.mode === "managed") {
    return {
      mode: detection.mode,
      configured: detection.configured,
      description: detection.configured
        ? `Credentials available via env vars (${detection.method ?? "unknown method"})`
        : detection.error ?? "No credentials found in env vars",
    };
  }

  return {
    mode: detection.mode,
    configured: true,
    description: "No auth required",
  };
}

// ============================================================
// Source-Level OAuth Host Injection Interface
// ============================================================

/**
 * Interface that the host application must implement for source OAuth flows.
 *
 * Weft does NOT own browser callback servers or PKCE flows.
 * The host app (Electron, web UI, CLI) provides the actual OAuth implementation
 * and passes credentials back through this interface.
 *
 * This replaces the previous stub OAuth classes (GoogleOAuth, SlackOAuth,
 * MicrosoftOAuth, GenericOAuth) with a single injection point.
 */
export interface SourceOAuthProvider {
  /**
   * Authenticate a source via its provider-specific OAuth flow.
   * The host app opens a browser, handles the callback, and returns tokens.
   */
  authenticate(
    sourceSlug: string,
    provider: "google" | "slack" | "microsoft" | "generic" | "mcp",
    options: SourceOAuthOptions,
  ): Promise<SourceAuthResult>;

  /**
   * Refresh an expired OAuth token for a source.
   */
  refresh(
    sourceSlug: string,
    provider: "google" | "slack" | "microsoft" | "generic" | "mcp",
    refreshToken: string,
  ): Promise<SourceAuthResult>;
}

/**
 * Options for source OAuth authentication.
 * Generalized across all provider types — the host app interprets
 * provider-specific fields as needed.
 */
export interface SourceOAuthOptions {
  /** Service identifier (e.g. "google-drive", "slack-workspace") */
  service?: string;
  /** OAuth scopes to request */
  scopes?: string[];
  /** App type context (e.g. "desktop", "web", "cli") */
  appType?: string;
  /** Callback port (host app decides actual port) */
  callbackPort?: number;
  /** Callback URL override */
  callbackUrl?: string;
  /** OAuth client ID (host app may have its own) */
  clientId?: string;
  /** OAuth client secret (host app may have its own) */
  clientSecret?: string;
  /** Session context for tracking */
  sessionContext?: OAuthSessionContext;
}

/**
 * No-op SourceOAuthProvider that throws on all operations.
 * Used when no host app OAuth implementation is injected.
 */
export class StubSourceOAuthProvider implements SourceOAuthProvider {
  async authenticate(): Promise<SourceAuthResult> {
    return {
      success: false,
      error: "Source OAuth not available — no host OAuthProvider injected. " +
        "The host application must provide a SourceOAuthProvider implementation.",
    };
  }

  async refresh(): Promise<SourceAuthResult> {
    return {
      success: false,
      error: "Source OAuth refresh not available — no host OAuthProvider injected.",
    };
  }
}
