// Security-regression guard for templates/session-routes.mjs.
//
// Asserts the Tier-1 invariants from references/security-contract.md that the
// TEMPLATE enforces: §1 auth (401), §2 ownership fail-closed (403), §3
// end_user_id from cookie, §4 proxy (header allowlist + path-normalize denylist
// + streaming body cap), §6 CORS per-request. (§5 SSE cap is app-level — the
// host SSE handler owns it, not this template — so it is NOT tested here; the
// integrator's §6 checklist covers it.)
//
// This is the closed loop's executable security dimension (SKILL.md §6): a
// future weakening of the template (fail-open ownership, non-streaming body
// read, denylist proxy headers, module-scope CORS const, body-supplied
// end_user_id) FAILS this guard at `node --test`. Run it in CI.
//
// It is a TEMPLATE: copy next to session-routes.mjs + `node --test
// security.test.mjs`. Works against the placeholder form (the mock weftdAPI
// ignores the {{toolset}} literal) and the substituted form.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import {
  cid, corsPolicy, isSessionOwner, isPreHandshakeFetchError, proxyHeaders, readJSON,
  MAX_JSON_BODY, PROXY_HEADER_ALLOW, wireSessionRoutes,
} from './session-routes.mjs'

// ─── mock weftdAPI (the integrator-backend side is fully testable without weftd)
const mockWeftdAPI = async (method, path, body) => {
  if (method === 'POST' && path === '/v1/sessions') {
    return { session_id: 'sid-alice-1', token: 'tok-alice', base_url: 'http://weftd.local', expires_at: 0 }
  }
  if (method === 'POST' && /\/v1\/sessions\/[^/]+\/token$/.test(path)) {
    return { session_id: 'sid-alice-1', token: 'tok-alice-refreshed', base_url: 'http://weftd.local', expires_at: 0 }
  }
  throw new Error(`mock weftdAPI: unexpected ${method} ${path}`)
}
const mockEnsureApp = async () => ({ tenantId: 'tid', appId: 'aid' })

// ─── helpers
function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve(`http://127.0.0.1:${server.address().port}`)
    })
  })
}
function close(server) {
  return new Promise((resolve, reject) => {
    server.closeAllConnections?.()
    server.close((err) => (err ? reject(err) : resolve()))
  })
}
async function req(base, method, path, { body, cookie, origin, headers } = {}) {
  const h = { 'content-type': 'application/json' }
  if (cookie) h.cookie = cookie
  if (origin) h.origin = origin
  if (headers) Object.assign(h, headers)
  const r = await fetch(`${base}${path}`, {
    method,
    headers: h,
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  })
  let data = null
  try { data = await r.json() } catch { /* no body */ }
  return { status: r.status, data, headers: r.headers }
}
// Fixture cookie name for the guard — any stable name works; the host app
// substitutes {{sessionCookie}} at scaffold time.
const SESSION_COOKIE = 'app_session'

function aliceCookie(sessions) {
  // mint a session sid → {username:'alice'} in the shared sessions map
  const sid = 'sess-alice'
  sessions.set(sid, { username: 'alice' })
  return `${SESSION_COOKIE}=${sid}`
}
function bobCookie(sessions) {
  const sid = 'sess-bob'
  sessions.set(sid, { username: 'bob' })
  return `${SESSION_COOKIE}=${sid}`
}

async function startServer({ sessions, freshSessionOwners = false } = {}) {
  // A fresh server = a fresh wireSessionRoutes = a fresh (empty) sessionOwners
  // map — the post-restart condition. The shared `sessions` map (cookie→user) is
  // the same across servers so alice/bob cookies resolve.
  const server = createServer((req, res) => { // the "original" listener (fall-through)
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  })
  wireSessionRoutes(server, {
    weftdBase: 'http://127.0.0.1:9',   // a closed port → ECONNREFUSED fast (for the forwarded /v1 test; the denylist + body-cap fire before any connect)
    apiKey: 'wsk-test', tenantId: 'tid',
    ensureApp: mockEnsureApp, weftdAPI: mockWeftdAPI,
    sessions,
    sessionCookie: SESSION_COOKIE,
    sseEventName: 'app.event',
  })
  const base = await listen(server)
  return { server, base }
}

// ════════════════════════════════════════════════════════════════════════
// UNIT — the exported helpers (pure / factory)
// ════════════════════════════════════════════════════════════════════════

