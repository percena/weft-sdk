# Fail-open dependency graphs

> **See also:** [`security-contract.md`](./security-contract.md) Tier 3 — the reactive `409 + allowed_actions` backstop is the SOLE enforcement of the state machine once the DAG fails open (this keystone is *why* the backstop is mandatory).

## Why fail-open

The API dependency graph (DAG) is a **routing and ordering hint**, not a security control. A wrong graph must degrade gracefully — weaker `plan_route` suggestions — never block a legitimate call.

Hard-veto only on edges that are:

- `verified:true` (human sign-off), **and**
- `required:true` (true generative prerequisite), **and**
- clearly broken lineage in the current run

Everything else **fails open** (ALLOW).

## Produce vs reference

This is the classification the reviewer applies to decide `required`. A consumed field is either:

- **Generative** — `from` *creates* the value (e.g. `createResource` produces a fresh resource `id`). Operating on *that new instance* may justify `required:true`, because there is no other source for the freshly-minted id.
- **Referential** — `to` operates on a *pre-existing* resource whose id can come from many sources (`listResources`, a prior session, a user saying a concrete id). These edges **must be `required:false`**.

The test the reviewer applies, per-edge: *"is the consumed value freshly produced by `from`, or a reference to a pre-existing resource? If the latter → `required:false`."*

### Why referential edges MUST be `required:false`

If a referential edge is marked `required:true`, the veto treats "operate on resource X" as if X *must* have been created by `createResource` **in the current session's data lineage**. An id that the user supplied directly, that came from a list call, or that originated in a *prior* session is **not** in the current run's lineage — so a `required:true` referential edge hard-denies every legitimate cross-session or user-supplied reference. The agent, blocked from the resource it was asked to operate on, "solves" the veto by minting a duplicate.

Under analyzer v2 the draft already defaults every inferred data edge to `required:false` (fail-open default), so the demotion is the default — the reviewer opts *into* `required:true` with evidence, never the reverse.

## Canonical regression (case study)

Cause → symptom → fix:

- **Cause:** the analyzer marked every `createResource → {mutate, …}` edge `required:true`. These are *referential* edges (mutations operate on a pre-existing id that can come from many sources), but they were treated as generative prerequisites.
- **Symptom:** the veto hard-denied operating on any resource not created in the current session. Asked to operate on a known id across a session boundary, the agent was blocked and minted a duplicate so that `createResource` would populate the lineage.
- **Fix:** set `required:false`, keep `verified:true`. The edge stays in the graph (it still informs review and the truth-table), but it is dropped from `plan_route` and is no longer a hard-veto surface. Cross-session reference is permitted; the reactive `409 + allowed_actions` layer backstops genuinely illegal operations.

This is why the cross-session reference test (create a resource in session A; in a *fresh* session — empty data lineage — operate on it by id) is the fail-open regression test: if a duplicate appears, a referential edge is still `required:true`.

## The veto truth-table

| Situation | Action |
|---|---|
| No graph bound / node not in graph / graph stale | ALLOW (degrade to reactive) |
| Edge `verified:false` (AI-inferred, unconfirmed) | ALLOW (edge only informs `plan_route`) |
| Edge `verified:true` but `required:false` | ALLOW (optional enrichment) |
| `produces` extraction failed / field not found | ALLOW (record `unknown`, never false-veto) |
| `verified:true && required:true` data edge, value clearly never produced | **DENY** with structured hint |
| `verified:true && required:true` precondition edge, precursor not called | **DENY** with structured hint |

The deny payload should mirror your API's `409 + allowed_actions` so the LLM's recovery behavior (relay allowed actions, don't blind-retry) applies unchanged.

## v1 lineage limitation (why user-supplied values aren't in the table)

The veto requires consumed values to be present in the session's data lineage — i.e. produced by a tracked graph producer *in this run*. A value the user supplies directly, or that came from a non-graph tool / a prior session, is NOT in the lineage. With a `required:true` edge that would be a false veto; with the fail-open default (`required:false` for referential edges) it is simply not a veto surface, and the reactive `409`/`404` layer backstops the rare user-supplied case.

## The layered safety guarantee

You cannot "guarantee correctness" of an AI/heuristic-generated DAG — you **guarantee safety**. The layers, in order:

- **Layer 0** — derive deterministically from the spec (parameters/response schemas); minimize AI-inferred edges.
- **Layer 1** — schema-aware inference: array-item unrolling surfaces list→item id sources; a path-based resource tag + same-resource guard excludes cross-resource false edges.
- **Layer 2** — fail-open default: inferred data edges default `required:false`; the reviewer opts into `required:true` with evidence. An entrypoint corollary keeps entrypoints = read ops with no required consume fields.
- **Layer 3** — cross-validate with runtime traces (spec `examples`, recorded call logs, integration/e2e tests); promote/demote `required` by observed success.
- **Layer 4** — human-review only edges that will hard-enforce (`verified:true && required:true`): a scarce, evidence-backed set.
- **Layer 5** — fail-open + reactive `409`/`allowed_actions` backstop is the invariant that makes a wrong DAG non-blocking.

**The `409 + allowed_actions` backstop is MANDATORY, not optional.** Because the DAG fails open by design, the reactive state-machine `409` is the SOLE enforcement of legal transitions. Your classic app's inline state module may LACK this backstop — you MUST return `409 {error, allowed_actions:[…]}` on an illegal transition. Without it the agent is fully un-enforced: out-of-order calls and illegal state transitions go through unchecked. (A wrong DAG then costs weaker routing hints; a missing 409 costs real enforcement.)

A wrong DAG costs weaker routing hints, not blocked calls — as long as `required:true` stays scarce and reviewed. That invariant is what makes the whole feature safe to ship.
