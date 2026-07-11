# Execution Model — `server` vs `client` Reachability

> Reference note for the `integrate-weft-kit` skill. This file stands alone and **closes gap #5** (the skill gave the 2-row table but no decider).

## What the decision is (and isn't)

`execution: "server" | "client"` decides **where the HTTP call is made** — it is a **reachability** decision, not a graph semantics decision. It is orthogonal to the DAG: both modes resolve graph nodes by `tool_name` (one unique name per operation, e.g. `<toolset>_createResource`), so the route/veto code is identical for both. You make this call once, at toolset-provision time (`PUT /v1/tenants/{tid}/toolsets/{name}` `{base_url, execution, auth_type, spec, enabled}`).

Do **not** confuse this with the public-vs-private *integration* decision (you integrate whenever you have an OpenAPI spec; reachability only picks the execution knob) or with the spec-less decision (no OpenAPI → use `client_http_request`, no graph at all).

## The 2-row table

| | `server` | `client` |
|---|---|---|
| HTTP call made by | weftd/flitro server | the browser, same-origin |
| `base_url` | real reachable URL | `""` (relative; follows page origin) |
| Use when | API public to weftd | API private/local or shares page origin/cookie |

## The decider checklist (gap #5)

The skill's v1 left this to first-principles reasoning each time. Run this two-question checklist instead:

### Question 1 — Reachability: who can reach the API?

Is the API reachable from **weftd's network**, or only from the **end-user's browser**?

- **Public / forwarded to weftd** — weftd (cloud) can reach the API directly (public hostname, or a tunnel/NAT-forwarded endpoint weftd's egress can hit). → candidate for `server`.
- **Browser-only** — the API is reachable only from the end-user's browser: **same-origin** to the page, **`127.0.0.1`/`localhost`** on the user's machine, or **VPN-internal** to the user's network (weftd's cloud egress has no route to it). → `client`.

### Question 2 — Auth: who holds the credential?

Is the call authed by a **sealed per-toolset credential weftd presents**, or a **browser-held cookie/session**?

- **Sealed credential** — a token weftd stores server-side and presents on the call (bearer/header/query/basic/oauth — the `auth_type` you set on the toolset). → candidate for `server`.
- **Browser-held cookie/session** — the call relies on a cookie the browser holds (e.g. a session cookie set by the page's own login), or a session that only makes sense in the user's browser context. → `client`.

### Decision rule

| Reachability (Q1) | Auth (Q2) | `execution` | `base_url` | `auth_type` |
|---|---|---|---|---|
| same-origin / `127.0.0.1` / VPN-internal + browser cookie | browser-held cookie/session | **`client`** | `""` (relative; follows page origin) | **`"none"`** |
| public / forwarded to weftd + sealed credential | sealed per-toolset credential | **`server`** | absolute reachable URL | real `auth_type` (`bearer`/`header`/`query`/`basic`/`oauth`) |

**Rule of thumb:** *same-origin + cookie + local → `client`; public + sealed → `server`.*

### Why `auth_type:"none"` for the cookie case

For `execution:"client"` on a same-origin cookie-authed API, set `auth_type:"none"`. The browser's cookie rides the same-origin `fetch` automatically; identity is **not** conveyed via this field — the runtime stamps `X-Weft-Actor: agent` on the call as the agent-identity marker. Setting a real `auth_type` here would be wrong (weftd has no credential to present; the browser holds the cookie).

## The canonical case: same-origin cookie API

Most private SaaS UIs use `execution:"client"` + `base_url:""` + `auth_type:"none"`:

- **Reachability:** the API runs on the user's machine / is same-origin to the page → weftd's cloud egress cannot reach it. (Browser-only.)
- **Auth:** the page authenticates via a session cookie the browser holds. (Browser-held.)

So the agent literally calls the same REST API the page uses — same origin, same cookie, with `X-Weft-Actor: agent` stamped by the runtime. This is the hardest end-user case (cloud agent + local/private API + named toolset executing client-side + graph sequencing).

## The other case: a public, sealed-credential API

If the API is a public cloud service authed by a bearer token weftd holds server-side, the decision flips: `execution:"server"`, `base_url` = the public absolute URL, `auth_type:"bearer"` (and the sealed token configured per-toolset). The graph still works unchanged — node resolution is by `tool_name` in both modes.

## How `client` execution actually runs

Under `execution:"client"`, `openapiTool.Execute` builds the HTTP request (method, resolved URL from `servers` + path + path-params, auth, body from args) and returns **Suspended** with `{method, url, headers, body}` — the same payload shape as `ClientHTTPTool`. The Weft browser runtime's `handleToolSuspension` executes any suspend payload shaped like an HTTP request (`{method, url}`) via `executeClientHttpRequest` **regardless of tool name**, so named toolset-client tools (e.g. `<toolset>_createResource`) are executed by the browser, not just `client_http_request`. The result returns via `POST /v1/sessions/{sid}/runs/{rid}/tool-outputs`; weftd resumes the LLM.

> **Security implication:** because ANY `{method,url}`-shaped suspend payload is browser-executed regardless of tool name, audit every `execution:client` tool's schema for model-controllable URL fields. A tool that lets the model set a `url`/`callback_url`/`redirect`/`webhook` parameter becomes a browser-side fetch channel steerable by prompt injection (the model's output is untrusted). The same-origin check + `clientHttpAllowlist` are the only barriers. Keep URL fields server-resolved where possible; never let the model set the host of a same-origin call; and if a tool legitimately takes a URL arg, scope it to an operator-allowlisted host/prefix.

## `client_http_request` is a different tool — don't conflate

`client_http_request` is a **shared-name generic HTTP tool** distinguished by URL, used for **spec-less APIs** (the LLM improvises method+URL from docs; no spec → no graph). The graph feature is inherently for **spec'd APIs** (the analyzer generates the graph from an OpenAPI spec). Using `client_http_request` for a spec'd API creates a mismatch: `NodeByToolName("client_http_request")` cannot distinguish one named operation from another, so the veto/route can't sequence them. For a spec'd API, use an **openapi toolset** with `execution: server|client` + the graph; reserve `client_http_request` for its correct niche (spec-less APIs).

## Common mistakes

- **`execution:"client"` + cross-origin API** → the browser rejects the fetch. Fix: same-origin reverse-proxy the API behind the page's origin, use custom `toolHandlers`, or switch to `server` (if weftd can reach it).
- **Setting a real `auth_type` for a cookie-authed `client` toolset** → wrong; weftd has no credential to present. Use `auth_type:"none"`; the cookie rides same-origin, identity is via `X-Weft-Actor`.
- **Treating reachability as the integration decision** → you integrate whenever you have an OpenAPI spec; reachability only picks `server` vs `client`. Don't skip the integration because the API is "only local" — that's exactly the `client` case.
- **Using `client_http_request` for a spec'd API** → breaks node resolution; use an openapi toolset + `execution` instead.
