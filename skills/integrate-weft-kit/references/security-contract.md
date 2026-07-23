# Security Contract — integrate-weft-kit

> The canonical security invariants for a `@percena/weft` integration. The skill's templates (`templates/session-routes.*`) **enforce Tier 1**; the skill's guards (`security.test.*`) **verify** them; `SKILL.md` points here. Companion to the SDK's [SECURITY-MODEL.md](https://github.com/percena/weft-sdk/blob/main/docs/SECURITY-MODEL.md) (the runtime/provider/SDK layer) — this is the **integration-layer** contract.
>
> Read this before adapting the templates. A green functional run does NOT mean a safe run — the closed loop catches functional bugs, this contract catches security bugs, and `security.test.*` makes it executable.

## Trust model (4 boundaries)

| Boundary | Trust | Implication for the integration |
|---|---|---|
| **Host operator** | Trusted | Selects provider, cwd, executable, env, sources, policies, permission mode. The integrator backend holds the weftd developer key. |
| **Agent / model output** | **Untrusted** | Prompt injection arrives via fetched pages + tool results. Every model-emitted tool call is gated. Model output rendered as Markdown is sanitized. |
| **Browser** | **Untrusted** | Cookies + most headers are client-settable. The session cookie is NEVER forwarded to weftd. `X-Forwarded-*` is NOT trusted by default. `X-Weft-Actor` is visual-replay only, never an auth/audit decision. |
| **weftd** | Trusted control plane | The integrator backend holds the developer API key (server-side only) and mints scoped session tokens for the browser. |

## Tier 1 — enforced by the template (the defaults the skill ships; DO NOT weaken; verified by `security.test.*`)

These ship in `session-routes.mjs` / `session_routes.py`. The guard asserts each. An adaptation that weakens one fails the guard. **§5 is app-level (the template ships the SSE Set + broadcast, NOT the endpoint/cap) and §6 is split (Node: template; Python: app-level `CORSMiddleware`) — enforcement location is noted inline; the guard asserts only the template-enforced items.**

1. **Auth on every state-changing route** — `POST /api/chat/session`, `POST /api/chat/session/:id/token`, and the `/v1/*` proxy: a caller with no valid session cookie resolves to `'guest'` and is **rejected with 401** (not minted a session).
2. **Ownership fail-closed** — `/token` tracks `sessionOwners` (`session_id → end_user_id`) populated at create; on refresh it **fails CLOSED**: `if (owner === undefined || owner !== refreshUser) return 403`. An unknown session (post-restart / created via another path) is **rejected**, not allowed. The previous `owner !== undefined && …` failed OPEN on restart — the IDOR returned for any known session id.
3. **`end_user_id` from the cookie only** — never from the request body. A body-supplied `end_user_id` lets any caller mint a session impersonating an arbitrary end-user.
4. **`/v1` reverse proxy**:
   - request-header **allowlist** (Authorization + X-Weft-* only; `Cookie` stripped) — a denylist silently leaks `cookie` (it is not hop-by-hop).
   - **path normalization before the admin denylist** — `posixpath.normpath` (Python) / `decodeURIComponent(p).toLowerCase().replace(/\/+/g,'/')` (Node), so `/v1/sessions/../tenants/` (Starlette doesn't normalize `..`; httpx does) and case / `%2f` / `//` variants can't bypass `/v1/tenants|admin|platform`.
   - **streaming body cap** (per-chunk → 413) — `Content-Length` is spoofable, a pre-check alone is insufficient; `request.body()`/`request.json()` buffer the entire body, so read per-chunk.
   - retry only pre-handshake errors (a reverse-proxy TLS-handshake drop), never mid-stream (headers already sent → would replay non-idempotent POSTs).
5. **SSE cap** — global (240) + per-IP (12) concurrent connection cap (→ 429). The per-IP key trusts `X-Forwarded-For` ONLY when `DEMO_TRUSTED_PROXY=1` (default off → `socket.remoteAddress`, which a client cannot spoof). Behind a trusted proxy that overwrites XFF, set the flag for real per-IP caps; off, the per-IP cap collapses to "per-connection" (stricter, safe). **[app-level]** — the template ships the SSE client Set + broadcast helper; the endpoint, the global/per-IP cap (→ 429), and the `clientIp` XFF gating live in the host app's SSE handler, NOT in `session-routes.*`. The guard does NOT test §5 (it's app-level); `SKILL.md` §6 has the integrator checklist.
6. **CORS per-request allowlist** — reflect `Origin` against `DEMO_CORS_ORIGIN` (comma-separated exact origins) evaluated **per request** (NOT at module import time — ESM imports resolve before `run.mjs` loads `.env`, so a module-scope const captured an empty allowlist). `Access-Control-Allow-Credentials` ONLY on an explicit allowlist match; the dev fallback (env unset) reflects the origin WITHOUT credentials (inert for credentialed, never widens the cookie surface). Never `*` + credentials. **[split]** — Node: template-enforced (`corsPolicy()`/`corsAllowOrigins()` in `session-routes.mjs`, guard-tested); Python: app-level `CORSMiddleware` in `main.py` (the Python port delegates §6 to the app — there is no per-route CORS in `session_routes.py`; the integrator wires `CORSMiddleware` themselves, Tier 3 for the Python port).
7. **`publicBaseURL`** — `APP_PUBLIC_BASE` (alias `PUBLIC_BASE`) is the production setting (the fixed browser-reachable origin). The `X-Forwarded-Host`/`Proto` fallback is **unsafe-by-default** (host-header-injection) and only safe behind a trusted reverse proxy you control; it is gated behind `DEMO_TRUSTED_PROXY`.

