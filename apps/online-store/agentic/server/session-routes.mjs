// weftd chat-session backend + /v1 reverse proxy — parameterized extract of
// apps/store-agentic/server/shop-server.mjs (CORS+OPTIONS, X-Weft-Actor,
// weftdUrl/weftdRequest/weftdPathPrefix/publicBaseURL, the POST /api/chat/session
// + :id/token routes, the guarded SSE fan-out) with `proxyToWeftd` reproduced
// VERBATIM from apps/online-store/server/shop-server.mjs:230-287 (the
// TLS-handshake retry, headersSent gating, transient-error regex — battle-tested
// production code, copied byte-for-byte by mandate). One deliberate deviation: the
// upstream `headers` are built via `proxyHeaders(...)` (an allowlist) instead of
// `{ ...req.headers }` so Cookie + hop-by-hop headers are never forwarded to
// weftd — the TLS retry / headersSent / transient-error logic is unchanged.
//
// `writeJSON` is a hoisted module-scope `function` (NOT an in-factory `const`)
// — v1 declared it after proxyToWeftd, a temporal-dead-zone forward-ref hazard;
// hoisting it removes the TDZ so wireSessionRoutes + proxyToWeftd call it freely.
//
// Interface (module-export approach — Task 3's scaffold injects a single call):
//   wireSessionRoutes(server, { weftdBase, apiKey, tenantId, ensureApp, weftdAPI,
//                               state, sseClients, sessions })
// It wraps the server's existing 'request' listener (store-classic's REST +
// static handler) with a single-writer wrapper: CORS/OPTIONS + X-Weft-Actor +
// /api/chat/* + /v1/* are handled here; everything else delegates to the
// original listener. This avoids the double-listener race (two handlers writing
// the same response). If `state` is provided, its onEvent is re-wired to the
// guarded SSE fan-out (state.onEvent REPLACES, so store-classic's unguarded
// broadcast is superseded — no double-fire). sseClients/sessions are shared
// with store-classic's own /api/events + cookie-session machinery (in scope at
// the scaffold's injection point inside createShopServer).

import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

