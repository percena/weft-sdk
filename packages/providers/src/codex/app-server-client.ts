import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { asRecord } from '@weft/core'
import type {
  CodexAppServerClient,
  CodexAppServerNotification,
  CodexAppServerRequest,
} from './app-server-driver.ts'

export interface CodexAppServerJsonRpcTransport {
  write(message: string): void | Promise<void>
  onMessage(handler: (message: unknown) => void): () => void
  /** Fired once when the transport dies unexpectedly (process exit/error). */
  onClose?(handler: () => void): () => void
  close?(): void
}

export interface CreateCodexAppServerJsonRpcClientOptions {
  transport: CodexAppServerJsonRpcTransport
  requestTimeoutMs?: number
  clientInfo?: {
    name: string
    title?: string
    version: string
  }
}

export interface CodexAppServerJsonRpcClient extends CodexAppServerClient {
  initialize(): Promise<void>
  close(): void
  /** Fired when the transport dies unexpectedly (not on explicit close()). */
  onClose(handler: () => void): () => void
}

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: number
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

interface PendingRequest {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000

export function createCodexAppServerJsonRpcClient(
  options: CreateCodexAppServerJsonRpcClientOptions,
): CodexAppServerJsonRpcClient {
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  const pending = new Map<number, PendingRequest>()
  const notificationHandlers = new Set<(notification: CodexAppServerNotification) => void>()
  const requestHandlers = new Set<(request: CodexAppServerRequest) => Promise<unknown>>()
  const closeHandlers = new Set<() => void>()
  let nextId = 1
  let closed = false

  // Reject pending requests and notify close handlers when the transport dies.
  // Guarded so an explicit close() (which already rejects pending) does not
  // re-trigger crash handling.
  options.transport.onClose?.(() => {
    if (closed) return
    for (const entry of pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(new Error('Codex app-server connection closed unexpectedly'))
    }
    pending.clear()
    for (const handler of closeHandlers) handler()
  })

  const unsubscribeTransport = options.transport.onMessage((message) => {
    void handleMessage(message)
  })

  async function request<T = unknown>(method: string, params?: unknown): Promise<T> {
    const id = nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`Codex app-server request timed out: ${method}`))
      }, timeoutMs)
      pending.set(id, { resolve: resolve as (result: unknown) => void, reject, timer })
      void Promise.resolve(options.transport.write(JSON.stringify({
        jsonrpc: '2.0',
        id,
        method,
        ...(params === undefined ? {} : { params }),
      }))).catch(error => {
        const entry = pending.get(id)
        if (!entry) return
        pending.delete(id)
        clearTimeout(entry.timer)
        entry.reject(error instanceof Error ? error : new Error(String(error)))
      })
    })
  }

  async function handleMessage(message: unknown): Promise<void> {
    const record = asRecord(message)
    if (typeof record.id === 'number' && typeof record.method === 'string') {
      await handleServerRequest(record.id, {
        id: record.id,
        method: record.method,
        params: record.params,
      })
      return
    }

    if (typeof record.id === 'number') {
      handleResponse(record as unknown as JsonRpcResponse)
      return
    }

    if (typeof record.method === 'string') {
      const notification = {
        method: record.method,
        params: record.params,
      }
      for (const handler of notificationHandlers) handler(notification)
    }
  }

  function handleResponse(response: JsonRpcResponse): void {
    const entry = pending.get(response.id)
    if (!entry) return
    pending.delete(response.id)
    clearTimeout(entry.timer)
    if (response.error) {
      entry.reject(new Error(response.error.message))
      return
    }
    entry.resolve(response.result)
  }

  async function handleServerRequest(id: number, request: CodexAppServerRequest): Promise<void> {
    const handler = requestHandlers.values().next().value as ((request: CodexAppServerRequest) => Promise<unknown>) | undefined
    if (!handler) {
      void options.transport.write(JSON.stringify({ jsonrpc: '2.0', id, result: {} }))
      return
    }

    try {
      const result = await handler(request)
      void options.transport.write(JSON.stringify({ jsonrpc: '2.0', id, result }))
    } catch (error) {
      void options.transport.write(JSON.stringify({
        jsonrpc: '2.0',
        id,
        error: {
          code: -32000,
          message: (error as Error).message,
        },
      }))
    }
  }

  return {
    async initialize() {
      await request('initialize', {
        // app-server `initialize` takes only clientInfo + capabilities; there is
        // no protocolVersion field (that concept belongs to MCP). The binary is
        // the source of truth for the protocol surface.
        //
        // Capabilities are intentionally empty: `experimental_api` is only
        // needed for `thread/start.dynamicTools` (deferred — no host execution
        // bridge yet) and `mcp_server_openai_form_elicitation`
        // is only needed if we serve MCP form elicitations (we decline them).
        // Declaring either without the corresponding handler would be
        // over-promising, so neither is advertised. Other available flags
        // (`request_attestation`, `opt_out_notification_methods`) are unused.
        capabilities: {},
        clientInfo: options.clientInfo ?? {
          name: 'weft',
          title: 'Weft',
          version: '0.1.0',
        },
      })
      void options.transport.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} }))
    },
    request,
    onNotification(handler) {
      notificationHandlers.add(handler)
      return () => notificationHandlers.delete(handler)
    },
    onRequest(handler) {
      requestHandlers.add(handler)
      return () => requestHandlers.delete(handler)
    },
    onClose(handler) {
      closeHandlers.add(handler)
      return () => closeHandlers.delete(handler)
    },
    close() {
      if (closed) return
      closed = true
      unsubscribeTransport()
      for (const entry of pending.values()) {
        clearTimeout(entry.timer)
        entry.reject(new Error('Codex app-server client closed'))
      }
      pending.clear()
      notificationHandlers.clear()
      requestHandlers.clear()
      closeHandlers.clear()
      options.transport.close?.()
    },
  }
}

