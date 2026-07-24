#!/usr/bin/env bash
# publish-npm.sh — scripted core for .claude/skills/publish-npm
#
# Resolves versions, optionally rebuilds, toggles provenance, dry-runs or
# publishes with --filter, restores provenance, verifies dist-tags.
#
# The agent still owns AskUserQuestion confirms and git push decisions.
# This script REFUSES real publish unless --i-confirm-publish is passed
# (after the agent got an explicit operator yes).
#
# Usage examples:
#   bash scripts/publish-npm.sh --channel next --mode auto --packages weft --plan
#   bash scripts/publish-npm.sh --channel next --mode auto --packages weft --dry-run
#   bash scripts/publish-npm.sh --channel latest --mode bump --bump patch \
#        --packages both --i-confirm-publish
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "${ROOT}" || ! -f "$ROOT/package.json" ]]; then
  echo "publish-npm: must run inside weft-sdk git repo" >&2
  exit 2
fi
cd "$ROOT"

CHANNEL="next"
MODE="auto"
BUMP="patch"
EXACT_VERSION=""
PACKAGES=""
PLAN=0
DRY_RUN=0
CONFIRM_PUBLISH=0
SKIP_TESTS=0
SKIP_REBUILD=0
ALLOW_NON_MAIN=0
DO_APPS_ALIGN=1
DO_SET_VERSION=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --channel) CHANNEL="${2:-}"; shift 2 ;;
    --mode) MODE="${2:-}"; shift 2 ;;
    --bump) BUMP="${2:-}"; shift 2 ;;
    --version) EXACT_VERSION="${2:-}"; shift 2 ;;
    --packages) PACKAGES="${2:-}"; shift 2 ;;
    --plan) PLAN=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --i-confirm-publish) CONFIRM_PUBLISH=1; shift ;;
    --skip-tests) SKIP_TESTS=1; shift ;;
    --skip-rebuild) SKIP_REBUILD=1; shift ;;
    --allow-non-main) ALLOW_NON_MAIN=1; shift ;;
    --no-apps-align) DO_APPS_ALIGN=0; shift ;;
    --no-set-version) DO_SET_VERSION=0; shift ;;
    -h|--help)
      sed -n '1,40p' "$0"
      exit 0
      ;;
    *)
      echo "publish-npm: unknown arg: $1" >&2
      exit 2
      ;;
  esac
done

if [[ -z "$PACKAGES" ]]; then
  echo "publish-npm: --packages weft|weft-node|both is required" >&2
  exit 2
fi
if [[ "$CHANNEL" != "next" && "$CHANNEL" != "latest" ]]; then
  echo "publish-npm: --channel must be next|latest" >&2
  exit 2
fi
if [[ "$MODE" != "auto" && "$MODE" != "exact" && "$MODE" != "bump" ]]; then
  echo "publish-npm: --mode must be auto|exact|bump" >&2
  exit 2
fi
if [[ "$MODE" == "exact" && -z "$EXACT_VERSION" ]]; then
  echo "publish-npm: --version required with --mode exact" >&2
  exit 2
fi
# Independent version lines — a single --version cannot safely apply to both.
if [[ "$MODE" == "exact" && "$PACKAGES" == "both" ]]; then
  echo "publish-npm: refuse --mode exact with --packages both (version lines are independent)." >&2
  echo "  Run twice with --packages weft and --packages weft-node, each with its own --version." >&2
  exit 2
fi
# --dry-run is a hard no-registry-write. Confirm never overrides it.
if [[ "$DRY_RUN" -eq 1 && "$CONFIRM_PUBLISH" -eq 1 ]]; then
  echo "publish-npm: WARN --dry-run wins over --i-confirm-publish (no real publish)"
  CONFIRM_PUBLISH=0
fi

pkg_keys=()
case "$PACKAGES" in
  weft) pkg_keys=(weft) ;;
  weft-node) pkg_keys=(weft-node) ;;
  both) pkg_keys=(weft weft-node) ;;
  *)
    echo "publish-npm: --packages must be weft|weft-node|both" >&2
    exit 2
    ;;
esac

pkg_name() {
  case "$1" in
    weft) echo "@percena/weft" ;;
    weft-node) echo "@percena/weft-node" ;;
  esac
}
pkg_dir() {
  case "$1" in
    weft) echo "publish/browser" ;;
    weft-node) echo "publish/desktop" ;;
  esac
}

echo "== publish-npm preflight =="
echo "root:    $ROOT"
echo "channel: $CHANNEL"
echo "mode:    $MODE"
echo "bump:    $BUMP"
echo "packages:$PACKAGES"
echo "plan:    $PLAN  dry_run: $DRY_RUN  confirm: $CONFIRM_PUBLISH"

# Auth
if ! WHOAMI=$(npm whoami 2>/dev/null); then
  echo "publish-npm: npm whoami failed — login first (npm login)" >&2
  exit 1
fi
echo "npm user: $WHOAMI"