test('corsPolicy (§6): per-request allowlist, credentials only on match', async () => {
  delete process.env.DEMO_CORS_ORIGIN
  assert.equal(corsPolicy(undefined), null)                       // same-origin/non-browser
  assert.deepEqual(corsPolicy('https://evil.example'), { origin: 'https://evil.example', credentials: false }) // dev fallback (no creds)
  process.env.DEMO_CORS_ORIGIN = 'https://good.example,https://www.good.example'
  assert.equal(corsPolicy('https://evil.example'), null)          // un-allowlisted → no ACAO
  assert.deepEqual(corsPolicy('https://good.example'), { origin: 'https://good.example', credentials: true })
  delete process.env.DEMO_CORS_ORIGIN
})

test('proxyHeaders (§4): allowlist strips Cookie + unknown, keeps Authorization + X-Weft-*', () => {
  const out = proxyHeaders({
    authorization: 'Bearer tok', cookie: `${SESSION_COOKIE}=x`, 'x-weft-actor': 'agent',
    'x-evil': 'pwn', 'content-type': 'application/json',
  }, 'weftd.local')
  assert.equal(out.authorization, 'Bearer tok')
  assert.equal(out['x-weft-actor'], 'agent')
  assert.equal(out['content-type'], 'application/json')
  assert.equal(out.host, 'weftd.local')
  assert.equal(out.cookie, undefined)         // stripped (not hop-by-hop — a denylist would leak it)
  assert.equal(out['x-evil'], undefined)      // stripped
  assert.ok(PROXY_HEADER_ALLOW.has('authorization') && !PROXY_HEADER_ALLOW.has('cookie'))
})

test('cid (§3): end_user_id from the cookie only; no/invalid cookie → guest', () => {
  const sessions = new Map([['s1', { username: 'alice' }]])
  assert.equal(cid({ headers: { cookie: `${SESSION_COOKIE}=s1` } }, sessions, SESSION_COOKIE), 'alice')
  assert.equal(cid({ headers: {} }, sessions, SESSION_COOKIE), 'guest')                       // no cookie
  assert.equal(cid({ headers: { cookie: `${SESSION_COOKIE}=unknown` } }, sessions, SESSION_COOKIE), 'guest') // invalid cookie
  assert.equal(cid({ headers: { cookie: 'other=x' } }, sessions, SESSION_COOKIE), 'guest')    // wrong cookie name
})

test('isSessionOwner (§2): FAIL CLOSED on unknown session', () => {
  const owners = new Map([['sid-a', 'alice']])
  assert.equal(isSessionOwner(owners, 'sid-a', 'alice'), true)    // owner
  assert.equal(isSessionOwner(owners, 'sid-a', 'bob'), false)    // non-owner → 403
  assert.equal(isSessionOwner(owners, 'sid-unknown', 'alice'), false) // UNKNOWN session → 403 (fail-closed; the post-restart edge)
  assert.equal(isSessionOwner(new Map(), 'sid-a', 'alice'), false) // empty map (post-restart) → 403
})

// Shape an error like undici's `TypeError: fetch failed` (a TypeError with a
// .cause carrying the real socket/DNS/TLS code).
function fetchFailed(cause) {
  const e = new TypeError('fetch failed')
  e.cause = cause
  return e
}

