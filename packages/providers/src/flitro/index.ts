/**
 * @weft/providers/flitro
 *
 * Weft Runtime Provider for the Flitro Go Agent Server.
 *
 * Flitro is the 3rd AgentRuntime alongside Claude and Codex:
 *  - providers/claude  → Claude Agent SDK (native-sdk) / claude -p (cli-fallback)
 *  - providers/codex   → Codex app-server / codex exec (cli-fallback)
 *  - providers/flitro  → Flitro agentd HTTP API (app-server)
 *
 * Integration model:
 *  - Flitro runs as the Go backend (stateful, multi-tenant, concurrent)
 *  - This provider wraps Flitro's REST+SSE API as a Weft AgentRuntime
 *  - Weft policy, sources, and skills are forwarded as API parameters
 *  - The Weft UI (TurnCard, etc.) consumes the canonical timeline
 */

import {
  createRuntimeCapabilityReport,
  createRuntimeExtensionContext,
  sanitizeProviderSourceTools,
  type AgentRuntime,
  type PermissionMode,
  type ProviderSourceToolDescriptor,
  type RuntimeAuthDetection,
  type RuntimeCandidate,
  type RuntimeCapabilityReport,
  type RuntimeExtensionContext,
} from '@weft/runtime-core'
import {
  createTimelineCursor,
  parseTimelineEnvelope,
  type TimelineEnvelope,
  type TimelineItem,
  type TimelineSequencer,
} from '@weft/timeline'

import {
  createProviderRuntimeScaffold,
  type ProviderRuntimeDriverInput,
  type ProviderRuntimeScaffold,
} from '../shared/runtime-scaffold.ts'
import { createStandardExtensionCapabilities } from '../shared/capability-helpers.ts'
import { WeftHttpClient, type WeftHttpClientOptions } from './client/index.ts'
import { createFlitroDriver, type FlitroProviderRuntimeDriver } from './runtime-driver.ts'
import { createTimelineStream } from './client/index.ts'

// Re-export the standalone client (the providers/flitro API surface
// historically included the HTTP client and SSE streams that now live here).
// The client's structural TimelineEnvelope/TimelineStream are intentionally
// omitted: in Weft context the canonical types come from @weft/timeline and
// @weft/runtime-core.
export {
  WeftClient,
  WeftHttpClient,
  WeftHttpError,
  // session contract: WeftSseTimelineStream (bearer-token-in-URL constructor) is
  // intentionally NOT re-exported — instantiating it directly bakes the session
  // token into a URL (logs/proxies leak it). The public path is WeftClient.subscribe
  // (uses WeftFetchSseTimelineStream, header-based auth). The class stays internal
  // (createTimelineStream/weft-client construct it); only the options type is public
  // (WeftClient.subscribe's signature references it).
  WeftFetchSseTimelineStream,
  createTimelineStream,
  type WeftClientOptions,
  type TimelineSubscription,
  type WeftHttpClientOptions,
  type WeftSession,
  type WeftRun,
  type WeftCapabilityReport,
  type WeftPatchSessionOptions,
  type WeftModelInfo,
  type WeftModelListResult,
  type WeftTimelineItem,
  type WeftTimelineFetchResult,
  type WeftSseTimelineStreamOptions,
} from './client/index.ts'
export { createFlitroDriver } from './runtime-driver.ts'
export type { FlitroProviderRuntimeDriver, CreateFlitroDriverOptions } from './runtime-driver.ts'

// ─── Capability report ───────────────────────────────────────────────────────

export interface CreateFlitroRuntimeCapabilityReportOptions {
  candidates: RuntimeCandidate[]
  auth: RuntimeAuthDetection
  allowFallback?: boolean
  extensions?: RuntimeExtensionContext
}

export function createFlitroRuntimeCapabilityReport(
  options: CreateFlitroRuntimeCapabilityReportOptions,
): RuntimeCapabilityReport {
  const appServerAvailable = options.candidates.some(c => c.kind === 'app-server' && c.available)

  return createRuntimeCapabilityReport({
    provider: 'flitro',
    candidates: options.candidates,
    preferredRuntime: 'app-server',
    allowFallback: options.allowFallback,
    auth: options.auth,
    extensionCapabilities: createStandardExtensionCapabilities({
      strong: appServerAvailable,
      // Flitro is a remote server: every capability collapses to server
      // availability (no CLI-fallback "weak but partial" tier), so all the
      // gating flags are on and `degraded` is omitted (not `false`) when up.
      omitFalseDegraded: true,
      gateToolPolicy: true,
      policyReasonWeak: 'Flitro server is unavailable',
      sources: {
        credentialGateway: false,
        reasonWeak: 'Source tools require a running Flitro server',
      },
      skillsReasonWeak: 'Skill activation requires a running Flitro server',
      automations: {
        gateSupported: true,
        gateEventBus: true,
        schedulerHostWhenStrong: true,
        gatePromptAction: true,
        reasonWeak: 'Automations require a running Flitro server',
      },
      hostTools: {
        supported: appServerAvailable,
        sessionTools: false,
        workflowTransitions: false,
        browserActions: false,
        metadataWrites: appServerAvailable,
      },
    }),
  })
}

