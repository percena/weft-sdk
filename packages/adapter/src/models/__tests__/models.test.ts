import { describe, expect, it } from 'vitest'
import { normalizeReasoningEffort } from '@weft/runtime-core'
import { uniqueModels, mergeWithDefault, fetchModels } from '../shared.ts'
import { parseCodexConfigToml } from '../codex-models.ts'
import { loadClaudeSettingsEnv, discoverClaudeModels } from '../claude-models.ts'
import { discoverCodexModels } from '../codex-models.ts'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/** Build a fake fetch that maps URL → { ok, json payload }. */
function makeFetcher(routes: Record<string, { ok?: boolean; status?: number; json: unknown }>) {
  return async (url: string) => {
    const route = routes[url]
    if (!route) return { ok: false, status: 404, json: async () => ({}) }
    return { ok: route.ok ?? true, status: route.status ?? 200, json: async () => route.json }
  }
}

describe('normalizeReasoningEffort', () => {
  it('lowercases + trims known values', () => {
    expect(normalizeReasoningEffort('  High ')).toBe('high')
    expect(normalizeReasoningEffort('XHigh')).toBe('xhigh')
  })
  it('passes through unknown codex Custom values', () => {
    expect(normalizeReasoningEffort('custom-beta')).toBe('custom-beta')
  })
  it('returns undefined for empty / invalid', () => {
    expect(normalizeReasoningEffort(undefined)).toBeUndefined()
    expect(normalizeReasoningEffort('   ')).toBeUndefined()
    expect(normalizeReasoningEffort('bad value!')).toBeUndefined()
  })
  it('keeps Claude-specific max', () => {
    expect(normalizeReasoningEffort('max')).toBe('max')
  })
})

describe('uniqueModels / mergeWithDefault', () => {
  it('dedupes + drops empties', () => {
    expect(uniqueModels(['a', 'b', 'a', '', undefined, 'b'])).toEqual(['a', 'b'])
  })
  it('surfaces default first even if absent from list', () => {
    expect(mergeWithDefault('glm-5.2', ['deepseek-v4-flash', 'glm-5.2'])).toEqual(['glm-5.2', 'deepseek-v4-flash'])
    expect(mergeWithDefault(undefined, ['a', 'b'])).toEqual(['a', 'b'])
  })
})

describe('fetchModels', () => {
  it('probes both URL candidates and parses {data:[{id}]}', async () => {
    const fetchImpl = makeFetcher({
      'https://api.anthropic.com/v1/models': { json: { data: [{ id: 'claude-sonnet-4-6' }, { id: 'glm-5.2' }] } },
    })
    const ids = await fetchModels({ base: 'https://api.anthropic.com', token: 'sk-x', protocol: 'anthropic-messages', fetchImpl })
    expect(ids).toEqual(['claude-sonnet-4-6', 'glm-5.2'])
  })
  it('falls back to the other candidate when the first 404s', async () => {
    const fetchImpl = makeFetcher({
      'https://dashscope.aliyuncs.com/compatible-mode/v1/models': { ok: false, status: 404, json: {} },
      'https://dashscope.aliyuncs.com/compatible-mode/v1/v1/models': { json: { data: [{ id: 'qwen3-max' }] } },
    })
    const ids = await fetchModels({ base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', token: 'sk-x', protocol: 'openai-chat', fetchImpl })
    expect(ids).toEqual(['qwen3-max'])
  })
  it('returns undefined when no candidate serves models', async () => {
    const fetchImpl = makeFetcher({})
    const ids = await fetchModels({ base: 'https://x.test/v1', token: 'sk-x', fetchImpl })
    expect(ids).toBeUndefined()
  })
  it('returns undefined without a token', async () => {
    const ids = await fetchModels({ base: 'https://x.test', token: '', fetchImpl: makeFetcher({}) })
    expect(ids).toBeUndefined()
  })
})

describe('parseCodexConfigToml', () => {
  it('parses an active provider block with /v1 base_url', () => {
    const toml = `
model_provider = "dashscope"
model = "qwen3-max"
model_reasoning_effort = "high"

[model_providers.dashscope]
base_url = "https://dashscope.aliyuncs.com/compatible-mode/v1"
env_key = "DASHSCOPE_API_KEY"
`
    const parsed = parseCodexConfigToml(toml)
    expect(parsed).toEqual({
      activeProvider: 'dashscope',
      model: 'qwen3-max',
      effort: 'high',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      envKey: 'DASHSCOPE_API_KEY',
    })
  })
  it('parses a base_url without /v1 suffix', () => {
    const toml = `
model_provider = "acme"
model = "acme-1"

[model_providers.acme]
base_url = "https://api.acme.test"
env_key = "ACME_KEY"
`
    expect(parseCodexConfigToml(toml).baseUrl).toBe('https://api.acme.test')
  })
  it('stops the block at the next section header', () => {
    const toml = `
model_provider = "a"
[model_providers.a]
base_url = "https://a.test/v1"
env_key = "A_KEY"

[model_providers.b]
base_url = "https://b.test/v1"
`
    const parsed = parseCodexConfigToml(toml)
    expect(parsed.baseUrl).toBe('https://a.test/v1')
    expect(parsed.envKey).toBe('A_KEY')
  })
  it('handles a missing provider block (built-in OpenAI)', () => {
    const toml = `model = "gpt-4o"\nmodel_reasoning_effort = "medium"\n`
    const parsed = parseCodexConfigToml(toml)
    expect(parsed.model).toBe('gpt-4o')
    expect(parsed.effort).toBe('medium')
    expect(parsed.baseUrl).toBeUndefined()
    expect(parsed.envKey).toBeUndefined()
  })
})

function withTempClaudeHome(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'weft-claude-'))
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content)
  return dir
}

