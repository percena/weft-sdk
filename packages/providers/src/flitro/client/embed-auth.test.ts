import { createServer, type ServerResponse } from 'node:http'
import { afterEach, describe, expect, test } from 'vitest'

import { WeftHttpClient } from './http-client.ts'

const servers: Array<ReturnType<typeof createServer>> = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => closeServer(server)))
})

describe('WeftHttpClient embed auth', () => {
  test('sends the scoped token as bearer and omits the tenant header', async () => {
    let auth = ''
    let tenant: string | undefined
    const server = createServer((req, res) => {
      auth = req.headers.authorization ?? ''
      tenant = req.headers['x-tenant-id'] as string | undefined
      writeJson(res, 200, { session_id: 's1' })
    })
    servers.push(server)
    const baseUrl = await listen(server)

    const client = new WeftHttpClient({ baseUrl, token: 'scoped-jwt' })
    await client.getSession('s1')

    expect(auth).toBe('Bearer scoped-jwt')
    expect(tenant).toBeUndefined()
  })

  test('refreshes via onTokenExpired on 401 and retries once', async () => {
    const seen: string[] = []
    const server = createServer((req, res) => {
      seen.push(req.headers.authorization ?? '')
      if (seen.length === 1) {
        writeJson(res, 401, { error: 'unauthorized' })
        return
      }
      writeJson(res, 200, { session_id: 's1' })
    })
    servers.push(server)
    const baseUrl = await listen(server)

    let refreshed = 0
    const client = new WeftHttpClient({
      baseUrl,
      token: 'stale-jwt',
      onTokenExpired: () => {
        refreshed++
        return 'fresh-jwt'
      },
    })
    const session = await client.getSession('s1')

    expect(refreshed).toBe(1)
    expect(seen).toEqual(['Bearer stale-jwt', 'Bearer fresh-jwt'])
    expect(session.session_id).toBe('s1')
    expect(client.getBearerToken()).toBe('fresh-jwt')
  })

  test('surfaces the 401 when no refresh callback is configured', async () => {
    const server = createServer((_req, res) => writeJson(res, 401, { error: 'unauthorized' }))
    servers.push(server)
    const baseUrl = await listen(server)

    const client = new WeftHttpClient({ baseUrl, token: 'stale-jwt' })
    await expect(client.getSession('s1')).rejects.toThrow('Weft HTTP 401')
  })

  test('refreshToken returns the Weft Server token refresh response shape', async () => {
    let body = ''
    const server = createServer((req, res) => {
      body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        expect(req.url).toBe('/v1/sessions/s1/token')
        expect(req.headers.authorization).toBe('Bearer tenant-key')
        writeJson(res, 200, { session_id: 's1', token: 'fresh', expires_at: 1781690000 })
      })
    })
    servers.push(server)
    const baseUrl = await listen(server)

    const client = new WeftHttpClient({ baseUrl, token: 'tenant-key' })
    const refreshed = await client.refreshToken('s1', { ttlSeconds: 120 })

    expect(JSON.parse(body)).toEqual({ ttl_seconds: 120 })
    expect(refreshed).toEqual({ session_id: 's1', token: 'fresh', expires_at: 1781690000 })
  })
})

async function listen(server: ReturnType<typeof createServer>): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (typeof address === 'object' && address) return `http://127.0.0.1:${address.port}`
  throw new Error('failed to bind test server')
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close(err => (err ? reject(err) : resolve())),
  )
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

describe('WeftFetchSseTimelineStream lifecycle', () => {
  test('connect after disconnect revives the stream', async () => {
    let connections = 0
    const server = createServer((_req, res) => {
      connections++
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`event: timeline\ndata: ${JSON.stringify({ sessionId: 's1', provider: 'flitro', seq: connections, epoch: 'e1', timestamp: 1, item: {} })}\n\n`)
      // keep the connection open; the client aborts it on disconnect
    })
    servers.push(server)
    const baseUrl = await listen(server)

    const { WeftFetchSseTimelineStream } = await import('./timeline-stream.ts')
    const stream = new WeftFetchSseTimelineStream({ url: `${baseUrl}/v1/sessions/s1/timeline` })

    const first = await new Promise((resolve) => stream.connect((e) => resolve(e.seq)))
    expect(first).toBe(1)

    stream.disconnect()
    expect(stream.isConnected()).toBe(false)

    // A second consumer (e.g. a remounted chat panel) must get a live stream,
    // not a permanently disposed one.
    const second = await new Promise((resolve) => stream.connect((e) => resolve(e.seq)))
    expect(second).toBe(2)
    expect(connections).toBe(2)

    stream.disconnect()
  })
})
