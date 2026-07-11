import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { AgentRuntime } from '@weft/runtime-core'

const createFlitroEmbedRuntimeMock = vi.hoisted(() => vi.fn<() => AgentRuntime>())

vi.mock('@weft/providers/flitro', () => ({
  createFlitroEmbedRuntime: createFlitroEmbedRuntimeMock,
}))

import { createDeferredAgentRuntime, useAgentSession } from './use-agent-session.ts'

describe('useAgentSession', () => {
  beforeEach(() => {
    createFlitroEmbedRuntimeMock.mockReset()
    createFlitroEmbedRuntimeMock.mockReturnValue(createFakeRuntime())
  })

  test('does not create a Flitro runtime during render', () => {
    function Probe() {
      const session = useAgentSession({
        server: 'http://127.0.0.1:8787',
        token: 'scoped-token',
        sessionId: 'session-1',
      })

      return createElement('span', null, session.sessionId)
    }

    expect(renderToString(createElement(Probe))).toContain('session-1')
    expect(createFlitroEmbedRuntimeMock).not.toHaveBeenCalled()
  })
})

describe('createDeferredAgentRuntime', () => {
  test('defers runtime creation until the runtime is actually used', () => {
    const runtime = createFakeRuntime()
    const createRuntime = vi.fn(() => runtime)
    const deferred = createDeferredAgentRuntime({
      provider: 'flitro',
      runtimeKind: 'app-server',
      sessionId: 'session-1',
      createRuntime,
    })

    expect(deferred.getState().status).toBe('idle')
    expect(deferred.events.isConnected()).toBe(false)
    expect(createRuntime).not.toHaveBeenCalled()

    deferred.events.connect(() => undefined)

    expect(createRuntime).toHaveBeenCalledTimes(1)
    expect(runtime.events.isConnected()).toBe(true)
  })

  test('disposes the underlying runtime only if it was created', async () => {
    const created = createFakeRuntime()
    const createRuntime = vi.fn(() => created)
    const deferred = createDeferredAgentRuntime({
      provider: 'flitro',
      runtimeKind: 'app-server',
      sessionId: 'session-1',
      createRuntime,
    })

    await deferred.disposeIfCreated()

    expect(createRuntime).not.toHaveBeenCalled()

    await deferred.commands.sendMessage('hello')
    await deferred.disposeIfCreated()

    expect(createRuntime).toHaveBeenCalledTimes(1)
    expect(created.commands.dispose).toHaveBeenCalledTimes(1)
  })

  test('revives after disposeIfCreated (StrictMode mount→cleanup→remount)', async () => {
    const runtimes: AgentRuntime[] = []
    const createRuntime = vi.fn(() => {
      const runtime = createFakeRuntime()
      runtimes.push(runtime)
      return runtime
    })
    const deferred = createDeferredAgentRuntime({
      provider: 'flitro',
      runtimeKind: 'app-server',
      sessionId: 'session-1',
      createRuntime,
    })

    // First mount: the panel connects, creating the real runtime.
    deferred.events.connect(() => undefined)
    expect(createRuntime).toHaveBeenCalledTimes(1)

    // StrictMode's simulated unmount runs the effect cleanup.
    await deferred.disposeIfCreated()
    expect(runtimes[0]!.commands.dispose).toHaveBeenCalledTimes(1)
    expect(deferred.events.isConnected()).toBe(false)

    // Remount reuses the same memoized deferred runtime; connect must
    // lazily create a fresh underlying runtime rather than throw.
    deferred.events.connect(() => undefined)
    expect(createRuntime).toHaveBeenCalledTimes(2)
    expect(deferred.events.isConnected()).toBe(true)
  })

  test('commands.dispose is terminal', async () => {
    const deferred = createDeferredAgentRuntime({
      provider: 'flitro',
      runtimeKind: 'app-server',
      sessionId: 'session-1',
      createRuntime: createFakeRuntime,
    })

    deferred.events.connect(() => undefined)
    await deferred.commands.dispose()

    expect(() => deferred.events.connect(() => undefined)).toThrow('disposed')
  })

  test('resumeTool rejects when the underlying runtime does not support it', async () => {
    const runtime = createFakeRuntime()
    delete runtime.commands.resumeTool
    const deferred = createDeferredAgentRuntime({
      provider: 'flitro',
      runtimeKind: 'app-server',
      sessionId: 'session-1',
      createRuntime: () => runtime,
    })

    await expect(deferred.commands.resumeTool!('run-1', {})).rejects.toThrow(
      'resumeTool is not supported',
    )
  })

  test('respondToPermission forwards the 4th `detail` arg to the runtime', async () => {
    const runtime = createFakeRuntime()
    const deferred = createDeferredAgentRuntime({
      provider: 'flitro',
      runtimeKind: 'app-server',
      sessionId: 'session-1',
      createRuntime: () => runtime,
    })

    const detail = { updatedInput: { path: '/safe' }, interrupt: false }
    await deferred.commands.respondToPermission('req-1', true, true, detail)

    expect(runtime.commands.respondToPermission).toHaveBeenCalledWith(
      'req-1', true, true, detail,
    )
  })
})

function createFakeRuntime(): AgentRuntime {
  let connected = false

  return {
    sessionId: 'session-1',
    provider: 'flitro',
    runtimeKind: 'app-server',
    events: {
      connect() {
        connected = true
      },
      disconnect() {
        connected = false
      },
      isConnected() {
        return connected
      },
    },
    commands: {
      sendMessage: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
      respondToPermission: vi.fn(async () => undefined),
      resumeTool: vi.fn(async () => undefined),
      dispose: vi.fn(async () => undefined),
    },
    preflight: vi.fn(async () => ({
      provider: 'flitro',
      selected: 'app-server',
      candidates: [{ kind: 'app-server', available: true }],
      preferredRuntime: 'app-server',
      allowFallback: false,
      auth: { mode: 'provider-owned', configured: true, source: 'test' },
    })),
    fetchTimeline: vi.fn(async () => ({
      items: [],
      cursor: { epoch: 'session-1', afterSeq: 0 },
      hasGap: false,
    })),
    getState: vi.fn(() => ({
      status: 'idle',
      acceptedMessages: [],
      queuedMessages: [],
    })),
  }
}
