// weftd provisioning chain (skill template).
//
// weftdAPI + provisionApp + provisionToolset + provisionGraph (ENOENT
// graceful-skip) + provisionSkill + provisionAutomation + ensureApp.
//
// The weftd slugs + model default + spec path + display name are placeholder
// tokens ({{…}}). Env resolution (WEFTD_BASE / WEFT_API_KEY / WEFT_TENANT_ID)
// lives in the CALLER, which resolves them from process.env and passes the
// resolved values into createProvisioning(). The system prompt is injected as
// a string — this module stays zero-dep on your prompt renderer.
//
// Expected placement: server/provision.mjs (or equivalent), so
// __dirname/.. resolves to the app root where {{specPath}} and
// {{appSlug}}-graph.json live.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

/**
 * Derive the fail-closed tool_names allowlist from the {{toolset}} OpenAPI spec.
 *
 * Formula: for every operationId across all paths/methods in the spec,
 *   `{{toolset}}_${operationId}`.toLowerCase().
 *
 * flitro's toolVisibleForRun is fail-closed on an empty allowlist — the skill
 * must list these {{toolset}}_* names for the named-toolset tools to be visible
 * to the LLM. plan_route is a runtime internal tool (always visible, no
 * listing).
 *
 * Phase 2b's scripts/gen-tool-allowlist.mjs (Task 4) supersedes this inline
 * derivation; it is preserved here to mirror v1's shape.
 *
 * @param {object} spec - Parsed OpenAPI spec (with `.paths`).
 * @returns {string[]} Ordered array of `{{toolset}}_<operationId>`.toLowerCase() names.
 */
