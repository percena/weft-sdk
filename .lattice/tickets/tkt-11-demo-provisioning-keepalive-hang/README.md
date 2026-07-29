# tkt-11-demo-provisioning-keepalive-hang

> **TL;DR:** The agentic demo chat hangs indefinitely ("Connecting to chat…" / run-POST 30s timeout) because fetches from the long-running demo server process to weftd intermittently stall on stale keep-alive sockets, and the demo's fetches had no per-request timeout. Fix: aggressive keep-alive drop + fetch timeout/retry (provisioning + proxy).

| Field | Value |
| --- | --- |
| kind | fix |
| priority | P1 |
| labels | bug, P1 |
| github | https://github.com/percena/weft-sdk/issues/12 |
| status | in_progress |
| summary | demo chat bootstrap/run-POST indefinite hang from stale keep-alive + no fetch timeout; fix re-targeted to the integrate-weft-kit skill templates (JS+Python) + both demo apps |
| spec | none (ticket-only) |
| covers | KeepAlive, ProvisionTimeout, ProxyTTFB |
| blocked_by | (none) |
| parallel_group | (serial) |
| paths | apps/online-store/agentic/run.mjs; apps/online-store/agentic/server/provision.mjs; apps/online-store/agentic/server/session-routes.mjs |
| solo_merge | yes |
| **primary_ticket** | tkt-11 (this issue) |
| **related_tickets** | (none — client-side resilience; the control-plane ingress + metering root causes are tracked separately on the closed-source side) |
| **worktree_bind** | `tkt-11-demo-provisioning-keepalive-hang` |
| prs | (pending) |

## Acceptance

- [x] **LayerSoT** Fix lives in the `integrate-weft-kit` skill TEMPLATES (`skills/integrate-weft-kit/templates/{,python/}`), not only in a scaffolded demo instance — so it propagates to future scaffolded apps. (rev-20260729-141433Z Finding 1.)
- [x] **KeepAlive** JS `templates/run.mjs` + `apps/online-store/agentic/run.mjs` set `setGlobalDispatcher(new Agent({ keepAliveTimeout: 500, keepAliveMaxTimeout: 500, headersTimeout: 20000 }))` — stale idle sockets dropped before reuse (core fix).
- [x] **ProvisionTimeout** JS `templates/provision.mjs` `weftdAPI` adds `AbortSignal.timeout(20000)` + retry (≤3, backoff) on `TypeError`/`AbortError`/`TimeoutError`.
- [x] **ProxyTTFB** JS `templates/session-routes.mjs` + demo `proxyToWeftd` add a TTFB timeout (20s, cleared on headers so timeline SSE is never killed) + retry (≤3). Tightened per Finding 3: pre-handshake errors retry for ALL methods; TTFB-timeout retries ONLY idempotent GET/HEAD (fires after body sent → weftd may have created the run → non-idempotent POST/PUT/DELETE fail-closed 504).
- [x] **Python** `templates/python/provision.py` (httpx `keepalive_expiry=0.5` + ReadTimeout retry) + `templates/python/session_routes.py` (per-method `httpx.Timeout`: GET/HEAD read=None for SSE, POST/PUT/DELETE read=30; tightened retry). `provision.py` already had a 60s timeout (kept).
- [x] **itsm-demo** `apps/itsm/agentic/app/{provision.py,session_routes.py}` synced to the template fixes.
- [x] **A-green** Tests: online-store JS 15/15; itsm Python 11/11. ego-browser e2e (147 timeline events, tool_call + assistant_message + turn_completed); re-verify (provisioning + bootstrap + run-POST via proxy green).
- [x] No regression: idempotent provisioning (duplicate-key 500s swallowed) still completes; non-idempotent run-POST fails-closed (504) on TTFB-timeout (no duplicate createRun).

## Notes

- Root cause confirmed by instrumented `weftdAPI` trace: `PUT /toolsets/shop` timed out at 15s in the demo process while curl + standalone Node returned in ~1-2s. The reverse proxy in front of the weftd control plane silently closes idle keep-alive connections; undici's default 4s idle window sometimes reuses a half-closed socket.
- The ingress-side keep-alive root cause is tracked separately on the control-plane side (closed-source); this ticket is the client-side resilience layer.
- Fix applied + verified via ego-browser e2e (147 timeline events, tool_call + assistant_message + turn_completed).

## Lineage

- Parent: none (standalone bug fix)
- Related: (none — control-plane root causes tracked separately on the closed-source side)
