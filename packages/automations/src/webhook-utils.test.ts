/**
 * Tests for webhook SSRF hardening.
 *
 * Automation webhooks are attacker-influenceable via config, so outbound
 * requests must never reach private, loopback, or link-local targets —
 * most importantly the cloud metadata endpoint (169.254.169.254).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { executeWebhookRequest, isPrivateWebhookTarget, redactUrl } from './webhook-utils.ts'
import { fetchWithSsrfGuard, SsrfBlockedError } from '@weft/core'
import type { WebhookAction } from './types.ts'

const BLOCKED_HOSTS = [
  'localhost',
  'foo.localhost',
  'printer.local',
  '127.0.0.1',
  '127.8.8.8',
  '0.0.0.0',
  '10.0.0.1',
  '172.16.0.1',
  '172.31.255.255',
  '192.168.1.1',
  '169.254.169.254', // cloud metadata endpoint
  '[::1]',
  '[::]',
  '[fe80::1]',
  '[::ffff:127.0.0.1]',
  '[::ffff:7f00:1]', // IPv4-mapped loopback, hex form (WHATWG serialization)
  '[::ffff:169.254.169.254]',
  '[::ffff:a9fe:a9fe]', // IPv4-mapped metadata endpoint, hex form
]

const ALLOWED_HOSTS = [
  'example.com',
  'hooks.slack.com',
  'api.github.com',
  '8.8.8.8',
  '172.32.0.1', // just outside 172.16/12
  '[2606:4700::6810:84e5]', // public IPv6
]

describe('isPrivateWebhookTarget', () => {
  it('blocks private, loopback, link-local, and localhost targets', () => {
    for (const host of BLOCKED_HOSTS) {
      expect(isPrivateWebhookTarget(host), host).toBe(true)
    }
  })

  it('allows public targets', () => {
    for (const host of ALLOWED_HOSTS) {
      expect(isPrivateWebhookTarget(host), host).toBe(false)
    }
  })
})

describe('executeWebhookRequest SSRF guard', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('fetch must not be called for blocked targets')
    }) as unknown as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  function action(url: string): WebhookAction {
    return { type: 'webhook', url, method: 'GET' }
  }

  it('rejects the cloud metadata endpoint without making a request', async () => {
    const result = await executeWebhookRequest(action('http://169.254.169.254/latest/meta-data/'))
    expect(result.success).toBe(false)
    expect(result.statusCode).toBe(0)
    expect(result.error).toMatch(/Blocked webhook target/)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('rejects loopback and private targets', async () => {
    for (const url of ['http://localhost:8080/hook', 'http://127.0.0.1/x', 'http://[::1]/x', 'http://192.168.0.10/x']) {
      const result = await executeWebhookRequest(action(url))
      expect(result.success, url).toBe(false)
      expect(result.error, url).toMatch(/Blocked webhook target/)
    }
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('rejects integer-form IP literals that normalize to loopback', async () => {
    // 2130706433 === 127.0.0.1; the WHATWG URL parser normalizes it
    const result = await executeWebhookRequest(action('http://2130706433/x'))
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/Blocked webhook target/)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('still performs requests to public targets', async () => {
    globalThis.fetch = vi.fn(async () => new Response('ok', { status: 200 })) as unknown as typeof fetch
    const result = await executeWebhookRequest(action('https://hooks.slack.com/services/T00/B00/xyz'))
    expect(result.success).toBe(true)
    expect(result.statusCode).toBe(200)
    expect(globalThis.fetch).toHaveBeenCalledOnce()
  })

  it('blocks a redirect to the cloud metadata endpoint (redirect bypass)', async () => {
    // attacker.example (public) 302→ 169.254.169.254 — the guard must re-check
    // the redirect target and block it WITHOUT fetching the metadata endpoint.
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('attacker.example')) {
        return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } })
      }
      throw new Error('fetch must not reach the metadata endpoint')
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const result = await executeWebhookRequest(action('http://attacker.example/redir'))
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/Blocked webhook target/)
    expect(fetchMock).toHaveBeenCalledTimes(1) // only the public first hop
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('attacker.example')
  })

  it('blocks a DNS name that resolves to a private IP (DNS bypass)', async () => {
    // localtest.me resolves to 127.0.0.1 — the literal guard would miss it; the
    // injected resolver closes the static-DNS-to-private bypass.
    globalThis.fetch = vi.fn(async () => {
      throw new Error('fetch must not be called for a private-resolving host')
    }) as unknown as typeof fetch
    const result = await executeWebhookRequest(
      action('http://localtest.me/x'),
      { resolveIps: async () => ['127.0.0.1'] },
    )
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/Blocked webhook target/)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('follows a redirect to a PUBLIC target (legit redirects still work)', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('api.example.com')) {
        return new Response(null, { status: 302, headers: { location: 'https://cdn.example.com/result' } })
      }
      if (String(url).includes('cdn.example.com')) {
        return new Response('ok', { status: 200 })
      }
      throw new Error(`unexpected fetch ${url}`)
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const result = await executeWebhookRequest(action('https://api.example.com/redirect'))
    expect(result.success).toBe(true)
    expect(result.statusCode).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('downgrades POST→GET and drops the body on a 302 redirect (Fetch spec)', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes('api.example.com')) {
        return new Response(null, { status: 302, headers: { location: 'https://cdn.example.com/result' } })
      }
      if (String(url).includes('cdn.example.com')) {
        // Second hop must arrive as GET with no body.
        expect(init?.method ?? 'GET').toBe('GET')
        expect(init?.body).toBeUndefined()
        return new Response('ok', { status: 200 })
      }
      throw new Error(`unexpected fetch ${url}`)
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const result = await executeWebhookRequest({
      type: 'webhook',
      url: 'https://api.example.com/redirect',
      method: 'POST',
      body: { hi: 1 },
    })
    expect(result.success).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

// The sources package uses the same guard with blockPrivateInitial=false (a
// source baseUrl may legitimately be an internal API the operator configured).
// Verified here so the shared guard's two modes are covered in one place.
describe('fetchWithSsrfGuard — sources mode (blockPrivateInitial=false)', () => {
  const originalFetch = globalThis.fetch
  afterEach(() => { globalThis.fetch = originalFetch })

  it('allows a private INITIAL target (legit internal source baseUrl)', async () => {
    globalThis.fetch = vi.fn(async () => new Response('ok', { status: 200 })) as unknown as typeof fetch
    const res = await fetchWithSsrfGuard('http://192.168.1.10/api', {}, { blockPrivateInitial: false })
    expect(res.status).toBe(200)
    expect(globalThis.fetch).toHaveBeenCalledOnce()
  })

  it('blocks a public→private redirect (open-redirect SSRF)', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('api.example.com')) {
        return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } })
      }
      throw new Error('must not reach metadata endpoint')
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch
    await expect(
      fetchWithSsrfGuard('https://api.example.com/x', {}, { blockPrivateInitial: false }),
    ).rejects.toThrow(SsrfBlockedError)
    expect(fetchMock).toHaveBeenCalledTimes(1) // only the public first hop
  })
})

describe('redactUrl — audit B1 (webhook URL path-secret redaction)', () => {
  // Slack/Discord webhooks embed the secret in the PATH, not a query param, so
  // the path must NEVER appear in a redacted form (log / history / retry-queue
  // expandedUrl / onWebhookResults callback). Only scheme + host is shown.
  it('shows scheme + host only; NEVER the path (Slack path is the secret)', () => {
    const r = redactUrl('https://hooks.slack.com/services/T12345678/B123456/secret-token')
    expect(r).toBe('https://hooks.slack.com/…')
    // no substring of the secret path leaks
    expect(r).not.toContain('services')
    expect(r).not.toContain('T12345678')
    expect(r).not.toContain('B123456')
    expect(r).not.toContain('secret-token')
  })

  it('keeps a pathless origin as-is', () => {
    expect(redactUrl('https://api.example.com')).toBe('https://api.example.com')
    expect(redactUrl('https://api.example.com/')).toBe('https://api.example.com')
  })

  it('returns a fixed <redacted> marker for an unparseable URL (no prefix leak)', () => {
    // a Slack URL that lost its scheme — showing a prefix would leak the path secret
    expect(redactUrl('hooks.slack.com/services/T00/B00/secret')).toBe('<redacted>')
    expect(redactUrl('not a url at all')).toBe('<redacted>')
  })
})

describe('executeWebhookRequest — error-message URL scrub (audit B1)', () => {
  // The catch-all network error path uses err.message; if it embeds the expanded
  // (secret-bearing) URL verbatim, it must be replaced with the redacted form so
  // lastError (persisted) + onWebhookResults callback can't leak the path secret.
  beforeEach(() => { vi.resetAllMocks() })
  afterEach(() => { vi.restoreAllMocks() })

  it('redacts the expanded URL if the fetch error embeds it verbatim', async () => {
    const secret = 'https://hooks.slack.com/services/T00/B00/secret-token'
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError(`fetch failed for ${secret}: connect ECONNREFUSED`)
    }) as unknown as typeof fetch
    const result = await executeWebhookRequest({ type: 'webhook', method: 'POST', url: secret })
    expect(result.success).toBe(false)
    expect(result.url).toBe(secret) // internal result keeps the real URL
    expect(result.error).not.toContain(secret) // the secret URL is scrubbed
    expect(result.error).not.toContain('services')
    expect(result.error).not.toContain('secret-token')
    expect(result.error).toContain('hooks.slack.com') // redacted form (origin) retained
    expect(result.error).toContain('ECONNREFUSED') // the useful diagnostic survives
  })

  it('leaves a non-URL-bearing error message unchanged', async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error('Request timed out') })
    const result = await executeWebhookRequest({ type: 'webhook', method: 'POST', url: 'https://x.example/hook' })
    expect(result.error).toBe('Request timed out')
  })
})
