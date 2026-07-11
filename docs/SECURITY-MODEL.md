# Weft Security Model

This document describes the security model integrators must understand when
embedding `@percena/weft` (the browser SDK) and wiring it to a weftd control
plane. It is the integrator-facing companion to [ARCHITECTURE.md](./ARCHITECTURE.md)
(which covers the internal design).

## Threat surface

The browser runs two kinds of agent-issued tool calls; the security model
treats them differently:

1. **Server-side tools** (`execution: server`) — the agent calls weftd, which
   calls your REST API from the server. The browser never sees the request body
   or the developer credential. This is the safe default for anything that
   touches privileged state.

2. **Client-side tools** (`execution: client`, e.g. `client_http_request` and
   your named `*_<operationId>` tools) — the browser executes them directly
   against your same-origin REST API, riding the user's session cookie. The
   action-bridge replays them visually. **The browser is the execution
   boundary here**, so the SDK applies hard guards:

   - **Same-origin only.** The built-in `client_http_request` executor refuses
     any URL that is not same-origin with the page. A relative URL (recommended)
     or an exact same-origin absolute URL is required. To call a cross-origin
     endpoint from the browser you must register a custom `toolHandlers` entry
     (an explicit, audited opt-out — never the default).
   - **`autoExecuteClientHttp` is OFF by default.** Without it, a
     `client_http_request` tool call surfaces as a permission prompt; the user
     must approve before the request fires. Set `autoExecuteClientHttp: true`
     only for unattended/e2e flows where you have already vetted the request
     shape.
   - **Permission mode defaults to `ask`.** The chat panel starts in `ask`
     (review changes before execution). `auto` executes without prompts;
     `explore` is read-only. The integrator chooses the mode per session; the
     SDK never silently downgrades to `auto`.

3. **`X-Weft-Actor` stamping.** The browser runtime stamps
   `X-Weft-Actor: agent` on client-side tool calls so your event-emission can
   tag those events `actor: "agent"` (the action-bridge replays only
   agent-originated events). The integrator's backend MUST NOT trust
   `X-Weft-Actor` for authorization — it is a labeling header, stripped from
   model-provided arguments and set by the runtime, not a credential.

## Credential boundary

- The **developer credential** (`WEFT_API_KEY`) never reaches the browser. The
  backend holds it and mints a **scoped session token**
  (`POST /v1/sessions` → `{session_id, token, base_url, expires_at}`) via
  `POST /api/chat/session`; the browser only ever sees the scoped token, and
  refreshes it reactively on 401 via `POST /api/chat/session/:id/token`
  (`onTokenExpired`) — never a proactive timer.
- The **`/v1/*` reverse proxy** to weftd forwards only an allowlisted set of
  headers (Authorization + `X-Weft-*` routing/actor headers); the browser's
  session **Cookie is stripped** so it is not forwarded to the agent control
  plane. See `skills/integrate-weft-kit/templates/session-routes.mjs`
  (`proxyHeaders`).

## Rendered content (XSS)

Agent markdown is untrusted. The rendering pipeline is, in order:
`react-markdown` → `rehype-raw` (parses the raw HTML the model emits) →
`rehype-sanitize` (the XSS gate) → `rehype-katex` → Shiki for code.

- `rehype-sanitize` runs **after** `rehype-raw`, with a schema that extends
  the GitHub-style `defaultSchema` (which blocks `iframe`/`script`/`form`/
  `style`). `rehype-sanitize` is a **declared runtime dependency** of
  `@percena/weft` (not bundled) and a publish-time assertion
  (`publish/browser/scripts/assert-exports.mjs` §5) guards that it stays
  external — a future tsup/externalization change cannot silently drop or
  stale it without failing the build.
- Code blocks use `dangerouslySetInnerHTML` with **Shiki output** (Shiki
  escapes source into `<span>`s); both sites are `biome-ignore`d with that
  justification, and `noDangerouslySetInnerHtml` is an **error** rule repo-wide.

## CORS

Templates default to **origin reflection against a `DEMO_CORS_ORIGIN`
allowlist**, never `Access-Control-Allow-Origin: *` on cookie-authenticated
sessions (`*` is inert for credentialed cross-origin fetches anyway and
misleads integrators). Unset = dev-only permissive reflection (Vite dev server
→ backend); production MUST set `DEMO_CORS_ORIGIN` to its exact origins. See
[EMBEDDING.md](./EMBEDDING.md) §CORS.

## What the SDK does NOT enforce

- **Your REST API's authorization.** The SDK enforces the *execution*
  boundary (who can call, from where, with whose cookie); it does not model
  your resource-level permissions. Enforce those in your REST layer (role
  checks, per-resource ACLs) — the agent's `actor: "agent"` label is a hint,
  not an authz decision.
- **The API dependency graph (DAG).** It is **fail-open** by design — all
  edges `required: false`, and graph validate-failure is skipped so a graph
  issue cannot block the site. It is a planning hint, not a security control;
  real enforcement is the reactive `409 + allowed_actions` your SM returns on
  illegal transitions.
