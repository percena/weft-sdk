import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createFlitroProviderRuntime,
  type CreateFlitroProviderRuntimeOptions,
} from '../index.ts'
import type { ProviderRuntimeScaffold } from '../../shared/runtime-scaffold.ts'
import type { WeftHttpClient } from '../client/index.ts'
import type { FlitroProviderRuntimeDriver } from '../runtime-driver.ts'

// transport contract acceptance: a kill-server (mock) drives the scaffold stream's
// error state + flips isConnected to false. The flitro driver's SSE onError
// callback (the terminal give-up) must forward into the scaffold's
// PushTimelineStream — previously it was discarded.
//
// We mock createTimelineStream so the driver wires a fake SSE stream whose
// onError callback we can invoke to simulate the kill, without touching the
// network or waiting on real reconnect backoff.
const { fakeStream, getCapturedOnError, getCapturedOnEvent } = vi.hoisted(() => {
  let capturedOnEvent: ((env: unknown) => void) | undefined
  let capturedOnError: ((err: Error) => void) | undefined
  const fakeStream = {
    connect: (onEvent: unknown, onError?: (err: Error) => void) => {
      capturedOnEvent = onEvent as ((env: unknown) => void) | undefined
      capturedOnError = onError
    },
    disconnect: () => {},
    isConnected: () => false,
  }
  return {
    fakeStream,
    getCapturedOnError: () => capturedOnError,
    getCapturedOnEvent: () => capturedOnEvent,
  }
})

vi.mock('../client/timeline-stream.ts', () => ({
  createTimelineStream: () => fakeStream,
}))

const live: ProviderRuntimeScaffold[] = []
afterEach(() => {
  for (const r of live) r.dispose?.()
  live.length = 0
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function makeRuntime(): ProviderRuntimeScaffold {
  // Stub fetch for any non-SSE calls (capability report etc.); the SSE stream
  // itself is mocked above so /timeline is never fetched.
  vi.stubGlobal('fetch', vi.fn(async () => new Response('OK', { status: 200 })))
  const client = {
    timelineUrl: (sid: string) => `http://localhost/v1/sessions/${sid}/timeline`,
    getBearerToken: () => 'tok',
    setToken: () => {},
    submitToolOutputs: vi.fn(async () => ({})),
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
  } as CreateFlitroProviderRuntimeOptions) as unknown as ProviderRuntimeScaffold
  live.push(runtime)
  return runtime
}

describe('flitro driver — transport contract terminal transport death', () => {
  it('forwards the SSE give-up error into the scaffold stream + marks transport disconnected', () => {
    const runtime = makeRuntime()

    // The hook reads off runtime.stream (the scaffold's PushTimelineStream).
    const onError = vi.fn()
    runtime.stream.connect(() => {}, onError)

    // The driver called connectSse at construction → the fake SSE stream's
    // onError callback is now captured. Simulate the terminal give-up.
    const kill = getCapturedOnError()
    if (!kill) {
      throw new Error('SSE onError callback was not captured — connectSse did not run')
    }
    kill(new Error('Weft SSE: max reconnect attempts (3) reached'))

    // contract part 1: the terminal error is forwarded (not discarded) → the hook's
    // onError (→ setError) fires.
    expect(onError).toHaveBeenCalledOnce()
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('max reconnect attempts'),
    }))

    // contract part 2: isConnected is transport-backed — the give-up flips it false.
    expect(runtime.stream.isConnected()).toBe(false)
  })

  it('marks the transport connected when the SSE session is established (first event)', () => {
    const runtime = makeRuntime()
    // SDK-R-7: setConnected(true) fires on the first successful event, not at
    // connectSse() initiation. At construction the transport is not yet
    // established (setConnected(false) ran at initiation).
    expect(runtime.stream.isConnected()).toBe(false)
    const onEvent = getCapturedOnEvent()
    expect(onEvent).toBeDefined()
    onEvent!({
      sessionId: 's1',
      provider: 'flitro',
      seq: 1,
      epoch: 'flitro-s1-b1',
      timestamp: 1,
      item: { type: 'session_status', status: 'running' },
    })
    expect(runtime.stream.isConnected()).toBe(true)
  })
})
