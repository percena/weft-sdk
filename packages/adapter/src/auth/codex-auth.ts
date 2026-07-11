/**
 * Codex Auth Detection
 *
 * Codex auth is 100% provider-owned.
 * Weft starts `codex app-server` as a subprocess, performs
 * JSON-RPC handshake, and calls `account/read` to detect auth.
 * Never injects OPENAI_API_KEY or OPENAI_BASE_URL.
 *
 * If auth is missing, fail fast with a clear error directing
 * the user to run `codex login`.
 */

import type { ProviderAuthDetection } from "@weft/runtime-core";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

// ============================================================
// JSON-RPC Helpers
// ============================================================

/** Default timeout for Codex JSON-RPC requests (ms) */
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

let nextRpcId = 1;

function makeRequest(method: string, params?: Record<string, unknown>): JsonRpcRequest {
  return { jsonrpc: "2.0", id: nextRpcId++, method, params };
}

// ============================================================
// Auth Detection
// ============================================================

/**
 * Resolve `codex` executable path.
 * Checks WEFT_CODEX_EXECUTABLE env var first, then PATH.
 */
function resolveCodexExecutable(env: Record<string, string>): string | undefined {
  return env.WEFT_CODEX_EXECUTABLE || undefined;
}

/**
 * Result shape from `codex app-server` `account/read` RPC call.
 */
interface CodexAccountReadResult {
  requiresOpenaiAuth?: boolean;
  account?: { id?: string; email?: string; name?: string };
}

/**
 * Extract ProviderAuthDetection from the `account/read` result.
 */
export function codexAuthFromResult(
  result: CodexAccountReadResult,
  source: string,
): ProviderAuthDetection {
  const requiresOpenaiAuth = result.requiresOpenaiAuth === true;
  const accountPresent = Boolean(result.account);
  const configured = !requiresOpenaiAuth || accountPresent;

  return {
    mode: "provider-owned",
    configured,
    source,
    accountPresent,
    requiresOpenaiAuth,
    error: configured
      ? undefined
      : codexAuthMissingMessage(),
  };
}

/**
 * Detect Codex auth by spawning `codex app-server` and performing
 * JSON-RPC handshake (initialize → initialized → account/read).
 *
 * Provider-owned: Weft never injects OpenAI credentials.
 * The `codex` binary reads auth from CODEX_HOME (~/.codex).
 */
export async function readCodexAuth(
  executable?: string,
  env?: Record<string, string>,
  requestTimeoutMs?: number,
): Promise<ProviderAuthDetection> {
  const resolvedEnv = env ?? Object.fromEntries(
    Object.entries(process.env).filter(([, v]) => v !== undefined),
  ) as Record<string, string>;
  const codexBin = executable ?? resolveCodexExecutable(resolvedEnv) ?? "codex";
  const timeout = requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const source = `${codexBin} app-server account/read`;

  let proc: ChildProcess | null = null;

  try {
    proc = spawn(codexBin, ["app-server"], {
      env: resolvedEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    return {
      mode: "provider-owned",
      configured: false,
      source,
      error: `Codex auth detection failed: ${(err as Error).message}. ` +
        "Ensure `codex` is on PATH or set WEFT_CODEX_EXECUTABLE.",
    };
  }

  // Handle async spawn errors (e.g. ENOENT for missing binary)
  const spawnError = new Promise<never>((_, reject) => {
    proc!.on('error', (err: Error) => {
      reject(new Error(`Codex auth detection failed: ${err.message}. ` +
        "Ensure `codex` is on PATH or set WEFT_CODEX_EXECUTABLE."));
    });
  });

  try {
    const rl = createInterface({ input: proc.stdout!, crlfDelay: Infinity });

    // Helper: write JSON-RPC message to stdin
    const writeMsg = (msg: JsonRpcRequest | { jsonrpc: "2.0"; method: string; params?: Record<string, unknown> }) => {
      proc!.stdin!.write(`${JSON.stringify(msg)}\n`);
    };

    // Helper: read stdout until we get a JSON-RPC response line
    const readResponse = (): Promise<JsonRpcResponse> => {
      const linePromise = new Promise<JsonRpcResponse>((resolve, reject) => {
        const deadline = Date.now() + timeout;
        const timer = setTimeout(() => {
          reject(new Error(`Timeout waiting for Codex app-server response (${timeout}ms)`));
        }, Math.max(0, deadline - Date.now()));

        rl.once('line', (line: string) => {
          clearTimeout(timer);
          const trimmed = line.trim();
          if (trimmed) {
            try {
              resolve(JSON.parse(trimmed) as JsonRpcResponse);
            } catch {
              reject(new Error(`Invalid JSON-RPC response: ${trimmed}`));
            }
          }
        });
      });
      return Promise.race([linePromise, spawnError]);
    };

    // Step 1: initialize (no protocolVersion — app-server handshake uses only
    // clientInfo + capabilities; the binary is the protocol source of truth).
    writeMsg(makeRequest("initialize", {
      capabilities: {},
      clientInfo: { name: "weft", title: "Weft", version: "0.1.0" },
    }));
    const initResp = await readResponse();

    if (initResp.error) {
      rl.close();
      proc.kill();
      return {
        mode: "provider-owned",
        configured: false,
        source,
        error: `Codex initialize failed: ${initResp.error.message}`,
      };
    }

    // Step 2: initialized notification (no response expected)
    writeMsg({ jsonrpc: "2.0", method: "initialized", params: {} });

    // Brief delay for server to process notification
    await new Promise(resolve => setTimeout(resolve, 50));

    // Step 3: account/read
    writeMsg(makeRequest("account/read", { refreshToken: false }));
    const accountResp = await readResponse();

    // Cleanup: kill the app-server subprocess
    rl.close();
    proc.kill();

    if (accountResp.error) {
      return {
        mode: "provider-owned",
        configured: false,
        source,
        error: `Codex account/read failed: ${accountResp.error.message}`,
      };
    }

    return codexAuthFromResult(
      accountResp.result as CodexAccountReadResult,
      source,
    );
  } catch (err) {
    // Always kill subprocess on any error to prevent leaks
    try { proc.kill(); } catch { /* already exited */ }
    return {
      mode: "provider-owned",
      configured: false,
      source,
      error: `Codex auth detection failed: ${(err as Error).message}. ` +
        "Ensure `codex` is on PATH or set WEFT_CODEX_EXECUTABLE.",
    };
  }
}

/**
 * Build a user-facing error message when Codex auth is missing.
 */
export function codexAuthMissingMessage(): string {
  return "Codex authentication is not configured. " +
    "Run `codex login` or set CODEX_HOME to a directory with valid auth.";
}

/**
 * Assert that Codex auth is configured, throwing if not.
 * Used at backend init to fail fast when auth is missing.
 */
export function assertCodexAuthConfigured(auth: ProviderAuthDetection): void {
  if (!auth.configured) {
    throw new Error(auth.error ?? codexAuthMissingMessage());
  }
}
