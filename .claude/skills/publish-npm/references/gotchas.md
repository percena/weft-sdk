# publish-npm gotchas

Battle-tested failure modes for local release of `@percena/weft` /
`@percena/weft-node`. The skill **must** encode these — do not re-discover.

## 1. Provenance is sticky on npm 11 — the key must stay ABSENT

- Neither facade manifest carries `publishConfig.provenance` anymore, **on
  purpose**: this local skill is the break-glass path and publishes **without
  attestations** — metadata must not promise provenance the tarballs don't
  carry. The canonical provenance-bearing path is the OIDC CI workflow
  (`.github/workflows/release.yml`), which enables provenance via publish
  flags, not the manifest.
- If `provenance: true` ever creeps back in, local `npm publish` hits:
  `EUSAGE / Automatic provenance generation not supported for provider: null`
- **`--no-provenance` does not override** `publishConfig.provenance: true`,
  and a `--dry-run` will **not** surface this — provenance is only attempted
  on real publish.
- **Fix:** remove the key (`provenance-toggle.mjs <pkg>/package.json clear`).
  Do **not** "restore" it to `true` afterward — "key absent" is the correct
  at-rest state.

## 2. Next channel iterates the prerelease suffix — never burns a patch

When iterating test builds under dist-tag `next`:

| Wrong | Right |
| --- | --- |
| `1.0.1-next.0` → `1.0.2-next.0` | `1.0.1-next.0` → `1.0.1-next.1` |

The patch/minor/major numbers are the **target stable**. `-next.N` is the
iteration track on that target. Only advance the base when promoting to
stable or intentionally retargeting.

## 3. Unpublish leaves a tombstone

Signature:

- `npm publish` → **E400** "Cannot publish over previously published version"
- `npm view <pkg>@<v>` → **404**

Do **not** wait for the tombstone to clear. Bump to a new version string
(e.g. planned `0.1.0` stable → ship `0.1.1`). Hit historically on
`@percena/weft-node@0.1.0`.

## 4. Dual package — always `--filter`, never blind `release`

- `pnpm run release` / `changeset publish` can publish **both** facades.
- Default path is explicit:
  `pnpm publish --filter @percena/weft …` and/or
  `pnpm publish --filter @percena/weft-node …`
- Version lines are **independent** (`weft` 1.x vs `weft-node` 0.1.x).
- **`exact` + `both` is refused** — one `--version` cannot apply to both lines.
  Publish each package with its own exact version.

## 4b. Dry-run must not stick version bumps or publish

- `--dry-run` (and the default no-confirm path) may temporarily write the
  planned version into `package.json` so pack metadata matches the plan, then
  **restores** prior versions on EXIT.
- `--dry-run` **always wins** over `--i-confirm-publish` — never real-publish
  when dry-run was requested.
- Only a successful real publish keeps the bumped version for the post-publish
  commit.

## 5. Rebuild L0→L4→publish from HEAD before pack

Workspace `dist/` lags source. Version bump commits without a full rebuild
can ship **stale** provider/runtime code under the new version. Always:

```bash
pnpm run build:L0 && pnpm run build:L1 && pnpm run build:L2 && \
pnpm run build:L3 && pnpm run build:L4 && pnpm run build:publish
```

`prepublishOnly` rebuilds the facade only — it does **not** rebuild internal
`@weft/*` layers.

## 6. Release commits belong on `main`

- CI builds `push: main`.
- Do not publish-and-commit a release only on `dev` or a random feature branch
  without an explicit operator override (`ALLOW_NON_MAIN=1` + confirm).
- Prefer: land code on `main` first, then run this skill on `main`.

## 7. Post-publish apps align is stable-only

- Agentic demos pin `@percena/weft` with `^X.Y.Z`. After a **latest** publish,
  bump those ranges and refresh the lockfile.
- Leave `workspace:*` deps alone (e.g. chat-playground → weft-node).
- `next` prereleases do **not** require apps range bumps.

## 8. No auto-push

Version commit is local. `git push` is a second, explicit confirm. Outward
actions stay gated.

## 9. Changesets are optional hygiene, not this skill's engine

`pnpm changeset` on PRs remains fine for changelog collection. This skill owns
the **local publish** sequence and does not require an open changeset to ship.