// ─── Provider runtime ────────────────────────────────────────────────────────

/** Custom tool handler for client-side execution (OpenAI function-calling model). */
export interface ToolHandler {
  description?: string
  execute: (args: Record<string, unknown>) => Promise<unknown>
}

/**
 * Allow-rule for the built-in browser-side `client_http_request` executor (S2).
 *
 * Auto-executing a suspended tool whose payload carries `{method, url}` turns
 * the user's browser into a same-origin CSRF surface: a server/model-controlled
 * payload could otherwise drive arbitrary authenticated same-origin requests
 * with no confirmation. By default nothing is auto-executed; provide one or more
 * of these rules (or set `autoExecuteClientHttp`) to deliberately opt specific
 * request shapes back in. A suspension is auto-executed only when it matches a
 * rule; anything else is surfaced to the host to handle explicitly.
 */
export interface ClientHttpAllowRule {
  /** Allowed HTTP method (case-insensitive). Omit or use '*' to allow any. */
  method?: string
  /** URL path prefix the request pathname must start with (e.g. '/api/'). */
  pathPrefix: string
}

const STRIP_HEADERS = new Set([
  'authorization', 'cookie', 'x-weft-actor', 'x-weft-session',
  'x-weft-end-user', 'x-weft-app', 'x-tenant-id',
])

const MAX_RESPONSE_SIZE = 262144 // 256 KB
const CLIENT_HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])

function resolveClientHttpRequestUrl(url: string | undefined): string {
  const raw = url?.trim() || '/'
  if (raw.startsWith('//')) {
    throw new Error('client_http_request default executor only allows same-origin URLs')
  }
  if (!/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(raw)) {
    return raw
  }
  const origin = globalThis.location?.origin
  if (origin) {
    const parsed = new URL(raw)
    if (parsed.origin === origin) return parsed.href
  }
  throw new Error('client_http_request default executor only allows same-origin URLs; use a relative URL or register a custom handler for external URLs')
}