# Branch gate (soft on --plan; hard otherwise)
BRANCH=$(git branch --show-current)
echo "branch:  $BRANCH"
if [[ "$BRANCH" != "main" && "$ALLOW_NON_MAIN" -ne 1 ]]; then
  if [[ "$PLAN" -eq 1 ]]; then
    echo "publish-npm: WARN non-main branch '$BRANCH' (plan only; real publish needs main or --allow-non-main)"
  else
    echo "publish-npm: refuse non-main branch '$BRANCH' (pass --allow-non-main after operator confirm)" >&2
    exit 1
  fi
fi

# Resolve versions
declare -a PLAN_LINES=()
declare -a RESOLVED_JSON=()
for key in "${pkg_keys[@]}"; do
  name=$(pkg_name "$key")
  dir=$(pkg_dir "$key")
  args=(node "$SCRIPT_DIR/resolve-version.mjs" --name "$name" --path "$dir" --channel "$CHANNEL" --mode "$MODE" --bump "$BUMP")
  if [[ "$MODE" == "exact" ]]; then
    args+=(--version "$EXACT_VERSION")
  fi
  json=$("${args[@]}")
  RESOLVED_JSON+=("$json")
  to=$(node -e 'const j=JSON.parse(process.argv[1]); process.stdout.write(j.to)' "$json")
  from=$(node -e 'const j=JSON.parse(process.argv[1]); process.stdout.write(j.fromLocal)' "$json")
  exists=$(node -e 'const j=JSON.parse(process.argv[1]); process.stdout.write(String(j.exists))' "$json")
  tag=$(node -e 'const j=JSON.parse(process.argv[1]); process.stdout.write(j.tag)' "$json")
  line="$key  $name  $from → $to  tag=$tag  exists=$exists"
  PLAN_LINES+=("$line")
  echo "plan: $line"
  if [[ "$exists" == "true" ]]; then
    echo "publish-npm: $name@$to already on registry — refuse (pick exact or wait for auto next)" >&2
    exit 3
  fi
done

if [[ "$PLAN" -eq 1 ]]; then
  echo "== plan only (no rebuild, no publish) =="
  printf '%s\n' "${PLAN_LINES[@]}"
  exit 0
fi

# Rebuild
if [[ "$SKIP_REBUILD" -ne 1 ]]; then
  echo "== rebuild L0→L4→publish =="
  pnpm run build:L0
  pnpm run build:L1
  pnpm run build:L2
  pnpm run build:L3
  pnpm run build:L4
  pnpm run build:publish
else
  echo "== skip rebuild (operator) =="
fi

if [[ "$SKIP_TESTS" -ne 1 ]]; then
  echo "== check / validate / test =="
  pnpm run check
  pnpm run validate
  pnpm run test
else
  echo "== skip tests (operator) =="
fi

# Version + provenance restore. Versions are restored on any path that does
# NOT successfully complete a real publish (dry-run, plan-adjacent exits,
# publish failure). Provenance always restores to true.
VERSIONS_MUTATED=0
PUBLISH_SUCCEEDED=0
PROVENANCE_RESTORED=0
VERSIONS_RESTORED=0

restore_versions() {
  if [[ "$VERSIONS_MUTATED" -ne 1 || "$VERSIONS_RESTORED" -eq 1 ]]; then
    return 0
  fi
  # Keep bumped versions only after a successful real publish.
  if [[ "$PUBLISH_SUCCEEDED" -eq 1 ]]; then
    VERSIONS_RESTORED=1
    return 0
  fi
  VERSIONS_RESTORED=1
  for json in "${RESOLVED_JSON[@]}"; do
    path=$(node -e 'const j=JSON.parse(process.argv[1]); process.stdout.write(j.path)' "$json")
    from=$(node -e 'const j=JSON.parse(process.argv[1]); process.stdout.write(j.fromLocal)' "$json")
    node "$SCRIPT_DIR/set-version.mjs" "$path" "$from" >/dev/null || true
  done
  echo "publish-npm: package versions restored to pre-run values"
}

restore_provenance() {
  if [[ "$PROVENANCE_RESTORED" -eq 1 ]]; then
    return 0
  fi
  PROVENANCE_RESTORED=1
  for key in "${pkg_keys[@]}"; do
    dir=$(pkg_dir "$key")
    node "$SCRIPT_DIR/provenance-toggle.mjs" "$dir/package.json" true >/dev/null || true
  done
  echo "publish-npm: provenance restored to true"
}

cleanup_on_exit() {
  restore_versions
  restore_provenance
}
trap cleanup_on_exit EXIT

# Temporarily set planned versions so dry-run / real pack reflect the target.
# Restored on EXIT unless real publish succeeds (see restore_versions).
if [[ "$DO_SET_VERSION" -eq 1 ]]; then
  for json in "${RESOLVED_JSON[@]}"; do
    path=$(node -e 'const j=JSON.parse(process.argv[1]); process.stdout.write(j.path)' "$json")
    to=$(node -e 'const j=JSON.parse(process.argv[1]); process.stdout.write(j.to)' "$json")
    node "$SCRIPT_DIR/set-version.mjs" "$path" "$to"
  done
  VERSIONS_MUTATED=1