export interface CreateCodexAppServerSubprocessClientOptions {
  executable?: string
  args?: string[]
  env?: Record<string, string>
  requestTimeoutMs?: number
}

export async function createCodexAppServerSubprocessClient(
  options: CreateCodexAppServerSubprocessClientOptions = {},
): Promise<CodexAppServerJsonRpcClient> {
  const transport = createNodeSubprocessTransport({
    executable: options.executable ?? 'codex',
    args: options.args ?? ['app-server'],
    env: options.env,
  })
  const client = createCodexAppServerJsonRpcClient({
    transport,
    requestTimeoutMs: options.requestTimeoutMs,
  })
  try {
    await client.initialize()
  } catch (error) {
    client.close()
    throw error
  }
  return client
}

function createNodeSubprocessTransport(options: {
  executable: string
  args: string[]
  env?: Record<string, string>
}): CodexAppServerJsonRpcTransport {
  const proc: ChildProcess = spawn(options.executable, options.args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: options.env ?? process.env,
  })
  const handlers = new Set<(message: unknown) => void>()
  const closeHandlers = new Set<() => void>()
  let closed = false
  let emittedClose = false

  if (!proc.stdout || !proc.stdin) {
    throw new Error('Failed to create subprocess with piped stdio')
  }

  // app-server diagnostics are written to stderr. Consume the stream even when
  // the host does not surface diagnostics yet, otherwise a verbose child can
  // block once its stderr pipe fills and leave turns waiting indefinitely.
  proc.stderr?.resume()

  const emitClose = (): void => {
    if (emittedClose) return
    emittedClose = true
    for (const handler of closeHandlers) handler()
  }

  // Surface unexpected process termination (crash, signal, ENOENT) so the
  // client can reject pending requests and the driver can fail the turn.
  proc.once('exit', () => {
    if (!closed) emitClose()
  })
  proc.once('error', () => {
    if (!closed) emitClose()
  })

  const rl = createInterface({ input: proc.stdout })
  rl.on('line', (line: string) => {
    const trimmed = line.trim()
    if (!trimmed) return
    try {
      const message = JSON.parse(trimmed)
      for (const handler of handlers) handler(message)
    } catch {
      // Ignore non-JSON app-server output.
    }
  })

  return {
    write(message) {
      if (closed) return
      proc.stdin!.write(`${message}\n`)
    },
    onMessage(handler) {
      handlers.add(handler)
      return () => handlers.delete(handler)
    },
    onClose(handler) {
      closeHandlers.add(handler)
      return () => closeHandlers.delete(handler)
    },
    close() {
      closed = true
      handlers.clear()
      closeHandlers.clear()
      rl.close()
      proc.kill()
    },
  }
}
