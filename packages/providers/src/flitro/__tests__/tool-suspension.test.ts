import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TimelineEnvelope, TimelineItem } from '@weft/timeline'
import {
  createFlitroProviderRuntime,
  type CreateFlitroProviderRuntimeOptions,
} from '../index.ts'
import type { ProviderRuntimeScaffold } from '../../shared/runtime-scaffold.ts'
import type { WeftHttpClient } from '../client/index.ts'
import type { FlitroProviderRuntimeDriver } from '../runtime-driver.ts'

// Keep the SSE connection (opened at construction) and the browser executor
// from touching the network; both go through global fetch.
function stubFetch(): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async (input: unknown) => {
    const url = String(input)
    if (url.includes('/timeline')) {
      // SSE endpoint: empty stream that ends immediately (then reconnects).
      return new Response('', { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    return new Response('OK', { status: 200 })
  })
  vi.stubGlobal('fetch', mock)
  return mock
}

function makeRuntime(
  overrides: Partial<CreateFlitroProviderRuntimeOptions>,
): { runtime: ProviderRuntimeScaffold; submitToolOutputs: ReturnType<typeof vi.fn> } {
  const submitToolOutputs = vi.fn(async () => ({}))
  const client = {
    timelineUrl: (sid: string) => `http://localhost/v1/sessions/${sid}/timeline`,
    getBearerToken: () => 'tok',
    setToken: () => {},
    submitToolOutputs,
    fetchTimeline: vi.fn(),
  } as unknown as WeftHttpClient

  const driver = {
    sendMessage: vi.fn(async () => {}),
    getActiveRunId: () => 'run-1',
  } as unknown as FlitroProviderRuntimeDriver

  const runtime = createFlitroProviderRuntime({
    server: { baseUrl: 'http://localhost', token: 'tok' },
    sessionId: 's1',
    candidates: [{ kind: 'app-server', available: true }],
    auth: { mode: 'provider-owned', configured: true, source: 'flitro' },
    client,
    driver,
    ...overrides,
  }) as unknown as ProviderRuntimeScaffold

  live.push(runtime)
  return { runtime, submitToolOutputs }
}

function suspend(name: string, suspendData: unknown): TimelineEnvelope {
  return {
    sessionId: 's1',
    provider: 'flitro',
    seq: 1,
    epoch: 'flitro-s1',
    timestamp: 0,
    item: {
      type: 'tool_suspended',
      callId: 'c1',
      name,
      suspendData,
      turnId: 'run-1',
    } as TimelineItem,
  }
}

const tick = () => new Promise(r => setTimeout(r, 5))

const live: ProviderRuntimeScaffold[] = []

describe('flitro tool suspension — S2 auto-execution opt-in', () => {
  afterEach(async () => {
    for (const rt of live.splice(0)) await rt.commands.dispose()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('does NOT auto-execute an HTTP-shaped suspension by default', async () => {
    stubFetch()
    const { runtime, submitToolOutputs } = makeRuntime({})

    runtime.appendEnvelope(suspend('some_openapi_tool', { method: 'POST', url: '/admin/delete-account' }))
    await tick()

    expect(submitToolOutputs).not.toHaveBeenCalled()
    // The suspension is surfaced observably rather than silently executed.
    expect(runtime.timeline.some(e => e.item.type === 'session_status')).toBe(true)
  })

  it('does NOT auto-execute even the explicit client_http_request marker without opt-in', async () => {
    stubFetch()
    const { runtime, submitToolOutputs } = makeRuntime({})

    runtime.appendEnvelope(suspend('client_http_request', { method: 'POST', url: '/x' }))
    await tick()

    expect(submitToolOutputs).not.toHaveBeenCalled()
  })

  it('auto-executes the client_http_request marker when autoExecuteClientHttp is set', async () => {
    stubFetch()
    const { runtime, submitToolOutputs } = makeRuntime({ autoExecuteClientHttp: true })

    runtime.appendEnvelope(suspend('client_http_request', { method: 'GET', url: '/api/ping' }))
    await tick()

    expect(submitToolOutputs).toHaveBeenCalledTimes(1)
  })

  it('auto-executes only allowlisted method+path shapes', async () => {
    stubFetch()
    const { runtime, submitToolOutputs } = makeRuntime({
      clientHttpAllowlist: [{ method: 'GET', pathPrefix: '/api/' }],
    })

    // Not allowlisted (wrong method + path) → surfaced, not executed.
    runtime.appendEnvelope(suspend('tool_a', { method: 'DELETE', url: '/admin/x' }))
    await tick()
    expect(submitToolOutputs).not.toHaveBeenCalled()

    // Allowlisted → executed.
    runtime.appendEnvelope({
      ...suspend('tool_b', { method: 'GET', url: '/api/things' }),
      seq: 2,
    })
    await tick()
    expect(submitToolOutputs).toHaveBeenCalledTimes(1)
  })

  it('re-fires a replayed tool_suspended via the fallback timer when the host never arms replay (live-run wedge fix)', async () => {
    // Reproduces the online-store demo hang: the runtime's initial epoch is
    // `flitro-s1` (derived from sessionId by createFlitroProviderRuntime);
    // the run's events arrive under a run-epoch `flitro-s1-<bootID>-g0`,
    // which differs → an epoch rotation → replayMode=true → the
    // tool_suspended is tracked (NOT dispatched live). The host (chat hook)
    // never calls armReplay — a client-side tool suspension pauses the run,
    // no further events flush, the host's flush-based armReplay timer never
    // fires. Before the fix the run wedged at the first tool call (the demo
    // hung at shop_listproducts on "buy 2 keyboards and pay"). The
    // scaffold's fallback timer fires armReplay → re-fire → auto-execute.
    stubFetch()
    const { runtime, submitToolOutputs } = makeRuntime({
      clientHttpAllowlist: [{ pathPrefix: '/api/' }],
    })

    runtime.appendEnvelope({
      ...suspend('shop_listproducts', { method: 'GET', url: '/api/products' }),
      epoch: 'flitro-s1-9783056b-g0',
    })
    // Tracked during replay — not executed yet (the host hasn't armed replay).
    expect(submitToolOutputs).not.toHaveBeenCalled()

    // The fallback timer fires armReplay after ARM_REPLAY_FALLBACK_MS even
    // though the host never calls it.
    await new Promise(r => setTimeout(r, 650))
    expect(submitToolOutputs).toHaveBeenCalledTimes(1)
  })
})