## Tier 2 — documented but enforced by the SDK packages (the skill references these; it does NOT re-implement them)

The integration does not duplicate these — it consumes the SDK packages that own them. Each is verified fixed in the SDK.

- **Debug logging** — `@weft/sources` (`api-tools.ts`, `utils/debug.ts`) + `@weft/automations` (`utils/debug.ts`) gate ALL log levels on `process.env.WEFT_DEBUG === '1'`; `redactHeaders` (allowlist — `content-type`/`accept`/`user-agent`/`content-length`/`content-encoding` only, everything else `<redacted>`) + `redactUrl` (the query-auth key stripped) + 200-char body/error previews under the gate. The skill's templates add no logging of their own.
- **Credential storage** — `@weft/sources` `encrypted-backend.ts`: `openSync(tmpPath, 'wx', 0o600)` (O_CREAT|O_EXCL — atomically fails if a symlink exists, closing the `unlink`→`write` TOCTOU), `chmodSync(0o600)` + 0700 dir, AES-256-GCM.
- **SSRF guard** — `@weft/core` `fetchWithSsrfGuard`: redirect-aware, `resolveIps: nodeDnsResolveAll` injected at the API-source + webhook + credential-renew call sites (DNS names resolving to private ranges blocked). The DNS-rebinding TOCTOU (the resolved IP is not pinned across the fetch) is the documented open residual.
- **Markdown sanitize** — `@weft/ui` `rehype-raw` → `rehype-sanitize` + `style-sanitizer.ts`: `filterInlineStyle` (only KaTeX-strut layout props; blocks `url()`) + `filterClassName` (strips dangerous Tailwind UI-redress tokens — position/offset/inset/z-index/opacity/pointer-events/transform, the `pe-none`/`pe-auto` pointer-events aliases, and visual-reordering tokens `order-*`/`flex-*-reverse`; preserves KaTeX/GFM).
- **Factory policy hook** — `@weft/providers` `createHostAgentRuntime` bridges `policy.hook` → the driver's `policy` field so `ask`/`explore` actually gate tool calls (a previous gap, now fixed). `auto` mode deliberately bypasses (≈ `--dangerously-skip-permissions`).

## Tier 3 — integrator responsibility (NOT enforceable by the skill's test — the integrator owns these)

The skill's guard verifies the templates' defaults; it cannot verify the integrator's own code. These are the integrator's duties:

