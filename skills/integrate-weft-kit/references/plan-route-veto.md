# `plan_route` + the Deterministic Veto

> Reference note for the `integrate-weft-kit` skill. This file stands alone — read it to understand how the graph sequences calls and what it does **not** carry. Everything here is stated as the **observable contract**: what an integrator sees on the wire (tool defs, tool results, timeline items), independent of how the server implements it.

## The three layers (orientation)

The graph participates in runtime at two deterministic layers that sit alongside the existing discovery layer. None of the graph body is in the LLM prompt — the LLM gets operation names + schemas from tool defs / `tool_search`, a short system-prompt nudge ("for multi-step API sequences, call `plan_route`…"), and the `plan_route` tool def is emitted only when a graph is bound to the session.

- **Layer 1 — Discovery (existing, unchanged):** `tool_search` answers "which tool can do X." It does not model relationships between APIs.
- **Layer 2 — Routing (deterministic):** `plan_route` — a runtime-handled pseudo-tool that returns a topo-ordered precursor chain for a target operation.
- **Layer 3 — Enforcement (deterministic veto gate):** a per-call precondition check that denies out-of-order/missing-data calls with a structured, actionable error the model can recover from.

## `plan_route` — the routing pseudo-tool

`plan_route` appears in the tool list like any other tool, but the runtime answers it directly (calling it never reaches your API — the same pattern as `propose_plan`/`tool_search`).

**Input:** `{target: <node id or tool_name>, have?: {field: value, …}}`. `target` is required; an unresolvable target returns a tool error. `have` lets the model declare values it already holds (e.g. user-supplied ids) so they count as available.

**Output** (a JSON tool result):

```jsonc
{
  "chain": [{"node_id": "createOrder"}, {"node_id": "payOrder"}],  // topo-ordered: producers before consumers; includes the target
  "bindings": [{"from_field": "order_id", "to_field": "order_id"}], // which produced fields feed which consumed fields, when known
  "degraded": true,                                                 // only when no usable graph is bound
  "hint": "…"                                                       // present on degraded results: sequence manually, watch 409s
}
```

The routing algorithm is **deterministic**: starting from the target, it walks incoming **`required` data edges** whose value is not yet available and incoming **`required` + `verified` precondition edges** whose precursor has not been called this session, pulls the missing precursors in transitively, and topo-sorts the result. Values already produced earlier in the session (or declared via `have`) drop their producer from the chain. A malformed graph with a cycle among the needed nodes returns a tool error rather than an arbitrary order.

Two consequences of "only `required`":

- **`required:false` edges are dropped from `plan_route` entirely.** The route never traverses them. This is load-bearing for referential create→mutate edges (`required:false`): `plan_route` does **not** try to sequence "create then mutate" as a graph-derived chain.
- **Multi-step lifecycle sequences are carried by the system prompt + reactive 409, not the graph.** The prompt's state machine + your API's `409 + allowed_actions` backstop define legal transitions; the graph's job is cross-cutting data-flow lineage (does this mutation have a resource id?), not re-deriving the state machine. State edges are recorded in the graph but routing ignores them — the reactive layer handles state transitions.

## The deterministic veto

Every named-toolset call is checked against the graph **before** it executes (and before any permission prompt). The check mirrors your API's `409 + allowed_actions` reactive pattern, so the LLM recovers the same way.

Policy (the fail-open keystone — see `references/fail-open.md`):

- **Fail-open by default.** Hard-veto **only** on `verified:true && required:true` edges where the lineage is *clearly* broken.
- **Unverified (AI-inferred) edges never hard-veto** — they only feed `plan_route`.
- **Anything the runtime cannot judge → allow** (no graph, node not in the graph, argument absent — the API's own 400 handles that — or a result body it could not parse). The veto never turns uncertainty into a block.

The check, per incoming edge of the called operation:

- **data edges:** for each required consumed field with a `verified && required` incoming data edge, if the call's argument value was never recorded as produced for that field this session, **DENY** with reason `missing_precursor`. (Matching is by produced-field name + value — a value emitted by *any* graph producer of that field satisfies the edge, not only the specific producer the edge names.)
- **precondition edges:** for each `verified && required` incoming precondition edge whose precursor has not been called this session, **DENY** with `reason: "missing_precondition"`.
- Otherwise **ALLOW**.

**Deny surface (what the model and the timeline see):** the tool call completes as a *failed tool result* whose content is a **flattened string** of the form `Error: <reason>; <hint>` — e.g.

```text
Error: missing_precursor; call plan_route or run createOrder first to produce order_id
Error: missing_precondition; run createOrder before payOrder
```

The same string appears as the step's error and as the `error` field of the failed-tool timeline event. `<reason>` is one of `missing_precursor` (a required consumed value was never produced this session; the hint names the expected producer and the field) or `missing_precondition` (a required precursor op was never called; the hint names it). **No structured JSON violation object is emitted on the wire** — integrators and prompts should branch on the `missing_precursor` / `missing_precondition` string, not on JSON fields.

The **run continues** — a veto is recoverable, never terminal. The deny shape deliberately mirrors `409 + allowed_actions`, so the LLM's existing recovery behavior (follow the hint / call `plan_route`, don't blind-retry) applies unchanged.

