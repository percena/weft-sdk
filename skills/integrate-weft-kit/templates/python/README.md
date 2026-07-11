# Python backend templates (skill)

> **Security:** this port enforces the same Tier-1 invariants as the Node port (see [`../../references/security-contract.md`](../../references/security-contract.md) — the canonical contract + OWASP mapping + Node↔Python equivalence). The executable guard `test_session_routes_security.py` verifies them — run `pytest -q test_session_routes_security.py` in CI. The two ports are security-equivalent; a fix to one MUST mirror to the other.

The skill's backend templates are Node `.mjs` by default (`provision.mjs` /
`session-routes.mjs` / `run.mjs`). For a **Python / FastAPI** backend, use this
`python/` set instead.

| Template | Role |
|---|---|
| `provision.py` | The weftd provisioning chain (httpx): app/toolset/skill/automation/graph + `ensure_app` (thread-safe). Param-driven (`create_provisioning(...)`). |
| `session_routes.py` | FastAPI `APIRouter`: `POST /api/chat/session` + `/token` + the `/v1/*` httpx streaming reverse-proxy (one pre-handshake TLS retry). `create_session_router(provisioning, toolset=, app_name=, sessions=, session_cookie=)` — `sessions` (cookie→user) + `session_cookie` are INJECTED (self-contained, testable; mirrors the Node port). |
| `weft.py` | The `X-Weft-Actor` → event-actor override (contextvar + middleware). A real site won't have this — the skill adds it. |
| `run.py` | `assert_weftd_creds` + `uvicorn.run` (NO vite build — the frontend build is a separate step). |
| `system_prompt.py` | Renders the SM into the agent prompt (skeleton — point it at YOUR state-machine module + customize the behavior rules). |
| `test_session_routes_security.py` | The security-regression guard (the closed loop's executable §6) — `pytest -q`. |

## Wiring (in your app entry) — the Node listener-wrap DISSOLVES

A FastAPI backend wires via `app.include_router` — no `server.listeners`
surgery, no per-route CORS (the app-level `CORSMiddleware` covers it). The Node
port's "6 wiring constraints" don't apply:

```python
provisioning = create_provisioning(
    weftd_base=os.environ["WEFTD_BASE"], api_key=os.environ["WEFT_API_KEY"],
    tenant_id=os.environ["WEFT_TENANT_ID"], system_prompt=build_system_prompt(),
    toolset="{{toolset}}", app_slug="{{appSlug}}", app_name="{{appName}}",
    skill_slug="{{skillSlug}}", graph_slug="{{graphSlug}}",
    model="{{model}}", spec_path="{{specPath}}")

app = FastAPI(title="{{appName}}", lifespan=lifespan,
    servers=[{"url": "http://127.0.0.1:{{port}}"}])   # FastAPI's auto-openapi has NO servers field → flitro rejects the toolset without this
app.middleware("http")(actor_middleware)               # X-Weft-Actor → event actor

# SECURITY (security-contract §3): `sessions` (cookie sid → username) +
# `session_cookie` (the cookie name) are INJECTED into create_session_router
# (mirrors the Node port — self-contained, no relative `from .auth import`,
# testable by test_session_routes_security.py). Pass your app's auth-session map.
from .auth import sessions, SESSION_COOKIE   # your app's login-session map + cookie name
app.include_router(create_session_router(provisioning, toolset="{{toolset}}", app_name="{{appName}}",
                                          sessions=sessions, session_cookie=SESSION_COOKIE),
                   include_in_schema=False)            # the chat backend + /v1 proxy (NOT agent tools)
# + your business routers (unchanged) + the SPA catch-all (AFTER /api + /v1)
```

Your event emit path gets a one-line override: `actor = get_actor() or actor`
(the contextvar set by `actor_middleware` when `X-Weft-Actor: agent`).

## Python-specific notes

- The `.mjs` templates are Node-only → this `python/` set.
- The `/v1` proxy TLS-retry is Node `http` → httpx pre-handshake retry (mid-stream errors surface, not retried — headers already sent).
- `X-Weft-Actor` actor extraction is NOT in a real site → add `weft.py` + the emit override.
- Router-based backends wire via `include_router` (no listener-wrap).
- FastAPI's auto-openapi has NO `servers` field → set `servers=[...]` or flitro rejects the toolset ("no base URL in spec or config").
- The analyzer's shared-field edges can cycle → `_provision_graph` gracefully skips on validate-failure (fail-open — the agent uses the system prompt + 409, not the graph).
- The analyzer matches path params to response fields by NAME — idiomatic `{iid}`/`{cid}` (vs `id`) → fewer id-edges inferred. Use `{id}` when practical OR accept the graph is sparse (fail-open).
- `CORSMiddleware` with `allow_origins=["*"]` + `allow_credentials=True` is NOT inert — Starlette reflects ANY origin WITH credentials. Use a string allowlist (empty → `["*"]` no-creds; set → allowlist + creds). Mirror the Node `DEMO_CORS_ORIGIN` semantics.
- The `/v1` proxy must NOT forward the session cookie to weftd. This template uses a `_PROXY_HEADER_ALLOW` **allowlist** for inbound request headers (Authorization + X-Weft-* only); the `_HOP_BY_HOP` set is for the outbound/response direction only.
- **Security:** `POST /api/chat/session` + `/api/chat/session/{sid}/token` derive `end_user_id` from the authenticated cookie ONLY (never the request body) and **fail CLOSED** on session ownership: unknown/non-owner → 403. An unauthenticated caller gets **401**. The fail-closed default means a restart rejects (403) unknown sessions — a persisted ownership store (SQLite/Redis) is a UX upgrade, not a security fix. Mirror the Node template's `session-routes.mjs` exactly (the two sets are security-equivalent — see the template-sync rule in SKILL.md).
- **Security:** `public_base_url` falls back to client-controlled `X-Forwarded-Proto`/`X-Forwarded-Host` when `*_PUBLIC_BASE` is unset → host-header-injection redirect. Set an explicit public base to the fixed origin behind any proxy you don't fully control.

See `SKILL.md` "Non-JS backend (Python)" for the full list.