- **Real auth on login** — `cid`/`end_user_id` reads the session cookie; the integrator's login flow must set it with real credentials. Templates may illustrate a no-password login for readability (`POST /api/login {username}`) — **replace it** in any real deployment, or the cookie-based identity is circumvented one step back.
- **Verified policy hook** — pass a `policy.hook` to `createHostAgentRuntime` for `ask`/`explore` mode; **write a contract test** that a deny hook blocks a tool for every provider you use. Demo templates host-seal `config.permission_mode: "auto"` on createSession (developer API key) so the chat panel's Auto selector can inherit auto under weftd fenced autonomy (embed JWT **cannot** elevate sealed ask→auto). That seal is **dev/e2e ONLY** — production MUST seal `ask`/`explore` (or omit → ask) + the hook; a prompt-injected agent otherwise runs allowlisted tools with zero confirmation.
- **Production config** — set `DEMO_CORS_ORIGIN` (exact origins), `APP_PUBLIC_BASE` (fixed origin), `DEMO_TRUSTED_PROXY=1` (only behind a trusted proxy) in production.
- **Persisted ownership store** — `sessionOwners` is in-memory (lost on restart). The fail-closed default means a restart rejects (403) unknown sessions — safe, but forces the browser to re-create the session via `onTokenExpired` → `/api/chat/session`. Persist (`session_id → end_user_id` in SQLite/Redis) for **UX** (avoid re-creation), not security.
- **Tool allowlist review** — `tool_names` is fail-closed + minimal; `execution:client` means a prompt-injected agent calls every allowlisted tool **with the user's cookie**. Review the allowlist as you would a permission grant: do NOT enumerate high-blast-radius admin/destructive ops. The same-origin + `clientHttpAllowlist` + the SM `409` backstop are the only barriers.
- **`409 + allowed_actions` backstop** — the DAG/veto fails open by design (see `fail-open.md`), so the reactive SM is the SOLE enforcement of the state machine. Your state module MUST return `409 {error, allowed_actions:[…]}` on illegal transitions; an inline SM that only throws/returns 400 is not enough.

## OWASP API Security Top 10 (2023) mapping

| Invariant / finding | OWASP |
|---|---|
| Ownership fail-closed, session scoping | **API1:2023** Broken Object Level Authorization |
| Unauthenticated session mint | **API2:2023** Broken Authentication |
| `end_user_id` from body | **API3:2023** Broken Object Property Level Authorization |
| Body cap, SSE cap | **API4:2023** Unrestricted Resource Consumption |
| `/v1` proxy reaching admin routes | **API5:2023** Broken Function Level Authorization |
| CORS per-request, proxy header forwarding, XFF trust | **API8:2023** Security Misconfiguration |
| SSRF (SDK — `@weft/sources`/`@weft/core`) | **API10:2023** Unsafe API Consumption |

## Node ↔ Python equivalence

`templates/session-routes.mjs` (Node) and `templates/python/session_routes.py` (Python) are **security-equivalent ports** of this contract. Rule: **a security fix to one set MUST mirror to the other in the same commit** — the two sets previously drifted (fixes applied to one were missing from the other). Both sets ship a mirrored guard (`security.test.mjs` / `test_session_routes_security.py`) asserting the template-enforced Tier-1 invariants — a divergence fails one guard. **§5 (SSE) + §6 (CORS) are app-level/split by design (see the per-item notes above), so the two guards do NOT test those two — §5 is enforced in the app's SSE handler on both ports; §6 is template-enforced (guard-tested) on Node and app-level (`CORSMiddleware`) on Python.** When porting a fix, diff the two `session_routes` files (they should be byte-faithful modulo language) + update both.

## What is NOT in scope

- The skill does not store credentials (Tier 2 — `@weft/sources`). The skill does not implement the SSRF guard (Tier 2 — `@weft/core`). The skill does not sanitize Markdown (Tier 2 — `@weft/ui`). The skill does not bridge the policy hook (Tier 2 — `@weft/providers`). The skill does not own publishing/provenance (`publish/`).
