import { afterEach, describe, expect, test, vi } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

import {
  createFlitroDriver,
  createFlitroProviderRuntime,
  type ToolHandler,
  type WeftHttpClient,
} from '@weft/providers/flitro'
import type { RuntimeAuthDetection, RuntimeCandidate } from '@weft/runtime-core'
import type { TimelineEnvelope, TimelineItem, TimelineSequencer } from '@weft/timeline'

/**
 * Inline app-server candidate, replacing the deleted `createFlitroRuntimeCandidates`
 * factory (Phase 3/4 removed it; the runtime now takes the candidate array
 * directly). Describes an available Flitro app-server runtime.
 */
const appServerCandidates: RuntimeCandidate[] = [{ kind: 'app-server', available: true }]

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => closeServer(server)))
})

describe('Provider Flitro — timeline stream integration', () => {
  test('uses canonical Flitro session_id and run_id fields for runtime commands', async () => {
    const requests: Array<{ method?: string; url?: string; body?: unknown }> = []
    const { server, baseUrl } = await startFlitroApiServer(requests)
    servers.push(server)

    const runtime = createFlitroProviderRuntime({
      server: { baseUrl },
      sessionId: 'session-from-flitro',
      candidates: appServerCandidates,
      auth: providerOwnedAuth(),
      model: 'openai/gpt-5.4',
    })

    await runtime.commands.sendMessage('hello from weft')

    expect(runtime.sessionId).toBe('session-from-flitro')
    expect(requests.map(request => request.url)).toContain('/v1/sessions/session-from-flitro/runs')
    expect(requests.find(request => request.url === '/v1/sessions/session-from-flitro/runs')?.body)
      .toMatchObject({
        message: 'hello from weft',
        model: 'openai/gpt-5.4',
      })

    await runtime.commands.abort('stop')

    expect(requests.map(request => request.url)).toContain('/v1/sessions/session-from-flitro/runs/run-from-flitro/cancel')

    await runtime.commands.dispose()
  })

  test.each([
    ['explore'],
    ['ask'],
    ['auto'],
  ] as const)('threads per-message permissionMode=%s to createRun.permission_mode', async (permissionMode) => {
    const calls: Array<{ sessionId: string; message: string; permissionMode?: string }> = []
    const client = {
      async createRun(
        sessionId: string,
        message: string,
        options?: { permissionMode?: string },
      ) {
        calls.push({ sessionId, message, permissionMode: options?.permissionMode })
        return {
          run_id: 'run-from-flitro',
          session_id: sessionId,
          status: 'queued',
          execution_mode: 'chat',
          input_message: message,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }
      },
    } as unknown as WeftHttpClient
    const driver = createFlitroDriver({ client, sessionId: 'session-from-flitro' })

    await driver.sendMessage({
      message: 'permission mode check',
      options: { permissionMode },
    }, unusedSequencer())

    expect(calls).toEqual([
      {
        sessionId: 'session-from-flitro',
        message: 'permission mode check',
        permissionMode,
      },
    ])
  })

  test('falls back to the creation-time permissionMode when per-message mode is unset', async () => {
    const calls: Array<{ permissionMode?: string }> = []
    const client = {
      async createRun(
        sessionId: string,
        message: string,
        options?: { permissionMode?: string },
      ) {
        calls.push({ permissionMode: options?.permissionMode })
        return {
          run_id: 'run-from-flitro',
          session_id: sessionId,
          status: 'queued',
          execution_mode: 'chat',
          input_message: message,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }
      },
    } as unknown as WeftHttpClient
    const driver = createFlitroDriver({
      client,
      sessionId: 'session-from-flitro',
      permissionMode: 'ask',
    })

    await driver.sendMessage({ message: 'no per-message mode' }, unusedSequencer())

    expect(calls).toEqual([{ permissionMode: 'ask' }])
  })

  test('per-message permissionMode overrides the creation-time permissionMode', async () => {
    const calls: Array<{ permissionMode?: string }> = []
    const client = {
      async createRun(
        sessionId: string,
        message: string,
        options?: { permissionMode?: string },
      ) {
        calls.push({ permissionMode: options?.permissionMode })
        return {
          run_id: 'run-from-flitro',
          session_id: sessionId,
          status: 'queued',
          execution_mode: 'chat',
          input_message: message,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }
      },
    } as unknown as WeftHttpClient
    const driver = createFlitroDriver({
      client,
      sessionId: 'session-from-flitro',
      permissionMode: 'auto',
    })

    await driver.sendMessage({
      message: 'per-message wins',
      options: { permissionMode: 'explore' },
    }, unusedSequencer())

    expect(calls).toEqual([{ permissionMode: 'explore' }])
  })

  test('consumes canonical Flitro SSE timeline events into runtime state', async () => {
    const envelope: TimelineEnvelope = {
      sessionId: 'session-flitro',
      provider: 'flitro',
      epoch: 'flitro-session-flitro',
      seq: 1,
      timestamp: Date.now(),
      item: {
        type: 'permission_requested',
        request: {
          requestId: 'approval-1',
          toolName: 'delete_database',
          reason: 'destructive operation',
        },
      },
    }

    const { server, baseUrl } = await startSseServer(envelope)
    servers.push(server)

    const runtime = createFlitroProviderRuntime({
      server: { baseUrl },
      sessionId: 'session-flitro',
      candidates: appServerCandidates,
      auth: providerOwnedAuth(),
    })

    await waitFor(() => runtime.getState().status === 'waiting_for_permission')

    expect(runtime.getState()).toMatchObject({
      status: 'waiting_for_permission',
      waitingPermissionRequestId: 'approval-1',
    })

    await runtime.commands.dispose()
  })

  test('routes permission responses through Flitro session permission API for restored sessions', async () => {
    const requests: Array<{ method?: string; url?: string; body?: unknown }> = []
    const { server, baseUrl } = await startFlitroApiServer(requests)
    servers.push(server)

    const runtime = createFlitroProviderRuntime({
      server: { baseUrl },
      sessionId: 'session-from-flitro',
      candidates: appServerCandidates,
      auth: providerOwnedAuth(),
    })

    await runtime.commands.respondToPermission('approval-1', true, true)

    expect(requests.find(request => request.url === '/v1/sessions/session-from-flitro/permission-response')?.body)
      .toEqual({
        requestId: 'approval-1',
        allowed: true,
        remember: true,
      })

    await runtime.commands.respondToPermission('approval-2', false, false)

    expect(requests.find(request => {
      return request.url === '/v1/sessions/session-from-flitro/permission-response' &&
        (request.body as { requestId?: string } | undefined)?.requestId === 'approval-2'
    })?.body)
      .toEqual({
        requestId: 'approval-2',
        allowed: false,
        remember: false,
      })

    await runtime.commands.dispose()
  })

  test('keeps runtime running until Flitro emits turn_completed over SSE', async () => {
    const requests: Array<{ method?: string; url?: string; body?: unknown }> = []
    const stream = await createManualTimelineServer(requests)
    servers.push(stream.server)

    const runtime = createFlitroProviderRuntime({
      server: { baseUrl: stream.baseUrl },
      sessionId: 'session-from-flitro',
      candidates: appServerCandidates,
      auth: providerOwnedAuth(),
    })

    await stream.waitForClient()
    await runtime.commands.sendMessage('hello from weft')

    expect(runtime.getState().status).toBe('running')

    stream.emit({
      sessionId: 'session-from-flitro',
      provider: 'flitro',
      epoch: 'flitro-session-from-flitro',
      seq: 1,
      timestamp: Date.now(),
      item: { type: 'turn_completed', turnId: 'run-from-flitro' },
    })

    await waitFor(() => runtime.getState().status === 'ready')

    await runtime.commands.dispose()
  })

  test('does not drop first server timeline event after local preflight creates seq 1', async () => {
    const requests: Array<{ method?: string; url?: string; body?: unknown }> = []
    const stream = await createManualTimelineServer(requests, { createSession: true })
    servers.push(stream.server)

    const runtime = createFlitroProviderRuntime({
      server: { baseUrl: stream.baseUrl },
      sessionId: 'session-from-flitro',
      candidates: appServerCandidates,
      auth: providerOwnedAuth(),
    })

    await runtime.preflight()
    await runtime.commands.sendMessage('hello after preflight')
    await stream.waitForClient()

    stream.emit({
      sessionId: 'session-from-flitro',
      provider: 'flitro',
      epoch: 'flitro-session-from-flitro',
      seq: 1,
      timestamp: Date.now(),
      item: {
        type: 'permission_requested',
        request: {
          requestId: 'approval-after-create',
          toolName: 'delete_database',
          reason: 'destructive operation',
        },
      },
    })

    await waitFor(() => runtime.getState().status === 'waiting_for_permission')

    expect(runtime.getState()).toMatchObject({
      status: 'waiting_for_permission',
      waitingPermissionRequestId: 'approval-after-create',
    })

    await runtime.commands.dispose()
  })

  test('keeps permission wait state when Flitro rejects permission response', async () => {
    const requests: Array<{ method?: string; url?: string; body?: unknown }> = []
    const stream = await createManualTimelineServer(requests, { rejectPermissionResponse: true })
    servers.push(stream.server)

    const runtime = createFlitroProviderRuntime({
      server: { baseUrl: stream.baseUrl },
      sessionId: 'session-from-flitro',
      candidates: appServerCandidates,
      auth: providerOwnedAuth(),
    })

    await stream.waitForClient()
    stream.emit({
      sessionId: 'session-from-flitro',
      provider: 'flitro',
      epoch: 'flitro-session-from-flitro',
      seq: 1,
      timestamp: Date.now(),
      item: {
        type: 'permission_requested',
        request: {
          requestId: 'approval-foreign-session',
          toolName: 'delete_database',
          reason: 'destructive operation',
        },
      },
    })

    await waitFor(() => runtime.getState().status === 'waiting_for_permission')

    await expect(runtime.commands.respondToPermission('approval-foreign-session', true, false))
      .rejects.toThrow('Weft HTTP 404')

    expect(runtime.getState()).toMatchObject({
      status: 'waiting_for_permission',
      waitingPermissionRequestId: 'approval-foreign-session',
    })

    await runtime.commands.dispose()
  })

  test('queues messages locally while a Flitro run is active', async () => {
    const requests: Array<{ method?: string; url?: string; body?: unknown }> = []
    const stream = await createManualTimelineServer(requests)
    servers.push(stream.server)

    const runtime = createFlitroProviderRuntime({
      server: { baseUrl: stream.baseUrl },
      sessionId: 'session-from-flitro',
      candidates: appServerCandidates,
      auth: providerOwnedAuth(),
    })

    await stream.waitForClient()
    await runtime.commands.sendMessage('first')
    await runtime.commands.sendMessage('second')

    expect(runRequestBodies(requests)).toEqual([
      expect.objectContaining({ message: 'first' }),
    ])
    expect(runtime.getState()).toMatchObject({
      status: 'running',
      queuedMessages: ['second'],
    })

    stream.emit({
      sessionId: 'session-from-flitro',
      provider: 'flitro',
      epoch: 'flitro-session-from-flitro',
      seq: 1,
      timestamp: Date.now(),
      item: { type: 'turn_completed', turnId: 'run-from-flitro' },
    })

    await waitFor(() => runRequestBodies(requests).length === 2)

    expect(runRequestBodies(requests)).toEqual([
      expect.objectContaining({ message: 'first' }),
      expect.objectContaining({ message: 'second' }),
    ])
    expect(runtime.getState()).toMatchObject({
      status: 'running',
      queuedMessages: [],
    })

    await runtime.commands.dispose()
  })

  test('drops queued Flitro messages when the active run is aborted', async () => {
    const requests: Array<{ method?: string; url?: string; body?: unknown }> = []
    const stream = await createManualTimelineServer(requests)
    servers.push(stream.server)

    const runtime = createFlitroProviderRuntime({
      server: { baseUrl: stream.baseUrl },
      sessionId: 'session-from-flitro',
      candidates: appServerCandidates,
      auth: providerOwnedAuth(),
    })

    await stream.waitForClient()
    await runtime.commands.sendMessage('first')
    await runtime.commands.sendMessage('second')
    await runtime.commands.abort('stop')

    stream.emit({
      sessionId: 'session-from-flitro',
      provider: 'flitro',
      epoch: 'flitro-session-from-flitro',
      seq: 1,
      timestamp: Date.now(),
      item: { type: 'turn_completed', turnId: 'run-from-flitro' },
    })

    await new Promise(resolve => setTimeout(resolve, 20))

    expect(runRequestBodies(requests)).toEqual([
      expect.objectContaining({ message: 'first' }),
    ])
    expect(requests.map(request => request.url)).toContain('/v1/sessions/session-from-flitro/runs/run-from-flitro/cancel')

    await runtime.commands.dispose()
  })
})