function deriveToolNames(spec) {
  const names = []
  for (const methods of Object.values(spec.paths ?? {})) {
    for (const [m, op] of Object.entries(methods ?? {})) {
      if (!['get', 'post', 'put', 'patch', 'delete', 'head', 'options'].includes(m)) continue
      if (op?.operationId) names.push(`{{toolset}}_${op.operationId}`.toLowerCase())
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
    // Retries ONCE on a transient pre-handshake TLS/connect error (a
    // reverse-proxy TLS-handshake drop — undici surfaces it as a `TypeError: fetch failed`),
    // mirroring the /v1 proxy's retry in session-routes.mjs. HTTP 4xx/5xx are
    // NOT retried — the provisioning chain is idempotent (find-or-create +
    // draft/validate/publish/bind), so a re-run after a mid-chain failure is
    // safe, but a single HTTP error is a real problem, not a transient one.
    const doFetch = () =>
      fetch(`${weftdBase}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      }).then(async (res) => {
        if (!res.ok) {
          let msg = `HTTP ${res.status}`
          try { const e = await res.json(); if (e.error) msg = e.error } catch {}
          const err = new Error(msg)
          err.status = res.status
          throw err
        }
        return res.json()
      })
    return doFetch().catch((err) => {
      if (err instanceof TypeError) return doFetch() // one retry on a reverse-proxy TLS-handshake drop
      throw err
    })
  }

  async function provisionApp() {
    // Remote mode: tenant is pre-provisioned via the Weft console (WEFT_TENANT_ID).
    if (tenantId) {
      tenantCtx = { tenantId, appId: null }
    } else {
      const t = await weftdAPI('POST', '/v1/tenants', { name: '{{appName}}' })
      tenantCtx = { tenantId: t.tenant_id, appId: null }
    }

    // Find or create the {{appSlug}} app (slug is unique per tenant).
    const existingApps = await weftdAPI('GET', `/v1/tenants/${tenantCtx.tenantId}/apps`)
    const existing = Array.isArray(existingApps) ? existingApps.find(a => a.slug === '{{appSlug}}') : null
    let app
    if (existing) {
      app = existing
    } else {
      app = await weftdAPI('POST', `/v1/tenants/${tenantCtx.tenantId}/apps`, {
        slug: '{{appSlug}}',
        display_name: '{{appName}}',
        allowed_origins: ['*'],
      })
    }
    tenantCtx.appId = app.app_id
    const appBase = `/v1/tenants/${tenantCtx.tenantId}/apps/${app.app_id}`

    // The named toolset provides the {{toolset}}_* tools, but flitro's
    // toolVisibleForRun is fail-closed on an empty allowlist — so the skill must
    // list the {{toolset}}_* names (derived from the spec's operationIds) for
    // them to be visible to the LLM. plan_route is a runtime internal tool
    // (always visible, no listing needed).
    const specText = await readFile(join(__dirname, '..', '{{specPath}}'), 'utf8')
    const toolsetSpec = JSON.parse(specText)
    // Fail-closed tool_names allowlist: every {{toolset}}_<operationId>.toLowerCase()
    // derived from the spec. flitro hides tools not listed here.
    const toolNames = deriveToolNames(toolsetSpec)
    const skillPayload = {
      tool_names: toolNames,
      system_prompt: systemPrompt,
      model: process.env.OPENAI_MODEL || '{{model}}',
    }
    const autoPayload = {
      config_snapshot: JSON.stringify({
        trigger: { event: 'session.created' },
        action: { type: 'agent_message', message: "Hello! I'm the {{appName}} shopping assistant. I can help you browse products, manage your cart, and process orders. Try saying 'buy 2 mechanical keyboards and pay'!" },
      }),
    }

    // Skill/automation/graph provisioning are independent — run them in
    // parallel to cut the sequential call count. Each chain is: create
    // (idempotent) → draft → validate → publish → unbind (best-effort) → bind.
    // Toolset (tenant-level, named {{toolset}}_* tools, execution:client) goes
    // first (sequential — it's tenant-scoped, not app-scoped).
    await provisionToolset(tenantCtx.tenantId, toolsetSpec)
    await Promise.all([
      provisionSkill(appBase, skillPayload),
      provisionAutomation(appBase, autoPayload),
      provisionGraph(appBase),
    ])

    return tenantCtx
  }

  // --- Reachability decision: execution:client for {{appSlug}} ---
  //
  // The host API is SAME-ORIGIN (the browser loads the page from {{port}} and
  // calls /api/* + /v1 on {{port}}), COOKIE-AUTHED (the {{sessionCookie}} cookie
  // rides the same-origin fetch — no per-request credential), and LOCAL/PRIVATE
  // (binds 127.0.0.1, not reachable by the remote weftd). Together
  // that means the named {{toolset}}_* tools must SUSPEND TO THE BROWSER: the
  // Weft runtime returns a tool-permission request to the chat panel, the
  // browser executes the call same-origin (the cookie authenticates it), and
  // the Weft runtime stamps X-Weft-Actor: agent on the outbound request. Hence
  // execution:"client".
  //
  // base_url:"" => relative paths: the tools follow whatever origin the page
  //   was loaded from. auth_type:"none" => the host session cookie handles auth
  //   on the same-origin fetch; no per-request bearer/sealed credential is
  //   attached to the toolset. X-Weft-Actor is the only header the runtime
  //   stamps.
  async function provisionToolset(tenantId, spec) {
    await weftdAPI('PUT', `/v1/tenants/${tenantId}/toolsets/{{toolset}}`, {
      base_url: '',
      execution: 'client',
      auth_type: 'none',
      spec,
      enabled: true,
    })
  }

  // provisionGraph: a freshly-scaffolded app has NO {{appSlug}}-graph.json yet
  // (Task 5's gen-graph.mjs generates it). If the file is absent, skip the
  // entire create/draft/validate/publish/bind chain — ENOENT graceful-skip so
  // first-provision doesn't reject (gap #2b). Task 5 generates the graph +
  // re-provisions to bind it.
  async function provisionGraph(appBase) {
    let graphText
    try {
      graphText = await readFile(join(__dirname, '..', '{{appSlug}}-graph.json'), 'utf8')
    } catch {
      console.warn('[{{appSlug}}] {{appSlug}}-graph.json not found — skipping graph provisioning (Task 5 generates + binds it)')
      return
    }
    let created = false
    try { await weftdAPI('POST', `${appBase}/graphs`, { slug: '{{graphSlug}}', display_name: '{{appName}} Dependency Graph', description: 'Data-flow DAG for the API' }); created = true } catch {}
    const graphVer = await weftdAPI('PUT', `${appBase}/graphs/{{graphSlug}}/draft`, { config_snapshot: graphText })
    await weftdAPI('POST', `${appBase}/graphs/{{graphSlug}}/validate`)
    await weftdAPI('POST', `${appBase}/graphs/{{graphSlug}}/publish`)
    if (!created) { try { await weftdAPI('DELETE', `${appBase}/graphs/{{graphSlug}}/unbind`) } catch {} }
    await weftdAPI('POST', `${appBase}/graphs/{{graphSlug}}/bind`, { version_id: graphVer.version_id })
  }

  async function provisionSkill(appBase, payload) {
    let created = false
    try { await weftdAPI('POST', `${appBase}/skills`, { slug: '{{skillSlug}}', display_name: '{{appName}}', description: 'Assistant skill' }); created = true } catch {}
    const skillVer = await weftdAPI('PUT', `${appBase}/skills/{{skillSlug}}/draft`, payload)
    await weftdAPI('POST', `${appBase}/skills/{{skillSlug}}/validate`)
    await weftdAPI('POST', `${appBase}/skills/{{skillSlug}}/publish`)
    // Skip unbind on first creation — nothing is bound yet.
    if (!created) { try { await weftdAPI('DELETE', `${appBase}/skills/{{skillSlug}}/unbind`) } catch {} }
    await weftdAPI('POST', `${appBase}/skills/{{skillSlug}}/bind`, { version_id: skillVer.version_id })
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
