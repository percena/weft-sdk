---
name: publish-npm
description: >
  Local npm publish for @percena/weft and/or @percena/weft-node: channels
  next|latest, version modes auto (default 顺延)|exact|bump, dual-package
  filter, provenance toggle, rebuild gates, dry-run, confirm-before-publish,
  post-publish version commit + apps align without auto-push. Use for
  /publish-npm, "publish next", "release latest", "bump npm", or shipping a
  test/stable facade version. Does NOT enable CI release.yml or publish
  internal @weft/* packages.
argument-hint: "[next|latest] [auto|exact=<ver>|patch|minor|major] [weft|weft-node|both] [--dry-run|--plan]"
---

# publish-npm

Local release path for the two **published** facades in this monorepo:

| Package | Path | Current role |
| --- | --- | --- |
| `@percena/weft` | `publish/browser` | Browser-safe SDK (`latest` / `next`) |
| `@percena/weft-node` | `publish/desktop` | Node/desktop SDK (`latest` / `next`) |

CI `.github/workflows/release.yml` is **workflow_dispatch-only**. Day-to-day
releases are **local** `pnpm publish --filter …` with a provenance workaround.
This skill encodes that path so operators do not re-derive gotchas from memory.

## When to use / When NOT

| Use | Not |
| --- | --- |
| Publish a **test** build to dist-tag `next` | Publish internal `@weft/*` workspace packages |
| Publish a **stable** build to `latest` | Auto-enable OIDC / rewrite `release.yml` |
| Exact version or patch/minor/major bump | `npm unpublish` automation (manual only) |
| Plan/dry-run the release without writing registry | GHCR / weftd image deploys → `deploy-weftd-flitro` |

## Inputs (args or AskUserQuestion)

| Input | Values | Default |
| --- | --- | --- |
| `CHANNEL` | `next` \| `latest` | ask; "test/next" → `next`; "release/stable" → `latest` |
| `VERSION_MODE` | `auto` \| `exact` \| `bump` | **`auto`** (顺延) |
| `VERSION` | full semver | required when `VERSION_MODE=exact` |
| `BUMP` | `patch` \| `minor` \| `major` | `patch` when mode is `bump` or stable `auto` |
| `PACKAGES` | `weft` \| `weft-node` \| `both` | **ask** each run |
| `DRY_RUN` / `--plan` | `1` | `0` — plan only, no registry write |
| `SKIP_TESTS` | `1` | `0` — require explicit reason if set |
| `SKIP_PUSH_CONFIRM` | — | push is **never** default; second confirm only |
| `ALLOW_NON_MAIN` | `1` | `0` — refuse non-`main` unless set + confirmed |

Parse free-form user text first (`next`, `latest`, `1.0.2`, `1.0.2-next.3`,
`patch`, `weft-node`, `dry-run`). Fill gaps with one `AskUserQuestion` batch.

## Version policy (canonical)

Full tables: `references/version-policy.md`. Summary:

### Channel `next` (prerelease / test)

- dist-tag: `--tag next`
- **auto (default):** do **not** burn a new patch just to iterate.
  - If registry `next` is `X.Y.Z-next.N` → publish `X.Y.Z-next.(N+1)`
  - Else if local version is `X.Y.Z-next.N` → `X.Y.Z-next.(N+1)`
  - Else start `X.Y.Z-next.0` where `X.Y.Z` is the **target** stable
    (usually current local version if stable, or the base of an existing line)
- **exact:** use operator semver; must include prerelease id for next channel
  unless operator explicitly wants a non-prerelease on `next` (discouraged — warn)
- **bump:** recompute target base with patch|minor|major from current `latest`,
  then publish `<base>-next.0`

### Channel `latest` (stable)

- dist-tag: default (`latest`) — do **not** pass `--tag latest` unless you
  need to move the tag onto an already-published version (out of v1)
- **auto:** `latest + patch` (or `BUMP` if set)
- **exact:** operator semver (no prerelease preferred)
- **bump:** explicit patch|minor|major from registry `latest`

### Dual package

`weft` and `weft-node` have **independent** version lines (e.g. `1.0.1` vs
`0.1.1`). When `PACKAGES=both`, apply the **same channel + mode** but run
auto-math **per package**. Do not force them onto one version string.

## Hard gates (order is fixed)

1. **cwd** = weft-sdk repo root (or worktree root with workspace `package.json`).
2. **Auth:** `npm whoami` succeeds (expect publish-capable user, e.g. `admin-percena`).
3. **Branch:** `git branch --show-current` is `main`, **or** `ALLOW_NON_MAIN=1`
   after operator confirm. Release commits belong on main
   (`release-on-main-merge-first`).
4. **Plan resolve:** for each selected package, compute `{name, path, from, to, tag}`
   via `scripts/resolve-version.sh` (or inline equivalent). Print the plan table.
5. **Tombstone / exists check:** `npm view <name>@<to> version` → if present, refuse
   and ask for a new exact version. If publish later returns E400 "previously
   published" while view 404s → tombstone; bump or re-ask (do not wait).
6. **Rebuild from HEAD** (always before pack):
   ```bash
   pnpm run build:L0 && pnpm run build:L1 && pnpm run build:L2 && \
   pnpm run build:L3 && pnpm run build:L4 && pnpm run build:publish
   ```
7. **Validate** (unless `SKIP_TESTS=1` + reason):
   ```bash
   pnpm run check && pnpm run validate && pnpm run test
   ```
8. **Provenance toggle** (local npm 11 cannot mint OIDC provenance):
   - For each package path: set `publishConfig.provenance` `true` → `false`
   - Use a shell `trap` to **restore `true`** on EXIT (success or fail)
   - Source stays aspirationally `true` for future CI trusted publishing
9. **Dry-run pack** per package:
   ```bash
   pnpm publish --filter <name> --dry-run --no-git-checks [--tag next]
   ```
10. **Confirm** via `AskUserQuestion`: packages, from→to, tag, dry-run result OK?
11. **Real publish** (only after confirm; skip if `DRY_RUN=1`):
    ```bash
    # next:
    pnpm publish --filter <name> --tag next --no-git-checks
    # latest:
    pnpm publish --filter <name> --no-git-checks
    ```
    **Never** `pnpm run release` / `changeset publish` as the default — those
    can publish both facades without the interactive matrix.
12. **Restore provenance** (trap + explicit verify `jq`/node read-back).
13. **Verify registry:**
    ```bash
    npm view <name> dist-tags --json
    npm view <name>@<to> version
    ```

## Version file write

Before publish (after plan confirm, before or as part of pack):

1. Write `version` in `publish/browser/package.json` and/or `publish/desktop/package.json`.
2. Optionally prepend a short section to that package's `CHANGELOG.md`.
3. Do **not** commit yet — commit is post-publish only if registry write succeeded.

Helper: `scripts/set-version.mjs <package-json> <version>`.

## Post-publish (default on; still no push)

On **successful** registry write:

1. **Apps align (stable `latest` only):**
   - `@percena/weft` → bump range in `apps/online-store/agentic/package.json` and
     `apps/itsm/agentic/package.json` to `^<stable>` when they depend on it.
   - `@percena/weft-node` → if `apps/chat-playground/package.json` uses a
     **registry pin** (not `workspace:*`), bump to the new stable; leave
     `workspace:*` alone.
   - `pnpm install` to refresh lockfile when apps changed.
2. **Git commit** (local only):
   ```bash
   git add publish/browser/package.json publish/desktop/package.json \
           publish/*/CHANGELOG.md apps/**/package.json pnpm-lock.yaml
   git commit -m "chore(release): <name>@<ver>[, …] (<channel>)"
   ```
3. **Push:** ask separately — default **no**. Only `git push origin main` (or
   the release branch) after explicit yes.

## Plan / dry-run mode

`--plan` or `DRY_RUN=1`:

- Resolve versions, print plan table, optionally rebuild + dry-run pack
- **Must not** leave `provenance: false` on disk (toggle only inside a
  subshell/trap around dry-run if dry-run needs it; prefer dry-run without
  mutating when possible — note: `pnpm publish --dry-run` does not need
  provenance off; only real publish does)
- **Must not** `npm publish` for real, **must not** commit/push

## Operator flow (checklist)

```text
1. Parse args / AskUserQuestion (channel, mode, packages)
2. scripts/resolve-version.sh → plan table
3. Gate: whoami, branch, exists/tombstone
4. AskUserQuestion confirm plan
5. Rebuild L0→publish; check/validate/test
6. If DRY_RUN: dry-run publish; stop with plan report
7. Provenance false (trap restore)
8. pnpm publish --filter … [--tag next] --no-git-checks
9. Restore provenance; npm view verify
10. Apps align (latest); git commit; ask push
```

Prefer running the scripted path:

```bash
SKILL_ROOT="$(git rev-parse --show-toplevel)/.claude/skills/publish-npm"
bash "$SKILL_ROOT/scripts/publish-npm.sh" \
  --channel next \
  --mode auto \
  --packages weft \
  --dry-run
```

The agent still owns: `AskUserQuestion` confirms, interpreting user free-form
intent, and deciding whether to push.

## Gotchas (must read)

See `references/gotchas.md` — provenance sticky on npm 11, next-suffix rule,
tombstones, dual-package filter, rebuild-before-pack, main-only releases,
changeset publish footgun.

## Failure playbook

| Symptom | Action |
| --- | --- |
| `EUSAGE` provenance / provider null | Provenance still true — re-toggle false; ensure trap restore after |
| `E400` cannot publish over + view 404 | Tombstone — choose new version, do not wait |
| `E403` / need auth | `npm login` / check `npm whoami` |
| Tests red | Fix or `SKIP_TESTS=1` with written reason (operator-only) |
| Wrong next version published | Within 72h: manual `npm unpublish <pkg>@<bad>` then republish correct; prefer not to unpublish stables |
| Accidentally ran `pnpm run release` | Stop; check npm for unintended weft-node publish; fix dist-tags if needed |

## Related

- Spec: `.lattice/specs/spc-9-publish-npm-skill.md`
- Workflow (manual CI path): `.github/workflows/release.yml`
- Facades: `publish/browser`, `publish/desktop`
