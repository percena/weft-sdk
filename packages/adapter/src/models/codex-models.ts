/**
 * Codex model discovery — reads `~/.codex/config.toml` + `~/.codex/auth.json`
 * and probes the OpenAI-compatible gateway's `/v1/models`.
 *
 * Codex uses an OpenAI-compatible endpoint (`config.toml [model_providers.X]
 * base_url` + `env_key`); discovery is the same shape as Claude's: GET
 * `{base}/models` (or `{base}/v1/models` when the base lacks the `/v1`
 * suffix). The configured `model` / `model_reasoning_effort` are surfaced as
 * the active defaults so the picker matches the user's in-use config.
 *
 * TOML is parsed with a flat regex + line-scan (no TOML dep — matches the
 * lean-package ethos). Codex's config shape is flat enough that this is
 * reliable; a full TOML lib would regress the published bundle size.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { normalizeReasoningEffort } from '@weft/runtime-core'
import type { ProviderModelDiscovery } from '@weft/runtime-core'
import { fetchModels, mergeWithDefault, type ModelProbeFetcher } from './shared.ts'

/** Result of parsing the flat fields we care about from ~/.codex/config.toml. */
export interface ParsedCodexConfig {
  /** Active provider block name (`model_provider = "..."`). */
  activeProvider?: string
  /** `model = "..."`. */
  model?: string
  /** `model_reasoning_effort = "..."`. */
  effort?: string
  /** Resolved `[model_providers.X]` block: base_url + env_key. */
  baseUrl?: string
  envKey?: string
}

/**
 * Parse the flat fields codex needs from a config.toml string. Line-scans the
 * `[model_providers.<active>]` block (a regex with `$` in multiline mode would
 * match the header's own line-end and capture nothing, which is why we don't
 * use lookahead-with-$ here — see chat-playground commit 85f1274).
 */
export function parseCodexConfigToml(toml: string): ParsedCodexConfig {
  const providerMatch = toml.match(/^model_provider\s*=\s*"([^"]+)"/m)
  const activeProvider = providerMatch?.[1] ?? ''
  const modelMatch = toml.match(/^model\s*=\s*"([^"]+)"/m)
  const model = modelMatch?.[1] ?? ''
  const effortMatch = toml.match(/^model_reasoning_effort\s*=\s*"([^"]+)"/m)
  const effort = effortMatch?.[1] ?? ''

  let baseUrl: string | undefined
  let envKey: string | undefined
  if (activeProvider) {
    const lines = toml.split(/\r?\n/)
    const headerRe = new RegExp(
      `^\\[model_providers\\.${activeProvider.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]\\s*$`,
    )
    let inBlock = false
    const blockLines: string[] = []
    for (const line of lines) {
      if (inBlock) {
        if (/^\s*\[/.test(line)) break // next section header ends the block
        blockLines.push(line)
      } else if (headerRe.test(line)) {
        inBlock = true
      }
    }
    const block = blockLines.join('\n')
    const baseMatch = block.match(/^base_url\s*=\s*"([^"]+)"/m)
    baseUrl = baseMatch?.[1]?.replace(/\/+$/, '')
    const envKeyMatch = block.match(/^env_key\s*=\s*"([^"]+)"/m)
    envKey = envKeyMatch?.[1]
  }

  return { activeProvider: activeProvider || undefined, model, effort, baseUrl, envKey }
}

export interface CodexModelDiscoveryOptions {
  /** Override process.env (testing / sandboxed launch). */
  env?: Record<string, string | undefined>
  /** Override ~/.codex location (testing). */
  codexDir?: string
  /** Skip the network probe, only read config (offline). */
  offline?: boolean
  signal?: AbortSignal
  /** Inject fetch (tests). */
  fetchImpl?: ModelProbeFetcher
}

/**
 * Discover the real model list for a Codex (OpenAI-compatible) endpoint.
 *
 * Resolves the active `[model_providers.X]` block's `base_url` + `env_key`,
 * then the API key (`env_key` → `OPENAI_API_KEY` → `~/.codex/auth.json`
 * `OPENAI_API_KEY` where `codex login` stores it for the built-in provider).
 * No custom provider block means the built-in OpenAI provider — defaults to
 * the real `api.openai.com/v1` so an `OPENAI_API_KEY` user still gets the live
 * `/v1/models` catalog. Codex-CLI oauth login exposes no key → config fallback.
 */
export async function discoverCodexModels(
  options: CodexModelDiscoveryOptions = {},
): Promise<ProviderModelDiscovery> {
  const codexDir = options.codexDir || process.env['CODEX_HOME'] || join(homedir(), '.codex')
  const env = options.env ?? process.env

  let config: ParsedCodexConfig = {}
  try {
    const toml = readFileSync(join(codexDir, 'config.toml'), 'utf-8')
    config = parseCodexConfigToml(toml)
  } catch {
    // no config → no discovery beyond env
  }

  const defaultEffort = normalizeReasoningEffort(config.effort)

  // Resolve the API key: provider env_key first, then OPENAI_API_KEY env,
  // then ~/.codex/auth.json (where `codex login` stores it for the built-in
  // OpenAI provider).
  let token = ''
  if (config.envKey) token = env[config.envKey] || ''
  if (!token) token = env['OPENAI_API_KEY'] || ''
  if (!token) {
    try {
      const auth = JSON.parse(readFileSync(join(codexDir, 'auth.json'), 'utf-8')) as { OPENAI_API_KEY?: string }
      token = auth.OPENAI_API_KEY ?? ''
    } catch {
      // ignore — no auth file
    }
  }

  let base = config.baseUrl
  // No custom provider block (base empty) means the built-in OpenAI provider —
  // default to the real api.openai.com/v1 so an OPENAI_API_KEY user still gets
  // the live /v1/models catalog.
  if (!base && token) base = 'https://api.openai.com/v1'

  if (base && token && !options.offline) {
    const ids = await fetchModels({
      base,
      token,
      protocol: 'openai-chat',
      signal: options.signal,
      fetchImpl: options.fetchImpl,
    })
    if (ids?.length) {
      const merged = mergeWithDefault(config.model, ids)
      if (merged.length) {
        return { models: merged, source: 'gateway', defaultModel: config.model, defaultEffort, baseUrl: base }
      }
    }
  }

  return {
    models: config.model ? [config.model] : [],
    source: config.model ? 'config' : 'none',
    defaultModel: config.model,
    defaultEffort,
    baseUrl: base,
  }
}

/**
 * Just the active default model + effort (no `/v1/models` round-trip).
 * For populating a picker default before the gateway probe completes.
 */
export function readCodexModelDefaults(
  options: { codexDir?: string; env?: Record<string, string | undefined> } = {},
): { model?: string; reasoningEffort?: string } {
  const codexDir = options.codexDir || process.env['CODEX_HOME'] || join(homedir(), '.codex')
  let config: ParsedCodexConfig = {}
  try {
    const toml = readFileSync(join(codexDir, 'config.toml'), 'utf-8')
    config = parseCodexConfigToml(toml)
  } catch {
    // no config
  }
  return {
    model: config.model,
    reasoningEffort: normalizeReasoningEffort(config.effort),
  }
}
