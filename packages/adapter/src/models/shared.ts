/**
 * Shared model-discovery helpers — the gateway `/v1/models` probe + dedupe.
 *
 * Provider-owned config discovery, sibling to `@weft/adapter/auth`. Reads the
 * same local files (`~/.claude/settings.json`, `~/.codex/config.toml`) as the
 * auth probes, but for model-list + active-default resolution rather than
 * auth-state. Like auth, it **detects** provider config — it never manages
 * credentials.
 *
 * This is the local (Node) probe. The Weft server re-implements the same
 * `/v1/models` probe server-side (it holds the tenant's sealed credential);
 * both produce the shared `ProviderModelDiscovery` wire contract
 * (`@weft/runtime-core`), which is the merge point — so the picker UI is
 * identical whether the list came from this local probe or the server.
 */
import type {
  ListProviderModelsOptions,
  ProviderModelDiscovery,
} from '@weft/runtime-core'

export type { ListProviderModelsOptions, ProviderModelDiscovery }

/** Dedupe a string list, dropping empties. */
export function uniqueModels(values: (string | undefined | null)[]): string[] {
  return [...new Set(values.filter((v): v is string => !!v && typeof v === 'string'))]
}

/** Minimal Response-like type the probe needs; injectable for tests. */
export interface ModelProbeFetcher {
  (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }): Promise<{
    ok: boolean
    status: number
    json(): Promise<unknown>
  }>
}

/** Anthropic-native (`{data:[{id}]}`) OR OpenAI (`{data:[{id}]}`) — both work. */
interface ModelsEndpointResponse {
  data?: Array<{ id?: string }>
}

/**
 * Probe `{base}/models` / `{base}/v1/models` (both candidates; ordered by
 * whether `base` ends in `/v1`) and return the deduped model ids, or
 * `undefined` when the endpoint is unreachable / doesn't implement the models
 * endpoint (e.g. DashScope 404s) so the caller falls back to config/env.
 *
 * Auth: `x-api-key` + `Authorization: Bearer` are both set when present so the
 * probe works against Anthropic-native (x-api-key) and OpenAI-compatible
 * (Bearer) gateways alike; `anthropic-version` is set for the anthropic
 * protocol.
 */
export async function fetchModels(args: {
  base: string
  token: string
  protocol?: 'anthropic-messages' | 'openai-chat' | 'openai-responses'
  signal?: AbortSignal
  fetchImpl?: ModelProbeFetcher
}): Promise<string[] | undefined> {
  const base = args.base.replace(/\/+$/, '')
  if (!base || !args.token) return undefined
  const fetchImpl = args.fetchImpl ?? (globalThis.fetch as unknown as ModelProbeFetcher)
  if (!fetchImpl) return undefined

  const headers: Record<string, string> = {
    authorization: `Bearer ${args.token}`,
  }
  if (args.protocol === 'anthropic-messages') {
    headers['x-api-key'] = args.token
    headers['anthropic-version'] = '2023-06-01'
  }

  // OpenAI-compatible base conventionally ends in /v1 (so the models endpoint
  // is {base}/models); some gateways omit /v1 (then {base}/v1/models). Try the
  // likely one first, fall back to the other — mirrors the chat-playground demo.
  const candidates = base.toLowerCase().endsWith('/v1')
    ? [`${base}/models`, `${base}/v1/models`]
    : [`${base}/v1/models`, `${base}/models`]

  for (const url of candidates) {
    try {
      const res = await fetchImpl(url, { headers, signal: args.signal })
      if (!res.ok) continue
      const json = (await res.json()) as ModelsEndpointResponse
      const ids = uniqueModels((json.data ?? []).map(m => m.id))
      if (ids.length) return ids
    } catch {
      // endpoint doesn't implement /v1/models or network error → try next
    }
  }
  return undefined
}

/**
 * Merge a discovered gateway list with a stored/active default, surfacing the
 * default first so the picker can default to the user's in-use model even when
 * the gateway doesn't list it (some gateways alias it).
 */
export function mergeWithDefault(defaultModel: string | undefined, discovered: string[]): string[] {
  return uniqueModels([...(defaultModel ? [defaultModel] : []), ...discovered])
}
