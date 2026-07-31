---
id: tkt-14
slug: wefttimeout-runtime-note
title: document WeftTimeoutError runtime requirement (rev-20260731)
kind: docs
status: in_progress
priority: P3
covers: [F12, F11, F15]
spec: none
adopted: true
blocked_by: []
parallel_group: null
---

# tkt-14 — WeftTimeoutError runtime-requirement doc note

## Why

Independent re-review `rev-20260731-152730Z` (weftd `.lattice/reviews/`) of the
2026-07-31 remediation commit `d35f83d` found no confirmed bugs in weft-sdk. One
Low-severity doc gap: the observable-contract doc claims an aborted request
rejects with `error.name === 'WeftTimeoutError'`, but that name depends on the
runtime surfacing `controller.signal.reason` (not a bare `AbortError` DOMException).

## In

- **F12 (doc):** `http-client.ts` transport-error doc block — added a runtime-
  requirement note: the stable `WeftTimeoutError` name holds on Node >= 18.17 and
  modern browsers (Chrome 103+ / FF 103+ / Safari 16+); on older runtimes the
  abort may surface as `error.name === 'AbortError'`. The timeout still fires on
  every runtime; only the error's `name` is environment-dependent. The SDK targets
  Node >= 18 / React 19 peers, so this is out of scope in practice — documented
  for integrators on edge runtimes.

## Out

- F11 (timeout now applies during body read) — intentional fix; inform-only.
- F15 (provenance-toggle.mjs clear throws if publishConfig absent) — not
  reachable; inform-only.

## Acceptance

- [F12] runtime-requirement note added to the transport-error doc block
- [x] `pnpm build` clean; http-client test (11/11) green

## Workspace

- repo: percena/weft-sdk
- branch: tkt-14-wefttimeout-runtime-note (base dev @ d35f83d)
- worktree: /Users/mxue/GitRepos/MVP/weft-sdk.worktrees/tkt-14-wefttimeout-runtime-note

## Ship

one-PR (Fixes #14). Lineage: rev-20260731-152730Z. Prior commit: d35f83d.