function runRequestBodies(requests: Array<{ method?: string; url?: string; body?: unknown }>): unknown[] {
  return requests
    .filter(request => request.method === 'POST' && request.url === '/v1/sessions/session-from-flitro/runs')
    .map(request => request.body)
}

async function createManualTimelineServer(
  requests: Array<{ method?: string; url?: string; body?: unknown }>,
  options: { createSession?: boolean; rejectPermissionResponse?: boolean } = {},
): Promise<{
  server: Server
  baseUrl: string
  emit: (envelope: TimelineEnvelope) => void
  waitForClient: () => Promise<void>
}> {
  const clients = new Set<ServerResponse>()
  let resolveClient: (() => void) | undefined
  const clientReady = new Promise<void>(resolve => {
    resolveClient = resolve
  })

  const server = createServer(async (req, res) => {
    const body = await readJsonBody(req)
    requests.push({ method: req.method, url: req.url, body })

    if (req.method === 'GET' && req.url?.startsWith('/v1/sessions/session-from-flitro/timeline')) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })
      clients.add(res)
      resolveClient?.()
      req.on('close', () => clients.delete(res))
      return
    }

    if (options.createSession && req.method === 'POST' && req.url === '/v1/sessions') {
      writeJson(res, 201, {
        session_id: 'session-from-flitro',
        tenant_id: 'default',
        title: 'Weft session',
        status: 'active',
        config_snapshot: {},
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      return
    }

    if (req.method === 'POST' && req.url === '/v1/sessions/session-from-flitro/runs') {
      writeJson(res, 201, {
        run_id: 'run-from-flitro',
        session_id: 'session-from-flitro',
        status: 'queued',
        execution_mode: 'chat',
        input_message: (body as { message?: string } | undefined)?.message ?? '',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      return
    }

    if (req.method === 'POST' && req.url === '/v1/sessions/session-from-flitro/permission-response') {
      if (options.rejectPermissionResponse) {
        writeJson(res, 404, { error: 'approval approval-foreign-session not found' })
        return
      }
      writeJson(res, 200, {
        ok: true,
        type: 'approval',
        requestId: (body as { requestId?: string } | undefined)?.requestId,
      })
      return
    }

    writeJson(res, 404, { error: 'not found' })
  })

  let baseUrl = ''
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('server did not bind to a TCP port')
  baseUrl = `http://127.0.0.1:${addr.port}`

  return {
    server,
    baseUrl,
    emit(envelope: TimelineEnvelope) {
      for (const client of clients) {
        client.write(`event: timeline\ndata: ${JSON.stringify(envelope)}\n\n`)
      }
    },
    waitForClient: () => clientReady,
  }
}

async function startFlitroApiServer(
  requests: Array<{ method?: string; url?: string; body?: unknown }>,
): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer(async (req, res) => {
    const body = await readJsonBody(req)
    requests.push({ method: req.method, url: req.url, body })

    if (req.method === 'POST' && req.url === '/v1/sessions') {
      writeJson(res, 201, {
        session_id: 'session-from-flitro',
        tenant_id: 'default',
        title: 'Weft session',
        status: 'active',
        config_snapshot: {},
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      return
    }

    if (req.method === 'POST' && req.url === '/v1/sessions/session-from-flitro/runs') {
      writeJson(res, 201, {
        run_id: 'run-from-flitro',
        session_id: 'session-from-flitro',
        status: 'queued',
        execution_mode: 'chat',
        input_message: 'hello from weft',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      return
    }

    if (req.method === 'POST' && req.url === '/v1/sessions/session-from-flitro/runs/run-from-flitro/cancel') {
      writeJson(res, 200, { status: 'canceled' })
      return
    }

    if (req.method === 'POST' && req.url === '/v1/sessions/session-from-flitro/permission-response') {
      writeJson(res, 200, {
        ok: true,
        type: 'approval',
        requestId: (body as { requestId?: string } | undefined)?.requestId,
      })
      return
    }

    if (req.method === 'GET' && req.url?.startsWith('/v1/sessions/session-from-flitro/timeline')) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })
      return
    }

    writeJson(res, 404, { error: 'not found' })
  })

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('server did not bind to a TCP port')
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` }
}

async function startSseServer(envelope: TimelineEnvelope): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/v1/sessions/session-flitro/timeline')) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })
      res.write(`event: timeline\ndata: ${JSON.stringify(envelope)}\n\n`)
      return
    }

    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  })

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('server did not bind to a TCP port')
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` }
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close(err => err ? reject(err) : resolve())
  })
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  if (chunks.length === 0) return undefined
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

