---
id: spc-10
slug: budget-release-completion
title: Complete the budget-forwarding release — honest changelog, minor release, demos actually send budgets
kind: fix
status: in_progress
mode: M
priority: P1
summary: "Finish shipping run-budget support end to end: reconcile the stale changeset state (tkt-15 part 1, PR #26), fix the budget contract docs + RunBudget re-export + demo typecheck (tkt-16, PR #27), cut the minor release via the release.yml dispatch flow, verify the published tarball exposes budget on the embed-runtime options, then re-bump both agentic demos and flip check:demos to blocking. Until the release lands, the demos' budget option is a silent no-op against the pinned 1.0.4."
created: 2026-08-06
updated: 2026-08-06
tickets: [tkt-15, tkt-16]
prs: [pr-26, pr-27]
reviews: []
supersedes: []
superseded_by: null
---

# Spec: complete the budget-forwarding release

> **TL;DR:** Budget forwarding (1ae56ec) is merged on dev but unreleased; the
> agentic demos pin registry `^1.0.4`, whose types have no `budget` on
> `CreateFlitroEmbedRuntimeOptions` — their budget option typechecks red
> (TS2353) and is dropped at runtime. The changeset state was also wedged
> (stale shipped entries pending, the real payload uncovered). This spec
> tracks the full sequence to an honest release and demos that really send
> budgets.

## Why

Found in the 2026-08-06 review pass. Two coupled defects:

1. **Demo budget no-op:** `apps/itsm/agentic` and `apps/online-store/agentic`
   pass `budget: { maxWallTimeSec: 600, maxSteps: 32 }` while pinning
   `@percena/weft@^1.0.4` (released 2026-08-01, one day before the budget
   feature merged). Verified against the published tarball. vite's
   transpile-only build ships the TS2353 silently; CI never typechecks the
   demo apps.
2. **Wedged changesets:** the hand-rolled 1.0.4 release left already-shipped
   changesets pending and the budget feature without one — the next version
   PR would have repeated 1.0.4's notes and omitted the real payload.

## Plan (strict order)

1. **tkt-15 part 1 (PR #26):** delete the shipped changeset, keep the
   genuinely-unreleased `@percena/weft-node` one, add a **minor**
   `@percena/weft` changeset for budget forwarding. ✔ implemented
2. **tkt-16 (PR #27):** contract.ts "honored where supported" fix,
   `RunBudget` re-export from both publish entry types, `check:demos` CI
   step (non-blocking until step 4). ✔ implemented
3. **Release:** merge #26 + #27 → dispatch `release.yml` → merge the
   changesets version PR (expect `@percena/weft` 1.1.0 minor +
   `@percena/weft-node` patch) → dispatch again to publish → verify the
   published tarball's `CreateFlitroEmbedRuntimeOptions` includes `budget`.
4. **tkt-15 part 2:** bump both agentic demos to the released version,
   refresh the lockfile, remove `continue-on-error` from the `check:demos`
   CI step (flip to blocking), verify `check:demos` passes.

## Acceptance

- [ ] npm `latest` of `@percena/weft` exposes `budget` on
  `CreateFlitroEmbedRuntimeOptions` / `SendMessageOptions` (tarball check)
- [ ] Release changelog describes budget forwarding; no repeated 1.0.4 notes
- [ ] `changeset status` empty after the release
- [ ] Demos pin the released version; `pnpm run check:demos` green and
  blocking in CI
