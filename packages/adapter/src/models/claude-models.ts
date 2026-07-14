/**
 * Claude model discovery — reads `~/.claude/settings.json` (+`settings.local.json`)
 * `env` block + probes the compatible gateway's `/v1/models`.
 *
 * **The key gotcha** (see chat-playground commit 85f1274): the host process
 * (Electron main / any Node SDK consumer launched outside the claude CLI)
 * does NOT inherit `~/.claude/settings.json`'s `env` block — the claude CLI
 * applies that block only to its own children. So reading `process.env` alone
 * returns nothing for a compatible gateway configured via settings.json. This
 * module reads the settings.json env block itself and merges it under
 * `process.env` (process.env wins).
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { normalizeReasoningEffort } from '@weft/runtime-core'
import type { ProviderModelDiscovery } from '@weft/runtime-core'
import { fetchModels, uniqueModels, type ModelProbeFetcher } from './shared.ts'

/** Read the `env` block from ~/.claude/settings.json (+ settings.local.json). */
export function loadClaudeSettingsEnv(
  configDir?: string,
): Record<string, string> {
  const dir = configDir || process.env['CLAUDE_CONFIG_DIR'] || join(homedir(), '.claude')
  const merged: Record<string, string> = {}
  for (const name of ['settings.json', 'settings.local.json']) {
    try {
      const raw = readFileSync(join(dir, name), 'utf-8')
      const env = (JSON.parse(raw) as { env?: Record<string, string> }).env
      if (env && typeof env === 'object') Object.assign(merged, env)
    } catch {
      // missing or invalid file → skip
    }
  }
  return merged
}

/** Resolve a claude config value: resolved env wins, then ~/.claude settings env.
 * When {@link resolvedEnv} is explicitly passed (testing / sandboxed launch) it
 * fully replaces process.env — no fall-through to the host process env. Mirrors
 * `readClaudeAuth`'s `env ?? createSanitizedClaudeEnvironment()` semantics so a
 * caller-provided env is authoritative. */
function claudeEnv(key: string, settingsEnv: Record<string, string>, resolvedEnv: Record<string, string | undefined>): string | undefined {
  return resolvedEnv[key] || settingsEnv[key] || undefined
}

export interface ClaudeModelDiscoveryOptions {
  /** Override process.env (testing / sandboxed launch). */
  env?: Record<string, string | undefined>
  /** Override ~/.claude location (testing). */
  configDir?: string
  /** Skip the network probe, only read config (offline). */
  offline?: boolean
  signal?: AbortSignal
  /** Inject fetch (tests). */
  fetchImpl?: ModelProbeFetcher
}

/**
 * Discover the real model list for a Claude (Anthropic-compatible) endpoint.
 *
 * Tries `GET {base}/v1/models` first; on failure falls back to the env-derived
 * model list (`ANTHROPIC_MODEL` + the `ANTHROPIC_DEFAULT_{SONNET,OPUS,HAIKU,FABLE}_MODEL`
 * aliases). `defaultModel` = `ANTHROPIC_MODEL`; `defaultEffort` =
 * `CLAUDE_CODE_EFFORT_LEVEL` (or `CLAUDE_EFFORT`). For official Anthropic auth
 * (no `ANTHROPIC_BASE_URL`), defaults to the real `api.anthropic.com` so an
 * `ANTHROPIC_API_KEY` user still gets the live `/v1/models` catalog. Pure
 * claude-CLI oauth exposes no key we can use → falls through to `source:'none'`.
 */
export async function discoverClaudeModels(
  options: ClaudeModelDiscoveryOptions = {},
): Promise<ProviderModelDiscovery> {
  const settingsEnv = loadClaudeSettingsEnv(options.configDir)
  // An explicit env fully replaces process.env (no fall-through) so a sandboxed
  // launch / test is authoritative. process.env is the default only when no env
  // is passed — matching readClaudeAuth's `env ?? sanitized` pattern.
  const env = options.env ?? process.env as Record<string, string | undefined>
  const base = (claudeEnv('ANTHROPIC_BASE_URL', settingsEnv, env)?.replace(/\/+$/, '') || 'https://api.anthropic.com')
  const token = claudeEnv('ANTHROPIC_AUTH_TOKEN', settingsEnv, env) || claudeEnv('ANTHROPIC_API_KEY', settingsEnv, env)
  const defaultModel = claudeEnv('ANTHROPIC_MODEL', settingsEnv, env)
  const defaultEffort = normalizeReasoningEffort(
    claudeEnv('CLAUDE_CODE_EFFORT_LEVEL', settingsEnv, env)
    || claudeEnv('CLAUDE_EFFORT', settingsEnv, env),
  )

  if (token && !options.offline) {
    const ids = await fetchModels({
      base,
      token,
      protocol: 'anthropic-messages',
      signal: options.signal,
      fetchImpl: options.fetchImpl,
    })
    if (ids?.length) {
      return { models: ids, source: 'gateway', defaultModel, defaultEffort, baseUrl: base }
    }
  }

  const envModels = uniqueModels([
    defaultModel,
    claudeEnv('ANTHROPIC_DEFAULT_SONNET_MODEL', settingsEnv, env),
    claudeEnv('ANTHROPIC_DEFAULT_OPUS_MODEL', settingsEnv, env),
    claudeEnv('ANTHROPIC_DEFAULT_HAIKU_MODEL', settingsEnv, env),
    claudeEnv('ANTHROPIC_DEFAULT_FABLE_MODEL', settingsEnv, env),
  ])
  return {
    models: envModels,
    // Static fallback read from local config (settings.json env block + process.env),
    // not a live probe → 'config' (see ProviderModelSource). Same label codex and the
    // server use for their static fallbacks, so the picker treats them uniformly.
    source: envModels.length ? 'config' : 'none',
    defaultModel,
    defaultEffort,
    baseUrl: base,
  }
}

/**
 * Just the active default model + effort (no `/v1/models` round-trip).
 * For populating a picker default before the gateway probe completes.
 */
export function readClaudeModelDefaults(
  options: { env?: Record<string, string | undefined>; configDir?: string } = {},
): { model?: string; reasoningEffort?: string } {
  const settingsEnv = loadClaudeSettingsEnv(options.configDir)
  const env = options.env ?? process.env as Record<string, string | undefined>
  return {
    model: claudeEnv('ANTHROPIC_MODEL', settingsEnv, env),
    reasoningEffort: normalizeReasoningEffort(
      claudeEnv('CLAUDE_CODE_EFFORT_LEVEL', settingsEnv, env)
      || claudeEnv('CLAUDE_EFFORT', settingsEnv, env),
    ),
  }
}