describe('loadClaudeSettingsEnv', () => {
  it('merges settings.json + settings.local.json env blocks', () => {
    const dir = withTempClaudeHome({
      'settings.json': JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://gw.test', ANTHROPIC_MODEL: 'glm-5.2' } }),
      'settings.local.json': JSON.stringify({ env: { ANTHROPIC_API_KEY: 'sk-local' } }),
    })
    const env = loadClaudeSettingsEnv(dir)
    expect(env.ANTHROPIC_BASE_URL).toBe('https://gw.test')
    expect(env.ANTHROPIC_MODEL).toBe('glm-5.2')
    expect(env.ANTHROPIC_API_KEY).toBe('sk-local')
  })
  it('skips missing/invalid files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'weft-claude-empty'))
    expect(loadClaudeSettingsEnv(dir)).toEqual({})
  })
})

describe('discoverClaudeModels', () => {
  it('probes the gateway and returns source gateway + defaults', async () => {
    const dir = withTempClaudeHome({
      'settings.json': JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: 'https://gw.test',
          ANTHROPIC_AUTH_TOKEN: 'sk-token',
          ANTHROPIC_MODEL: 'glm-5.2',
          CLAUDE_CODE_EFFORT_LEVEL: 'high',
        },
      }),
    })
    const fetchImpl = makeFetcher({
      'https://gw.test/v1/models': { json: { data: [{ id: 'glm-5.2' }, { id: 'deepseek-v4-flash' }] } },
    })
    const result = await discoverClaudeModels({ configDir: dir, env: {}, fetchImpl })
    expect(result.source).toBe('gateway')
    expect(result.models).toEqual(['glm-5.2', 'deepseek-v4-flash'])
    expect(result.defaultModel).toBe('glm-5.2')
    expect(result.defaultEffort).toBe('high')
    expect(result.baseUrl).toBe('https://gw.test')
  })
  it('falls back to config model aliases when gateway 404s', async () => {
    const dir = withTempClaudeHome({
      'settings.json': JSON.stringify({
        env: {
          ANTHROPIC_API_KEY: 'sk-token',
          ANTHROPIC_MODEL: 'glm-5.2',
          ANTHROPIC_DEFAULT_SONNET_MODEL: 'sonnet-x',
        },
      }),
    })
    const result = await discoverClaudeModels({ configDir: dir, env: {}, fetchImpl: makeFetcher({}) })
    expect(result.source).toBe('config')
    expect(result.models).toEqual(['glm-5.2', 'sonnet-x'])
  })
  it('returns source none when nothing is configured', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'weft-claude-none'))
    const result = await discoverClaudeModels({ configDir: dir, env: {}, fetchImpl: makeFetcher({}) })
    expect(result.source).toBe('none')
    expect(result.models).toEqual([])
  })
  it('defaults base to api.anthropic.com for official auth', async () => {
    const dir = withTempClaudeHome({
      'settings.json': JSON.stringify({ env: { ANTHROPIC_API_KEY: 'sk-anthropic' } }),
    })
    const fetchImpl = makeFetcher({
      'https://api.anthropic.com/v1/models': { json: { data: [{ id: 'claude-sonnet-4-6' }] } },
    })
    const result = await discoverClaudeModels({ configDir: dir, env: {}, fetchImpl })
    expect(result.baseUrl).toBe('https://api.anthropic.com')
    expect(result.models).toEqual(['claude-sonnet-4-6'])
  })
  it('offline mode skips the probe', async () => {
    const dir = withTempClaudeHome({
      'settings.json': JSON.stringify({ env: { ANTHROPIC_API_KEY: 'sk', ANTHROPIC_MODEL: 'glm-5.2' } }),
    })
    let called = false
    const result = await discoverClaudeModels({
      configDir: dir,
      env: {},
      offline: true,
      fetchImpl: async () => { called = true; return { ok: true, status: 200, json: async () => ({}) } },
    })
    expect(called).toBe(false)
    expect(result.source).toBe('config')
  })
})

