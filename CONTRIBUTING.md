# Contributing to Weft

Thanks for your interest in contributing! This repo (`weft-sdk`) publishes two
npm packages: `@percena/weft` (browser-safe) and `@percena/weft-node`
(Node.js/desktop).

## Prerequisites

- Node.js 22+ (see `.nvmrc`)
- pnpm 10+ (`corepack enable && corepack prepare pnpm@10.18.2 --activate`)

## Setup

```bash
git clone https://github.com/percena/weft-sdk.git
cd weft-sdk
pnpm install
pnpm build      # layered build: L0–L4 + publish + browser-canary
```

> **`shamefully-hoist=true` is required** (set in `.npmrc`, applied
> automatically by `pnpm install`). Without it the `zod` instance resolves to
> two separate copies across the workspace and `pnpm check` (tsc) fails in
> `packages/sources/src/sdk-server.ts` (formerly `sdk-stub.ts`) with
> mismatches. Keep it until the zod duplication is fixed. Do not delete
> `.npmrc`.

## Common tasks

```bash
pnpm check        # tsc --noEmit across the workspace
pnpm validate     # build-contract + browser-purity assertions
pnpm test         # vitest
pnpm playground  # launch the mock-data UI (no backend)
```

## Before opening a PR

1. `pnpm build` is green.
2. `pnpm check`, `pnpm validate`, and `pnpm test` pass. `pnpm validate` asserts
   the exact published `dist/` file contract (e.g. ESM-only `.js`+`.d.ts` for
   the publish facades — no `.cjs`/`.d.cts`) — run it, not just `pnpm build`.
3. The browser bundle stays **pure**: no `node:*` imports may leak into
   `publish/browser/dist` (enforced by `assert-exports.mjs` + `browser-canary`).
4. If you change user-facing behavior in a published package, add a changeset:
   `pnpm changeset`.

## Package layout

- `packages/*` — internal workspace packages (browser-safe core + Node-only extensions).
- `publish/browser` — the `@percena/weft` facade (browser-safe, ESM-only).
- `publish/desktop` — the `@percena/weft-node` facade (Node.js/desktop, ESM-only).
- `tools/browser-canary` — CI guard that the browser bundle imports cleanly.
- `apps/chat-playground` — mock-data UI playground (no backend).
- `apps/online-store` — chat-driven storefront demo (Node + React).
- `apps/itsm` — chat-driven ITSM demo (Python/FastAPI + React).
- `skills/integrate-weft-kit` — agent skill that layers Weft on a REST + OpenAPI app (see below).

## Integration skill (`skills/integrate-weft-kit`)

The skill is **self-contained** after install — users do not need this monorepo.
When changing it in-tree, the canonical sources are:

| Path | Role |
|------|------|
| [`skills/integrate-weft-kit/SKILL.md`](skills/integrate-weft-kit/SKILL.md) | Runbook (contract, closed loop, test categories) |
| [`skills/integrate-weft-kit/references/`](skills/integrate-weft-kit/references/) | Deep theory (`security-contract`, fail-open, plan-route, execution-model) |
| [`skills/integrate-weft-kit/templates/`](skills/integrate-weft-kit/templates/) | Node + Python fast-paths + security guards |

Security layers (do not merge these docs into one):

- **SDK / browser embed** — [`docs/SECURITY-MODEL.md`](docs/SECURITY-MODEL.md)
- **Integration templates (Tier 1–3)** — [`skills/integrate-weft-kit/references/security-contract.md`](skills/integrate-weft-kit/references/security-contract.md)

A security fix to the Node templates must mirror the Python port in the same
commit (and both guards must stay green).