---
name: integrate-weft-kit
description: Use when integrating the @percena/weft SDK into an existing REST API project that has an OpenAPI/swagger spec to make it agentic (embed a Weft chat panel whose LLM agent drives the project's REST API); or when modeling, generating, reviewing, or repairing the per-resource state machine and API dependency graph (DAG) for such an integration. Symptoms include an agent that "can't" operate a pre-existing or cross-session resource and mints a duplicate instead.
license: MIT
compatibility: "Requires @percena/weft ^1.0.1, a REST API with an OpenAPI/swagger spec, Node 20+ or Python 3.11+, and a Weft control-plane (weftd) tenant provisioned at https://weft-kit.dev."
metadata:
  author: percena
  version: "1.0.3"
  min-weft-sdk: "1.0.1"
  source: https://github.com/percena/weft-sdk/tree/main/skills/integrate-weft-kit
  changelog: https://github.com/percena/weft-sdk/blob/main/skills/integrate-weft-kit/CHANGELOG.md
---

# Integrate Weft Kit

## Overview

Make a REST API agentic with `@percena/weft`: an LLM agent drives your REST API through an embedded chat panel, operating the same endpoints the page uses. Two layers must be correct — **integration wiring** (provisioning + browser SDK + tools from your OpenAPI spec) and **behavioral model** (per-resource state machine + API dependency DAG).

This skill is self-contained: the runbook, `templates/`, and `references/` are enough. Do **not** assume any monorepo layout, demo app, or sibling package path exists in the user's project.

## When to Use

- You have a REST API + OpenAPI/swagger spec and want an LLM agent to operate it via a Weft chat panel.
- You're modeling a resource state machine or generating/reviewing the API dependency graph (DAG) for a Weft integration.
- An agent "can't" operate a pre-existing or cross-session resource and mints a duplicate instead → a DAG edge is mis-marked `required:true` (see Part 2).
- A running integration hits `EADDRINUSE`, `502 weftd proxy failed: …TLS…`, or the chat prompts on every write tool → operational gotchas in Common Mistakes.

**When NOT:** spec-less APIs (no OpenAPI) → use `client_http_request`, no graph. Public-vs-private reachability decides `execution`, not whether to integrate.

## Prerequisites — verify + install (eager for build deps, lazy at point of use)

Two npm packages must be present for a full run. **Verify + install if missing — do NOT let a missing package throw an execution error mid-run** (e.g. `Cannot find module '@percena/weft'`, `playwright-cli: command not found`). But don't install everything upfront: **eager-install only what the next phase needs; lazy-install the rest at its point of use.** This avoids a wasteful global install when the user only builds/provisions (or when weftd is down + the loop falls back to non-weftd REST tests, never reaching e2e). Re-check after a fresh clone or a branch switch.

- **`@percena/weft`** — *eager, before Part 1 (build).* The browser SDK ships the chat panel, action-bridge, + the `weft-api-graph` bin; the frontend bundle `import`s it at build time, so it must resolve **before** the first `vite build`. Verify in the **project** first; install with the **project's own package manager** only if the verify finds nothing. Pin to `^1.0.1` (the frontmatter `metadata.min-weft-sdk`). Do **not** use `workspace:*` — that only resolves inside the weft monorepo (see Part 1 §0).
  ```bash
  # 1. verify presence with the project's package manager (pick the one the project uses)
  npm ls @percena/weft 2>/dev/null || pnpm ls @percena/weft 2>/dev/null || yarn list --pattern '@percena/weft' 2>/dev/null
  # 2. install ONLY if the verify above found nothing — use the SAME package manager the project already uses
  npm install   @percena/weft@^1.0.1   # pnpm add @percena/weft@^1.0.1  |  yarn add @percena/weft@^1.0.1
  ```

- **`@playwright/cli`** (provides the `playwright-cli` bin) — *lazy, at Phase 3 (e2e) point of use.* Only the headed-e2e loop needs it; don't global-install it for a build-only run. The verify-or-install guard lives in Phase 3, right before the first `playwright-cli` command:
  ```bash
  # the bin is `playwright-cli`; the npm package that provides it is `@playwright/cli`
  command -v playwright-cli || npm install -g @playwright/cli
  ```
  > ⚠️ Do **NOT** `npm install -g playwright-cli` or `npx playwright-cli` — `playwright-cli` is a *different, unrelated* npm package that happens to share the bin name. The scoped `@playwright/cli` is the correct one (it provides the `playwright-cli` bin). Verify with `command -v`, not by package-name guess.
  The e2e steps run it **headed** (`playwright-cli open` → `goto`/`click`/`fill` …) so the user sees the browser + the automated live cursor + can intervene (see Phase 3).

If an install itself fails (no Node 20+, registry offline, no write access for `-g`), surface that root cause + stop — don't paper over it with a downstream error.

## Trust model (read this first — security is a contract, not an afterthought)

A green functional run does NOT mean a safe run. The closed loop catches functional bugs; **security is a separate contract** ([references/security-contract.md](references/security-contract.md)) enforced by the templates + verified by an executable guard (`templates/security.test.mjs` / `templates/python/test_session_routes_security.py`). Four trust boundaries:

| Boundary | Trust | Implication |
|---|---|---|
| **Host operator** | Trusted | Selects provider, cwd, executable, env, sources, policies, permission mode. Holds the weftd developer key (server-side only). |
| **Agent / model output** | **Untrusted** | Prompt injection arrives via fetched pages + tool results. Every model-emitted tool call is gated; model Markdown is sanitized. |
| **Browser** | **Untrusted** | Cookies + most headers are client-settable — the session cookie is NEVER forwarded to weftd; `X-Forwarded-*` is not trusted by default; `X-Weft-Actor` is visual-replay only. |
| **weftd** | Trusted control plane | The integrator backend mints scoped session tokens for the browser. |

The templates ship **secure-by-default** (Tier 1 of the contract: auth 401, ownership fail-closed 403, `end_user_id` from cookie, proxy header allowlist + path-normalize + body cap, SSE cap, CORS per-request). The guard makes the closed loop's §6 security dimension **executable** — a future weakening of a template fails the guard. Do NOT weaken the defaults; your real auth, policy hook, prod config, + tool-allowlist review are **Tier 3 integrator responsibilities** (the guard can't verify them — see the contract).

