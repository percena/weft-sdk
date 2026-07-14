import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { afterEach, describe, expect, test } from 'vitest'

import { WeftHttpClient } from './http-client.ts'

const servers: Array<ReturnType<typeof createServer>> = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => closeServer(server)))
})

describe('WeftHttpClient', () => {
  test('sends structured input answers on permission response requests', async () => {
    let receivedBody: unknown
    const server = createServer(async (req, res) => {
      receivedBody = await readJsonBody(req)
      writeJson(res, 200, {
        ok: true,
        type: 'input_request',
        requestId: (receivedBody as { requestId?: string }).requestId,
      })
    })
    servers.push(server)
    const baseUrl = await listen(server)
    const client = new WeftHttpClient({ baseUrl })

    await client.respondToPermission('session-1', 'input-1', true, {
      remember: true,
      comment: 'yes, proceed',
    })

    expect(receivedBody).toEqual({
      requestId: 'input-1',
      allowed: true,
      remember: true,
      comment: 'yes, proceed',
    })
  })

  test('forwards the structured `detail` object on the permission response wire', async () => {
    let receivedBody: unknown
    const server = createServer(async (req, res) => {
      receivedBody = await readJsonBody(req)
      writeJson(res, 200, { ok: true, type: 'input_request', requestId: 'input-2' })
    })
    servers.push(server)
    const baseUrl = await listen(server)
    const client = new WeftHttpClient({ baseUrl })

    const detail = { updatedInput: { path: '/safe' }, interrupt: true }
    await client.respondToPermission('session-1', 'input-2', false, {
      remember: false,
      detail,
    })

    // The weftd handler currently ignores `detail` (only reads `comment`),
    // but it must still be carried on the wire so weftd/Flitro can consume
    // updatedInput/interrupt once they gain support (additive, non-breaking).
    expect(receivedBody).toEqual({
      requestId: 'input-2',
      allowed: false,
      remember: false,
      detail,
    })
  })

  test('listProviderModels GETs /v1/provider/models?provider=... and returns the discovery shape', async () => {
    let receivedUrl = ''
    const server = createServer((req, res) => {
      receivedUrl = req.url ?? ''
      writeJson(res, 200, {
        models: ['glm-5.2', 'deepseek-v4-flash'],
        source: 'gateway',
        default_model: 'glm-5.2',
        default_effort: 'high',
        base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      })
    })
    servers.push(server)
    const baseUrl = await listen(server)
    const client = new WeftHttpClient({ baseUrl })

    const result = await client.listProviderModels('claude')

    expect(receivedUrl).toBe('/v1/provider/models?provider=claude')
    expect(result.models).toEqual(['glm-5.2', 'deepseek-v4-flash'])
    expect(result.source).toBe('gateway')
    expect(result.defaultModel).toBe('glm-5.2')
    expect(result.defaultEffort).toBe('high')
  })
})

async function listen(server: ReturnType<typeof createServer>): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('server did not bind to a TCP port')
  return `http://127.0.0.1:${addr.port}`
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
  })
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk))
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw) return undefined
  return JSON.parse(raw)
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}
