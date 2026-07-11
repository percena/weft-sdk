# `plan_route` + the Deterministic Veto

> Reference note for the `integrate-weft-kit` skill. This file stands alone — read it to understand how the graph sequences calls and what it does **not** carry.

## The three layers (orientation)

The graph participates in runtime at two deterministic layers that sit alongside the existing discovery layer. None of the graph body is in the LLM prompt — the LLM gets operation names + schemas from tool defs / `tool_search`, a short system-prompt nudge ("for multi-step API sequences, call `plan_route`…"), and the `plan_route` tool def emitted only when a graph is bound.

- **Layer 1 — Discovery (existing, unchanged):** `tool_search` answers "which tool can do X." It does not model relationships between APIs.
- **Layer 2 — Routing (NEW, deterministic):** `plan_route` — a runtime-intercepted pseudo-tool that returns a topo-ordered precursor chain for a target op.
- **Layer 3 — Enforcement (NEW, deterministic veto gate):** `enforceGraphPreconditions` — a per-call chokepoint that denies out-of-order/missing-data calls with a structured, actionable error.

## `plan_route` traverses only `required` data edges

`plan_route` is a runtime-intercepted pseudo-tool (its builtin `Execute` returns `"plan_route is handled by the runtime"`, the same pattern as `propose_plan`/`tool_search`). Input: `{target: <op id or tool_name>, have?: {field: value}}` (omit `target` for a pure "what can I do" listing of entrypoints).

The algorithm is **deterministic**:

1. Parse the graph body from the run's `ConfigSnapshot["graph"]` (`EffectiveGraphBody`); nil or stale → **degrade** (return `{degraded:true, hint:"no verified graph; sequence manually, watch 409s"}`).
2. Build `available = RunDataBindings ∪ have` and read `call_history` from the session.
3. Walk **only `required`** incoming edges of the target:
   - **data edges** where `e.required` — if `data_satisfied(e, available)` is false, prepend `e.from` to the needed chain and recurse.
   - **precondition edges** where `e.required and e.verified` — if `e.from` is not in `call_history`, prepend and recurse.
4. Return `{chain: dedupe_toposort(needed), bindings, satisfied, entrypoints}`.

Two consequences of "only `required`":

- **`required:false` edges are dropped from `plan_route` entirely.** The route algorithm never traverses them. This is load-bearing for referential create→mutate edges (`required:false`): `plan_route` does **not** try to sequence "create then mutate" as a graph-derived chain.
- **Multi-step lifecycle sequences are carried by the system prompt + reactive 409, not the graph.** The prompt's state machine + the `409 + allowed_actions` backstop define legal transitions; the graph's job is cross-cutting data-flow lineage (does this mutation have a resource id?), not re-deriving the state machine. State edges are recorded but the route algorithm ignores them — the reactive layer handles state transitions.

`data_satisfied(e, available)` checks that `available[e.binding.from_field]` contains a value matching the value bound for `e.binding.to_field` in the pending call (or, for a route *preview* without a concrete call, just "a value exists").

## The deterministic veto (`enforceGraphPreconditions`)

Inserted at the per-call chokepoint, **before** permission and `executeToolStep`. It mirrors the API's `409 + allowed_actions` reactive pattern, so the LLM recovers the same way.

Policy (the fail-open keystone — see `references/fail-open.md`):

- **Fail-open by default.** Hard-veto **only** on `verified:true && required:true` **data** edges where the lineage is *clearly* broken.
- **Unverified (AI-inferred) edges never hard-veto** — they only feed `plan_route`.
- **Extraction/parse failures → record `unknown`, allow** (never false-veto).

The check, per incoming edge of the called node:

- **data edges:** for each `consumes` where `c.required`, find the data edge into the node for `c.field`. If the edge is not `verified && required`, skip (can't judge). Best-effort extract the arg value; if absent, let the API 400 it. If the lineage does **not** contain the producer's value, **DENY** `{reason:"missing_precursor", field, expected_from, hint:"call plan_route or run {e.from} first"}`.
- **precondition edges:** for each `verified && required` incoming precondition, if `e.from` is not in `call_history`, **DENY** `{reason:"missing_precondition", required_first, hint:"run {e.from} before {node.id}"}`.
- Otherwise **ALLOW**.

The deny payload shape mirrors `409 + allowed_actions` deliberately — the LLM's existing recovery behavior (relay allowed actions, don't blind-retry) applies unchanged.

