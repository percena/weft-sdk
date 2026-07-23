# itsm — the Weft skill-integration 2nd-demo apps

Two variants of the same ITSM SaaS — the `integrate-weft-kit` skill's 2nd demo
(after `apps/online-store/`). A **Python/FastAPI** backend (vs the store's
Node) + a more complex, higher-stakes SaaS (IT ops: P1 incident response, CAB
change management, CMDB traversal) — proving the skill works for a non-JS
backend and a harder domain.

> The skill's core is now a **language-agnostic contract + a closed loop**
> (build → headed test → self-repair). The Node (`.mjs`) + Python (`.py`)
> template sets are fast-paths; for any other backend the LLM follows the
> contract. See `skills/integrate-weft-kit/SKILL.md` (the ITSM demo's lessons
> are fed back into the skill's "Non-JS backend (Python)" section).

## Directory structure

| Dir | What it is | How it was generated |
|---|---|---|
| `classic/` | A traditional ITSM SaaS (FastAPI + React, no AI) — the scaffold source. | Hand-written (idiomatic Python/FastAPI + React). The **input** to the skill — deliberately NOT mirroring `online-store/classic` (a realistic, varied site the skill must adapt to). |
| `agentic/` | The same ITSM + a Weft chat agent that drives it. | **Built by the `integrate-weft-kit` skill** (Python branch) from `classic/`. Live-agent e2e PASSED; findings fed back into the skill. |

See `classic/README.md` + `agentic/README.md` for build/use details.

## `classic/` — the traditional ITSM SaaS

A focused ITSM SaaS — incidents / changes / CIs / SLAs, two state machines,
3-role auth, a CMDB relationship graph, a live SSE feed. **No weft, no AI.**

**Tech stack:** Python 3.12 + **uv** + FastAPI + Uvicorn; in-memory store +
Pydantic v2 schemas (robust, zero-cleanup; the OpenAPI derives from the
schemas, not the persistence layer); React 19 + TS + Vite + Tailwind; pytest.

**The model:**
- **5 resources:** Incidents `INC-*`, Changes `CHG-*`, CIs `CI-*`, Users, SLAs.
- **Incident SM** (6 states): `new → in_progress → pending_user` (request/provide
  info) `→ resolved → closed`, + `escalate` + `reopen` (`$prior` back-edge).
- **Change SM** (9 states): `draft → submitted → cab_approved → scheduled →
  implementing → implemented → closed`, + `reject` + `rollback` (records
  `$prior` + **auto-creates + links** the incident it caused).
- **3-role auth** (cookie session): `requester` (carol), `agent` (alice, dave —
  the demo's primary user + the chat agent's role), `manager` (bob — CAB
  approve/reject, separation of duties).
- **CMDB graph:** `depends_on` / `runs_on` (payment-service depends on
  payment-db + api-gateway + redis-cache, runs on payment-server); multi-hop
  traversal at `/api/cis/{id}/dependents`.
- **SLA matrix:** P1 15/60 min, P2 60/240, P3 240/1440, P4 1440/4320.

**The API — 35 business operations** (`itsm_*` tool names, auto-curated via
`include_in_schema=False` on auth/utility/SSE → the live `/openapi.json` is
already the curated spec). Illegal transitions return `409 { error,
allowed_actions }`. Build + use in `classic/README.md`.

## `agentic/` — how it came to be

`agentic/` is **built by the `integrate-weft-kit` skill** (Python branch) from
`classic/`. The skill's runbook drove the pipeline; the LLM implemented the
contract in Python (the Node `.mjs` templates don't apply) + the closed loop
caught the issues.

### The pipeline (classic → agentic)

1. **Scaffold** — rsync `classic/` → `agentic/` + the deltas (`package.json`
   `@percena/weft`, vite port/proxy, `.env.example`, pyproject).
2. **Python backend templates** — `app/provision.py` (httpx weftd provisioning),
   `app/session_routes.py` (FastAPI `APIRouter`: `/api/chat/session` + `/v1/*`
   httpx streaming reverse-proxy), `app/weft.py` (X-Weft-Actor middleware),
   `app/system_prompt.py`, `run.py`. *(The skill's `templates/python/` — the
   first Python set, created during this build.)*
3. **Wire `main.py`** — `include_router(create_session_router(...))` (NO
   listener-wrap — the Node port's wiring dissolves on a router backend) +
   `actor_middleware` + `servers=[...]` + provisioning warm-up. `store.emit`
   one-line override (`actor = get_actor() or actor`).
4. **Frontend** — `ChatPane` + `chat-bootstrap` into `App.tsx` (chat sidebar) +
   `ActionReplayLayer` + `weftAction` annotations on the incident/change/CI
   rows. Kept the classic's own auth.
5. **Graph** — `scripts/gen-itsm-graph.ts` → `itsm-agentic-graph.json` (35
   nodes / 221 edges, all `required:false`). `_provision_graph` gracefully
   skips on validate-failure (the analyzer's shared-field edges cycle on rich
   schemas — fail-open).
6. **Provision + run** — `pnpm start` (build web + `run.py`: assert creds +
   uvicorn + `ensure_app` warm-up). Provisions the `itsm` toolset + `itsmbot`
   skill + automation on weftd.

### Fully automatable — human review is optional, not required

The pipeline is fully automatable — the skill can produce a working agentic
site end-to-end, **no human intervention required to close the loop**. The
defaults work out-of-the-box: the graph generates fail-open; the execution
model is auto-decidable (same-origin + cookie + local → `client`); the SM is
shared; the system-prompt is rendered from it. The e2e is a **verification**
(the agent drives the tools + the action-bridge replays), not a build step.

**We recommend developers review the AI's output** (the graph edges, the SM,
the e2e) — best-practice due-diligence, like reviewing a PR. But it's
**icing on the cake**: the skill's defaults produce a correct,
running agentic site without it. The closed loop (build → headed test →
self-repair) is what guarantees correctness, not one-shot perfection.

### Build + use

```sh
cd apps/itsm/agentic
cp .env.example .env   # fill WEFTD_BASE / WEFT_API_KEY / WEFT_TENANT_ID / OPENAI_*
uv sync && pnpm install
pnpm test              # 25/25 (the classic's SM + REST tests, unchanged)
pnpm start             # vite build + uvicorn on http://127.0.0.1:19755 + provision on weftd
```

Open the URL, log in (alice/bob/carol/dave), set the chat permission `Auto`,
and tell the agent what to do — it drives the `itsm_*` tools, the action-bridge
automated live cursor replays each on the console, and the result lands in `/api/state`.
(The host already seals `permission_mode: auto` at createSession so panel Auto is not demoted by weftd's embed authority gate.)

## Manual testing the agentic

The agentic is best tested **by hand, in a headed browser** — you see the agent
drive the tools + the action-bridge automated live cursor + can intervene. This demo is
more complex than the store, so here are several test cases with expected
results. **Quick test first, then the deeper cases.**

### Quick test (~5 min — the happy path)

1. **Start** — `cd apps/itsm/agentic && pnpm start` → open `http://127.0.0.1:19755`.
   Wait for `Application startup complete.` + `Uvicorn running on …` (weftd
   provisioning runs during startup); a `GET /` → 200 means it's ready.
2. **Log in** as **alice** (agent role — the chat agent's role).
3. **Set the chat permission to Auto** — click the "ⓘ Ask ⌄" button (bottom of
   the chat sidebar) → "⇄ Auto". *(Auto = the agent runs unattended; Ask =
   it prompts before each write.)*
4. **Send:** *"P1: the payment service is down. Create an incident, link the
   affected CI + its dependent CIs, assign to the on-call, escalate, then
   resolve + close it."*
5. **Watch** — the chat shows each `itsm_*` tool call; the **automated live cursor**
   moves to the incident row for each (AI Create → AI Link CI → AI Assign → AI
   Escalate → AI Resolve → AI Close).
6. **Verify** — wait for the chat status badge to leave "● Running" (the UI
   lags the server by a beat while the `itsm_*` calls stream in), then the
   incident row shows **INC-1 [closed/P1], assignee=alice,
   linked_cis=[ci1..ci5]**. Or `curl -b <cookie> http://127.0.0.1:19755/api/state`
   (poll until `status` is `closed` — the run takes ~20-40s).

> If a step 502s ("weftd proxy failed: …TLS…"), it's a **transient reverse-proxy
> TLS-handshake drop** (the proxy retries once; both attempts failed) — NOT a code bug
> (the SKILL.md "Common Mistakes" documents this). **Recovery depends on where
> it died:** if no incident was created yet, just resend. But if it died
> mid-lifecycle (INC-N already exists — e.g. after `escalate`), don't blindly
> resend the original message — that creates a duplicate INC-N+1. Send a
> targeted follow-up ("resolve and close INC-N") instead, or reset (below) +
> resend.
>
> **Re-running?** The store is **in-memory** (no DB to clean) — incidents/
> changes persist across chat runs until the server restarts, so a second run
> creates INC-2, INC-3, …. For a clean repeat (INC-1, deterministic IDs across
> the TC1–TC6 suite), reset first: `curl -b <cookie> -X POST
> http://127.0.0.1:19755/api/reset`, or — easier from the logged-in browser's
> devtools console — `await fetch('/api/reset', { method: 'POST' })`, or just
> restart `pnpm start`. Don't reset mid-TC5: that case relies on INC-N
> surviving a page reload (the store persists, the weftd session doesn't).

### Test cases (send these messages; expected results below)

| # | Scenario | Send this (as alice, unless noted) | Expected result |
|---|---|---|---|
| **TC1** | Major incident response (P1) | *"P1: the payment service is down. Create an incident, link the affected CI + its dependent CIs, assign to the on-call, escalate, then resolve + close it."* | INC-N `[closed/P1]`, assignee=alice, `linked_cis=[ci1,ci2,ci3,ci4,ci5]` (the full dependency chain via `getCiDependents`), history `create→assign→escalate→resolve→close`. Automated live cursor replays each. |
| **TC2** | Change mgmt + CAB + rollback | (alice) *"Create a normal change for a DB migration on payment-db (ci2), link the CI, submit it for CAB."* → (switch to **bob**/manager) *"Approve change CHG-N."* → (back to alice) *"Schedule + implement + complete it."* → *"Rollback the change — it broke something."* | CHG-N `draft→submitted→cab_approved→scheduled→implementing→implemented→rolled_back`. The rollback **auto-creates + links** an incident (the one it caused). Approve as alice → **403** (manager-only — the SM's role gate). |
| **TC3** | CMDB traversal | *"The payment service is slow — check its dependent CIs + their status."* | The agent calls `itsm_listcis` / `itsm_getci` / `itsm_getcidependents` + reports the chain: payment-service depends on payment-db + api-gateway + redis-cache, runs on payment-server, + their statuses. (No incident created — a read-only triage.) |
| **TC4** | The SM 409 backstop | With an `in_progress` incident, *"Close INC-N."* | The agent calls `itsm_closeincident` → **409 `{error, allowed_actions:[resolve,...]}`** → it relays "must resolve first" → resolves → closes. (Tests the reactive backstop — no blind-retry.) |
| **TC5** | Cross-session reference (the key regression) | Create INC-N in session A. **Reload the page** (new weftd session, empty `RunDataBindings`). *"Resolve INC-N."* | The agent operates on the **pre-existing** INC-N by id directly — **no duplicate** created. (For the ITSM's fail-open graph this always works; the test catches a `required:true` edge regression.) |
| **TC6** | Role separation (CAB) | (alice/agent) *"Approve change CHG-N."* | **403** — approve is manager-only. The agent should tell you a manager must approve (relay the error, no blind-retry). Switch to **bob** + re-send → succeeds. |

> **Deterministic IDs:** the table uses `INC-N`/`CHG-N` generically. For
> reproducible IDs (INC-1, CHG-1) across the suite, `POST /api/reset` first
> (see Quick test). And don't reset between TC5's two steps — it relies on
> INC-N surviving the page reload.

## Live-drive the demo (headed Playwright)

The easiest way to see the agentic in action: **open a headed browser, log in,
set Auto, send one message, and watch the agent drive + the automated live cursor
replay.** This is more intuitive than manually stepping through the test cases
above — you see the agent do the work end-to-end, hands-off.

### The 30-second live-drive

```sh
cd apps/itsm/agentic && pnpm start                          # 1. start the server → http://127.0.0.1:19755 (wait for "Application startup complete" — weftd provisions during startup)
npx playwright-cli open --headed http://127.0.0.1:19755     # 2. open a VISIBLE Chrome window
```

Then **in the browser window** (a real Chrome — you can click/type directly):
1. Click **alice** (agent) → **Sign in**.
2. Click **"ⓘ Ask ⌄"** (bottom of the chat sidebar) → **"⇄ Auto"**.
3. Send: *"P1: the payment service is down. Create an incident, link the
   affected CI + its dependent CIs, assign to the on-call, escalate, then
   resolve + close it."*
4. **Watch** — the chat streams each `itsm_*` tool call; the **automated live cursor**
   moves to the incident row for each (AI Create → AI Link CI → AI Assign → AI
   Escalate → AI Resolve → AI Close).
5. **Verify** — wait for the status badge to leave "● Running" (the UI lags
   the server), then expect **INC-1 [closed/P1], assignee=alice,
   linked_cis=[ci1..ci5]**. In the browser devtools console:
   `await (await fetch('/api/state')).json()` (the cookie rides same-origin).

> **502 / re-run:** if a step 502s (`weftd proxy failed: …TLS…`) it's a
> transient reverse-proxy TLS-handshake drop, not a code bug — see the Quick test note for
> recovery (resend, or a targeted follow-up if it died mid-lifecycle). The
> store is in-memory (no DB); for a clean re-run, `POST /api/reset` from the
> console (`await fetch('/api/reset', { method: 'POST' })`) or restart
> `pnpm start`.

### Cli-driven (hands-off — the commands do the clicking)

```sh
npx playwright-cli open --headed http://127.0.0.1:19755
npx playwright-cli snapshot                                 # find the refs (e8, e23, …)
npx playwright-cli click e8                                 # alice
npx playwright-cli click e23                                # Sign in
# Set Auto: the "ⓘ Ask ⌄" button is its own ref (e58 here); clicking it opens a
# menu whose items get NEW refs — so re-snapshot, then click "⇄ Auto" (e79 here):
npx playwright-cli click e58                                # "ⓘ Ask ⌄" — opens the permission menu
npx playwright-cli snapshot                                 # menu items weren't in the prior snapshot — re-snapshot
npx playwright-cli click e79                                # "⇄ Auto"
# Find the composer textbox + Send button (e55 / e56 here), then send:
npx playwright-cli fill e55 "P1: the payment service is down. Create an incident, link the affected CI + its dependent CIs, assign to the on-call, escalate, then resolve + close it."
npx playwright-cli click e56                                # Send — starts the agent run (~20-40s, multi-step itsm_* calls)
# Poll /api/state until INC-1 is closed (the cookie rides same-origin):
npx playwright-cli eval "async () => { const j = await (await fetch('/api/state')).json(); return (j.incidents.find(i => i.id === 'INC-1') || {}).status; }"   # → "closed"
npx playwright-cli screenshot --filename=/tmp/itsm-demo.png
# Re-run from a clean state (in-memory store; no DB to clean):
npx playwright-cli eval "async () => (await fetch('/api/reset', { method: 'POST' })).status"   # → 200
```

> The refs (e8, e23, e55, e58, e79, …) come from `playwright-cli snapshot` —
> stable within a render, but they change when the page re-renders or a menu
> opens (the permission menu's items weren't in the prior snapshot — that's why
> you re-snapshot after clicking "ⓘ Ask ⌄"). The refs above are from one render;
> yours may differ — snapshot to confirm. Or just click/type directly in the
> headed browser window (it's a real Chrome — you can interact).

### What you'll see

- **Chat panel** (left sidebar): the agent's reasoning + each `itsm_*` tool call.
- **Automated live cursor**: moves to the incident row for each tool call, labeled
  ("AI Assign INC-1") — the "mouse-animation" visual feedback.
- **Incident list** (main panel): updates live (SSE) as the agent drives the
  lifecycle.
- `/api/state` confirms the result (e.g. INC-1 closed, linked to the full CI
  dependency chain).

For the deeper cases (TC1–TC6 above, incl. change-mgmt + CAB + rollback), send
those messages the same way. The skill's Phase 3 (`SKILL.md`) has the full
9-item e2e checklist (site up, chat bootstraps, tools visible, agent drives,
action-bridge replays, SM 409 backstop, cross-session reference, /v1 streams,
token refresh).

## The skill

`skills/integrate-weft-kit/` — the runbook (`SKILL.md`) + `templates/`
(parameterized agentic layer: `.mjs` for Node, `python/` for FastAPI) +
`references/` (fail-open / plan_route / execution-model theory). It turns a
traditional REST app (`classic/`) into an agentic app (`agentic/`) by the
pipeline above. The **language-agnostic contract + the closed loop** is the
core; the templates are fast-paths. The ITSM demo's lessons are documented in
`SKILL.md` "Non-JS backend (Python)".