/** Default executor for client_http_request tools — makes a browser-side fetch with security defaults. */
async function executeClientHttpRequest(
  args: { method?: string; url?: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  const method = (args.method ?? 'GET').toUpperCase()
  if (!CLIENT_HTTP_METHODS.has(method)) {
    throw new Error(`client_http_request method is not allowed: ${method}`)
  }
  const url = resolveClientHttpRequestUrl(args.url)
  const safeHeaders: Record<string, string> = {}
  for (const [k, v] of Object.entries(args.headers ?? {})) {
    const normalized = k.toLowerCase()
    if (!STRIP_HEADERS.has(normalized) && !normalized.startsWith('x-weft-')) safeHeaders[k] = v
  }
  safeHeaders['X-Weft-Actor'] = 'agent'
  const response = await fetch(url, {
    method,
    headers: safeHeaders,
    body: args.body || undefined,
    credentials: 'same-origin',
  })
  const text = await response.text()
  const body = text.length > MAX_RESPONSE_SIZE
    ? `${text.slice(0, MAX_RESPONSE_SIZE)}...[truncated]`
    : text
  const respHeaders: Record<string, string> = {}
  response.headers.forEach((v, k) => { respHeaders[k] = v })
  return { status: response.status, headers: respHeaders, body }
}

export interface CreateFlitroProviderRuntimeOptions
  extends CreateFlitroRuntimeCapabilityReportOptions {
  /** Flitro server connection options */
  server: WeftHttpClientOptions
  /** Session ID (required). */
  sessionId: string
  /** Epoch string for the timeline (default: derived from sessionId) */
  epoch?: string
  now?: () => number
  /** LLM model to use */
  model?: string
  /** Skills to activate per turn */
  skillNames?: string[]
  /** MCP servers to attach per turn */
  mcpServerNames?: string[]
  /** Provider-neutral source tool descriptors (unified with Claude/Codex) */
  sourceTools?: ProviderSourceToolDescriptor[]
  /** Canonical permission_mode default ('explore' | 'ask' | 'auto') for runs without a per-message mode. */
  permissionMode?: PermissionMode
  /** Injected runtime extensions (policy, sources, etc.) */
  extensions?: RuntimeExtensionContext
  /** Pre-built driver (for testing) */
  driver?: FlitroProviderRuntimeDriver
  /** Pre-built HTTP client (for testing — otherwise built from `server`) */
  client?: WeftHttpClient
  /** Custom tool handlers for client-side execution (OpenAI function-calling model) */
  toolHandlers?: Record<string, ToolHandler>
  /**
   * S2 opt-in: auto-execute suspended tools that carry the explicit
   * `client_http_request` name via the built-in same-origin browser executor.
   * Defaults to `false` — without this (or a matching {@link clientHttpAllowlist}
   * rule) an HTTP-shaped suspension is surfaced to the host rather than executed,
   * closing the same-origin CSRF surface. Only enable this if the session's tool
   * set is trusted to drive authenticated same-origin requests from the browser.
   */
  autoExecuteClientHttp?: boolean
  /**
   * S2 opt-in: allowlist of method+path rules. Any HTTP-shaped suspension (from
   * any tool name) whose `{method, url}` matches a rule is auto-executed via the
   * built-in same-origin browser executor. Empty/omitted ⇒ no shape-based
   * auto-execution.
   */
  clientHttpAllowlist?: ClientHttpAllowRule[]
}

/**
 * Create a Weft AgentRuntime backed by the Flitro Go server.
 *
 * Usage:
 * ```ts
 * const runtime = createFlitroProviderRuntime({
 *   server: { baseUrl: 'http://localhost:8080', token: 'secret' },
 *   candidates: [{ kind: 'app-server', available: true }],
 *   auth: { mode: 'provider-owned', configured: true, source: 'flitro' },
 *   sessionId: 'my-session',
 * })
 * await runtime.preflight()
 * await runtime.commands.sendMessage('Hello!')
 * ```
 */
export function createFlitroProviderRuntime(
  options: CreateFlitroProviderRuntimeOptions,
): AgentRuntime {
  const report = createFlitroRuntimeCapabilityReport(options)
  const extensions = createRuntimeExtensionContext(options.extensions)

  const client = options.client ?? new WeftHttpClient(options.server)
  const resolvedSessionId = options.sessionId ?? ''
  const epoch = options.epoch ?? (resolvedSessionId ? `flitro-${resolvedSessionId}` : 'flitro-pending')
  const now = options.now ?? (() => Date.now())

  // Resolve MCP server names from sourceTools (unified with Claude/Codex).
  // Flitro's server-side architecture means MCP servers must be pre-registered
  // on the Go backend — we pass names, not configs.
  const sourceToolMcpNames: string[] = []
  let hasInProcessSources = false
  for (const sourceTool of sanitizeProviderSourceTools(options.sourceTools)) {
    if (sourceTool.kind === 'mcp-server') {
      sourceToolMcpNames.push(sourceTool.sourceSlug)
    } else if (sourceTool.kind === 'in-process') {
      hasInProcessSources = true
    }
  }
  const resolvedMcpServerNames = [
    ...new Set([
      ...sourceToolMcpNames,
      ...(options.mcpServerNames ?? []),
    ]),
  ]

  // The scaffold owns dispatch / state sync / sequencer / commands / preflight /
  // fetchTimeline / getState. Flitro only contributes provider-specific glue:
  // session creation, SSE ingestion, HTTP transport, tool-suspension bridging.
  // The closures below reference `scaffold` (assigned after construction); they
  // are only ever invoked asynchronously — after `scaffold` is set — so the
  // late binding is safe.
  const ctx: { scaffold: ProviderRuntimeScaffold | undefined } = { scaffold: undefined }
  let runtimeDriver: FlitroProviderRuntimeDriver | undefined = options.driver
  let sseStream: ReturnType<typeof createTimelineStream> | undefined
  let inProcessWarned = false

  function appendSessionStatus(status: string): void {
    ctx.scaffold!.sequencer.append({ type: 'session_status', status } as TimelineItem)
  }

  // isHttpRequestSuspend reports whether a tool's suspend payload is an HTTP
// request (method + url) — true for client_http_request and for named
// openapi-toolset tools with execution:client. Being HTTP-shaped is NECESSARY
// but no longer SUFFICIENT to auto-execute (S2): auto-execution additionally
// requires an explicit opt-in (`autoExecuteClientHttp` for the marker name, or a
// matching `clientHttpAllowlist` rule).
function isHttpRequestSuspend(args: Record<string, unknown>): boolean {
  return typeof args?.method === 'string' && typeof args?.url === 'string'
}

// matchesClientHttpAllowlist reports whether an HTTP-shaped suspend payload is
// permitted by an explicit method+path allowlist. The URL is resolved against
// the current origin (or a neutral base in non-browser contexts) so rules match
// on pathname regardless of relative/absolute form; cross-origin safety is still
// enforced downstream by executeClientHttpRequest.
function matchesClientHttpAllowlist(
  args: Record<string, unknown>,
  allowlist: ClientHttpAllowRule[],
): boolean {
  const method = (typeof args.method === 'string' ? args.method : 'GET').toUpperCase()
  const rawUrl = typeof args.url === 'string' ? args.url : ''
  let pathname: string
  try {
    const base = globalThis.location?.origin ?? 'http://localhost'
    pathname = new URL(rawUrl, base).pathname
  } catch {
    return false
  }
  return allowlist.some(rule => {
    const ruleMethod = (rule.method ?? '*').toUpperCase()
    if (ruleMethod !== '*' && ruleMethod !== method) return false
    return pathname.startsWith(rule.pathPrefix)
  })
}

// S2: decide whether an HTTP-shaped suspension may be auto-executed by the
// built-in same-origin browser executor. Default is NO — a suspension is only
// auto-executed when (a) it uses the explicit `client_http_request` marker AND
// the integrator set `autoExecuteClientHttp`, or (b) it matches an explicit
// `clientHttpAllowlist` method+path rule. Everything else is surfaced to the
// host, closing the same-origin CSRF surface.
function shouldAutoExecuteClientHttp(name: string, args: Record<string, unknown>): boolean {
    if (!isHttpRequestSuspend(args)) return false
    if (name === 'client_http_request' && options.autoExecuteClientHttp) return true
    const allowlist = options.clientHttpAllowlist
    if (allowlist && allowlist.length > 0) return matchesClientHttpAllowlist(args, allowlist)
    return false
  }

  async function handleToolSuspension(callId: string, name: string, suspendData: unknown, eventRunId?: string): Promise<void> {
    if (ctx.scaffold!.getState().status === 'disposed') return
    const runId = eventRunId || getDriver().getActiveRunId?.()
    if (!runId || !resolvedSessionId) {
      // No active run to resume — surface so the host can observe the drop
      // instead of silently losing the suspension.
      appendSessionStatus(`tool_suspended: ${name} (no active run to resume)`)
      return
    }

    try {
      let output: unknown
      const args = (suspendData ?? {}) as Record<string, unknown>

      if (options.toolHandlers?.[name]) {
        output = await options.toolHandlers[name].execute(args)
      } else if (shouldAutoExecuteClientHttp(name, args)) {
        // client_http_request (generic HTTP tool) OR a named openapi-toolset
        // tool with execution:client — both suspend with an {method,url,...}
        // payload the browser executes locally (private/local API reachability).
        // S2: this branch now runs ONLY behind an explicit opt-in (see
        // shouldAutoExecuteClientHttp) so a server/model-controlled payload can
        // no longer silently drive authenticated same-origin requests.
        output = await executeClientHttpRequest(args as { method?: string; url?: string; headers?: Record<string, string>; body?: string })
      } else {
        // No handler registered / not opted-in — surface observably. We
        // deliberately do NOT dispatch a permission_request here: that maps to
        // the permission-response endpoint, not tool-outputs, so it could never
        // actually resume the tool and would wedge the runtime in an
        // unresolvable wait. Hosts should register a handler via `toolHandlers`,
        // opt into auto-execution via `autoExecuteClientHttp` / a
        // `clientHttpAllowlist` rule, or call `commands.resumeTool`.
        appendSessionStatus(`tool_suspended: ${name} (no handler registered; provide one via toolHandlers)`)
        return
      }

      if (ctx.scaffold!.getState().status === 'disposed') return
      await client.submitToolOutputs(resolvedSessionId, runId, [
        { toolCallId: callId, output },
      ])
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      // Best-effort error submission — guard so a second failure (e.g. the
      // submit call itself failing) doesn't become an unhandled rejection
      // (this function is invoked fire-and-forget via `void`).
      try {
        await client.submitToolOutputs(resolvedSessionId, runId, [
          { toolCallId: callId, output: { message: error }, isError: true },
        ])
      } catch {
        appendSessionStatus(`tool_suspended: ${name} (handler failed: ${error}; submission also failed)`)
      }
    }
  }

  function getDriver(): FlitroProviderRuntimeDriver {
    if (runtimeDriver) return runtimeDriver
    runtimeDriver = createFlitroDriver({
      client,
      sessionId: resolvedSessionId,
      model: options.model,
      skillNames: options.skillNames,
      mcpServerNames: resolvedMcpServerNames,
      permissionMode: options.permissionMode,
    })
    return runtimeDriver
  }

  /** Deferred transport: POST a Flitro Run (one message = one turn). The
   *  timeline events flow back via the SSE stream set up in `ensureSession`. */
  async function sendToFlitro(input: ProviderRuntimeDriverInput, _sequencer: TimelineSequencer): Promise<void> {
    if (hasInProcessSources && !inProcessWarned) {
      inProcessWarned = true
      appendSessionStatus('in-process MCP sources are not supported by Flitro server-side architecture; use sdkOptions.mcpServers via a provider that supports type:sdk')
    }
    await getDriver().sendMessage(input, _sequencer)
  }

  async function ensureSession(): Promise<{ sessionId: string; epoch?: string }> {
    if (resolvedSessionId) return { sessionId: resolvedSessionId, epoch }
    throw new Error('Flitro provider requires a sessionId — create a session via the server API before initializing the runtime')
  }

  function connectSse(): void {
    if (!resolvedSessionId || sseStream) return
    sseStream = createTimelineStream({
      url: client.timelineUrl(resolvedSessionId),
      getBearerToken: () => client.getBearerToken(),
      onTokenExpired: options.server.onTokenExpired
        ? async () => {
            const fresh = await options.server.onTokenExpired?.()
            if (fresh) client.setToken(fresh)
            return fresh
          }
        : undefined,
    })
    // SDK-R-7: the scaffold's PushTimelineStream defaults to connected=true
    // (in-process providers have no transport to die), but a remote-SSE flitro
    // session is NOT connected until the first event arrives. Previously
    // setConnected(true) fired at SSE *initiation*, so isConnected() reported
    // true for the entire (possibly failing) reconnect-attempt window until
    // final give-up. Now the transport starts not-connected and flips to true
    // only on the first successful event (establishment).
    ctx.scaffold!.stream.setConnected(false)
    let sseEstablished = false
    sseStream.connect(
      // The client package types `item` as unknown; the server emits the
      // canonical Weft envelope, so ingest it verbatim — preserving the
      // server's seq/epoch — via the scaffold's replica path.
      (envelope) => {
        if (!sseEstablished) {
          sseEstablished = true
          ctx.scaffold!.stream.setConnected(true)
        }
        ctx.scaffold!.appendEnvelope(envelope as TimelineEnvelope)
      },
      (err) => {
        // transport contract: the terminal SSE error (give-up after
        // maxReconnectAttempts) was previously discarded here. Forward it into
        // the scaffold stream lifecycle so the hook's `error` state fires on
        // real transport death, and mark the transport disconnected so the
        // hook's `isConnected` (read off runtime.events.isConnected()) stops
        // reporting a live connection that isn't there.
        ctx.scaffold!.stream.setConnected(false)
        sseEstablished = false
        ctx.scaffold!.stream.emitError(err)
        // SDK-R-7 residual: drop the sseStream reference so a subsequent
        // connectSse() can re-initiate a fresh transport. There is no
        // auto-trigger for retry today — the hook's onClose path does a one-shot
        // fetch catchup, not an SSE restart; a remount or an explicit reconnect
        // call is required to revive the transport. Documented as accepted
        // within transport contract's stated scope (surface the death).
        sseStream = undefined
      },
    )
  }

  const scaffold = createProviderRuntimeScaffold({
    provider: 'flitro',
    sessionId: resolvedSessionId,
    epoch,
    now,
    report,
    extensions,
    completion: 'deferred',
    dedup: true,
    resolveSessionId: ensureSession,
    onMessageDrained: sendToFlitro,
    onToolSuspended: (item) => {
      void handleToolSuspension(item.callId, item.name, item.suspendData, item.turnId)
    },
    remoteTimelineFetch: async (request) => {
      if (!resolvedSessionId) return undefined
      const afterSeq = request.cursor?.afterSeq ?? 0
      // catchup-epoch contract: send the last-seen epoch on the catchup fetch so flitro
      // detects a stale cursor after a restart and replays durable history
      // from 0 (its fetch handler resets afterSeq=0 when reqEpoch !=
      // SessionEpoch). Without it, a stale-high afterSeq returns empty under
      // the new epoch and the gap is never backfilled.
      const epoch = request.cursor?.epoch
      const result = await client.fetchTimeline(resolvedSessionId, afterSeq, request.limit, epoch)
      return {
        // session contract/X-B: validate + leniently decode each fetched envelope instead
        // of the unvalidated `as TimelineEnvelope[]` cast. Catches fetch-path
        // shape skew the SSE path already guards.
        items: result.items.map(parseTimelineEnvelope),
        nextCursor: createTimelineCursor({
          epoch: result.nextCursor.epoch,
          afterSeq: result.nextCursor.afterSeq,
        }),
        hasGap: result.hasGap,
      }
    },
    getDriver: () => getDriver(),
    onDispose: () => {
      sseStream?.disconnect()
      sseStream = undefined
    },
  })
  ctx.scaffold = scaffold

  // Connect the SSE transport immediately if the session ID is known. Done
  // AFTER ctx.scaffold is assigned so connectSse's synchronous setConnected
  // runs against a live scaffold reference (the onEvent/onError callbacks are
  // deferred, so they were always fine — transport contract's synchronous setConnected is
  // what made the ordering matter).
  if (resolvedSessionId) {
    connectSse()
  }

  return scaffold
}

// ─── Embed runtime factory ───────────────────────────────────────────────────

export interface CreateFlitroEmbedRuntimeOptions {
  /** Flitro server base URL, as returned by `POST /v1/sessions`. */
  baseUrl: string
  /** Scoped session token, as returned by `POST /v1/sessions`. */
  token: string
  /** Session bound to the token, as returned by `POST /v1/sessions`. */
  sessionId: string
  /** Re-fetch a token from the host backend when the current one expires. */
  onTokenExpired?: () => Promise<string | undefined> | string | undefined
  epoch?: string
  now?: () => number
  extensions?: RuntimeExtensionContext
  /**
   * Default permission_mode ('explore' | 'ask' | 'auto') for runs without a
   * per-message mode. Optional — the embed panel typically drives this
   * per-message and relies on weftd's session-sealed default (`ask`).
   */
  permissionMode?: PermissionMode
  /** Skills to activate per turn (subset of the session's sealed skills). */
  skillNames?: string[]
  /** MCP servers to attach per turn (subset of the session's sealed set). */
  mcpServerNames?: string[]
  /** Custom tool handlers for client-side execution (OpenAI function-calling model). */
  tools?: Record<string, ToolHandler>
  /**
   * S2 opt-in: auto-execute suspended `client_http_request` tools via the
   * built-in same-origin browser executor. Defaults to `false` (surface to the
   * host). See {@link CreateFlitroProviderRuntimeOptions.autoExecuteClientHttp}.
   */
  autoExecuteClientHttp?: boolean
  /**
   * S2 opt-in: method+path allowlist for shape-based auto-execution of
   * HTTP-shaped suspensions. See
   * {@link CreateFlitroProviderRuntimeOptions.clientHttpAllowlist}.
   */
  clientHttpAllowlist?: ClientHttpAllowRule[]
}

/**
 * Create an AgentRuntime for an embedded (third-party website) chat panel.
 *
 * The host backend bootstraps the session via weftd's `POST /v1/sessions`
 * (with its developer API key) and hands `{ baseUrl, token, sessionId }` to the
 * browser. Execution mode, permission envelope, approval policy, and the tool
 * whitelist are fixed server-side, so no runtime auth or policy configuration
 * is needed here.
 */
export function createFlitroEmbedRuntime(
  options: CreateFlitroEmbedRuntimeOptions,
): AgentRuntime {
  return createFlitroProviderRuntime({
    server: {
      baseUrl: options.baseUrl,
      token: options.token,
      onTokenExpired: options.onTokenExpired,
    },
    sessionId: options.sessionId,
    epoch: options.epoch,
    now: options.now,
    extensions: options.extensions,
    permissionMode: options.permissionMode,
    skillNames: options.skillNames,
    mcpServerNames: options.mcpServerNames,
    toolHandlers: options.tools,
    autoExecuteClientHttp: options.autoExecuteClientHttp,
    clientHttpAllowlist: options.clientHttpAllowlist,
    candidates: [{ kind: 'app-server', available: true }],
    auth: { mode: 'provider-owned', configured: true, source: 'flitro-embed' },
  })
}

