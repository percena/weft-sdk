# Version policy

## Package matrix

| Key | npm name | package.json path |
| --- | --- | --- |
| `weft` | `@percena/weft` | `publish/browser/package.json` |
| `weft-node` | `@percena/weft-node` | `publish/desktop/package.json` |

## Resolve algorithm (`auto`)

Inputs per package: registry dist-tags, registry versions list, local
`package.json` version, `CHANNEL`, optional `BUMP` (default `patch`).

### Helpers

- `latest_tag` = `npm view <name> dist-tags.latest` (empty if never published)
- `next_tag` = `npm view <name> dist-tags.next` (may be empty)
- `local` = version field in package.json
- `semver` tools: Node `semver` package if available, else small bash/node helper in `scripts/`

### CHANNEL=next

1. If `VERSION_MODE=bump`: first set base =
   `semver.inc(latest_tag || local_stable, BUMP)`, then **to** = `${base}-next.0`
2. Else if `next_tag` (or local) matches `^(.*)-next\.([0-9]+)$`:
   - base = group1, n = group2
   - If base **lags** registry `latest` (major/minor/patch all ≤ and at least one <):
     **retarget** → **to** = `${latest}-next.0` (stale prerelease line)
   - Else: **to** = `${base}-next.$((n+1))`
3. Else:
   - base = stable(`local`) or `latest_tag` or `0.1.0`
   - **to** = `${base}-next.0`
4. `ensureFree`: if **to** already published, walk `-next.(N+1)` until free.

### CHANNEL=latest

1. base_src = `latest_tag` if set, else strip prerelease from `local`, else `local`
2. **to** = `semver.inc(base_src, BUMP)` with `BUMP` default `patch`
3. Refuse if **to** has a prerelease component (stable channel)

### exact

- **to** = operator `VERSION` (must be valid semver)
- Still run exists/tombstone checks
- Warn if CHANNEL=next and version has no prerelease
- Warn if CHANNEL=latest and version has prerelease

## Exists / tombstone preflight

```bash
if npm view "${name}@${to}" version >/dev/null 2>&1; then
  # already published — refuse
fi
```

On publish E400 + view 404 → treat as tombstone; re-resolve with N+1 or ask.

## Examples (`@percena/weft`)

| Registry latest | Registry next | Mode | Channel | Result |
| --- | --- | --- | --- | --- |
| 1.0.1 | 1.0.1-next.1 | auto | next | 1.0.1-next.2 |
| 1.0.1 | 1.0.1-next.1 | auto | latest | 1.0.2 |
| 1.0.1 | 1.0.1-next.1 | bump=minor | latest | 1.1.0 |
| 1.0.1 | 1.0.1-next.1 | bump=minor | next | 1.1.0-next.0 |
| 1.0.1 | (none) | auto | next | 1.0.1-next.0 |
| 1.0.1 | 1.0.1-next.1 | exact=1.0.2 | latest | 1.0.2 |
| weft-node 0.1.1 | 0.1.0-next.0 | auto | next | 0.1.1-next.0 (retarget; next lagged latest) |

## Independent lines

Never copy weft's version onto weft-node (or vice versa) under `auto`.
`both` means "run the matrix twice".