// Hoisted module-scope function (binding req #2 — avoids v1's in-factory const
// TDZ). Called by both wireSessionRoutes' routes + the verbatim proxyToWeftd.
function writeJSON(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

// ════════════════════════════════════════════════════════════════════════
// SECURITY (see references/security-contract.md — Tier 1, enforced + tested)
// The helpers below are module-level + EXPORTED so security.test.mjs can unit-
// test them; wireSessionRoutes wires them into the request flow. Do NOT weaken
// (fail-open ownership, non-streaming body read, denylist proxy headers, module-
// scope CORS const) — the guard catches a regression.
// ════════════════════════════════════════════════════════════════════════

// Body-size caps to prevent memory-exhaustion DoS (security-contract §4).
// A single large POST body to readJSON or the /v1 proxy would otherwise
// be fully buffered with no limit (Buffer.concat / string concat) → unbounded
// memory growth. Content-Length is spoofable, so readJSON reads per-chunk.
export const MAX_JSON_BODY = 1 << 20   // 1 MiB for JSON API bodies
export const MAX_PROXY_BODY = 10 << 20 // 10 MiB for proxied chat traffic (tool outputs can be larger)

// Minimal body reader (the session POST routes .catch it to {} on parse failure;
// does not depend on state.mjs's HttpError, keeping this module zero-dep).
export async function readJSON(req) {
  let buf = ''
  let len = 0
  for await (const c of req) {
    len += c.length
    if (len > MAX_JSON_BODY) {
      throw Object.assign(new Error('request body too large'), { status: 413 })
    }
    buf += c
  }
  if (!buf) return {}
  try { return JSON.parse(buf) } catch { throw Object.assign(new Error('invalid json body'), { status: 400 }) }
}

// SECURITY (security-contract §6): CORS per-request allowlist.
// Never use `*` with cookie-authenticated sessions — it is inert for credentialed
// cross-origin fetches and signals "wide open" to integrators copying this
// template. Reflect the request Origin against `DEMO_CORS_ORIGIN` (comma-
// separated exact origins); an explicit allowlist match enables
// `Access-Control-Allow-Credentials`. Unset = dev-only permissive origin
// reflection WITHOUT credentials (the Vite dev server on :5173 hitting the shop
// on :19745) — equivalent to `*` for non-credentialed reads, inert for
// credentialed, so it never widens the cookie surface. Production MUST set
// DEMO_CORS_ORIGIN to its exact origins to enable credentialed cross-origin.
//
// Read DEMO_CORS_ORIGIN PER REQUEST, not at module import time. ESM imports
// resolve before any non-import statement runs, so a module-scope
// `const CORS_ALLOW_ORIGINS = (process.env.DEMO_CORS_ORIGIN ?? '')…` would be
// captured BEFORE run.mjs's `Object.assign(process.env, loadEnv())` populates
// process.env from .env → the allowlist would be silently empty at runtime even
// when DEMO_CORS_ORIGIN is set, falling through to permissive any-origin
// reflection. Evaluating per-request guarantees the configured allowlist is
// actually applied.
export function corsAllowOrigins() {
  return (process.env.DEMO_CORS_ORIGIN ?? '')
    .split(',').map((s) => s.trim()).filter(Boolean)
}
export function corsPolicy(origin) {
  if (!origin) return null                                      // same-origin / non-browser — no ACAO needed
  const allow = corsAllowOrigins()
  if (allow.length) {
    return allow.includes(origin)
      ? { origin, credentials: true }                            // explicit allowlist → credentials OK
      : null
  }
  return { origin, credentials: false }                          // dev-only permissive reflection (no credentials)
}

// SECURITY (security-contract §4): header ALLOWLIST for the /v1/*
// → weftd reverse proxy. Forward only what weftd needs (the scoped
// Authorization + X-Weft-* routing/actor headers); strip Cookie + hop-by-hop
// so a same-origin browser session cookie is never forwarded to the agent
// control plane. A denylist would silently leak whatever it forgets (cookie is
// not hop-by-hop).
export const PROXY_HEADER_ALLOW = new Set([
  'authorization', 'accept', 'content-type', 'content-length', 'content-encoding',
  'x-customer-id', 'x-weft-actor', 'x-weft-session', 'x-weft-end-user',
  'x-weft-app', 'x-weft-external-account', 'x-weft-external-user',
])
export function proxyHeaders(inHeaders, host) {
  const out = { host }
  for (const [k, v] of Object.entries(inHeaders)) {
    if (PROXY_HEADER_ALLOW.has(k.toLowerCase())) out[k] = v
  }
  return out
}

// SECURITY (security-contract §3): derive end_user_id from the
// authenticated session cookie ONLY. The session map (shop_session →
// {username}) is passed in (shared with the app's own login machinery); a
// caller with no valid cookie resolves to 'guest' (the caller of cid / the
// session-create route 401s on 'guest' per §1). The username STRING is
// returned (not the object) so callers can stringify it for weftd's end_user_id
// (String({ username }) === '[object Object]').
export function cid(req, sessions) {
  const sid = (req.headers.cookie || '').match(/shop_session=([^;]+)/)?.[1]
  return (sid && sessions.get(sid)?.username) || 'guest'
}

// SECURITY (security-contract §2): session-ownership check that
// FAILS CLOSED. Returns true ONLY when the caller (refreshUser) is the recorded
// owner of the session. An unknown session (owner === undefined — post-restart,
// the in-memory map lost; or created via another path) is REJECTED (returns
// false), NOT allowed. The previous `owner !== undefined && owner !== …` failed
// OPEN on restart — the IDOR returned for any known session id. Do not weaken.
export function isSessionOwner(sessionOwners, sessionId, refreshUser) {
  const owner = sessionOwners.get(sessionId)
  return owner !== undefined && owner === refreshUser
}

// SECURITY: the /v1 fetch-proxy retry MUST NOT replay non-idempotent
// POSTs. undici sends the full request body BEFORE awaiting response headers, so
// a socket drop AFTER weftd received the body but BEFORE it responds ALSO
// surfaces as `TypeError: fetch failed` (cause.code === 'UND_ERR_SOCKET') —
// retrying that re-sends the buffered body → duplicate createRun /
// permission-response / tool-outputs. Narrow the retry to errors that fire
// BEFORE the body is sent (connect/DNS/TLS-handshake) by walking error.cause
// (recursively — undici nests). Default: DON'T retry (fail-safe — no replay).
// The mid-stream `UND_ERR_SOCKET` / `UND_ERR_HEADERS_TIMEOUT` /
// `UND_ERR_BODY_TIMEOUT` are explicitly NOT matched. Mirrors the old
// http.request regex (`ECONNREFUSED|EAI_AGAIN|ENOTFOUND|EHOSTUNREACH|EACCES` +
// "before secure TLS connection") the fetch rewrite replaced — keep it tight.
export function isPreHandshakeFetchError(error) {
  const PRE_HANDSHAKE_CODE = /^(ECONNREFUSED|EACCES|EHOSTUNREACH|ENOTFOUND|EAI_AGAIN|EAI_NODATA|EAI_NONAME|EAI_NOSERVICE)$/
  const seen = new Set()
  let cause = error?.cause
  while (cause && typeof cause === 'object' && !seen.has(cause)) {
    seen.add(cause)
    const code = cause.code || ''
    const msg = cause.message || ''
    if (
      PRE_HANDSHAKE_CODE.test(code) ||
      /^UND_ERR_(CONNECT_TIMEOUT|DNS|TLS)/.test(code) ||
      /^ERR_TLS/.test(code) ||
      /before secure TLS connection|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|EHOSTUNREACH|EACCES/i.test(msg)
    ) {
      return true
    }
    cause = cause.cause
  }
  return false
}

/**
 * Wire the weftd chat-session backend + /v1 reverse proxy onto the scaffolded
 * shop server. Wraps the server's existing request listener with a single-writer
 * that handles CORS/OPTIONS, X-Weft-Actor, /api/chat/session,
 * /api/chat/session/:id/token, and /v1/*; all other paths delegate to the
 * original (store-classic's REST + static).
 *
 * @param {import('node:http').Server} server
 * @param {object} opts
 * @param {string} opts.weftdBase     - Resolved weftd base URL (no trailing slash).
 * @param {string} opts.apiKey        - Tenant API key (used by weftdAPI, passed through).
 * @param {string} opts.tenantId      - Tenant ID (used by ensureApp, passed through).
 * @param {() => Promise<{tenantId:string,appId:string}>} opts.ensureApp - Lazy provisioning.
 * @param {(method:string,path:string,body?:object)=>Promise<object>} opts.weftdAPI - Provisioning fetcher (used for /v1/sessions POST).
 * @param {object} [opts.state]       - Shop state; if present, onEvent is re-wired to the guarded fan-out.
 * @param {Set} [opts.sseClients]     - Shared SSE client set (store-classic's /api/events adds here).
 * @param {Map} [opts.sessions]       - Shared cookie-session map (for end_user_id resolution).
 */
export function wireSessionRoutes(server, { weftdBase, apiKey, tenantId, ensureApp, weftdAPI, state, sseClients, sessions }) {
  const _sseClients = sseClients ?? new Set()
  const _sessions = sessions ?? new Map()
  // SECURITY: session_id → end_user_id ownership map, populated when
  // SECURITY (security-contract §2): session_id → end_user_id
  // ownership map, populated when POST /api/chat/session creates a session and
  // checked (FAIL CLOSED, via isSessionOwner) on token refresh. In-memory only
  // (lost on restart) — the fail-closed default rejects (403) unknown sessions
  // post-restart; a persisted store (SQLite/Redis) is a UX upgrade so re-creation
  // after restart isn't needed, NOT a security fix.
  const sessionOwners = new Map()
  void apiKey   // apiKey is closure-captured by weftdAPI (from createProvisioning); reserved for parity.
  void tenantId // tenantId is used inside ensureApp; reserved for parity.

  // --- weftd reverse-proxy plumbing (mirrors apps/online-store :211-228) ---
  const weftdUrl = new URL(weftdBase)
  const weftdRequest = weftdUrl.protocol === 'https:' ? httpsRequest : httpRequest
  // Preserve the path prefix from WEFTD_BASE (e.g. "/weftd" when a reverse
  // proxy hosts weftd under a sub-path). Without this, /v1/* proxy
  // requests would drop the prefix and hit a 404 on the upstream.
  const weftdPathPrefix = weftdUrl.pathname.replace(/\/$/, '')
  const shopPublicBase = process.env.SHOP_PUBLIC_BASE?.replace(/\/$/, '')

  // Browser-reachable base for weftd calls. Defaults to the origin the page
  // was loaded from (follows whatever host/port the user opened, including a
  // forwarded one); override with SHOP_PUBLIC_BASE when behind a fixed URL.
  const publicBaseURL = (req) => {
    if (shopPublicBase) return shopPublicBase
    const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() || 'http'
    const host = req.headers['x-forwarded-host'] ?? req.headers.host
    return host ? `${proto}://${host}` : ''
  }

  // (cid is the module-level export above — cid(req, _sessions).)

  // Per-customer SSE fan-out (mirrors apps/online-store shop-server.mjs):
  // iterate a snapshot of clients, skip+drop any destroyed/ended, swallow
  // per-write errors so one dead socket can't kill the broadcast. The filter
  // scopes each connection to its own customer's cart/order events; global
  // events (product.updated, shop.reset) go to everyone. NOTE: state.onEvent
  // APPENDS (Set-based, not replaces), so when weftd is configured this runs
  // ALONGSIDE store-classic's own fan-out — both fire (a duplicated write to
  // each matching client; no leak, no miss).
  const broadcast = (event) => {
    const line = `event: shop.event\ndata: ${JSON.stringify(event)}\n\n`
    const ecid = event?.data?.customer_id ?? event?.data?.order?.customer_id ?? null
    for (const res of [..._sseClients]) {
      if (res.destroyed || res.writableEnded) { _sseClients.delete(res); continue }
      if (ecid && res.weftCustomerId && res.weftCustomerId !== ecid) continue
      try { res.write(line) } catch { _sseClients.delete(res) }
    }
  }
  if (state?.onEvent) state.onEvent(broadcast)

  // === proxyToWeftd — fetch (undici) transport ===
  // The upstream to weftd uses `fetch` rather than node:http's `request`.
  // Reason: the weftd control plane is fronted by an edge that negotiates
  // HTTP/2 via ALPN. Node's `http.request`/`https.request` is HTTP/1.1-only —
  // it either fails to parse the h2 frames the edge returns ("Expected HTTP/")
  // or hangs when limited to `http/1.1`. undici `fetch` speaks the edge's
  // negotiated protocol correctly AND streams `response.body` as a real
  // ReadableStream, which is what makes the long-lived timeline SSE actually
  // stream (the prior http.request proxy hung on the SSE handshake → the chat
  // showed "Not connected" and the SDK fell back to polling). Semantics
  // preserved: buffer the request body so a pre-handshake failure can retry
  // without replaying non-idempotent POSTs; retry ONCE on a connection-
  // establishment error only (before any response headers are written); once
  // headers are sent (SSE/streamed responses), mid-stream errors tear down the
  // downstream response instead of retrying. headersSent still gates the retry.
  const proxyToWeftd = async (req, res, url) => {
    // Buffer the request body so we can retry the upstream call on a
    // connection-ESTABLISHMENT error (a reverse-proxy edge occasionally closes a
    // connection during the TLS handshake, notably concurrent with the
    // long-lived timeline SSE, surfacing as a fetch `TypeError: fetch failed`
    // with an `ECONNRESET`/TLS cause). The retry is narrowed to pre-handshake/
    // connection errors ONLY: these fire before any body bytes are sent, so
    // retrying is safe even for non-idempotent POSTs (createRun, permission-
    // response, tool-outputs, token). Mid-stream errors (after the response
    // has started) can fire AFTER weftd already received the body, so retrying
    // would replay non-idempotent requests and create duplicates — those are
    // surfaced, not retried. headersSent gates the error path for streamed/SSE
    // responses, which have already sent headers by the time any mid-stream
    // error fires.
    const chunks = [];
    let proxyLen = 0;
    for await (const chunk of req) {
      proxyLen += chunk.length;
      if (proxyLen > MAX_PROXY_BODY) {                          // cap proxied body size
        if (!res.headersSent) writeJSON(res, 413, { error: 'request body too large' });
        return;
      }
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks);
    // Build the upstream URL from WEFTD_BASE + the (path-normalized) request
    // path + query. weftdPathPrefix preserves a sub-path (e.g. "/weftd") when
    // a reverse proxy hosts weftd under a sub-path.
    const upstreamUrl = weftdBase + weftdPathPrefix + url.pathname + url.search;
    // Allowlist the forwarded headers (security-contract §6 — Cookie is
    // NOT forwarded). `accept-encoding: identity` forces weftd to send the SSE
    // body raw (no gzip/br), so `response.body` is the verbatim stream and the
    // content-length/content-encoding we forward are faithful (fetch otherwise
    // decompresses transparently and the headers/body would disagree).
    const upHeaders = { ...proxyHeaders(req.headers, weftdUrl.host), 'accept-encoding': 'identity' };
    // Tear down the upstream fetch if the downstream client disconnects
    // (browser closed the SSE / navigated away). Without this, the proxy keeps
    // the weftd SSE connection open for the full stream lifetime after the
    // client is gone.
    const abortCtrl = new AbortController();
    const onClose = () => abortCtrl.abort();
    res.on('close', onClose);
    const attempt = async (retriesLeft) => {
      // The downstream response may have been closed/ended (client disconnect,
      // or a prior attempt already finished) before this retry runs — bail
      // instead of writing into a dead stream.
      if (res.writableEnded || res.destroyed) return;
      let response;
      try {
        response = await fetch(upstreamUrl, {
          method: req.method,
          headers: upHeaders,
          body: body.length ? body : undefined,
          redirect: 'manual',
          signal: abortCtrl.signal,
        });
      } catch (error) {
        // A pre-handshake / connection-establishment failure surfaces as a
        // `TypeError: fetch failed` (undici wraps the underlying cause). BUT
        // undici sends the full request body BEFORE awaiting response headers, so
        // a mid-stream drop AFTER weftd received the body ALSO lands here
        // (`cause.code === 'UND_ERR_SOCKET'`) — retrying that would replay the
        // buffered body → duplicate non-idempotent POSTs (createRun /
        // permission-response / tool-outputs). Narrow via
        // isPreHandshakeFetchError (connect/DNS/TLS-handshake codes only); the
        // default is fail-safe = NO retry (surface as 502). The client-disconnect
        // abort also lands here — bail, don't retry.
        if (abortCtrl.signal.aborted) return;
        if (retriesLeft > 0 && !res.headersSent && isPreHandshakeFetchError(error)) {
          setTimeout(() => attempt(retriesLeft - 1), 250);
          return;
        }
        if (!res.headersSent) writeJSON(res, 502, { error: `weftd proxy failed: ${error.message}` });
        else if (!res.destroyed) res.destroy();
        return;
      }
      // Stream the upstream response verbatim — works identically for JSON
      // responses and for the run/timeline SSE streams (no buffering). Forward
      // ONLY a safe subset of the upstream's headers: forwarding hop-by-hop or
      // framing headers (transfer-encoding, connection, keep-alive, content-
      // length) breaks Node's own response framing (Node manages those itself),
      // and forwarding content-encoding would disagree with the raw body we
      // stream (we forced `accept-encoding: identity`, so the body is raw).
      // N.B. `Object.fromEntries(response.headers.entries())` — spreading a
      // Headers object (`{...response.headers}`) iterates its [k,v] pair entries
      // as numeric keys, producing a garbage header map that breaks writeHead.
      const SAFE_RESP_HEADERS = new Set([
        'content-type', 'cache-control', 'vary', 'etag', 'last-modified',
        'x-weft-actor', 'x-request-id', 'x-weft-session', 'x-weft-end-user',
      ])
      const respHeaders = {}
      for (const [k, v] of response.headers.entries()) {
        if (SAFE_RESP_HEADERS.has(k.toLowerCase())) respHeaders[k] = v
      }
      // Once writeHead fires, headersSent is true → the mid-stream error path
      // below must NOT retry (would replay the request); it just tears down.
      res.writeHead(response.status ?? 502, respHeaders)
      // Flush headers IMMEDIATELY — Node otherwise buffers them until the first
      // res.write()/end(). For the timeline SSE that's fatal: an idle session
      // sends no body bytes until the first event, so the headers (200 + the
      // text/event-stream content-type) would never reach the browser → the
      // chat shows "Not connected" and the SDK falls back to polling.
      res.flushHeaders()
      // response.body is a web ReadableStream (or null for HEAD/204). Stream it
      // to the Node ServerResponse explicitly (for-await over the web stream);
      // on a mid-flight error (RST after weftd already sent headers), tear down
      // the downstream so the client doesn't hang on a half-finished body. A
      // client-disconnect abort is expected, not an error to surface.
      if (response.body) {
        ;(async () => {
          try {
            for await (const chunk of response.body) {
              if (res.destroyed || abortCtrl.signal.aborted) return
              res.write(chunk)
            }
            if (!res.destroyed) res.end()
          } catch (error) {
            if (abortCtrl.signal.aborted) return
            if (!res.destroyed) res.destroy()
          }
        })()
      } else {
        res.end()
      }
    };
    attempt(1); // one retry on connection-establishment errors
  };
  // === end fetch-transport block ===


  // Wrap the server's existing request listener (store-classic's REST + static)
  // with a single-writer that intercepts chat/proxy paths. The original listener
  // is captured + re-invoked for everything else, so there is exactly one writer
  // per request (no double-listener race).
  const original = server.listeners('request')[0]
  server.removeAllListeners('request')
  server.on('request', async (req, res) => {
    // CORS + OPTIONS at the top so every path (session, proxy, delegated REST,
    // static, SSE) carries the allow-list. Mirrors apps/online-store :305-314.
    const cors = corsPolicy(req.headers.origin)
    if (cors) {
      res.setHeader('Access-Control-Allow-Origin', cors.origin)
      if (cors.credentials) res.setHeader('Access-Control-Allow-Credentials', 'true')
    }
    // Vary by Origin whenever an Origin was sent, even when we did NOT add
    // Access-Control-Allow-Origin (e.g. an un-allowlisted origin in prod): a CDN
    // that does not see `Vary: Origin` could cache a CORS-less response and
    // serve it to a legitimately-allowlisted origin on a later request.
    if (req.headers.origin) res.setHeader('Vary', 'Origin')
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS')
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Content-Encoding, Authorization, X-Customer-ID, X-Weft-Actor, X-Weft-Session, X-Weft-End-User, X-Weft-App, X-Weft-External-Account, X-Weft-External-User',
    )
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end() }

    const url = new URL(req.url, 'http://localhost')
    // X-Weft-Actor is stripped from model-provided arguments, then stamped by
    // the Weft browser runtime for client-side tool calls. Reserved for
    // state.mjs actor param + event stamping; not forwarded to state methods here.
    const actor = req.headers['x-weft-actor'] === 'agent' ? 'agent' : 'user'
    void actor

    const p = url.pathname
    const m = req.method
    const c = cid(req, _sessions)

    try {
      // Chat session bootstrap — this server holds the weftd address + developer
      // credential; the browser only ever sees the scoped session token.
      // toolset "shop" (NOT "shop") matches the named toolset provisioned
      // by createProvisioning.
      if (p === '/api/chat/session' && m === 'POST') {
        // SECURITY (security-contract §4): swallow a JSON parse error (→ {}),
        // but RE-THROW the 413 size error so the outer catch returns 413 (a bare
        // .catch(() => ({})) would swallow the body-cap, returning 201 with an
        // empty body instead of rejecting the oversized request).
        const body = await readJSON(req).catch((e) => { if (e?.status === 413) throw e; return {} })
        // SECURITY: derive end_user_id from the authenticated session
        // (cookie) ONLY — never from the request body. A body-supplied
        // end_user_id would let any caller mint a weftd session impersonating an
        // arbitrary end-user. The demo previously allowed body.end_user_id "for
        // readability"; remove it in any real integration. (external_account_id
        // is an org-scoping hint, not an identity claim — keep your own auth on
        // it if account spoofing is in your threat model.)
        const endUserId = c ?? 'guest'
        // SECURITY: reject unauthenticated callers — the 'guest'
        // fallback is demo-only; ship a 401 default so an integrator who copies
        // the template inherits a safe default instead of minting weftd
        // sessions for anyone with no cookie.
        if (c === 'guest') {
          return writeJSON(res, 401, { error: 'authentication required' })
        }
        try {
          const ctx = await ensureApp()
          const session = await weftdAPI('POST', '/v1/sessions', {
            end_user_id: endUserId,
            app_id: ctx.appId,
            external_user_id: endUserId,
            external_account_id: body.external_account_id ?? 'demo-org',
            // The shop toolset (named shop_* tools, execution:client)
            // is resolved by flitro from the session's toolset name.
            toolset: 'shop',
            title: `Online Store — ${endUserId}`,
            credential: { token: `shop-cred-${endUserId}-${Date.now()}`, scheme: 'bearer' },
            // No sealed approval_policy: the chat panel's per-message
            // permission_mode (explore/ask/auto) controls each run's policy.
          })
          sessionOwners.set(session.session_id, endUserId)
          return writeJSON(res, 201, { ...session, base_url: publicBaseURL(req) })
        } catch (error) {
          return writeJSON(res, 502, { error: `weftd session bootstrap failed: ${error.message}` })
        }
      }
      // Token refresh: the browser's onTokenExpired callback lands here; only
      // this backend (holding the developer credential) can extend end-user access.
      const tokenMatch = p.match(/^\/api\/chat\/session\/([^/]+)\/token$/)
      if (tokenMatch && m === 'POST') {
        const refreshUser = c
        // SECURITY: reject unauthenticated callers.
        if (refreshUser === 'guest') {
          return writeJSON(res, 401, { error: 'authentication required' })
        }
        // SECURITY (security-contract §2): FAIL CLOSED — if the
        // session is not in the in-memory map (post-restart / created via another
        // path) the caller is rejected, not allowed. The previous check
        // (owner !== undefined && owner !== refreshUser) failed OPEN on restart,
        // re-opening the IDOR for any known session id. isSessionOwner is the
        // exported, unit-tested fail-closed predicate — do NOT inline a weaker one.
        const sessionId = decodeURIComponent(tokenMatch[1])
        if (!isSessionOwner(sessionOwners, sessionId, refreshUser)) {
          return writeJSON(res, 403, { error: 'not the session owner' })
        }
        try {
          await ensureApp()
          const session = await weftdAPI('POST', `/v1/sessions/${encodeURIComponent(sessionId)}/token`, {
            credential: { token: `shop-cred-${refreshUser}-${Date.now()}`, scheme: 'bearer' },
          })
          return writeJSON(res, 200, { ...session, base_url: publicBaseURL(req) })
        } catch (error) {
          const status = error.status === 404 ? 404 : 502
          return writeJSON(res, status, { error: `weftd token refresh failed: ${error.message}` })
        }
      }
      // Everything under /v1 is the chat traffic the browser sends through
      // the Client SDK; forward it to weftd.
      if (p === '/v1' || p.startsWith('/v1/')) {
        // SECURITY: defense-in-depth — block weftd admin/management
        // prefixes so a holder of a scoped SESSION token cannot reach
        // tenant/platform admin routes through this catch-all proxy. The browser
        // SDK only needs session-scoped routes (/v1/sessions/*, /v1/runs/*,
        // /v1/timeline*, /v1/messages/*, /v1/tool-outputs*). weftd must still
        // scope the token independently (this proxy denylist is not a
        // substitute); if you widen the SDK's /v1 surface, widen this denylist,
        // don't remove it. Normalize case / double-slash / percent-encoding, AND
        // collapse `..` segments: `new URL` does NOT decode `%2f` to `/`, so a
        // path like /v1/sessions/%2f../tenants survives as /v1/sessions/%2f../tenants
        // — decode first, then re-parse through `new URL` to normalize the `..`
        // the denylist would otherwise miss (defensive — depends on weftd's router).
        const ADMIN_PROXY_PREFIXES = ['/v1/tenants', '/v1/admin', '/v1/platform']
        const normalizedP = (() => {
          try {
            // decode %2f → / (new URL does NOT), collapse // (so a `..` after a
            // decoded %2f doesn't absorb an empty segment from `//` — e.g.
            // /v1/sessions/%2f../tenants decodes to /v1/sessions//../tenants,
            // collapse→/v1/sessions/../tenants), then re-parse through new URL
            // to fold the `..` → /v1/tenants so the denylist catches it.
            return new URL(decodeURIComponent(p).replace(/\/+/g, '/'), 'http://localhost').pathname.toLowerCase()
          } catch { return p.toLowerCase() }
        })()
        if (ADMIN_PROXY_PREFIXES.some((pre) => normalizedP === pre || normalizedP.startsWith(`${pre}/`))) {
          return writeJSON(res, 404, { error: 'not found' })
        }
        return await proxyToWeftd(req, res, url)
      }
    } catch (e) {
      return writeJSON(res, e.status ?? 500, { error: e.message })
    }

    // Fall through to store-classic's original handler (REST CRUD + static + SSE).
    return original(req, res)
  })
}
