# tkt-11-demo-provisioning-keepalive-hang

> **TL;DR:** The agentic demo chat hangs indefinitely ("Connecting to chat…" / run-POST 30s timeout) because fetches from the long-running demo server process to weftd intermittently stall on stale keep-alive sockets, and the demo's fetches had no per-request timeout. Fix: aggressive keep-alive drop + fetch timeout/retry (provisioning + proxy).

| Field | Value |
| --- | --- |
| kind | fix |
| priority | P1 |
| labels | bug, P1 |
| github | https://github.com/percena/weft-sdk/issues/12 |
| status | in_progress |
| summary | demo chat bootstrap/run-POST indefinite hang from stale keep-alive + no fetch timeout |
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

- [ ] **KeepAlive** `run.mjs` sets `setGlobalDispatcher(new Agent({ keepAliveTimeout: 500, keepAliveMaxTimeout: 500, headersTimeout: 20000 }))` so stale idle sockets are dropped before reuse (the core fix — standalone Node fetch already worked; only the long-running server process stalled).
- [ ] **ProvisionTimeout** `server/provision.mjs` `weftdAPI` adds `AbortSignal.timeout(20000)` + retry (≤3, backoff) on `TypeError`/`AbortError`/`TimeoutError`. Provisioning fails fast + recovers instead of hanging `ensureApp()` forever.
- [ ] **ProxyTTFB** `server/session-routes.mjs` `proxyToWeftd` adds a TTFB timeout (20s, cleared once response headers arrive so the timeline SSE stream is never killed) + retry (≤3) on pre-handshake/TTFB-timeout. Run-POST stall is pre-handshake (empty timeline proves weftd never received the body) → retry is non-duplicative.
- [ ] **A-green** Browser e2e: login → "list the products" → agent calls `shop_listproducts` + responds (timeline `turn_completed`); no 30s timeout.
- [ ] No regression: idempotent provisioning (duplicate-key 500s swallowed) still completes; non-idempotent run-POST only retried on pre-handshake/TTFB stalls.

## Notes

- Root cause confirmed by instrumented `weftdAPI` trace: `PUT /toolsets/shop` timed out at 15s in the demo process while curl + standalone Node returned in ~1-2s. The reverse proxy in front of the weftd control plane silently closes idle keep-alive connections; undici's default 4s idle window sometimes reuses a half-closed socket.
- The ingress-side keep-alive root cause is tracked separately on the control-plane side (closed-source); this ticket is the client-side resilience layer.
- Fix applied + verified via ego-browser e2e (147 timeline events, tool_call + assistant_message + turn_completed).

## Lineage

- Parent: none (standalone bug fix)
- Related: (none — control-plane root causes tracked separately on the closed-source side)
