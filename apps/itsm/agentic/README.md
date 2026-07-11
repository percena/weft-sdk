# itsm/agentic — the ITSM SaaS + a Weft chat agent

Built by the `integrate-weft-kit` skill (Python branch) on top of `../classic/`
— the 2nd demo (after `online-store/`), on a **Python/FastAPI** backend. The
live LLM agent drives the ITSM REST API through the `itsm_*` tools via an
embedded chat panel; the action-bridge automated live cursor replays each tool call on
the console.

## Prerequisites — this demo needs a weftd control plane

> **This agentic demo is NOT standalone.** It drives a live LLM agent through a
> remote **weftd** control plane (`WEFTD_BASE` / `WEFT_API_KEY` /
> `WEFT_TENANT_ID` + `OPENAI_*` in `.env`). Weft is open-sourced as an **embed
> SDK** (`@percena/weft`); the full classic → agentic loop needs a
> Cloud-hosted weftd tenant. Register one at the
> [Weft console](https://weft-kit.dev) (free trial). The classic ITSM backend
> (`apps/itsm/classic`) runs end-to-end with no weftd dependency; a fixture/mock
> agent backend for fully-offline agentic validation is on the roadmap.

## How it was generated (classic → agentic)

The skill's runbook (Python branch — `skills/integrate-weft-kit/templates/python/`) drove the pipeline:

1. **Scaffold** — rsync `classic/` → `agentic/` + the deltas (`package.json` `@percena/weft`, vite port/proxy, `.env.example`, pyproject).
2. **Python backend templates** — `app/provision.py` (httpx weftd provisioning), `app/session_routes.py` (FastAPI `APIRouter`: `/api/chat/session` + `/v1/*` httpx reverse-proxy), `app/weft.py` (X-Weft-Actor middleware), `app/system_prompt.py`, `run.py`.
3. **Wire `main.py`** — `include_router(create_session_router(...))` (NO listener-wrap) + `actor_middleware` + `servers=[...]` + provisioning warm-up. `store.emit` one-line override.
4. **Frontend** — `ChatPane` + `chat-bootstrap` into `App.tsx` (chat sidebar) + `ActionReplayLayer` + `weftAction` on the incident/change/CI rows. Kept the classic's own auth.
5. **Graph** — `scripts/gen-itsm-graph.ts` → `itsm-agentic-graph.json` (35 nodes / 221 edges, all `required:false`). `_provision_graph` gracefully skips on validate-failure.
6. **Provision + run** — `pnpm start` (build web + `run.py`: assert creds + uvicorn + `ensure_app` warm-up). Provisions the `itsm` toolset + `itsmbot` skill + automation on weftd.

## Build + use

```sh
cd apps/itsm/agentic
cp .env.example .env   # fill WEFTD_BASE / WEFT_API_KEY / WEFT_TENANT_ID / OPENAI_*
uv sync && pnpm install
pnpm test              # 25/25 (the classic's SM + REST tests, unchanged)
pnpm start             # vite build + uvicorn on http://127.0.0.1:19755 + provision on weftd
```

Open the URL, log in (alice = agent), set the chat permission `Auto`, and tell
the agent e.g. *"P1: payment service down — find the on-call, link the
dependent CIs, assign + escalate"* — it drives the `itsm_*` tools
(`itsm_listcis` → `itsm_createincident` → `itsm_linkincidentci` ×5 →
`itsm_assignincident` → `itsm_escalateincident`), the action-bridge automated live
cursor replays each on the incident row, and the incident lands in
`/api/state`.

## The findings (fed back to the skill)

This demo was the recursive-skill-optimization pass — a non-JS, idiomatic site
the skill had to adapt to. The findings are documented in
`skills/integrate-weft-kit/SKILL.md` ("Non-JS backend (Python)"). Highlights:
the Node `.mjs` templates → a Python set; the `/v1` proxy TLS-retry →
httpx; `X-Weft-Actor` actor extraction must be ADDED; the Node
listener-wrap dissolves on a router backend; FastAPI's auto-openapi
needs `servers=[...]`; the analyzer's shared-field edges cycle on rich
schemas + miss idiomatic `{iid}` path params — both non-blocking
(fail-open graph-skip; the agent uses the system prompt + 409).
