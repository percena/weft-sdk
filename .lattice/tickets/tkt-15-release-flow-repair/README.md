---
id: tkt-15
slug: release-flow-repair
title: release-flow repair — reconcile stale changesets, cut an honest 1.0.5, then re-bump demo budgets
kind: bug
status: in_progress
priority: P1
covers: [F2, F3]
spec: spc-10
adopted: true
blocked_by: []
parallel_group: null
github: percena/weft-sdk#24
---

# tkt-15 — release-flow repair (changesets → 1.0.5 → demo re-bump)

## Why

Two coupled defects found in the 2026-08-06 review pass:

**A. The demo budget option is a silent no-op against published 1.0.4.**
`apps/itsm/agentic/src/ChatPane.tsx:36` and
`apps/online-store/agentic/src/ChatPane.tsx:40` pass
`budget: { maxWallTimeSec: 600, maxSteps: 32 }` to
`createFlitroEmbedRuntime`, and both demos pin registry `@percena/weft@^1.0.4`.
But 1.0.4 (released 2026-08-01, b20c26f) predates the budget-forwarding fix
1ae56ec (2026-08-02). Verified against the published 1.0.4 tarball:
`CreateFlitroEmbedRuntimeOptions` and `SendMessageOptions` have no `budget`
field (only the low-level `WeftApiClient.createRun` accepts one), so `tsc`
fails with TS2353 and vite's transpile-only build ships the demo anyway with
the option silently dropped. Anyone copying the demo as an integration
reference believes they've capped agent runs; nothing is sent. The demo bump
(0484219) landed before the release containing the feature it depends on.

**B. Pending-changeset state guarantees a dishonest next changelog.**
Release commit b20c26f hand-bumped 1.0.4 and hand-wrote the CHANGELOG while
*adding* `.changeset/weft-transport-errors.md` as still-pending (a real
`changeset version` consumes changesets). At HEAD both
`weft-transport-errors.md` (patch `@percena/weft`) and
`typed-flitro-errors.md` (patch `@percena/weft-node`) are pending, and
1ae56ec — the actual next-release payload — has no changeset at all. The next
release dispatch would open a version PR whose changelog repeats the shipped
1.0.4 notes verbatim and says nothing about budget forwarding.

## In

Strictly ordered:

1. Delete `.changeset/weft-transport-errors.md` (its content already shipped
   in 1.0.4's hand-written changelog). Audit
   `.changeset/typed-flitro-errors.md` the same way — delete if its content
   is already in a shipped `@percena/weft-node` changelog, keep if genuinely
   unreleased.
2. Add a changeset for 1ae56ec (budget forwarding through the Flitro
   runtime-driver + `budget` on `SendMessageOptions` /
   `CreateFlitroDriverOptions` / embed-runtime options). It adds public API:
   prefer **minor** (1.1.0) over patch.
3. Cut the release via the `release.yml` dispatch flow (version PR → merge →
   publish). Verify the published tarball's
   `CreateFlitroEmbedRuntimeOptions` actually has `budget` before step 4.
4. Only after the release is live: bump both agentic demos to the new
   version (`package.json` + lockfile) so their `budget` option typechecks
   and reaches the wire.

## Out

- CI typecheck for demo apps + `contract.ts` doc fix + `RunBudget` re-export
  (tkt-16 — independent, can land before the release).
- Re-adding a scheduled changeset workflow (dispatch-only is intentional).

## Acceptance

- [ ] `changeset status` shows exactly the changesets that are truly unreleased
- [ ] Release changelog for the new version describes budget forwarding and
  does not repeat 1.0.4 notes
- [ ] Published tarball types include `budget` on the embed-runtime options
- [ ] Demos pin the new version; `tsc` on `apps/itsm/agentic` and
  `apps/online-store/agentic` passes

## Ship

- Branch `tkt-15-release-flow-repair` (base `dev`), PR base `dev`.
- The demo-bump commit (step 4) must NOT merge before the npm release is
  published.