describe('discoverCodexModels', () => {
  function withCodexHome(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), 'weft-codex-'))
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content)
    return dir
  }
  it('probes the gateway with base_url ending in /v1', async () => {
    const codexDir = withCodexHome({
      'config.toml': `model_provider = "dashscope"\nmodel = "qwen3-max"\nmodel_reasoning_effort = "high"\n\n[model_providers.dashscope]\nbase_url = "https://dashscope.aliyuncs.com/compatible-mode/v1"\nenv_key = "DASHSCOPE_API_KEY"\n`,
    })
    const fetchImpl = makeFetcher({
      'https://dashscope.aliyuncs.com/compatible-mode/v1/models': { json: { data: [{ id: 'qwen3-max' }, { id: 'qwen3-coder' }] } },
    })
    const result = await discoverCodexModels({ codexDir, env: { DASHSCOPE_API_KEY: 'sk-dash' }, fetchImpl })
    expect(result.source).toBe('gateway')
    expect(result.models).toEqual(['qwen3-max', 'qwen3-coder'])
    expect(result.defaultModel).toBe('qwen3-max')
    expect(result.defaultEffort).toBe('high')
  })
  it('merges the configured model even when the gateway does not list it', async () => {
    const codexDir = withCodexHome({
      'config.toml': `model_provider = "acme"\nmodel = "acme-custom"\n\n[model_providers.acme]\nbase_url = "https://api.acme.test/v1"\nenv_key = "ACME_KEY"\n`,
    })
    const fetchImpl = makeFetcher({
      'https://api.acme.test/v1/models': { json: { data: [{ id: 'acme-1' }] } },
    })
    const result = await discoverCodexModels({ codexDir, env: { ACME_KEY: 'sk' }, fetchImpl })
    expect(result.models).toEqual(['acme-custom', 'acme-1'])
  })
  it('falls back to config when no token is resolvable', async () => {
    const codexDir = withCodexHome({
      'config.toml': `model = "gpt-4o"\nmodel_reasoning_effort = "medium"\n`,
    })
    const result = await discoverCodexModels({ codexDir, env: {}, fetchImpl: makeFetcher({}) })
    expect(result.source).toBe('config')
    expect(result.models).toEqual(['gpt-4o'])
    expect(result.defaultEffort).toBe('medium')
  })
  it('reads auth.json for the built-in OpenAI provider', async () => {
    const codexDir = withCodexHome({
      'config.toml': `model = "gpt-4o"\n`,
      'auth.json': JSON.stringify({ OPENAI_API_KEY: 'sk-openai' }),
    })
    const fetchImpl = makeFetcher({
      'https://api.openai.com/v1/models': { json: { data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }] } },
    })
    const result = await discoverCodexModels({ codexDir, env: {}, fetchImpl })
    expect(result.source).toBe('gateway')
    expect(result.baseUrl).toBe('https://api.openai.com/v1')
  })
  it('returns source none with no config', async () => {
    const codexDir = mkdtempSync(join(tmpdir(), 'weft-codex-empty'))
    const result = await discoverCodexModels({ codexDir, env: {}, fetchImpl: makeFetcher({}) })
    expect(result.source).toBe('none')
  })
  it('never sends built-in OpenAI credentials to a custom gateway', async () => {
    // A custom provider block whose env_key is unset (the default when the app
    // is launched from the GUI) must NOT fall back to OPENAI_API_KEY /
    // auth.json — that would disclose the user's OpenAI key to a third-party
    // base_url. No token → no probe → config fallback.
    const codexDir = withCodexHome({
      'config.toml': `model_provider = "dashscope"\nmodel = "qwen3-max"\n\n[model_providers.dashscope]\nbase_url = "https://dashscope.aliyuncs.com/compatible-mode/v1"\nenv_key = "DASHSCOPE_API_KEY"\n`,
      'auth.json': JSON.stringify({ OPENAI_API_KEY: 'sk-openai-secret' }),
    })
    const probedUrls: string[] = []
    const fetchImpl = async (url: string) => {
      probedUrls.push(url)
      return { ok: true, status: 200, json: async () => ({ data: [{ id: 'qwen3-max' }] }) }
    }
    const result = await discoverCodexModels({
      codexDir,
      env: { OPENAI_API_KEY: 'sk-openai-secret' },
      fetchImpl,
    })
    expect(probedUrls).toEqual([])
    expect(result.source).toBe('config')
    expect(result.models).toEqual(['qwen3-max'])
  })

  describe('built-in OpenAI endpoint classification (credential routing)', () => {
    // The OPENAI_API_KEY / auth.json fallback may flow ONLY to the genuine
    // https://api.openai.com host. Classification parses the URL (never
    // prefix/substring matching), so lookalike hosts, userinfo tricks,
    // path/query embedding, and scheme downgrades all fail closed to
    // "custom gateway" — with no env_key on the provider block that means no
    // token, hence no request carrying credentials at all.
    async function discoverWithBase(base: string) {
      const codexDir = withCodexHome({
        // Custom provider block with NO env_key (the GUI-launch default):
        // the only credential candidates are the built-in OpenAI fallbacks.
        'config.toml': `model_provider = "custom"\nmodel = "gpt-4o"\n\n[model_providers.custom]\nbase_url = "${base}"\n`,
        'auth.json': JSON.stringify({ OPENAI_API_KEY: 'sk-openai-secret' }),
      })
      const probedUrls: string[] = []
      const fetchImpl = async (url: string) => {
        probedUrls.push(url)
        return { ok: true, status: 200, json: async () => ({ data: [{ id: 'gpt-4o' }] }) }
      }
      const result = await discoverCodexModels({
        codexDir,
        env: { OPENAI_API_KEY: 'sk-openai-secret' },
        fetchImpl,
      })
      return { result, probedUrls }
    }

    it.each([
      ['lookalike subdomain host', 'https://api.openai.com.evil.com/v1'],
      ['lookalike host with explicit port', 'https://api.openai.com.evil.com:443/v1'],
      ['userinfo trick (api.openai.com as username)', 'https://api.openai.com@evil.com/v1'],
      ['userinfo trick with credentials', 'https://api.openai.com:pass@evil.com/v1'],
      ['host embedded in the path', 'https://evil.com/api.openai.com'],
      ['host embedded in the query', 'https://evil.com/?u=api.openai.com'],
      ['plain-http scheme downgrade', 'http://api.openai.com/v1'],
      ['non-http scheme', 'ftp://api.openai.com/v1'],
      ['unparseable base', 'not a url'],
    ])('does NOT route credentials to %s (%s)', async (_label, base) => {
      const { result, probedUrls } = await discoverWithBase(base)
      // Fail closed: no token resolved for a non-built-in base → zero
      // outbound requests, so the credential cannot leak in any header.
      expect(probedUrls).toEqual([])
      expect(result.source).toBe('config')
    })

    it.each([
      ['exact built-in base', 'https://api.openai.com/v1'],
      ['built-in base with a different path', 'https://api.openai.com/beta/v1'],
      ['built-in base with explicit default port', 'https://api.openai.com:443/v1'],
      // A non-default port still targets the GENUINE host (TLS certificate
      // must match api.openai.com), so host authenticity — the property that
      // gates the credential — holds.
      ['built-in base with a non-default port', 'https://api.openai.com:8443/v1'],
      ['uppercase spelling (URL-normalized)', 'HTTPS://API.OPENAI.COM/v1'],
    ])('routes credentials to the genuine host for %s (%s)', async (_label, base) => {
      const { result, probedUrls } = await discoverWithBase(base)
      expect(probedUrls.length).toBeGreaterThan(0)
      for (const url of probedUrls) {
        expect(new URL(url).hostname).toBe('api.openai.com')
      }
      expect(result.source).toBe('gateway')
    })
  })
})
