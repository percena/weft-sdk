# Online Store

A full-stack demo showcasing **Weft Chat × visualized CRUD workflows**: a chat panel on the left, a storefront (products / cart / orders) on the right. The AI agent drives the same REST API the page uses via the named `shop_*` tools (one per OpenAPI operation), and an automated live cursor replays each step on the storefront so users can *see* the agent operating the real page.

## Prerequisites — this demo needs a weftd control plane

> **This agentic demo is NOT a standalone embed.** It drives a live LLM agent
> through a remote **weftd** control plane (the `WEFTD_BASE` /
> `WEFT_API_KEY` / `WEFT_TENANT_ID` vars in `.env`). Weft is open-sourced as an
> **embed SDK** (`@percena/weft`) — the full "classic → agentic" loop shown here
> is reproducible only with a Cloud-hosted weftd tenant, not from this repo
> alone.
>
> To run it:
> 1. Register a tenant at the **[Weft console](https://weft-kit.dev)** (free
>    trial available). The console's API Keys page shows your `WEFTD_BASE`,
>    `WEFT_API_KEY`, and `WEFT_TENANT_ID`.
> 2. Supply an OpenAI-compatible LLM endpoint (`OPENAI_*` in `.env`) — the
>    remote weftd control plane uses it for the agent runtime.
>
> Without those, the classic storefront (`apps/online-store/classic`) still runs
> end-to-end (REST + SSE + state machine) with no weftd dependency — use it to
> explore the non-agentic baseline. A fixture/mock agent backend that lets the
> chat panel + action-bridge work fully offline is on the roadmap; until then,
> external contributors cannot validate the agentic demo without a weftd tenant.

## Quick Start

```bash
cd apps/online-store/agentic

# 1. Configure .env (first run only)
cp .env.example .env
#    Edit .env: fill WEFTD_BASE / WEFT_API_KEY / WEFT_TENANT_ID (from the Weft
#    console) + OPENAI_* (your LLM). See Prerequisites above.

# 2. Build frontend + start server
pnpm start
#    → http://127.0.0.1:19745
```

Open the browser, log in with any username, and try in the chat:

- buy 2 mechanical keyboards and pay
- view cart / my orders
- ship / deliver / confirm receipt for ORD-1
- request / approve / deny refund

## Hot-Reload Development

```bash
# Terminal 1: shop backend (skip build, start directly)
SHOP_PORT=19745 WEFTD_BASE=... WEFT_API_KEY=... WEFT_TENANT_ID=... \
  node server/shop-server.mjs

# Terminal 2: Vite dev server
pnpm dev
#    → http://127.0.0.1:5173
```

