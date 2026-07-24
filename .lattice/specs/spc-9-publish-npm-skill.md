---
id: spc-9
slug: publish-npm-skill
title: "/publish-npm skill for @percena/weft + weft-node local release"
kind: feat
status: locked
mode: M
priority: P2
summary: "Operator skill for local npm publish: next/latest channels, auto/exact/bump versions, dual packages, safe gates."
created: 2026-07-24
updated: 2026-07-24
tickets: [tkt-10]
prs: [pr-11]
reviews: []
supersedes: []
superseded_by: null
---

# Spec: /publish-npm skill for @percena/weft + weft-node local release

> **TL;DR:** Ship a weft-sdk project skill `/publish-npm` that codifies the established local release path for `@percena/weft` and `@percena/weft-node` (channels, version modes, provenance toggle, dual-package filters, post-publish commit without auto-push).
> **Kind:** feat · **Status:** locked · **Mode:** M · **Priority:** P2
> **Path:** spc-9 → tkt-10 → pr-11

## Why

Local `npm publish` is the established release path for this monorepo: `.github/workflows/release.yml` is `workflow_dispatch`-only and CI trusted-publishing is not the day-to-day path. Operators currently reassemble release steps from session memory — provenance toggle, prerelease suffix iteration (`X.Y.Z-next.N` not patch burn), tombstone avoidance, dual-package `--filter`, rebuild L0→L4 before pack, main-branch gate, apps dep align. Mis-steps have already shipped wrong versions (`1.0.2-next.0` instead of `1.0.1-next.1`) and hit unpublish tombstones. Encoding this as a Claude skill removes re-derivation and enforces the safe gates every run.

## In scope

- Project skill at `weft-sdk/.claude/skills/publish-npm/` (invokable as `/publish-npm` in this repo’s Claude sessions).
- Package selection: `@percena/weft` (`publish/browser`), `@percena/weft-node` (`publish/desktop`), or both — interactive each run (or args).
- **Channels (dist-tags):**
  - `next` — prerelease test builds (`--tag next`)
  - `latest` — stable releases (npm default tag)
- **Version modes:**
  - `auto` (default / 顺延): derive next version from registry + local package.json
    - on `next`: same target base, bump prerelease id → `X.Y.Z-next.(N+1)`; if no prerelease line yet for that base, start `X.Y.Z-next.0` (base = current local version if already prerelease, else next stable candidate)
    - on `latest`: bump from current stable `latest` by `patch` (default) unless operator chose minor/major
  - `exact`: operator supplies full semver (e.g. `1.0.2` or `1.0.2-next.3`); skill refuses if version already published or tombstoned when detectable
  - `bump`: explicit `patch|minor|major` relative to current `latest` (stable) or, for `next`, relative to the target base of the current next line
- Safe gates before any registry write:
  1. Branch must be `main` (or worktree whose base is main and operator explicitly confirms — default: refuse non-main)
  2. Working tree clean enough for a version commit (or operator confirms dirty publish)
  3. Full rebuild `build:L0`…`build:publish` from HEAD
  4. `pnpm check` / `pnpm validate` / `pnpm test` green (or explicit skip with reason)
  5. Provenance toggle: flip `publishConfig.provenance` true→false for local publish, restore after
  6. Dry-run pack inspect (`pnpm publish --dry-run --filter …`) before real publish
  7. `AskUserQuestion` confirm plan (packages, versions, tags) before real publish
- Publish command shape: `pnpm publish --filter <pkg> --tag <tag> --no-git-checks` (never bare `changeset publish` / `pnpm run release` which would publish both facades blindly).
- Post-publish (default on):
  - Keep bumped `publish/*/package.json` version
  - For stable `latest`: bump agentic apps that depend on the package (`apps/*/agentic` `@percena/weft` ranges; chat-playground pin for weft-node if in scope)
  - Update package CHANGELOG entry if one is maintained at the facade
  - `git commit` version + apps + changelog on current branch
  - **Do not** `git push` unless operator confirms in a second step
- Post-publish verify: `npm view <pkg> dist-tags` + `npm view <pkg>@<v> version`
- Document known gotchas in skill body/references: provenance sticky, next-suffix rule, tombstone, dual package independence, rebuild-before-pack, release-on-main

## Out of scope