## `RunDataBindings` / `CallHistory` — runtime lineage, separate from `verified`

> **`verified` is developer sign-off; lineage is a runtime mechanism. Do not conflate them.** `verified` says "the edge is real"; lineage says "the edge fired this run." Both must hold to deny.

The deterministic layer depends on a runtime symbol table:

```
RunDataBindings: { field -> { step, value, json_path } }   # multi-valued; a field can have many producers
CallHistory:     [ op_id, ... ]                             # ordered, dedup-aware
```

Both live on `SessionContextProjection` — the **durable** per-session projection that already holds `ActiveToolNames`, `ActivePlan`, etc. Durability is mandatory: `client_http_request` (and named-toolset `execution:client`) suspends → the browser executes → resumes, and timeline reconnects happen; an in-memory-only table would be lost.

**Two satisfaction modes:**

- **data edge** → check `RunDataBindings` (was the value produced?).
- **precondition edge** → check `CallHistory` (did the precursor run?).

Both deterministic; both persisted.

**Population (post-execution):** in `executeToolStep`, immediately after `t.Execute` returns the `Result`, for each `produces` field of the node, best-effort `json_extract` the value from `Result.output.body`; if non-nil, add to `RunDataBindings`. Append the node id to `CallHistory`. Persist both. Extraction failure (non-JSON body, path miss) fails silently — the call still succeeded, and downstream stays fail-open. For `execution:client` tools, results arrive via `resume_data` (`__client_result`); the merged arguments hold `body` as a string, JSON-parsed per `produces.json_path`.

## Interaction with the plan system (no double-gate)

Avoid double-gating with `enforceApprovedPlan`:

- **At plan-proposal time:** if a graph is bound, validate the proposed `domain.Plan` against the graph — each consecutive step pair should respect data/precondition edges. Reject/warn graph-inconsistent plans before confirmation.
- **At call time with an approved plan:** enforce the plan (`enforceApprovedPlan`). The graph veto **still runs** — intentionally, not redundant. `ValidatePlan` checks plan *order* (did the plan list the precursor before the consumer?); the veto checks *runtime data lineage* (did the producer actually produce the value this run?). The latter catches cases the former can't (a hallucinated id even in an approved plan, or a producer that ran but didn't emit the expected field).
- **At call time with no approved plan (default `execute_direct` mode):** the graph veto is the fallback gate.

The graph acts at *propose-time validation* + *no-plan fallback gate*, never both on one call.

## Drift & degradation (robustness)

- `generated_by.spec_hash` is sealed with the graph. If the toolset's `Spec` is re-uploaded and the hash mismatches, the graph is flagged **stale**.
- Stale graph → runtime **warns** and degrades: `plan_route` returns `{degraded:true, hint}`; `enforceGraphPreconditions` returns ALLOW. The reactive `409 + allowed_actions` layer takes over.
- Missing graph / missing node → same graceful degradation. **The graph is an enhancement; it is never a hard dependency that can break the runtime.**

## Why veto-and-guide, not auto-inject

The hook system can only `Allow`/`Deny`/`Annotate` — it **cannot rewrite `tool.Call` or inject a precursor call**. Auto-injection would need a new interceptor beyond the hook engine. v1 deliberately uses veto-and-guide (the LLM re-plans from the structured deny), which is robust to runtime data changing the path (e.g. refund denied → back to prior status; a locked sequence would break, a veto-and-re-plan handles it).

## What the graph does NOT carry

- **State transitions** — the reactive `409 + allowed_actions` layer handles state machines, including `$prior` back-edges (refund denied → prior status). The graph records state edges but the route algorithm ignores them.
- **The resource lifecycle sequence** — carried by the system prompt's state machine + reactive 409, because the relevant edges are referential (`required:false`) and thus invisible to `plan_route`.
- **Cross-toolset data flow** — a non-goal for v1 (one graph per app; the envelope's `toolset` field names the toolset it describes).
