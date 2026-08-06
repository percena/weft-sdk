---
id: tkt-16
slug: budget-contract-doc-typecheck
title: budget contract honesty — fix contract.ts provider claim, re-export RunBudget, typecheck demo apps in CI
kind: bug
status: in_progress
priority: P2
covers: [F7, L2, L-typecheck]
spec: spc-10
adopted: true
blocked_by: []
parallel_group: null
github: percena/weft-sdk#25
---

# tkt-16 — budget contract doc + RunBudget re-export + demo typecheck

## Why

From the 2026-08-06 review pass:

- **F7 (Med):** `packages/runtime-core/src/contract.ts:276` claims the
  neutral fields (including `budget`) are "honored by every provider", while
  lines 264 and 293 of the same file correctly say only the Flitro driver
  honors `budget` and other providers may ignore it. The claude/codex
  providers have zero budget handling. This is exactly the
  budget/permission-class-field hazard the adjacent `maxBudgetUsd` warning
  describes: a host sets `budget` on a claude/codex session and gets no
  enforcement and no error.
- **L2 (Low):** `publish/browser/src/runtime-types.ts` re-exports
  `SendMessageOptions` and `PermissionMode` but not `RunBudget` — consumers
  must inline the shape to type a shared budget constant.
- **Typecheck gap (enabler for tkt-15):** root `pnpm run check` covers only
  `packages/*/src`; the agentic demo apps are never typechecked in CI, which
  is why a TS2353 in a demo can ship silently (vite build is
  transpile-only). 

## In

- `contract.ts:276`: change the blanket claim to "honored where supported"
  with `budget` explicitly called out as Flitro-driver-only (consistent with
  lines 264/293).
- Re-export `RunBudget` from the published entry points that already export
  `SendMessageOptions`.
- Add a CI step (or extend `pnpm run check`) that runs `tsc --noEmit` for
  `apps/itsm/agentic` and `apps/online-store/agentic`. Note: this will fail
  until tkt-15 step 4 lands (demos currently pin a version without
  `budget`); land the CI step together with tkt-15's demo bump, or gate it
  accordingly.

## Out

- Budget support in the claude/codex providers (future feature, not doc fix).
- Per-field budget merge semantics (whole-object replacement stays; it is
  documented).
- Release mechanics (tkt-15).

## Acceptance

- [ ] contract.ts no longer claims universal `budget` support
- [ ] `RunBudget` importable from the same entry point as `SendMessageOptions`
- [ ] CI fails on a type error in either agentic demo app
- [ ] `pnpm run check` + package tests green

## Ship

- Branch `tkt-16-budget-contract-doc-typecheck` (base `dev`), PR base `dev`.
- Coordinate the CI-typecheck landing with tkt-15's demo bump.