fi

# Dry-run does not need provenance off; real publish does.
# --dry-run always stops here (CONFIRM cannot override).
if [[ "$DRY_RUN" -eq 1 || "$CONFIRM_PUBLISH" -ne 1 ]]; then
  echo "== dry-run publish =="
  for json in "${RESOLVED_JSON[@]}"; do
    name=$(node -e 'const j=JSON.parse(process.argv[1]); process.stdout.write(j.name)' "$json")
    tag=$(node -e 'const j=JSON.parse(process.argv[1]); process.stdout.write(j.tag)' "$json")
    if [[ "$tag" == "next" ]]; then
      pnpm publish --filter "$name" --tag next --dry-run --no-git-checks
    else
      pnpm publish --filter "$name" --dry-run --no-git-checks
    fi
  done
  echo "publish-npm: stopping after dry-run (pass --i-confirm-publish without --dry-run for real publish)"
  exit 0
fi

# Real publish path (CONFIRM_PUBLISH=1 and DRY_RUN=0)
echo "== real publish (confirmed) =="
for key in "${pkg_keys[@]}"; do
  dir=$(pkg_dir "$key")
  node "$SCRIPT_DIR/provenance-toggle.mjs" "$dir/package.json" false
done

for json in "${RESOLVED_JSON[@]}"; do
  name=$(node -e 'const j=JSON.parse(process.argv[1]); process.stdout.write(j.name)' "$json")
  tag=$(node -e 'const j=JSON.parse(process.argv[1]); process.stdout.write(j.tag)' "$json")
  to=$(node -e 'const j=JSON.parse(process.argv[1]); process.stdout.write(j.to)' "$json")
  echo "publishing $name@$to (tag=$tag) …"
  set +e
  if [[ "$tag" == "next" ]]; then
    pnpm publish --filter "$name" --tag next --no-git-checks
  else
    pnpm publish --filter "$name" --no-git-checks
  fi
  rc=$?
  set -e
  if [[ $rc -ne 0 ]]; then
    echo "publish-npm: publish failed for $name@$to (exit $rc)." >&2
    echo "If E400 + npm view 404 → tombstone; bump version and retry." >&2
    exit "$rc"
  fi
  echo "verify: $(npm view "$name@$to" version 2>/dev/null || echo MISSING)"
  npm view "$name" dist-tags --json || true
done

PUBLISH_SUCCEEDED=1
restore_provenance
# Keep trap for restore_versions no-op after success; clear full cleanup now that
# provenance is restored and versions should stay bumped.
PROVENANCE_RESTORED=1
VERSIONS_RESTORED=1
trap - EXIT

# Apps align (stable only)
if [[ "$CHANNEL" == "latest" && "$DO_APPS_ALIGN" -eq 1 ]]; then
  echo "== apps align (latest) =="
  for json in "${RESOLVED_JSON[@]}"; do
    name=$(node -e 'const j=JSON.parse(process.argv[1]); process.stdout.write(j.name)' "$json")
    to=$(node -e 'const j=JSON.parse(process.argv[1]); process.stdout.write(j.to)' "$json")
    if [[ "$name" == "@percena/weft" ]]; then
      for app in apps/online-store/agentic/package.json apps/itsm/agentic/package.json; do
        if [[ -f "$app" ]]; then
          node -e '
            const fs=require("fs");
            const p=process.argv[1], v=process.argv[2];
            const j=JSON.parse(fs.readFileSync(p,"utf8"));
            if (j.dependencies && j.dependencies["@percena/weft"]) {
              j.dependencies["@percena/weft"] = "^"+v;
              fs.writeFileSync(p, JSON.stringify(j,null,2)+"\n");
              console.log("aligned", p, "->", "^"+v);
            }
          ' "$app" "$to"
        fi
      done
    fi
    if [[ "$name" == "@percena/weft-node" ]]; then
      app=apps/chat-playground/package.json
      if [[ -f "$app" ]]; then
        node -e '
          const fs=require("fs");
          const p=process.argv[1], v=process.argv[2];
          const j=JSON.parse(fs.readFileSync(p,"utf8"));
          const cur=j.dependencies && j.dependencies["@percena/weft-node"];
          if (cur && cur !== "workspace:*" && !String(cur).startsWith("workspace:")) {
            j.dependencies["@percena/weft-node"] = v;
            fs.writeFileSync(p, JSON.stringify(j,null,2)+"\n");
            console.log("aligned", p, "->", v);
          } else {
            console.log("skip apps align for weft-node (workspace dep or missing):", cur);
          }
        ' "$app" "$to"
      fi
    fi
  done
fi

echo "== done =="
printf '%s\n' "${PLAN_LINES[@]}"
echo "Next (agent): git add + commit version/changelog/apps; AskUserQuestion before git push."
echo "Skill dir: $SKILL_DIR"