## .env Configuration

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `WEFTD_BASE` | Yes | — | remote weftd URL |
| `WEFT_API_KEY` | Yes | — | Tenant API key from the Weft console (https://weft-kit.dev) |
| `WEFT_TENANT_ID` | Yes | — | Tenant ID that owns the API key |
| `OPENAI_API_KEY` | Yes | — | OpenAI-compatible API key for the remote weftd LLM configuration |
| `OPENAI_BASE_URL` | Yes | — | OpenAI-compatible `/v1` endpoint URL (configured on remote weftd) |
| `OPENAI_MODELS` | Yes | — | Comma-separated model catalog for the remote weftd LLM runtime |
| `OPENAI_MODEL` | Yes | — | Default model name (also used locally for skill provisioning) |
| `SHOP_PORT` | No | `19745` | Shop server port |

> `OPENAI_*` configure the remote weftd control plane's LLM endpoint. The local shop server only reads `OPENAI_MODEL` (written into the skill definition at provision time). All variables are kept in a single `.env` so the same file can seed both the local app and your weftd deployment.

## How It Works

```
Browser ── Weft chat panel ──► remote weftd
  ▲                              │ named shop_* tools (client-exec)
  │ X-Weft-Actor: agent          │
  └── automated live cursor replay ◄──── shop server (:19745)
                                │  REST + order state machine + SSE event feed
                                ▲
     LLM endpoint ──────────────┘  decides tool calls from chat intent
```

- The shop server reverse-proxies `/v1/*` to the remote weftd — the browser only needs the shop port.
- The agent calls the `/api/*` REST API via the named `shop_*` tools (one per OpenAPI operation, executed same-origin in the browser) — the same interface the page uses.
- A fail-open dependency graph (`required: false`, see `online-store-agentic-graph.json`) routes multi-step calls via `plan_route` but never blocks a tool.
- The `X-Weft-Actor: agent` header triggers the frontend automated live cursor replay.

## Order State Machine

```
pending_payment ──pay──► paid ──ship──► shipped ──deliver──► delivered ──confirm──► completed
   │ cancel               │ cancel        │                     │
   ▼                      ▼               └──request_refund──┐  │
cancelled ◄───────────────┘                                  ▼  ▼
                paid/shipped/delivered ──request_refund──► refund_requested
                                              approve_refund ▼         │ deny_refund
                                                         refunded   (back to prior status)
```

The state machine (states, transitions, labels, API paths) is defined once in `shared/meta.mjs` and shared by both the backend and the frontend.

## Security notes (demo limitations)

This is a **demo** — the security model is deliberately thin so the agentic
pattern stays readable. Before copying any of this into a real product, close
these gaps:

- **`POST /api/chat/session/:id/token` has no ownership check.** The token-refresh
  route mints a fresh scoped weftd token for whoever supplies a session id; it
  does NOT verify the caller owns that session (the demo doesn't persist a
  session→end_user mapping). A real integration MUST check the caller's cookie
  identity matches the session's `end_user_id` before issuing a refresh.
- **`publicBaseURL` trusts `X-Forwarded-Host` / `X-Forwarded-Proto`.** A browser
  can spoof these headers, so the `base_url` handed back to the chat panel (and
  thus the destination of the scoped weftd token) is client-influenceable when
  `SHOP_PUBLIC_BASE` is unset. In production, set `SHOP_PUBLIC_BASE` to the fixed
  browser-reachable origin; the `X-Forwarded-*` fallback is only safe behind a
  trusted reverse proxy you control (e.g. a reverse proxy).
- **The business REST API has no auth.** `customerId` is client-asserted
  (`X-Customer-ID` / `X-Weft-End-User` / cookie); `/api/reset` is gated to a
  logged-in user but the rest of the API is open. This is by design for a demo;
  keep your real auth.
- **`X-Weft-Actor` is trusted from the client** for event attribution only
  (audit), not authorization — but a client can self-stamp `agent` to make its
  actions appear as the agent's. Derive it server-side if attribution matters.

The SSE event feed IS scoped per-customer (a connection only receives its own
cart/order events; global product/reset events go to everyone) — that part is
safe to copy.

## Tests

```bash
pnpm test
```

## Layout

| Path | Description |
| --- | --- |
| `shared/meta.mjs` | State machine metadata (states, transitions, labels, API paths) |
| `lib/proc.mjs` | Process management + `.env` loader + health checks |
| `lib/system-prompt.mjs` | Generates the agent system prompt from `meta.mjs` |
| `server/` | Backend: REST CRUD + order state machine + SSE + static file serving |
| `src/` | Frontend: chat panel + storefront UI + automated live cursor replay |
| `run.mjs` | Entrypoint (builds frontend + starts shop server) |
| `online-store-agentic-graph.json` | Fail-open API dependency graph (15 nodes, 18 edges, all `required: false`) — routes multi-step tool calls |
| `scripts/gen-shop-graph.ts` | Generates the dependency graph from the OpenAPI spec (via `@percena/weft/api-graph`) |
| `scripts/verify-api-graph.mjs` | Validates the generated graph |
| `.env` | Credentials — gitignored |