**v1 limitation (intentional):** the veto requires consumed values to have been *produced by a tracked graph producer this session*. A value the user typed in, or one created in a prior session, is not in the lineage — on a `verified && required` data edge it will be vetoed until the producer runs. This is why referential edges (ids referencing pre-existing resources) MUST be `required:false` (see `references/fail-open.md` and the cross-session e2e test in the SKILL); the reactive 409/404 layer backstops those cases.

## Runtime lineage — separate from `verified`

> **`verified` is developer sign-off; lineage is a runtime mechanism. Do not conflate them.** `verified` says "the edge is real"; lineage says "the edge fired this session." Both must hold to deny.

Behaviorally, the runtime maintains two per-session records:

- **produced values** — after each successful tool call, the fields the graph says that operation `produces` are extracted from the result body (per the node's `json_path`) and remembered, per field, with the values seen. A data edge is satisfied when the consuming call's argument matches a value previously recorded for the producing field — the lineage table is keyed by field name, so a matching value from any graph producer of that field counts.
- **call history** — the ordered set of graph operations that have run. A precondition edge is satisfied when its precursor appears here.

Both are deterministic, and both **persist across suspensions and reconnects**: when a client-executed tool (`client_http_request` / `execution: client` named tools) suspends the run and the browser submits the result back, the resumed run's lineage includes fields extracted from that client-supplied result body exactly as if the server had executed the call. A page reload or timeline reconnect does not reset lineage — only a **new session** starts empty (which is what the cross-session e2e test exploits).

Extraction is best-effort: a non-JSON result body or a `json_path` miss records nothing and never fails the call — downstream checks stay fail-open for that field.

## Interaction with the plan system (no double-gate)

The graph and the approved-plan mechanism gate different things:

- **At plan-proposal time:** if a graph is bound, the proposed plan's step sequence is validated against the graph. A plan that orders a consumer before its `verified && required` producer **fails the run** — a terminal `plan inconsistent with dependency graph: …` failure, not a recoverable rejection (the model does not get to re-propose within that run). Only wrong *order among the plan's included steps* fails validation; a partial plan that simply omits a precursor is accepted (the runtime veto is the backstop).
- **At call time with an approved plan:** plan enforcement checks that calls follow the approved *order* — an out-of-plan call is likewise a terminal run failure. The graph veto **still runs** — intentionally, not redundant: plan order says "the plan listed the precursor first"; the veto checks *runtime data lineage* ("was this value actually produced this session?"). The latter catches what the former can't — a hallucinated id inside an approved plan, or a producer that ran but didn't emit the expected field. Unlike the two plan failures above, a graph veto stays recoverable.
- **At call time with no approved plan (default direct-execution mode):** the graph veto is the fallback gate.

The graph acts at *propose-time validation* + *no-plan fallback gate* + *lineage backstop under a plan* — it never duplicates the plan-order check.

## Drift & degradation (robustness)

- `generated_by.spec_hash` is sealed into the graph at generation time and identifies the exact spec bytes it was derived from. If you change the spec, **regenerate the graph from the same spec bytes you deploy** — a graph derived from a different spec can mis-route or (on `verified && required` edges) veto calls the current API allows.
- No graph bound → `plan_route` returns `{degraded: true, hint}` and the veto allows everything; the reactive `409 + allowed_actions` layer takes over.
- Unknown operation / node not in the graph → same graceful degradation, per call. **The graph is an enhancement; it is never a hard dependency that can break the runtime.**

## Why veto-and-guide, not auto-inject

The runtime never rewrites a tool call and never injects a precursor call on the model's behalf. It only allows, denies (with the structured hint), or annotates. v1 deliberately uses veto-and-guide — the LLM re-plans from the structured deny — which is robust to runtime data changing the path (e.g. refund denied → back to prior status; a locked auto-injected sequence would break, a veto-and-re-plan handles it).

## What the graph does NOT carry

- **State transitions** — the reactive `409 + allowed_actions` layer handles state machines, including `$prior` back-edges (refund denied → prior status). The graph records state edges but routing ignores them.
- **The resource lifecycle sequence** — carried by the system prompt's state machine + reactive 409, because the relevant edges are referential (`required:false`) and thus invisible to `plan_route`.
- **Cross-toolset data flow** — a non-goal for v1 (one graph per app; the envelope's `toolset` field names the toolset it describes).
