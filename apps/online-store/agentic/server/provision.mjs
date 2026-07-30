// weftd provisioning chain — parameterized extract of
// apps/store-agentic/server/shop-server.mjs (the weftdBase/apiKey/tenantId
// resolution + weftdAPI + provisionApp + provisionToolset + provisionGraph
// [ENOENT graceful-skip] + provisionSkill + provisionAutomation + ensureApp).
//
// The 5 weftd slugs + the model default + the spec path + the display name are
// placeholder tokens (rendered by scripts/scaffold.mjs in Task 3). The env
// resolution (WEFTD_BASE / WEFT_API_KEY / WEFT_TENANT_ID) lives in the CALLER —
// the scaffolded shop-server.mjs — which resolves them from process.env and
// passes the resolved values into createProvisioning(). This keeps the module
// zero-dep (no import of lib/system-prompt.mjs; the system prompt is injected
// as a string produced by scripts/gen-system-prompt.mjs in Task 7).
//
// Expected placement: server/provision.mjs (sibling of shop-server.mjs), so
// __dirname/.. resolves to the app root where openapi.json and
// online-store-agentic-graph.json live.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

/**
 * Derive the fail-closed tool_names allowlist from the shop OpenAPI spec.
 *
 * Formula: for every operationId across all paths/methods in the spec,
 *   `shop_${operationId}`.toLowerCase().
 *
 * the runtime's tool visibility is fail-closed on an empty allowlist — the skill
 * must list these shop_* names for the named-toolset tools to be visible
 * to the LLM. plan_route is a runtime internal tool (always visible, no
 * listing).
 *
 * Phase 2b's scripts/gen-tool-allowlist.mjs (Task 4) supersedes this inline
 * derivation; it is preserved here to mirror v1's shape.
 *
 * @param {object} spec - Parsed OpenAPI spec (with `.paths`).
 * @returns {string[]} Ordered array of `shop_<operationId>`.toLowerCase() names.
 */
function deriveToolNames(spec) {
  const names = []
  for (const methods of Object.values(spec.paths ?? {})) {
    for (const [m, op] of Object.entries(methods ?? {})) {
      if (!['get', 'post', 'put', 'patch', 'delete', 'head', 'options'].includes(m)) continue
      if (op?.operationId) names.push(`shop_${op.operationId}`.toLowerCase())
    }
  }
  return names
}

/**
 * Lazily provisions the weftd app + toolset + skill + automation + graph on the
 * pre-existing tenant (WEFT_TENANT_ID) the first time ensureApp() is awaited.
 *
 * @param {object} opts
 * @param {string} opts.weftdBase     - Resolved weftd base URL (no trailing slash).
 * @param {string} opts.apiKey        - Tenant API key (resolved by the caller).
 * @param {string} opts.tenantId      - Tenant ID that owns the key (resolved by the caller).
 * @param {string} [opts.shopPort]    - Shop port (v1 used it to build shopBase for the
 *   system-prompt builder; under the named-toolset model that base arg is voided, so
 *   shopBase is inert — kept for shape parity with v1).
 * @param {string} opts.systemPrompt  - The agent system prompt string (produced by
 *   scripts/gen-system-prompt.mjs in Task 7). Injected to keep this module zero-dep.
 * @returns {{ ensureApp: () => Promise<{tenantId:string,appId:string}>, weftdAPI: (method:string,path:string,body?:object)=>Promise<object> }}
 */