## The integration contract + the closed loop (the core)

This skill is **NOT a one-shot recipe** — that would need exhaustively detailed, language-specific guidance (a template set per language, unsustainable). It's a **closed-loop feedback system**: build → test (headed Playwright) → self-repair → repeat until green. The high-level **contract** below + the **test categories** are the spine; the LLM implements the contract in YOUR backend's idiom, and the feedback loop catches what it missed. The goal is a working agentic site via iteration — NOT correctness on the first try.

### The integration contract (language-agnostic)

Regardless of backend language, the Weft integration requires these. Implement them in your backend's idiom — the LLM decides the concrete code. The Node (`templates/*.mjs`) + Python (`templates/python/`) sets are **worked examples (fast-paths)**; for any other language (Go/Gin, Java/Spring, Ruby/Rails, …), follow this contract.

1. **Same-origin SPA + API.** Serve the built frontend bundle + the REST API on one origin (the browser cookie rides the same-origin fetch; the client-executed tools + the action-bridge need it). Dev: a Vite/webpack proxy; prod: the backend serves the bundle (SPA fallback).
2. **`POST /api/chat/session` + `POST /api/chat/session/{id}/token`.** The backend holds the weftd developer credential (server-side ONLY — never the browser) and mints a scoped session (`POST /v1/sessions` → `{session_id, token, base_url, expires_at}`). The browser only sees the scoped token. Token refresh is **reactive** (401 → `onTokenExpired` → the `/token` endpoint), not a timer.
3. **`/v1/*` reverse proxy → weftd.** Same-origin; stream the run/timeline SSE **unbuffered**; retry only **pre-handshake** errors (a reverse-proxy TLS-handshake drop), never mid-stream (headers already sent → would replay non-idempotent POSTs).
4. **`X-Weft-Actor` → event-actor.** The Weft browser runtime stamps `X-Weft-Actor: agent` on client-side tool calls. Your event-emission must tag those events `actor: "agent"` (so the action-bridge replays them). A real site won't have this — **ADD** it (a middleware/interceptor that sets the actor from the header).
5. **Provisioning** (server-side, `Authorization: Bearer <WEFT_API_KEY>`): an app + a toolset (`execution:client`, `base_url:""` relative, `auth_type:"none"`) + a skill (`tool_names` allowlist + `system_prompt` + `model`) + an automation (welcome) + the graph. `tool_names` = `<toolset>_<operationId>`.toLowerCase() per operationId (**fail-closed** — enumerate or the LLM sees zero tools). Lazy + idempotent (find-or-create + draft/validate/publish/bind).
6. **The OpenAPI is the source of truth** for the tools (+ the graph). Auto-curated if possible (exclude auth/utility/SSE from the schema → only business ops are tools). **Ensure a `servers` field exists** (some frameworks don't emit one → flitro rejects the toolset "no base URL").
7. **The system prompt** rendered from the SM (the same SM the backend enforces → can't drift). Include: the toolset prefix, the SM transitions (+ `$prior`), the `409`+`allowed_actions` backstop, the workflow rules.
8. **The dependency graph** — **fail-open** (all edges `required:false`); gracefully **skip on validate-failure** (the agent uses the system prompt + 409, not the graph). Don't let a graph issue block the site.
9. **The frontend chat layer** — `ChatPane` (from `@percena/weft`) + `chat-bootstrap` (calls `/api/chat/session`) into a sidebar; `ActionReplayLayer` + `weftAction(...)` annotations on the UI elements for each agent-mutatable resource (target an always-visible row/card, not a modal that may be closed). Keep YOUR auth; only adapt the end-user-id for the chat session.

### The closed loop (the methodology)

0. **Inventory + baseline (BEFORE the build)** — list the classic app's features: the resources, the state machines (+ `$prior` back-edges), the workflows, the auth roles, the **UI pages/tabs**, the SSE event types. Test them in the classic app first (its own tests + a manual smoke of each feature). This inventory is the feature checklist the agentic layer must preserve + extend — **it drives the test coverage**. If a feature isn't in the inventory, it isn't tested, and a bug there ships.
1. **Build** the agentic layer following the contract (a fast-path template if your language matches; else the LLM implements the contract in your idiom).
2. **Run** — build the SPA + start the backend + provision on weftd.
3. **Test ALL features** — **dynamically generate the test list** from the inventory (step 0) mapped to the **test categories** (below); verify each in a **headed** Playwright e2e (the user SEES the browser + the automated live cursor + can intervene); verify via `/api/state` (or your app's equivalent ground-truth endpoint). Don't rely on a fixed checklist — the inventory × the categories drives full coverage.
4. **On failure** → reproduce → isolate root cause → fix (in the app, a template, or the system-prompt) → re-run. Record each failure + fix.
5. Feed durable findings back into the skill when you maintain a fork (a new fast-path, a common mistake, a contract clarification, a test-category clarification).

### The test categories (the framework — dynamically generate the test list per site)

Don't rely on a fixed checklist — every site is different. **Inventory the site's features (step 0), map each to these categories, generate the test list, + verify each in e2e.** The categories are the DIMENSIONS to cover; the specific tests are generated per-site.

**1. Integration wiring (the contract, §1-9)** — each contract point works: same-origin SPA+API; chat-session bootstrap + token refresh; the `/v1` reverse proxy (streaming + TLS retry); the `X-Weft-Actor`→actor override; provisioning (the toolset/skill/automation/graph); the OpenAPI as the tool source; the system prompt from the SM; the fail-open graph; the frontend chat layer.

**2. Feature regression (the classic preserved)** — every classic feature still works through the agentic overlay: every resource (CRUD + transitions), every SM transition (incl `$prior` back-edges + side effects), every auth role + the role gates, every UI page/tab + the navigation, the SSE live-update on each page.

**3. Agent driving (the agent operates the API)** — the agent sees + can call every tool (the `tool_names` allowlist); drives every workflow end-to-end via the chat; handles the SM `409 + allowed_actions` backstop (relay + recover, no blind-retry); handles role separation (acts as the logged-in role).

**4. Visual feedback (the action-bridge)** — the automated live cursor replays every agent tool call (same-page); **cross-page/cross-tab visibility** — the user on a different page still sees the activity (auto-switch to the event's tab, or a badge); the SSE live-update (the list refreshes on agent events).

**5. Cross-cutting concerns** — cross-session reference (operate on a pre-existing resource by id from a new session — the graph fail-open regression); error handling (409/403 + the agent's recovery; the transient TLS-drop retry); streaming (the `/v1` SSE runs the chat live); token refresh (401 → `onTokenExpired` → new token); multi-page UX.

**6. Security / trust boundaries (DO NOT SKIP — the closed loop catches functional bugs, NOT security bugs)** — the e2e + ground-truth checks above verify the agent *works*; they do NOT verify it is *safe*. **The template-shipped Tier-1 invariants are verified by the executable guard** — run it as the first step of §6:
  - `cd templates && node --test security.test.mjs` (Node) — asserts: unauth → 401, non-owner → 403, post-restart → 403 (fail-closed), `/v1/tenants` + case/`//`/`%2f` → 404, oversized body → 413, CORS un-allowlisted → no ACAO.
  - `cd templates/python && pytest -q test_session_routes_security.py` (Python) — the same invariants + the `..`-traversal bypass (`/v1/sessions/../tenants/` → 404).
  The guard covers [security-contract §1-4,6](references/security-contract.md). The bullets below cover what the guard CAN'T (it can't verify the integrator's own code + the app-level config):
  - **Auth + ownership** — the guard asserts the template defaults; YOU must verify your login flow sets the cookie with real credentials (templates may illustrate a no-password login for local smoke tests — replace it; otherwise the cookie-based identity is circumvented one step back).
  - **CORS config actually applied** (app-level — Python `CORSMiddleware` in your app entry): with `DEMO_CORS_ORIGIN` (or your app's equivalent) set, assert a credentialed cross-origin request from an un-allowlisted origin is rejected AND the configured origins are the ones in effect at runtime.
  - **No credential forwarding / leakage**: assert the `/v1/*` proxy strips the session cookie (header allowlist, not denylist) and that no `Authorization`/`Set-Cookie` is logged (the `@weft/sources` debug logger is gated behind `WEFT_DEBUG=1` — verify it's silent by default).
  - **Body / connection limits**: the guard asserts the template body cap (413); YOU must cap the app's own SSE endpoint (the template provides the SSE Set + broadcast but no endpoint — the app owns the SSE handler + its global/per-IP cap → 429).
  - **Prompt-injection tool-allowlist review**: enumerate every tool in the `tool_names` allowlist and ask, for each, "if the model is prompt-injected to call this tool with the user's cookie, is the action acceptable?" Keep the allowlist minimal.
  - **The reactive 409 + `allowed_actions` backstop**: assert an illegal state transition returns 409 + `allowed_actions` and the agent relays it (this is the SOLE enforcement once the DAG fails open — see `references/fail-open.md`). Your classic app's inline state module may LACK it; you MUST return `409 { error, allowed_actions }` on illegal transitions.

**Generate + verify:** for each feature in the inventory, ask "which categories does this touch?" → generate a test per (feature × category). Drive each via a **headed** Playwright e2e (chat `Auto`); verify via ground-truth state, NOT chat text. Reload between sessions for the cross-session test.

The Node fast-path (Part 1) + the Python branch (below) are worked examples of this contract. **For a language with no fast-path, follow the contract + trust the closed loop** — the LLM implements, the categories catch, you iterate.

## Part 1 — Node reference implementation (fast-path)

The worked example for a **Node** backend — the contract above, materialized. **`templates/`** holds the parameterized agentic layer (copy + substitute `{{placeholders}}` + wire into your server). **`references/`** holds the deep theory (fail-open, plan_route/veto, execution model). For a **Python** backend, skip to "Non-JS backend (Python)" (+ `templates/python/`); for any other language, follow the contract + use the closed loop.

**Placeholders** (substitute with a word-only `{{\w+}}` regex — `auth-context.tsx`'s JSX `value={{ user, … }}` is NOT one): `{{port}}` `{{appName}}` `{{appSlug}}` `{{toolset}}` `{{skillSlug}}` `{{graphSlug}}` `{{model}}` `{{specPath}}` `{{sessionCookie}}` `{{sseEventName}}`.

| Placeholder | Meaning | Example |
|---|---|---|
| `{{sessionCookie}}` | Host app's browser session cookie name (used by `cid` / `end_user_id`) | `app_session` |
| `{{sseEventName}}` | SSE event type for the action-bridge fan-out | `app.event` |

**Backend language:** the runbook + `templates/*.mjs` assume **Node**. For a **Python/FastAPI** backend, use `templates/python/` instead — see "Non-JS backend (Python)" below.

0. **Scaffold** — start from your existing traditional REST + SPA app (or create one). First **verify `@percena/weft` resolves in the project — install it if missing (Prerequisites above) before any build**. Deltas: add `@percena/weft: ^1.0.1` from npm (do **not** use `workspace:*` — that only works inside a private monorepo; the graph analyzer + `weft-api-graph` bin ship **inside** `@percena/weft`, so no separate graph-tool dep); configure the Vite/webpack dev proxy to your API port; ensure `types:["vite/client"]` if using Vite; set the HTML title to `{{appName}}`. Confirm install + existing tests still pass (the REST routes survived).
1. **Copy the agentic layer in** — `templates/{provision.mjs,session-routes.mjs}` → your server directory; `templates/{ChatPane.tsx,chat-bootstrap.ts,auth-context.tsx,customer.ts}` → your frontend `src/` (adapt auth-context/customer to YOUR auth cookies); `templates/{run.mjs,.env.example}` → app root (or merge `assertWeftdCreds` into your existing entrypoint). Build a system-prompt module that imports your shared state-machine module. Wire your HTTP server: `import { createProvisioning } from './provision.mjs'`, `import { wireSessionRoutes } from './session-routes.mjs'`; resolve `WEFTD_BASE`/`WEFT_API_KEY`/`WEFT_TENANT_ID` from env; `const { ensureApp, weftdAPI } = createProvisioning({ weftdBase, apiKey, tenantId, shopPort: port, systemPrompt })`; create shared `sseClients = new Set()` / `sessions = new Map()`; call `wireSessionRoutes(server, { weftdBase, apiKey, tenantId, ensureApp, weftdAPI, sseClients, sessions, sessionCookie: '{{sessionCookie}}', sseEventName: '{{sseEventName}}' })` AFTER the request handler is registered (it wraps the listener). Match `ActionReplayLayer`'s `eventName` prop to `{{sseEventName}}`. Set `APP_PUBLIC_BASE` in production. The `/v1` proxy in `session-routes.mjs` is **verbatim** production-hardened code (TLS retry, `headersSent` gating) — don't simplify. `provisionGraph` try/catches the graph file's ENOENT so first-provision doesn't reject before the graph is generated. **Preserve the action-bridge** — include `ActionReplayLayer` + `weftAction(...)` (from `@percena/weft/action-bridge`) on interactive elements so the automated live cursor replays agent tool calls.
2. **`.env`** (backend only; never browser) — fill from the substituted `.env.example`: `WEFTD_BASE`, `WEFT_API_KEY`, `WEFT_TENANT_ID`, `OPENAI_API_KEY`/`OPENAI_BASE_URL`/`OPENAI_MODELS`/`OPENAI_MODEL`, and your server port.
3. **Browser SDK** — `templates/ChatPane.tsx` + `chat-bootstrap.ts` wire `@percena/weft` (the browser never sees the tenant key). Backend mints a scoped weftd session; token refresh is **reactive** (401→`onTokenExpired`), not a timer. `/v1/*` proxies to weftd same-origin; retry only pre-handshake TLS errors, never mid-stream.
4. **Tools from the spec** — `tool_name = `<toolset>_<operationId>`.toLowerCase()` per operationId (flitro lowercases; camelCase→"tool not found" — the #1 error). The `tool_names` allowlist is **fail-closed**: enumerate every `<toolset>_*` name or the LLM sees zero tools. `plan_route` is runtime-internal, never listed.
5. **`execution: server` vs `client`** (reachability — see `references/execution-model.md`):

   | | `server` | `client` |
   |---|---|---|
   | HTTP call by | weftd/flitro server | the browser, same-origin |
   | `base_url` | real reachable URL | `""` (relative; page origin) |
   | Use when | API public to weftd | API private/local or shares page origin/cookie |

   Same-origin + cookie + local → `client` (`base_url:""`, `auth_type:"none"`; the browser cookie rides the fetch, `X-Weft-Actor: agent` stamped by the runtime); public + sealed credential → `server`.
6. **State machine (reactive backstop)** — extract your inline SM into ONE shared module used by backend + frontend + system prompt: states, transitions incl. `$prior` back-edges, side-effect flags, labels. Render it at runtime so it can't drift. **Your state module must return 409 `{error, allowed_actions:[…]}`** (snake_case; the legal action names for the current status) on an illegal transition. The prompt relays `allowed_actions`, no blind-retry. **Reparameterize the system-prompt's toolset prefix** after copying — replace any example tool prefixes with YOUR toolset. Double-check the tool names match the `tool_names` allowlist from Step 4.
7. **Graph** — generate with the `weft-api-graph` bin that ships inside `@percena/weft` (no separate dependency): `npx weft-api-graph {{specPath}} {{toolset}} {{appSlug}}-graph.json --verified`. Set `<toolset>` to match Step 4's toolset literal. `--verified` records the fail-open review sign-off (sets `graph.verified` + every edge `.verified = true`); drop it for a `verified:false` PR-review draft you sign manually. Optionally keep a small regen script that does `import { generateGraph } from '@percena/weft/api-graph'` for byte-stable regen — do NOT list a separate graph-tool dep. **Review before publish** — per edge: produced by `from` (generative→may `required:true`) or a reference to a pre-existing resource (referential→MUST `required:false`)? See `references/fail-open.md` + `references/plan-route-veto.md`. Analyzer v2 draft is already fail-open (all `required:false`); review sets `verified:true`. Committing the reviewed `*-graph.json` IS the sign-off; `generated_by.spec_hash` seals the spec (regenerate on spec change).
8. **Provision + run** — start via your entrypoint (or `node run.mjs` after adapting imports); `assertWeftdCreds` fails fast on missing creds; `ensureApp` provisions on weftd. Set chat permission mode `Auto` for unattended/e2e.
9. **Verify** — Manual Verification below. Cross-session reference is the key test (a referential edge wrongly `required:true` → duplicate).

## Non-JS backend (Python/FastAPI)

> **Template-sync rule (security — do NOT drift):** the Node (`templates/*.mjs`) + Python (`templates/python/*.py`) template sets are **security-equivalent ports of the same contract**. A security fix to one set (auth, ownership, body/SSE limits, proxy denylist, header allowlist, redaction) MUST be mirrored to the other **in the same commit**. When porting a fix, diff the two `session_routes` files (they should be equivalent modulo language) + update both.

For a **Python/FastAPI** backend, use `templates/python/` instead of the Node `.mjs` set. See `templates/python/README.md` for the wiring. The classic's REST + SM are unchanged; the Weft layer is added on top.

- **The backend templates are Node-only by default.** `provision.mjs`/`session-routes.mjs`/`run.mjs` are Node. For Python, use the `templates/python/` set (httpx for the weftd calls + the `/v1` reverse proxy; `uvicorn` for serve).
- **The `/v1` reverse-proxy TLS-retry is Node `http`.** The Python port (`session_routes.py`) uses `httpx.AsyncClient` streaming + retries ONE pre-handshake `ConnectError`/`ConnectTimeout`; mid-stream errors surface (not retried — headers already sent).
- **`auth-context.tsx` + `customer.ts` are example-shaped.** Those browser templates reference a sample session cookie + guest-id singleton. For a real site, KEEP the classic's own auth + only adapt the end-user-id for `chat-bootstrap` (e.g. the logged-in username). Don't push these templates generically.
- **`X-Weft-Actor` actor extraction is NOT in a real site.** The skill must ADD it (Python: `weft.py` — a contextvar set by a middleware + a one-line emit override `actor = get_actor() or actor`). Without it, agent events aren't tagged `"agent"` → the action-bridge won't replay them.
- **Action-bridge annotations must be ADDED to the classic's elements.** Annotate YOUR elements with `weftAction('row', id)` + a `toActionEvent` map. Target an always-visible row/card (the detail modal may not be open when the agent acts).
- **The SSE event name is app-specific.** Use YOUR event name in BOTH the backend's SSE broadcast + the `ActionReplayLayer` `eventName` prop.
- **The system-prompt renderer is language-specific.** For Python, `system_prompt.py` renders the SM from your state-machine module (skeleton in `templates/python/`).
- **`run.mjs` conflates `vite build` + serve.** For Python, `run.py` does `assert_weftd_creds` + `uvicorn` ONLY (the frontend build is a separate step; chain both in your start script).
- **The Node listener-wrap DISSOLVES on a router-based backend.** `wireSessionRoutes` wraps `server.listeners('request')[0]` (a Node http artifact). On FastAPI (or any router framework), session routes are an `APIRouter` included via `app.include_router` — no listener surgery, no per-route CORS (the app-level `CORSMiddleware` covers it).
- **FastAPI's auto-openapi has NO `servers` field.** flitro rejects the toolset PUT ("no base URL in spec or config") if neither the spec's `servers` nor the toolset `base_url` is non-empty. Set `servers=[{"url": "http://127.0.0.1:<port>"}]` in the `FastAPI()` constructor (cosmetic for `execution:client` — `base_url:""` is used for resolution; it just needs to exist).
- **The analyzer's shared-field edges can cycle.** On a rich-schema API, the analyzer may infer edges on every shared field (`status`/`assignee`/`title`/…) → hundreds of edges → data-flow cycles → the graph publish validation rejects them. **Fix:** provisioning gracefully skips the graph on validate-failure (fail-open — the agent uses the system prompt + the reactive 409, not the graph).
- **The analyzer matches path params to response fields by NAME.** Prefer `{id}` path params when practical, or accept that the graph may be sparse (fail-open makes this non-blocking — the agent still works).
- **Per-page `ActionReplayLayer` + multi-tab UX.** On a multi-tab app, a per-page `ActionReplayLayer` + a scoped `toActionEvent` means cross-tab events are **ignored**. Prefer a global listener in the shell that **auto-switches to the event's tab** on agent events (so the automated live cursor shows on the correct board).
- **Python `CORSMiddleware` `["*"]` + `allow_credentials=True` reflects any origin with credentials.** Fixed pattern: empty allowlist → `["*"]` WITHOUT credentials; set → explicit allowlist WITH credentials. NEVER combine `["*"]` + `allow_credentials=True`.
- **Python `/v1` proxy must not forward the session cookie to weftd.** Use a request-header **allowlist** for the inbound direction (Authorization + X-Weft-* only). A denylist silently leaks whatever it forgets (cookie is not hop-by-hop).

## Part 2 — State Machine + DAG Best Practices

The DAG is a **data-flow + ordering** model; the state machine is a **per-resource lifecycle** model. Don't conflate them.

**The core distinction — produce vs reference.** A consumed field is either:
- **Generative**: `from` *creates* the value (e.g. create produces a fresh resource `id`). Operating on *that new instance* may justify `required:true`.
- **Referential**: `to` operates on a *pre-existing* resource whose id can come from many sources (list, a prior session, a user saying a concrete id). These edges **must be `required:false`**.

Classic bug: the analyzer marks all create→mutate edges `required:true`, so the veto hard-denies operating on any resource not created in the current session → the agent "solves" it by minting a duplicate. Fix: `required:false`, keep `verified:true`. **`required:false` edges are dropped from `plan_route` entirely** (it traverses only `required` edges) — so multi-step sequences are carried by the system prompt + reactive 409, *not* the graph. `verified:true` just marks human sign-off.

**`required` vs `verified` (different axes):**
- `required` = hard dependency vs optional enrichment. `plan_route` traverses only `required` data edges; the veto hard-denies only on `required && verified` data edges with broken lineage.
- `verified` = **developer sign-off flag** (a PR-review assertion), NOT runtime confirmation. `verified:false` = heuristic/AI-inferred → never hard-vetoes. `verified:true` = human-confirmed → eligible for hard-veto when also `required:true`.

**How to "guarantee correctness" of an AI/heuristic-generated DAG — you can't; you guarantee safety.** The architecture's keystone: *hard-veto only on `verified:true && required:true` data edges with clearly broken lineage; everything else fails open.* Layered:
- **Layer 0** — derive deterministically from the spec (parameters/response schemas); minimize AI-inferred edges.
- **Layer 1 — schema-aware inference (in analyzer v2; ships inside `@percena/weft`)**: array-item unrolling surfaces list→item id sources; a path-based **resource tag** + same-resource guard excludes cross-resource false edges. Unrolling is **produces-only** (responses).
- **Layer 2 — fail-open default**: inferred data edges default `required:false`. The reviewer opts INTO `required:true` with evidence.
- **Layer 3** — cross-validate with **runtime traces**: spec `examples`, recorded call logs, and your integration/e2e tests — promote/demote `required` by observed success.
- **Layer 4** — human-review only edges that will **hard-enforce** (`verified:true && required:true`): a scarce, evidence-backed set. Per-edge checklist: *"is the consumed value freshly produced by `from`, or a reference to a pre-existing resource? latter → `required:false`."*
- **Layer 5** — fail-open + reactive 409/`allowed_actions` backstop is the invariant that makes a wrong DAG non-blocking.

**Generate the graph** via `npx weft-api-graph <spec> <toolset> <out>.json --verified`, then **review before publish**. Under analyzer v2 the draft is already fail-open (all edges `required:false`) + same-resource guarded, so the review step just sets `verified:true`. Committing the reviewed `*-graph.json` IS the sign-off. A reviewed referential edge:

```json
{"from":"createResource","to":"mutateResource","binding":{"from_field":"id","to_field":"id"},"kind":"data","required":false,"verified":true,"notes":"heuristic name-match (pure-producer, same-resource) — required:false by default (fail-open); set required:true+verified:true only with evidence for a true generative prerequisite"}
```

`generated_by.spec_hash` seals the spec hash; on spec change, regenerate or the graph goes stale (veto→ALLOW, `plan_route`→degraded).

**Graph-change workflow:** dry-run inspect the regenerated graph (edge count, all `required:false`, id sources, entrypoints, no cross-resource edges, `spec_hash`) → regenerate `*-graph.json` → restart the app (re-provisions + re-binds the new graph) → live e2e (Manual Verification §3).

## Common Mistakes

- **camelCase tool names** → "tool not found" for every tool. Lowercase everywhere (`<toolset>_${operationId}`).
- **Empty `tool_names` allowlist** → LLM sees zero tools (fail-closed). Enumerate.
- **The `tool_names` allowlist is a SECURITY boundary, not just functional config** → `execution:client` means a prompt-injected agent calls every allowlisted tool WITH THE USER'S COOKIE. Do NOT enumerate tools the user shouldn't be agent-driven to call; keep the allowlist minimal; review it as you would a permission grant.
- **The reactive `409 + allowed_actions` backstop is MANDATORY** → the DAG/veto fails open by design (see `references/fail-open.md`), so the `409` is the SOLE enforcement of the state machine. Without it the agent is fully un-enforced.
- **`Auto` permission mode is dev/e2e ONLY** → `Auto`/`execute` maps to the provider's bypass mode. Production MUST use `ask`/`explore` with a real policy hook — AND verify the hook actually fires (write a contract test that a deny hook blocks a tool for every provider you use).
- **`X-Weft-Actor` is a client-controlled header — visual-replay ONLY** → use it for the action-bridge visual replay only; NEVER for authorization, audit-trust, or to gate a security decision.
- **`execution:client` + cross-origin API** → browser rejects. Same-origin proxy, custom `toolHandlers`, or switch to `server`.
- **Missing `clientHttpAllowlist` → the run "wedges" at the first named tool call** → `createFlitroEmbedRuntime` only auto-executes the `client_http_request` marker tool, NOT named-toolset tools, unless you pass `clientHttpAllowlist: [{ pathPrefix: '/api/' }]` (or your API prefix). The template ships with `pathPrefix: '/api/'`; tighten per app.
- **CORS `Access-Control-Allow-Origin: *` on a cookie session** → inert for credentialed fetches but misleads integrators. Templates reflect `Origin` against a `DEMO_CORS_ORIGIN` allowlist; production MUST set exact origins; never use `*` with cookie sessions.
- **Python/FastAPI `CORSMiddleware` with `allow_origins=["*"]` + `allow_credentials=True`** → Starlette reflects any origin WITH credentials. Empty allowlist → `["*"]` WITHOUT credentials; set → explicit allowlist WITH credentials.
- **Python `/v1` proxy forwarding the session Cookie to weftd** → use a request-header **allowlist** (Authorization + X-Weft-* only), NOT a denylist.
- **Token-refresh route ownership + fail-closed** → `POST /api/chat/session/:id/token` tracks `sessionOwners` and **FAILS CLOSED**: unknown session → 403. Do not weaken this back to fail-open "for readability". A persisted ownership store is a production UX upgrade, not a security fix.
- **Unauthenticated session-mint** → `POST /api/chat/session` must return **401** when there is no valid cookie. Do not re-add a guest path "for testing"; require login first.
- **`publicBaseURL` trusts client `X-Forwarded-Host`/`X-Forwarded-Proto`** → host-header-injection risk. In production set the explicit `*_PUBLIC_BASE` to the fixed browser-reachable origin; only trust `X-Forwarded-*` behind a reverse proxy you control (`DEMO_TRUSTED_PROXY=1`).
- **Referential edges marked `required:true`** → agent can't touch pre-existing/cross-session resources, mints duplicates. Demote to `required:false`.
- **`verified:true` rubber-stamp without review** → fail-open invariant silently weakened, or a `required:true` edge vetoes legitimate calls.
- **Treating the DAG as a security control** → it fails open by design. Real enforcement = reactive 409+`allowed_actions`.
- **Stale graph after spec change** → regenerate from the same spec bytes (spec_hash must match).
- **Stale browser bundle after SDK upgrade** → rebuild the web bundle; a missing `isHttpRequestSuspend` handler breaks named-tool execution.
- **Proactive token timers** → refresh is 401-triggered via `onTokenExpired`; wire it to `/api/chat/session/:id/token`.
- **Shipping `WEFT_API_KEY` to the browser** → all tenant-key calls are server-side only.
- **`EADDRINUSE: address already in use`** → a prior server left an orphaned process. Free the port, then restart.
- **`Weft HTTP 409` with code `llm_connection_unusable`** → the tenant's LLM connection (BYOK key / subscription) exists but is unusable — it must be fixed in the Weft console (re-connect the subscription or replace the key). Terminal until the user acts: retrying the run keeps failing with the same 409. The SDK surfaces this as a `WeftHttpError` with `code === 'llm_connection_unusable'` — branch on the code, not the message.
- **`Weft HTTP 502: weftd proxy failed: …socket disconnected before secure TLS connection was established`** → known transient reverse-proxy TLS-handshake drop. NOT usually application code. Reload/resend; if frequent, check reverse-proxy keepalive/load.
- **`/v1` proxy hangs / chat shows "Not connected" (but the run still works via polling)** → the SDK may fall back to polling when the SSE stream fails, so a **broken SSE proxy can still pass a green functional loop**. Assert the status-bar reads **"Connected"** as part of Cat 1. Concrete proxy bugs: (1) Node `http`/`https` can't reach an h2-over-ALPN edge — use `fetch` (undici); (2) `res.writeHead` without `res.flushHeaders()` buffers headers on idle SSE — call `flushHeaders()`; (3) forwarding upstream `transfer-encoding`/`connection`/`content-length` breaks framing — forward only a safe header subset and force `accept-encoding: identity`; (4) retry must be narrowed to pre-handshake cause codes, not a blanket `TypeError: fetch failed` (mid-stream retry re-sends non-idempotent POSTs).
- **Chat prompts on every write tool** → the panel defaults to permission mode `ask`. For unattended/e2e runs set `Auto`/execute (or approve prompts) so writes proceed.

## Phase 3 — E2E + self-repair (do NOT skip)

This is the detailed procedure for the closed loop + the test categories above. After wiring, exercise it end-to-end **by hand** (or via Playwright).

**Before running Playwright, ask the user to confirm the LLM mode** (this step REQUIRES user confirmation — do not skip):
- **Real API endpoint** — the live LLM (`OPENAI_API_KEY` → the real endpoint). Most realistic; **costs money** per run.
- **Mock data** — scripted LLM responses (no real API call). Free; **may not represent the real environment**.

**Run Playwright in HEADED mode** (`headless: false` / `--headed`) — the user must SEE the browser + the action-bridge automated live cursor + be able to intervene mid-run. Do NOT use background/silent/headless mode. **First e2e command: verify + lazy-install the driver** — `command -v playwright-cli || npm install -g @playwright/cli` (the package is `@playwright/cli`, NOT `playwright-cli`; see Prerequisites). A missing driver must not abort the loop with `command not found`. Probe the weftd endpoint health first (`GET <WEFTD_BASE>/health`); if down/keys expired, fall back to the non-weftd parts (REST tests, graph validation, dry provisioning) + document the rest. Then:
1. **Stack up** — start the server + build the web bundle; open the chat, log in.
2. **State machine** — drive a resource through **every** transition incl. back-edges; confirm a **409 + `allowed_actions`** on an illegal transition and that the agent relays them without blind-retry.
3. **Cross-session reference (the fail-open regression test)** — create a resource in session A; in a **new** session (reload the page → fresh weftd session with empty lineage), operate on it by id. It MUST succeed with **no duplicate created** — if a duplicate appears, a referential edge is still `required:true`. Automate with Playwright (HEADED): find the composer, set `Auto` permission mode, drive the chat, and **verify via ground-truth state polling** (not chat text); reload between sessions.
4. **DAG** — call `plan_route` for a multi-step target; confirm the precursor chain. Deliberately call an op out-of-order; confirm the veto/409 fires and the agent recovers.
5. **Tools visible** — confirm the LLM can see and call every intended tool; "tool not found" = lowercase mismatch or empty allowlist.
6. **Rebuild + re-provision** after any spec/SDK change so the served graph + bundle match.

**Self-repair loop:** on any scenario failure, reproduce → isolate root cause → fix (in the app, a template, or the system-prompt) → re-run. Repeat until green or blocked; record each failure + fix.

## Phase 4 — Hand off for developer review

Produce review artifacts for the human (the commit/review IS the second check):

- The reviewed **state machine** — states, transitions, `$prior` back-edges, `allowed_actions`, rendered as a diagram + table.
- The generated + reviewed **DAG** (`<app>-graph.json`) — every edge with `required`/`verified`/`notes`, the per-edge produce-vs-reference checklist filled, `spec_hash` sealed.
- A **record of what the skill automated vs. what needed human input** (the review gates: SM, graph edges; the skill-prompted decisions: `execution: server|client`, the LLM `model`).

## Versioning

This skill follows **independent semantic versioning** (decoupled from the `@percena/weft` SDK version — see `metadata.min-weft-sdk` for the host requirement). The current version is in the frontmatter `metadata.version` field above; the human-readable change history is in [`CHANGELOG.md`](CHANGELOG.md).

**Versioning contract (do not break):**
- A **major** bump = a breaking change to the integration contract (§1-9), the placeholder set, the template filenames, or a Tier-1 security default an integrator must re-apply.
- A **minor** bump = a new fast-path, reference, test category, or contract clarification (backward-compatible).
- A **patch** bump = a fix to a template, reference, or guard with no contract change.
- The `metadata.min-weft-sdk` field declares the minimum `@percena/weft` version this skill assumes.

**For reproducible installs** — `npx skills add percena/weft-sdk` always pulls the default-branch latest; there is no pin. To pin a version, commit the installed skill into your project (project-scope) or use the experimental lock-file flow (`npx skills experimental_install` against a committed `skills-lock.json`).

## References

- **Security contract** (canonical — trust model + Tier 1/2/3 + OWASP mapping + Node↔Python equivalence): [`references/security-contract.md`](references/security-contract.md). SDK-layer threat model (when developing against the weft-sdk source tree): [docs/SECURITY-MODEL.md](https://github.com/percena/weft-sdk/blob/main/docs/SECURITY-MODEL.md).
- **Security-regression guards** (the closed loop's executable §6): `templates/security.test.mjs` (Node — `node --test`) + `templates/python/test_session_routes_security.py` (Python — `pytest`).
- **Templates:** `templates/` (Node agentic layer) + `templates/python/` (Python branch — see `templates/python/README.md`).
- **Theory:** [`references/fail-open.md`](references/fail-open.md) (why a wrong DAG never blocks a call) + [`references/plan-route-veto.md`](references/plan-route-veto.md) (how the graph sequences calls) + [`references/execution-model.md`](references/execution-model.md) (`execution: server|client`).
- **Analyzer:** folded into `@percena/weft` (subpath `@percena/weft/api-graph` + bin `weft-api-graph`; not published as a separate package).