- Enabling or rewriting CI `release.yml` automatic publish / OIDC trusted publishing
- Publishing internal `@weft/*` workspace packages
- Changeset-driven multi-package release orchestration as the primary path
- `npm unpublish` automation (may document manual recovery only)
- Cross-repo publish (weftd/flitro images, GHCR) — separate deploy skill
- Publishing from dirty ad-hoc feature branches without explicit override
- Signing / provenance generation from local laptop (not supported by npm 11 without OIDC)

## Acceptance

- [ ] **A1** Skill is installed for weft-sdk Claude sessions as `/publish-npm` (project skill path under `.claude/skills/publish-npm/SKILL.md` with frontmatter `name: publish-npm`).
- [ ] **A2** Supports channels `next` and `latest`, and version modes `auto` (default), `exact`, and `bump(patch|minor|major)`; auto on next never burns a new patch solely to iterate a test build.
- [ ] **A3** Package selection is interactive (weft / weft-node / both) or overridable by args; each package’s version line is independent.
- [ ] **A4** Pre-publish gates run in order: main-branch check → rebuild → validate/test (or explicit skip) → provenance toggle → dry-run → user confirm → real publish → restore provenance.
- [ ] **A5** Real publish uses `--filter` on the chosen facade(s) only; never `pnpm run release` / unfiltered changeset publish.
- [ ] **A6** On success: version files committed locally; agentic apps dep ranges aligned for stable releases; push only after separate confirm (default no push).
- [ ] **A7** Skill documents and enforces the known gotchas (provenance, next suffix, tombstone detect/skip, dual package, rebuild, main-only).
- [ ] **A8** Dry-run / plan mode available that prints the full action plan without registry write or provenance mutation that is left unrestored.

## Non-goals

- Becoming a general-purpose multi-repo npm publisher
- Replacing changesets for collaborative PR changelog collection (changesets remain optional for PR hygiene; this skill owns the actual local publish)

## Decisions (principal, user-confirmed)

1. **Skill location:** weft-sdk project skill (`.claude/skills/publish-npm`), not a percena-skills global skill.
2. **Package selection:** interactive each run — weft / weft-node / both (args may pre-fill).
3. **Version policy:** `channel` (`next`|`latest`) + version mode `auto|exact|bump`; **auto is default (顺延)**.
4. **Post-publish:** bump commit + apps align; **no automatic push** (second confirm required).

## Agent-assumed (secondary)

- Mode **M** (one skill delivery, multi-step but single PR-sized unless tickets split script vs docs).
- Skill may include a small `scripts/publish-npm.sh` helper for version resolve / provenance toggle / publish sequence; pure markdown runbook is acceptable if scripts stay thin.
- Default channel when user says only “publish test” → `next`; only “release” / “stable” → `latest`; ambiguous → ask.
- Default bump for stable auto → `patch`.
- `npm whoami` must succeed as a publish-capable user (currently `admin-percena`); fail closed if anonymous.
- Tombstone: if publish returns E400 “previously published” while `npm view` 404s, skill bumps or asks for a new exact version rather than waiting.
- Branch gate: worktree branches bound to a release ticket may publish only if `base` is main and operator confirms; default skill text still says “prefer main”.
- Provenance restore is best-effort in a shell `trap` so mid-failure does not leave `provenance: false` committed.
- Apps align targets (stable only): `apps/online-store/agentic`, `apps/itsm/agentic` for `@percena/weft`; `apps/chat-playground` pin for `@percena/weft-node` when that package is published.

## Risks / open questions

- npm tombstone detection is heuristic (E400 + view 404); false negatives possible.
- CI trusted-publishing path remains aspirational; skill must not require OIDC.
- Dual publish “both” with different version modes in one invocation is disallowed for v1 (same channel+mode applied per package independently with each package’s own auto math).
- Whether to auto-create a GitHub Release / tag is deferred (out of v1).

## References

- Memory: `npm-local-publish-provenance-friction`, `npm-prerelease-version-iteration`, `npm-publish-tombstone-blocks-republish`, `release-on-main-merge-first`, `work-on-main-no-temp-branches`
- Workflow: `.github/workflows/release.yml` (manual only)
- Facades: `publish/browser` (`@percena/weft`), `publish/desktop` (`@percena/weft-node`)
- Analog skill shape: `weftd/.claude/skills/deploy-weftd-flitro` (confirm-before-execute, dry-run, scripts/)

## Links / bloodline (L0)

- Tickets: `tkt-10` → https://github.com/percena/weft-sdk/issues/10
- PRs: `pr-11` → https://github.com/percena/weft-sdk/pull/11
- Reviews: (none)
- Primary issue: https://github.com/percena/weft-sdk/issues/9