export function createProvisioning({ weftdBase, apiKey, tenantId, shopPort, systemPrompt }) {
  // shopBase preserved from v1's shape (buildStoreSystemPrompt's base arg is
  // voided under the named-toolset model, so this is inert — kept for parity).
  const shopBase = shopPort ? `http://127.0.0.1:${shopPort}` : ''
  void shopBase

  // Lazily provisioned on first ensureApp(): { tenantId, appId }.
  let tenantCtx = null
  let provisionPromise = null

  function weftdAPI(method, path, body) {
    const headers = {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    }
    // Retries ONCE on a transient pre-handshake TLS/connect error OR a mid-stream
    // stall (the reverse proxy in front of weftd intermittently drops the
    // TLS handshake / stalls mid-body — surfacing as `TypeError: fetch failed`
    // or an AbortError when the per-request timeout below fires). HTTP 4xx/5xx
    // are NOT retried — the provisioning chain is idempotent (find-or-create +
    // draft/validate/publish/bind), so a re-run after a mid-chain failure is
    // safe, but a single HTTP error is a real problem, not a transient one.
    // The 20s timeout is essential: WITHOUT it, a stalled fetch hangs
    // provisionApp forever → ensureApp() never settles → the chat bootstrap
    // (`POST /api/chat/session`) hangs indefinitely ("Connecting to chat…").
    const doFetch = (attempt = 0) =>
      fetch(`${weftdBase}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20000),
      }).then(async (res) => {
        if (!res.ok) {
          let msg = `HTTP ${res.status}`
          let code
          try {
            // weftd nested: {"error":{"type","code","message"}} — prefer message,
            // keep code for logs. Flat legacy: {"error":"<code>","message":"…"}
            // (string error IS the code). Never assign an object to msg (→ "[object Object]").
            const e = await res.json()
            if (typeof e?.error === 'string') {
              code = e.error
              msg = e.message || e.error
            } else if (e?.error && typeof e.error === 'object') {
              code = typeof e.error.code === 'string' ? e.error.code : undefined
              msg = e.error.message || code || msg
            } else if (typeof e?.message === 'string') {
              msg = e.message
            }
          } catch {}
          const err = new Error(msg)
          err.status = res.status
          if (code) err.code = code
          throw err
        }
        return res.json()
      }).catch((err) => {
        // Retry on a transient connection error: a pre-handshake drop
        // (TypeError: fetch failed) OR a mid-stream stall that the 20s timeout
        // surfaced as AbortError/TimeoutError. The reverse proxy in front
        // of weftd intermittently stalls connections (notably for keep-alive
        // reuse from a long-running server process — a fresh short-lived
        // process is unaffected); a retry with a fresh connection almost
        // always succeeds. The provisioning chain is idempotent, so up to 3
        // retries (with backoff) is safe. HTTP 4xx/5xx already threw above
        // (not retried).
        const transient = err instanceof TypeError || err.name === 'TimeoutError' || err.name === 'AbortError'
        if (transient && attempt < 3) {
          return new Promise((resolve) => setTimeout(() => resolve(doFetch(attempt + 1)), 250 * (attempt + 1)))
        }
        throw err
      })
    return doFetch()
  }

  async function provisionApp() {
    // Remote mode: tenant is pre-provisioned via the Weft console (WEFT_TENANT_ID).
    if (tenantId) {
      tenantCtx = { tenantId, appId: null }
    } else {
      const t = await weftdAPI('POST', '/v1/tenants', { name: 'Online Store' })
      tenantCtx = { tenantId: t.tenant_id, appId: null }
    }

    // Find or create the online-store-agentic app (slug is unique per tenant).
    const existingApps = await weftdAPI('GET', `/v1/tenants/${tenantCtx.tenantId}/apps`)
    const existing = Array.isArray(existingApps) ? existingApps.find(a => a.slug === 'online-store-agentic') : null
    let app
    if (existing) {
      app = existing
    } else {
      // Register the control-plane app with the same origin allowlist the local
      // server enforces (DEMO_CORS_ORIGIN). Fall back to '*' only when unset —
      // the dev default — so a production integrator who sets DEMO_CORS_ORIGIN
      // gets weftd-side origin enforcement instead of an open wildcard.
      const allowedOrigins = (process.env.DEMO_CORS_ORIGIN ?? '')
        .split(',').map(o => o.trim()).filter(Boolean)
      app = await weftdAPI('POST', `/v1/tenants/${tenantCtx.tenantId}/apps`, {
        slug: 'online-store-agentic',
        display_name: 'Online Store',
        allowed_origins: allowedOrigins.length ? allowedOrigins : ['*'],
      })
    }
    tenantCtx.appId = app.app_id
    const appBase = `/v1/tenants/${tenantCtx.tenantId}/apps/${app.app_id}`

    // The named toolset provides the shop_* tools, but the runtime's
    // tool visibility is fail-closed on an empty allowlist — so the skill must
    // list the shop_* names (derived from the spec's operationIds) for
    // them to be visible to the LLM. plan_route is a runtime internal tool
    // (always visible, no listing needed).
    const specText = await readFile(join(__dirname, '..', 'openapi.json'), 'utf8')
    const toolsetSpec = JSON.parse(specText)
    // Fail-closed tool_names allowlist: every shop_<operationId>.toLowerCase()
    // derived from the spec. tools not listed here stay hidden.
    const toolNames = deriveToolNames(toolsetSpec)
    const skillPayload = {
      tool_names: toolNames,
      system_prompt: systemPrompt,
      model: process.env.OPENAI_MODEL || 'deepseek-v4-flash',
    }
    const autoPayload = {
      config_snapshot: JSON.stringify({
        trigger: { event: 'session.created' },
        action: { type: 'agent_message', message: "Hello! I'm the Online Store shopping assistant. I can help you browse products, manage your cart, and process orders. Try saying 'buy 2 mechanical keyboards and pay'!" },
      }),
    }

    // Skill/automation/graph provisioning are independent — run them in
    // parallel to cut the sequential call count. Each chain is: create
    // (idempotent) → draft → validate → publish → unbind (best-effort) → bind.
    // Toolset (tenant-level, named shop_* tools, execution:client) goes
    // first (sequential — it's tenant-scoped, not app-scoped).
    await provisionToolset(tenantCtx.tenantId, toolsetSpec)
    await Promise.all([
      provisionSkill(appBase, skillPayload),
      provisionAutomation(appBase, autoPayload),
      provisionGraph(appBase),
    ])

    return tenantCtx
  }

  // --- Reachability decision: execution:client for online-store-agentic ---
  //
  // The shop API is SAME-ORIGIN (the browser loads the page from 19745 and
  // calls /api/* + /v1 on 19745), COOKIE-AUTHED (the shop_session cookie
  // rides the same-origin fetch — no per-request credential), and LOCAL/PRIVATE
  // (binds 127.0.0.1, not reachable by the remote weftd). Together
  // that means the named shop_* tools must SUSPEND TO THE BROWSER: the
  // Weft runtime returns a tool-permission request to the chat panel, the
  // browser executes the call same-origin (the cookie authenticates it), and
  // the Weft runtime stamps X-Weft-Actor: agent on the outbound request. Hence
  // execution:"client".
  //
  // base_url:"" => relative paths: the tools follow whatever origin the page
  //   was loaded from. auth_type:"none" => the shop_session cookie handles auth
  //   on the same-origin fetch; no per-request bearer/sealed credential is
  //   attached to the toolset. X-Weft-Actor is the only header the runtime
  //   stamps.
  async function provisionToolset(tenantId, spec) {
    await weftdAPI('PUT', `/v1/tenants/${tenantId}/toolsets/shop`, {
      base_url: '',
      execution: 'client',
      auth_type: 'none',
      spec,
      enabled: true,
    })
  }

  // provisionGraph: a freshly-scaffolded app has NO online-store-agentic-graph.json yet
  // (Task 5's gen-graph.mjs generates it). If the file is absent, skip the
  // entire create/draft/validate/publish/bind chain — ENOENT graceful-skip so
  // first-provision doesn't reject (gap #2b). Task 5 generates the graph +
  // re-provisions to bind it.
  async function provisionGraph(appBase) {
    let graphText
    try {
      graphText = await readFile(join(__dirname, '..', 'online-store-agentic-graph.json'), 'utf8')
    } catch {
      console.warn('[online-store-agentic] online-store-agentic-graph.json not found — skipping graph provisioning (Task 5 generates + binds it)')
      return
    }
    let created = false
    try { await weftdAPI('POST', `${appBase}/graphs`, { slug: 'shopgraph', display_name: 'Online Store Dependency Graph', description: 'Data-flow DAG for the API' }); created = true } catch {}
    const graphVer = await weftdAPI('PUT', `${appBase}/graphs/shopgraph/draft`, { config_snapshot: graphText })
    await weftdAPI('POST', `${appBase}/graphs/shopgraph/validate`)
    await weftdAPI('POST', `${appBase}/graphs/shopgraph/publish`)
    if (!created) { try { await weftdAPI('DELETE', `${appBase}/graphs/shopgraph/unbind`) } catch {} }
    await weftdAPI('POST', `${appBase}/graphs/shopgraph/bind`, { version_id: graphVer.version_id })
  }

  async function provisionSkill(appBase, payload) {
    let created = false
    try { await weftdAPI('POST', `${appBase}/skills`, { slug: 'shopbot', display_name: 'Online Store', description: 'Assistant skill' }); created = true } catch {}
    const skillVer = await weftdAPI('PUT', `${appBase}/skills/shopbot/draft`, payload)
    await weftdAPI('POST', `${appBase}/skills/shopbot/validate`)
    await weftdAPI('POST', `${appBase}/skills/shopbot/publish`)
    // Skip unbind on first creation — nothing is bound yet.
    if (!created) { try { await weftdAPI('DELETE', `${appBase}/skills/shopbot/unbind`) } catch {} }
    await weftdAPI('POST', `${appBase}/skills/shopbot/bind`, { version_id: skillVer.version_id })
  }

  async function provisionAutomation(appBase, payload) {
    let created = false
    try { await weftdAPI('POST', `${appBase}/automations`, { slug: 'welcome', display_name: 'Welcome Greeting', description: 'Greeting' }); created = true } catch {}
    const autoVer = await weftdAPI('PUT', `${appBase}/automations/welcome/draft`, payload)
    await weftdAPI('POST', `${appBase}/automations/welcome/validate`)
    await weftdAPI('POST', `${appBase}/automations/welcome/publish`)
    if (!created) { try { await weftdAPI('DELETE', `${appBase}/automations/welcome/unbind`) } catch {} }
    await weftdAPI('POST', `${appBase}/automations/welcome/bind`, { version_id: autoVer.version_id })
  }

  async function ensureApp() {
    if (tenantCtx?.appId) return tenantCtx
    provisionPromise ??= provisionApp()
      .catch((err) => { provisionPromise = null; tenantCtx = null; throw err })
    return provisionPromise
  }

  return { ensureApp, weftdAPI }
}
