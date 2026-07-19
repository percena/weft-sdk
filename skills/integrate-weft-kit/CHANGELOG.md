# Changelog

All notable changes to the **integrate-weft-kit** skill are documented here.
The skill follows [semantic versioning](https://semver.org/) independently of the
`@percena/weft` SDK; `metadata.min-weft-sdk` (in `SKILL.md` frontmatter) declares the
minimum SDK version assumed.

## [1.0.3] — 2026-07-16

### Added
- **Common Mistakes**: `Weft HTTP 409` / `llm_connection_unusable` — the tenant's LLM connection needs attention in the Weft console; terminal until the user acts (retrying keeps failing). Match the message substring on published SDKs; when the SDK exports `WeftHttpError`, prefer `error.code` (or `turn_failed.error.code`).

### Changed
- Backend behavior wording is now expressed as integrator-observable behavior ("the runtime's tool visibility is fail-closed on an empty allowlist", "the graph publish validation rejects data-flow cycles") instead of internal implementation attribution. No contract change.
- `apps/online-store` demo: `WEFTD_BASE` no longer has a hardcoded local fallback — unset now fails fast with a clear error (matches the README, which already documented it as required).
- Provisioning `weftdAPI` / `weftd_api` unwraps nested weftd `{error:{code,message}}` envelopes (and the flat legacy string-error shape) so logs no longer collapse to `[object Object]` / dict-repr.
- Python `weftd_api` now raises `WeftdApiError` (a `RuntimeError` subclass) carrying `code` / `status`, matching the Node template's `err.code` / `err.status` — both language templates expose the stable weftd code for branching.

### Notes
- Contract (§1-9) + placeholder set unchanged → patch bump.

## [1.0.2] — 2026-07-14

### Added
- **Prerequisites (verify + install — eager for build deps, lazy at point of use)** — a new runbook section. `@percena/weft` is verified + installed (with the project's own package manager) **eager**, before the first `vite build` (the frontend bundle imports it). `@playwright/cli` (the package that provides the `playwright-cli` bin) is verified + installed **lazy**, at the Phase 3 e2e point of use only — so a build-only run (or a weftd-down fallback that never reaches e2e) doesn't force a global driver install. The closed loop must not abort with `Cannot find module '@percena/weft'` or `playwright-cli: command not found`. Cross-linked from Part 1 §0 (Scaffold) + Phase 3 (e2e).

### Fixed
- Playwright driver package name: the `playwright-cli` bin is provided by **`@playwright/cli`** (install via `npm install -g @playwright/cli`), NOT the unrelated `playwright-cli` npm package that shares the bin name. `npx playwright-cli` is explicitly warned against (it resolves the wrong package). `README.md` Requirements now lists `@playwright/cli`.

### Notes
- Contract (§1-9) + placeholder set unchanged → patch bump.

## [1.0.1] — 2026-07-11

The graph analyzer is folded into `@percena/weft` — integrators no longer add a separate graph-tool dependency. Templates are parameterized for any host app (no product-specific cookie/SSE/env names).

### Changed
- **Step 7 (Graph)** now generates via `npx weft-api-graph <spec> <toolset> <out>.json --verified` (the bin ships inside `@percena/weft`, which the integrator already added in Step 0). The committed `*-graph.json` remains the sign-off; no separate graph-tool dep is required.
- **Step 0 (Scaffold)**: `@percena/weft` is `^1.0.1` from npm; the analyzer + `weft-api-graph` bin ship inside the SDK package.
- **Docs / templates**: skill is self-contained for installed use — no monorepo/demo path assumptions. Host-specific names are placeholders or opts:
  - `{{sessionCookie}}` / `wireSessionRoutes({ sessionCookie })` / `create_session_router(..., session_cookie=)`
  - `{{sseEventName}}` / `wireSessionRoutes({ sseEventName })`
  - `APP_PORT`, `APP_PUBLIC_BASE` (alias `PUBLIC_BASE`) instead of product-prefixed env vars

### Added
- `weft-api-graph` CLI `--verified`/`-v` flag: auto-signs the fail-open analyzer draft (`graph.verified` + every edge `.verified = true`). Default (no flag) still emits `verified:false` for PR review.
- `@percena/weft` subpath `@percena/weft/api-graph` (re-exports `generateGraph`) + the `weft-api-graph` bin.
- Placeholders `{{sessionCookie}}` + `{{sseEventName}}` in the substitution set.

### Notes
- External integrators pin `@percena/weft: ^1.0.1` from npm (Step 0 / `metadata.min-weft-sdk`).
- The integration contract (§1-9) is unchanged; this is a mechanism + dependency-boundary change, backward-compatible for integrators who already pass cookie/session opts.

## [1.0.0] — 2026-07-11

Initial public release, shipping with `@percena/weft` 1.0.0.

### Added
- The **closed-loop integration methodology** (build → headed-Playwright test → self-repair → repeat) around a language-agnostic 9-point integration contract.
- Six inventory-driven test categories: integration wiring, feature regression, agent driving, visual feedback, cross-cutting, and security/trust boundaries.
- **Node fast-path** templates: `provision.mjs`, `session-routes.mjs`, `run.mjs`, `ChatPane.tsx`, `chat-bootstrap.ts`, `auth-context.tsx`, `customer.ts`, `.env.example`.
- **Python/FastAPI fast-path** templates: `provision.py`, `session_routes.py`, `run.py`, `system_prompt.py`, `weft.py`.
- Reference docs: `security-contract.md` (trust model + Tier 1/2/3), `fail-open.md`, `plan-route-veto.md`, `execution-model.md`.
- **Executable security-regression guards** (`security.test.mjs`, `test_session_routes_security.py`) that verify the Tier-1 template defaults in CI.
- Secure-by-default template invariants: unauthenticated session-mint → 401, session-ownership fail-closed → 403 (including after a restart), `end_user_id` derived from the cookie only, `/v1` proxy header allowlist + path normalization + streaming body cap, CORS per-request allowlist.

### Security
- The `/v1` reverse-proxy upstream uses `fetch` (undici) instead of `node:http`, so it speaks an HTTP/2-over-ALPN edge and streams the timeline SSE. The proxy retry is narrowed to pre-handshake errors (connect/DNS/TLS-handshake); mid-stream drops do not retry, so non-idempotent POSTs are never replayed.

### Known limitations
- `provision.mjs` retries provisioning calls on any network `TypeError`; harmless for the idempotent provisioning chain, but less precise than the `/v1` proxy's pre-handshake-only retry.
- `SKILL.md` is long; deep theory lives in `references/` so the runbook can stay the spine.