function providerOwnedAuth(): RuntimeAuthDetection {
  return { mode: 'provider-owned', configured: true, source: 'test' }
}

function unusedSequencer(): TimelineSequencer {
  return {
    append(item) {
      return {
        sessionId: 'session-from-flitro',
        provider: 'flitro',
        seq: 1,
        epoch: 'flitro-session-from-flitro',
        timestamp: Date.now(),
        item,
      }
    },
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('condition was not met before timeout')
}

describe('Provider Flitro — client-side tool suspension (d1add07/d11fc4a)', () => {
  function makeRuntime({
    toolName = 'echo',
    suspendData = { text: 'hi' },
    toolHandlers,
    activeRunId = 'run-from-flitro',
    eventTurnId,
    submitFails = false,
    autoExecuteClientHttp = false,
  }: {
    toolName?: string
    suspendData?: unknown
    toolHandlers?: Record<string, ToolHandler>
    activeRunId?: string | null
    eventTurnId?: string
    submitFails?: boolean
    autoExecuteClientHttp?: boolean
  }) {
    const submitCalls: Array<{ sessionId: string; runId: string; outputs: unknown[] }> = []
    const client = {
      async createSession() { return { session_id: 'session-from-flitro' } },
      async createRun() {
        return { run_id: 'run-from-flitro', session_id: 'session-from-flitro', status: 'queued', execution_mode: 'chat', input_message: '', created_at: '', updated_at: '' }
      },
      async submitToolOutputs(sessionId: string, runId: string, outputs: unknown[]) {
        submitCalls.push({ sessionId, runId, outputs })
        if (submitFails) throw new Error('network down')
        return { status: 'ok' }
      },
      timelineUrl(_sessionId: string) { return 'http://127.0.0.1:1/timeline' },
      getBearerToken() { return undefined },
      setToken() {},
    } as unknown as WeftHttpClient
    const driver = {
      async sendMessage(_input: { message: string }, sequencer: TimelineSequencer) {
        sequencer.append({ type: 'tool_suspended', callId: 'call-1', name: toolName, suspendData, turnId: eventTurnId })
        sequencer.append({ type: 'turn_completed', turnId: 'run-from-flitro' })
      },
      getActiveRunId() { return activeRunId ?? undefined },
    }
    const items: TimelineItem[] = []
    const runtime = createFlitroProviderRuntime({
      server: { baseUrl: 'http://127.0.0.1:1' },
      sessionId: 'session-from-flitro',
      candidates: appServerCandidates,
      auth: providerOwnedAuth(),
      now: () => 0,
      client,
      driver,
      toolHandlers,
      autoExecuteClientHttp,
    })
    runtime.events.connect((event) => items.push(event.item as TimelineItem))
    return { runtime, submitCalls, items }
  }

  test('registered tool handler runs and submits its output via tool-outputs endpoint', async () => {
    const { runtime, submitCalls } = makeRuntime({
      toolHandlers: { echo: { execute: async (args) => (args as { text: string }).text } },
    })
    await runtime.commands.sendMessage('hi')
    await waitFor(() => submitCalls.length === 1)
    await runtime.commands.dispose()
    expect(submitCalls).toEqual([
      { sessionId: 'session-from-flitro', runId: 'run-from-flitro', outputs: [{ toolCallId: 'call-1', output: 'hi' }] },
    ])
  })

  test('client_http_request uses the built-in secure executor when autoExecuteClientHttp is opted in', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () => new Response('hello', { status: 200 })) as typeof fetch
    try {
      const { runtime, submitCalls } = makeRuntime({
        toolName: 'client_http_request',
        autoExecuteClientHttp: true,
        suspendData: {
          method: 'GET',
          url: '/api/products',
          headers: {
            Accept: 'application/json',
            Authorization: 'Bearer secret',
            Cookie: 'sid=secret',
            'X-Weft-Actor': 'actor-1',
            'X-Weft-Internal': 'internal-secret',
          },
        },
      })
      await runtime.commands.sendMessage('hi')
      await waitFor(() => submitCalls.length === 1)
      await runtime.commands.dispose()
      const output = submitCalls[0]?.outputs?.[0] as { output: { status: number; body: string } } | undefined
      expect(output?.output.status).toBe(200)
      expect(output?.output.body).toBe('hello')
      const requestInit = vi.mocked(globalThis.fetch).mock.calls
        .find(([url]) => url === '/api/products')?.[1] as RequestInit | undefined
      expect(requestInit?.headers).toEqual({ Accept: 'application/json', 'X-Weft-Actor': 'agent' })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('client_http_request built-in executor rejects external absolute URLs before fetch', async () => {
    const originalFetch = globalThis.fetch
    const fetchSpy = vi.fn(async () => new Response('external', { status: 200 }))
    globalThis.fetch = fetchSpy as typeof fetch
    try {
      const { runtime, submitCalls } = makeRuntime({
        toolName: 'client_http_request',
        autoExecuteClientHttp: true,
        suspendData: { method: 'GET', url: 'https://evil.example/api' },
      })
      await runtime.commands.sendMessage('hi')
      await waitFor(() => submitCalls.length === 1)
      await runtime.commands.dispose()
      expect(fetchSpy.mock.calls.some(([url]) => url === 'https://evil.example/api')).toBe(false)
      expect(submitCalls[0]?.outputs?.[0]).toMatchObject({
        toolCallId: 'call-1',
        isError: true,
      })
      const output = submitCalls[0]?.outputs?.[0] as { output?: { message?: string } } | undefined
      expect(output?.output?.message).toContain('same-origin')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('unregistered tool surfaces as session_status, never a permission_request, and does not submit', async () => {
    const { runtime, submitCalls, items } = makeRuntime({ toolName: 'mystery-tool' })
    await runtime.commands.sendMessage('hi')
    // No submit should happen; allow a tick for the (absent) async path.
    await new Promise((r) => setTimeout(r, 20))
    await runtime.commands.dispose()
    expect(submitCalls).toEqual([])
    const statuses = items.filter((i) => i.type === 'session_status').map((i) => (i as { status: string }).status)
    expect(statuses.some((s) => s.startsWith('tool_suspended: mystery-tool') && s.includes('no handler'))).toBe(true)
    expect(items.some((i) => i.type === 'permission_requested')).toBe(false)
  })

  test('handler failure submits an is_error output and does not reject', async () => {
    const { runtime, submitCalls } = makeRuntime({
      toolHandlers: { echo: { execute: async () => { throw new Error('boom') } } },
    })
    await runtime.commands.sendMessage('hi')
    await waitFor(() => submitCalls.length === 1)
    await runtime.commands.dispose()
    expect(submitCalls[0]?.outputs?.[0]).toMatchObject({ toolCallId: 'call-1', isError: true })
  })

  test('submitToolOutputs failure does not become an unhandled rejection (guarded catch)', async () => {
    const { runtime, submitCalls, items } = makeRuntime({
      toolHandlers: { echo: { execute: async () => { throw new Error('handler boom') } } },
      submitFails: true,
    })
    await runtime.commands.sendMessage('hi')
    // First submit (output) throws -> catch tries error submit -> that also throws -> guarded.
    await new Promise((r) => setTimeout(r, 30))
    await runtime.commands.dispose()
    expect(submitCalls.length).toBeGreaterThanOrEqual(1)
    const statuses = items.filter((i) => i.type === 'session_status').map((i) => (i as { status: string }).status)
    expect(statuses.some((s) => s.includes('handler failed'))).toBe(true)
  })

  test('no active run surfaces as session_status instead of a silent drop', async () => {
    const { runtime, submitCalls, items } = makeRuntime({ activeRunId: null })
    await runtime.commands.sendMessage('hi')
    await new Promise((r) => setTimeout(r, 20))
    await runtime.commands.dispose()
    expect(submitCalls).toEqual([])
    const statuses = items.filter((i) => i.type === 'session_status').map((i) => (i as { status: string }).status)
    expect(statuses.some((s) => s.includes('no active run'))).toBe(true)
  })

  test('tool_suspended turnId resumes after reconnect when no active run is held locally', async () => {
    const { runtime, submitCalls } = makeRuntime({
      toolHandlers: { echo: { execute: async (args) => (args as { text: string }).text } },
      activeRunId: null,
      eventTurnId: 'run-from-event',
    })
    await runtime.commands.sendMessage('hi')
    await waitFor(() => submitCalls.length === 1)
    await runtime.commands.dispose()
    expect(submitCalls).toEqual([
      { sessionId: 'session-from-flitro', runId: 'run-from-event', outputs: [{ toolCallId: 'call-1', output: 'hi' }] },
    ])
  })
})

describe('Provider Flitro — sourceTools MCP mapping', () => {
  test('extracts mcpServerNames from mcp-server sourceTools', async () => {
    const createRunCalls: Array<{ mcpServerNames?: string[] }> = []
    const client = {
      async createRun(_sessionId: string, _message: string, options?: { mcpServerNames?: string[] }) {
        createRunCalls.push({ mcpServerNames: options?.mcpServerNames })
        return { run_id: 'run-1', session_id: 'new-session', status: 'queued', execution_mode: 'chat', input_message: '', created_at: '', updated_at: '' }
      },
      async cancelRun() { return { status: 'canceled' } },
      async submitToolOutputs() { return { status: 'ok' } },
      timelineUrl(_sessionId: string) { return 'http://127.0.0.1:1/timeline' },
      getBearerToken() { return undefined },
      setToken() {},
    } as unknown as WeftHttpClient
    const runtime = createFlitroProviderRuntime({
      server: { baseUrl: 'http://127.0.0.1:1' },
      sessionId: 'new-session',
      candidates: appServerCandidates,
      auth: providerOwnedAuth(),
      now: () => 0,
      client,
      sourceTools: [
        { kind: 'mcp-server', sourceSlug: 'fs-server', transport: 'stdio', command: 'npx' },
        { kind: 'mcp-server', sourceSlug: 'http-api', transport: 'http', url: 'http://localhost:3000' },
      ],
      mcpServerNames: ['explicit-name'],
    })
    await runtime.commands.sendMessage('hi')
    await runtime.commands.dispose()

    expect(createRunCalls[0]?.mcpServerNames).toEqual(['fs-server', 'http-api', 'explicit-name'])
  })

  test('in-process sourceTools emit session_status warning', async () => {
    const items: TimelineItem[] = []
    const client = {
      async createSession() { return { session_id: 's1' } },
      async createRun() {
        return { run_id: 'r1', session_id: 's1', status: 'queued', execution_mode: 'chat', input_message: '', created_at: '', updated_at: '' }
      },
      async submitToolOutputs() { return { status: 'ok' } },
      timelineUrl(_sessionId: string) { return 'http://127.0.0.1:1/timeline' },
      getBearerToken() { return undefined },
      setToken() {},
    } as unknown as WeftHttpClient
    const driver = {
      async sendMessage(_input: { message: string }, sequencer: TimelineSequencer) {
        sequencer.append({ type: 'turn_completed', turnId: 'r1' })
      },
    }
    const runtime = createFlitroProviderRuntime({
      server: { baseUrl: 'http://127.0.0.1:1' },
      sessionId: 's1',
      candidates: appServerCandidates,
      auth: providerOwnedAuth(),
      now: () => 0,
      client,
      driver,
      sourceTools: [
        { kind: 'in-process', sourceSlug: 'internal', server: { name: 'internal', version: '1.0', tools: [] } },
      ],
    })
    runtime.events.connect((event) => items.push(event.item as TimelineItem))
    await runtime.commands.sendMessage('hi')
    await runtime.commands.dispose()

    const statuses = items
      .filter((i) => i.type === 'session_status')
      .map((i) => (i as { status: string }).status)
    expect(statuses.some((s) => s.includes('in-process MCP sources are not supported'))).toBe(true)
  })
})
