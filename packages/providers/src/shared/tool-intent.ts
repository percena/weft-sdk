/**
 * Shared tool-intent helpers used by the claude and codex provider drivers.
 *
 * The two drivers share the `Bash` and `MCP` intent shapes verbatim; the
 * provider-specific file-edit / API intents (claude `Write`/`Edit`/`API`,
 * codex `fileChange`) stay in each driver because their input field names
 * differ.
 *
 * `normalizeBaseRuntimeToolIntent` handles the common Bash + MCP cases and
 * falls back to `{ kind: 'unknown', toolName }`.  Each driver calls it after
 * its own provider-specific branches so the shared logic is written once.
 */

import type { RuntimeToolIntent } from '@weft/runtime-core'

/** Bash intent: the full command plus its first token as `baseCommand`. */
export function bashToolIntent(command: string): RuntimeToolIntent {
  return {
    kind: 'bash',
    command,
    baseCommand: command.trim().split(/\s+/)[0] ?? '',
  }
}

/** MCP intent: tool name resolved from the common input field names. */
export function mcpToolIntent(input: Record<string, unknown>, fallbackName: string): RuntimeToolIntent {
  return {
    kind: 'mcp',
    name: String(input.name ?? input.toolName ?? input.tool ?? fallbackName),
  }
}

/**
 * Base normalizer for the tool-intent cases shared across all providers:
 * Bash commands, MCP tool calls (including `mcp__`-prefixed names), and an
 * `unknown` fallback for anything the caller didn't handle itself.
 */
export function normalizeBaseRuntimeToolIntent(
  toolName: string,
  input: Record<string, unknown>,
): RuntimeToolIntent {
  if (toolName === 'Bash') {
    return bashToolIntent(String(input.command ?? ''))
  }

  if (toolName === 'MCP' || toolName.startsWith('mcp__')) {
    return mcpToolIntent(input, toolName)
  }

  return { kind: 'unknown', toolName }
}
