# itsm/classic — a traditional ITSM SaaS (no AI)

The scaffold source for the `integrate-weft-kit` skill's **2nd demo** (after
`online-store/`). A plain ITSM SaaS — incidents / changes / CIs / SLAs, two
state machines, 3-role auth, a CMDB relationship graph, a live SSE feed. **No
weft, no AI** — the agent layer is added by the skill on top of this (see
`../agentic/`, WIP).

Unlike `online-store/classic/` (Node), the backend here is **Python 3.12 +
FastAPI** — a deliberately different, idiomatic stack, so the skill has to
adapt to a site it wasn't tuned for (the recursive-skill-optimization test).

## Tech stack

| Layer | Choice |
|---|---|
| Backend | **Python 3.12 + FastAPI + Uvicorn** (idiomatic: `APIRouter` + `Depends` + `lifespan`) |
| State | **In-memory + Pydantic v2 schemas** (robust, zero-cleanup; OpenAPI derives from the Pydantic models, not the persistence layer) |
| OpenAPI | **FastAPI auto at `/openapi.json`**, auto-curated (`include_in_schema=False` on auth/events/state) → only the 35 business operations are exposed |
| Live events | **FastAPI `StreamingResponse` (SSE)** — `event: itsm.event` |
| Frontend | **React 19 + TypeScript + Vite 6 + Tailwind v4** |
| Env | **uv** (Python) + **pnpm** (frontend) — `rm -rf .venv` for a clean slate |
| Tests | **pytest** (25 tests: SM 409 backstop, both workflows, role gates, CI traversal, rollback auto-incident, `$prior` reopen) |

## The model

- **5 resources:** Incidents `INC-*`, Changes `CHG-*`, CIs `CI-*`, Users, SLAs.
- **Incident SM** (6 states): `new → in_progress → pending_user` (request/provide info) `→ resolved → closed`, + `escalate` + `reopen` (`$prior` back-edge). Illegal transition → `409 { error, allowed_actions }`.
- **Change SM** (9 states): `draft → submitted → cab_approved → scheduled → implementing → implemented → closed`, + `reject` + `rollback` (records `$prior` + **auto-creates + links** the incident it caused).
- **3-role auth** (cookie session): `requester` (carol), `agent` (alice, dave — the demo's primary user + the chat agent's role), `manager` (bob — CAB approve/reject, separation of duties).
- **CMDB graph:** `depends_on` / `runs_on` (e.g. `payment-service` depends on `payment-db` + `api-gateway` + `redis-cache`, runs on `payment-server`); `/api/cis/{id}/dependents` does the multi-hop traversal.
- **SLA matrix:** P1 15/60 min, P2 60/240, P3 240/1440, P4 1440/4320 (auto-attached to incidents by priority).

## Build + use

```sh
cd apps/itsm/classic
uv sync                 # Python deps → .venv
pnpm install            # frontend deps (shared workspace store)
pnpm test               # 25/25 pytest
pnpm start              # vite build → dist/ + uvicorn on http://127.0.0.1:19753
```

Open the URL, log in (alice/bob/carol/dave — any password), and use the
console: Incidents (list + create + detail with the `allowed_actions` buttons),
Changes (board + CAB), CMDB (explorer + dependents), SLAs (matrix).

Dev mode (HMR): `pnpm serve` (backend on :19753) in one terminal, `pnpm dev`
(Vite on :5175, proxies `/api` → :19753) in another.

## The API (35 business operations → `itsm_*` tool names)

`POST /api/incidents` (create), `GET /api/incidents`, `GET /api/incidents/{id}`,
`POST /api/incidents/{id}/{assign,escalate,resolve,close,reopen,request-info,provide-info}`,
`POST /api/incidents/{id}/{comments,priority,link/ci,link/change}` ·
`POST /api/changes` (create) + `GET`/`GET {id}` + `POST /{cid}/{submit,approve,reject,schedule,implement,complete,rollback,close,link/ci,link/incident}` ·
`GET /api/cis`, `GET /api/cis/{id}`, `GET /api/cis/{id}/dependents`, `PATCH /api/cis/{id}/status` ·
`GET /api/slas`, `GET /api/slas/{id}` · `GET /api/users`, `GET /api/users/{id}`.

Auth/utility (`/api/auth/*`, `/api/events` SSE, `/api/state`, `/api/reset`) are
excluded from the OpenAPI schema — they're not agent tools. The curated
`openapi.json` (committed) is dumped from the live spec via `pnpm openapi`.

The two deep workflows (Major Incident Response; Change Management + rollback)
are exercised end-to-end in `tests/test_incidents.py` + `tests/test_changes.py`.
