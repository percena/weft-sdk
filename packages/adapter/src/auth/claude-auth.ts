/**
 * Claude Code Auth Detection
 *
 * Claude Code auth is 100% provider-owned.
 * Weft calls `claude auth status --json` to detect auth state
 * and preserves the native environment at runtime — never injecting
 * ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or CLAUDE_CODE_OAUTH_TOKEN.
 *
 * If auth is missing, fail fast with a clear error message directing
 * the user to run `claude` and complete login.
 */

import type { ProviderAuthDetection } from "@weft/runtime-core";
import { execFile } from "node:child_process";

// ============================================================
// Environment Sanitization
// ============================================================

/**
 * Keys that must be stripped from the environment passed to Claude SDK.
 * These are nested agent environment variables that would interfere with
 * Claude Code's native auth precedence.
 */
const NESTED_AGENT_ENV_PREFIXES = [
  "CLAUDECODE",
  "CODEX_HOME",
  // All CODEX_* prefix keys
  "CODEX_",
  "CLAUDE_CODE_ENTRYPOINT",
];

/**
 * Check whether an env var key belongs to a nested agent namespace
 * that must be stripped from the Claude SDK environment.
 */
function shouldStripNestedAgentEnv(key: string): boolean {
  return NESTED_AGENT_ENV_PREFIXES.some(
    (prefix) => key === prefix || key.startsWith(`${prefix}_`) || key.startsWith(prefix),
  );
}

/**
 * Client app identifier sent to Claude Agent SDK so Claude Code
 * can identify the calling application.
 */
const CLAUDE_AGENT_SDK_CLIENT_APP = "weft/agent-bridge";

/**
 * Create a sanitized environment for Claude SDK subprocess.
 *
 * Preserves all host env vars EXCEPT nested agent namespaces
 * (CODEX_*, CLAUDECODE, etc.), then adds the client app identifier.
 * Claude Code's native auth precedence (OAuth token → API key helper
 → ANTHROPIC_AUTH_TOKEN → ANTHROPIC_API_KEY) remains intact.
 */
export function createSanitizedClaudeEnvironment(
  source: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && !shouldStripNestedAgentEnv(key)) {
      env[key] = value;
    }
  }
  env.CLAUDE_AGENT_SDK_CLIENT_APP = CLAUDE_AGENT_SDK_CLIENT_APP;
  return env;
}

// ============================================================
// Auth Detection
// ============================================================

/**
 * Resolve `claude` executable path.
 * Checks WEFT_CLAUDE_EXECUTABLE env var first, then PATH.
 */
function resolveClaudeExecutable(env: Record<string, string>): string | undefined {
  return env.WEFT_CLAUDE_EXECUTABLE || undefined;
}

/**
 * Auth status shape returned by `claude auth status --json`.
 * Only the fields we need for detection.
 */
interface ClaudeAuthStatus {
  loggedIn?: boolean;
  authMethod?: string;
  apiProvider?: string;
  account?: { email?: string; type?: string };
}

/**
 * Detect Claude Code auth status by running `claude auth status --json`.
 *
 * This is a provider-owned detection: Weft never manages Claude
 * credentials. If auth is not configured, returns a clear error message
 * directing the user to run `claude` and complete login.
 *
 * Uses a sanitized environment (strips nested agent vars) so Claude Code
 * reads its own native auth state from CLAUDE_CONFIG_DIR.
 */
export async function readClaudeAuth(
  executable?: string,
  env?: Record<string, string>,
): Promise<ProviderAuthDetection> {
  const resolvedEnv = env ?? createSanitizedClaudeEnvironment();
  const claudeBin = executable ?? resolveClaudeExecutable(resolvedEnv) ?? "claude";

  try {
    // Spawn `claude auth status --json` with sanitized environment
    const { stdout, exitCode } = await new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
      execFile(claudeBin, ["auth", "status", "--json"], { env: resolvedEnv }, (error, stdout, stderr) => {
        resolve({
          stdout: stdout?.toString() ?? '',
          stderr: stderr?.toString() ?? '',
          exitCode: error ? (error as any).code ?? 1 : 0,
        });
      });
    });

    if (exitCode !== 0) {
      return {
        mode: "provider-owned",
        configured: false,
        source: `${claudeBin} auth status --json`,
        error: `Claude Code CLI returned exit code ${exitCode}. ` +
          "Ensure `claude` is on PATH or set WEFT_CLAUDE_EXECUTABLE.",
      };
    }

    const status: ClaudeAuthStatus = JSON.parse(stdout);
    return {
      mode: "provider-owned",
      configured: status.loggedIn === true,
      source: `${claudeBin} auth status --json`,
      method: status.authMethod,
      provider: status.apiProvider,
      accountPresent: Boolean(status.account),
    };
  } catch (err) {
    return {
      mode: "provider-owned",
      configured: false,
      source: `${claudeBin} auth status --json`,
      error: `Claude Code auth detection failed: ${(err as Error).message}. ` +
        "Run `claude` and complete login, or set CLAUDE_CONFIG_DIR.",
    };
  }
}

/**
 * Build a user-facing error message when Claude Code auth is missing.
 */
export function claudeAuthMissingMessage(): string {
  return "Claude Code authentication is not configured. " +
    "Run `claude` and complete login, or set CLAUDE_CONFIG_DIR.";
}