test('isPreHandshakeFetchError: retry ONLY on pre-send errors; mid-stream → false (no replay)', () => {
  // pre-handshake (connection-establishment) → retry-safe
  assert.equal(isPreHandshakeFetchError(fetchFailed({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' })), true)
  assert.equal(isPreHandshakeFetchError(fetchFailed({ code: 'EACCES', message: 'permission denied' })), true)
  assert.equal(isPreHandshakeFetchError(fetchFailed({ code: 'EHOSTUNREACH', message: 'no route' })), true)
  assert.equal(isPreHandshakeFetchError(fetchFailed({ code: 'ENOTFOUND', message: 'dns not found' })), true)
  assert.equal(isPreHandshakeFetchError(fetchFailed({ code: 'EAI_AGAIN', message: 'dns temp' })), true)
  assert.equal(isPreHandshakeFetchError(fetchFailed({ code: 'UND_ERR_CONNECT_TIMEOUT', message: 'connect timeout' })), true)
  assert.equal(isPreHandshakeFetchError(fetchFailed({ code: 'UND_ERR_DNS_ENOTFOUND', message: 'dns' })), true)
  assert.equal(isPreHandshakeFetchError(fetchFailed({ code: 'UND_ERR_TLS_CERT', message: 'before secure TLS connection was established' })), true)
  assert.equal(isPreHandshakeFetchError(fetchFailed({ code: 'ERR_TLS_CERT_ALTNAME_INVALID', message: 'cert altname' })), true)

  // mid-stream (AFTER weftd received the body) → MUST NOT retry (would replay non-idempotent POSTs)
  assert.equal(isPreHandshakeFetchError(fetchFailed({ code: 'UND_ERR_SOCKET', message: 'other side closed' })), false, 'UND_ERR_SOCKET = post-send drop')
  assert.equal(isPreHandshakeFetchError(fetchFailed({ code: 'UND_ERR_HEADERS_TIMEOUT', message: 'headers timeout' })), false)
  assert.equal(isPreHandshakeFetchError(fetchFailed({ code: 'UND_ERR_BODY_TIMEOUT', message: 'body timeout' })), false)
  assert.equal(isPreHandshakeFetchError(fetchFailed({ code: 'ECONNRESET', message: 'read ECONNRESET' })), false, 'ECONNRESET is mid-stream')

  // nested cause chain — the real classification may be buried (undici nests)
  assert.equal(
    isPreHandshakeFetchError(fetchFailed({ code: 'ERR_HTTP_REQUEST', message: 'req failed', cause: { code: 'UND_ERR_SOCKET', message: 'other side closed' } })),
    false, 'nested mid-stream → no retry',
  )
  assert.equal(
    isPreHandshakeFetchError(fetchFailed({ code: 'ERR_HTTP_REQUEST', message: 'req failed', cause: { code: 'ERR_TCP', message: 'tcp', cause: { code: 'ECONNREFUSED', message: 'refused' } } })),
    true, 'deep-nested pre-handshake → retry',
  )

  // fail-safe: no cause / abort → no retry
  assert.equal(isPreHandshakeFetchError(new TypeError('fetch failed')), false)
  const abortErr = new Error('aborted'); abortErr.name = 'AbortError'
  assert.equal(isPreHandshakeFetchError({ cause: abortErr }), false)
})

test('readJSON (§4): streaming body cap → 413 on overflow', async () => {
  // a single chunk > the cap → throws {status:413} (the handler re-throws it).
  await assert.rejects(
    () => readJSON({ async *[Symbol.asyncIterator]() { yield 'x'.repeat(MAX_JSON_BODY + 1) } }),
    (e) => e.status === 413,
  )
  // empty → {}
  const empty = { async *[Symbol.asyncIterator]() {} }
  assert.deepEqual(await readJSON(empty), {})
})

// ════════════════════════════════════════════════════════════════════════
// INTEGRATION — wireSessionRoutes end-to-end (mock weftdAPI)
// ════════════════════════════════════════════════════════════════════════

test('§1: unauthenticated POST /api/chat/session → 401', async () => {
  const sessions = new Map()
  const { server, base } = await startServer({ sessions })
  try {
    const r = await req(base, 'POST', '/api/chat/session', { body: {} })  // no cookie
    assert.equal(r.status, 401)
  } finally { await close(server) }
})

test('§3: authenticated POST /api/chat/session → 201 (end_user_id from cookie)', async () => {
  const sessions = new Map()
  const { server, base } = await startServer({ sessions })
  try {
    const cookie = aliceCookie(sessions)
    const r = await req(base, 'POST', '/api/chat/session', { body: {}, cookie })
    assert.equal(r.status, 201)
    assert.equal(r.data.session_id, 'sid-alice-1')   // minted by mock weftdAPI
    assert.ok(r.data.base_url.startsWith('http://127.0.0.1:')) // host-derived
  } finally { await close(server) }
})

test('§2: non-owner /token → 403; owner /token → 200', async () => {
  const sessions = new Map()
  const { server, base } = await startServer({ sessions })
  try {
    const alice = aliceCookie(sessions)
    const bob = bobCookie(sessions)
    // alice creates the session → sessionOwners[sid]=alice
    const created = await req(base, 'POST', '/api/chat/session', { body: {}, cookie: alice })
    assert.equal(created.status, 201)
    const sid = created.data.session_id
    // owner refresh → 200
    const ok = await req(base, 'POST', `/api/chat/session/${sid}/token`, { cookie: alice })
    assert.equal(ok.status, 200)
    // non-owner refresh → 403
    const denied = await req(base, 'POST', `/api/chat/session/${sid}/token`, { cookie: bob })
    assert.equal(denied.status, 403)
    // unauthenticated refresh → 401 (the auth guard applies to the refresh route too)
    const unauth = await req(base, 'POST', `/api/chat/session/${sid}/token`, {})
    assert.equal(unauth.status, 401)
  } finally { await close(server) }
})

test('§2: post-restart (empty sessionOwners) /token → 403 (fail-closed)', async () => {
  const sessions = new Map()
  const { server: s1, base: b1 } = await startServer({ sessions })
  let sid
  try {
    const alice = aliceCookie(sessions)
    const created = await req(b1, 'POST', '/api/chat/session', { body: {}, cookie: alice })
    sid = created.data.session_id
  } finally { await close(s1) }
  // a FRESH server = fresh (empty) sessionOwners (the post-restart condition)
  const { server: s2, base: b2 } = await startServer({ sessions })
  try {
    const alice = aliceCookie(sessions)
    const r = await req(b2, 'POST', `/api/chat/session/${sid}/token`, { cookie: alice })
    assert.equal(r.status, 403, 'unknown session post-restart MUST be rejected (fail-closed), not allowed')
  } finally { await close(s2) }
})

test('§4: /v1 admin denylist (normalized) → 404', async () => {
  const sessions = new Map()
  const { server, base } = await startServer({ sessions })
  try {
    assert.equal((await req(base, 'GET', '/v1/tenants')).status, 404)
    assert.equal((await req(base, 'GET', '/v1/tenants/')).status, 404)
    assert.equal((await req(base, 'GET', '/v1/Tenants/')).status, 404)         // case (normalized)
    assert.equal((await req(base, 'GET', '/v1/admin/x')).status, 404)
    assert.equal((await req(base, 'GET', '/v1/platform/y')).status, 404)
    // %2f / // / %-encoded `..` variants — `new URL` does NOT decode %2f, so the
    // template decodes first then RE-PARSES through new URL to collapse `..`
    // (e.g. /v1/sessions/%2f../tenants → /v1/tenants). A regression that drops the
    // re-parse would let these bypass the denylist.
    assert.equal((await req(base, 'GET', '/v1/%2ftenants')).status, 404)
    assert.equal((await req(base, 'GET', '/v1//tenants')).status, 404)
    assert.equal((await req(base, 'GET', '/v1/sessions/%2f../tenants')).status, 404)
    // a non-admin /v1 path is NOT blocked (would forward to weftd — here the mock
    // isn't an http upstream, so the proxy errors 502; we only assert NOT-404-by-denylist)
    const forwarded = await req(base, 'GET', '/v1/sessions/sid-1/timeline')
    assert.notEqual(forwarded.status, 404)
  } finally { await close(server) }
})

test('§4: oversized POST body → 413 (streaming cap, not full-buffer)', async () => {
  const sessions = new Map()
  const { server, base } = await startServer({ sessions })
  try {
    const alice = aliceCookie(sessions)
    // a body larger than MAX_JSON_BODY to /api/chat/session → readJSON throws 413
    const big = 'x'.repeat(MAX_JSON_BODY + 1)
    const r = await req(base, 'POST', '/api/chat/session', { body: big, cookie: alice, headers: { 'content-type': 'text/plain' } })
    assert.equal(r.status, 413)
  } finally { await close(server) }
})

test('§6: CORS un-allowlisted origin → no ACAO; allowlisted → reflected + credentials', async () => {
  const sessions = new Map()
  process.env.DEMO_CORS_ORIGIN = 'https://good.example'
  const { server, base } = await startServer({ sessions })
  try {
    const evil = await req(base, 'GET', '/v1/tenants', { origin: 'https://evil.example' })
    assert.equal(evil.headers.get('access-control-allow-origin'), null)   // no ACAO for un-allowlisted
    const good = await req(base, 'GET', '/v1/tenants', { origin: 'https://good.example' })
    assert.equal(good.headers.get('access-control-allow-origin'), 'https://good.example')
    assert.equal(good.headers.get('access-control-allow-credentials'), 'true')
  } finally {
    delete process.env.DEMO_CORS_ORIGIN
    await close(server)
  }
})
