<!--
Thanks for the PR! Before submitting, make sure the basics are green:

  pnpm build        # layered build: L0–L4 + publish + browser-canary
  pnpm check        # tsc --noEmit
  pnpm test         # vitest
  pnpm lint         # biome (see CONTRIBUTING.md)

If you change user-facing behavior in a published package (@percena/weft or
@percena/weft-node), add a changeset: `pnpm changeset`.
-->

## Summary

<!-- What does this PR change, and why? Link the issue/finding ID if any. -->

## Verification

<!-- How did you verify this? Build/test commands run + their result. -->

## Checklist

- [ ] `pnpm build`, `pnpm check`, `pnpm test` green
- [ ] The browser bundle stays pure — no `node:*` imports leak into `publish/browser/dist` (enforced by `assert-exports.mjs` + `browser-canary`)
- [ ] Changeset added for user-facing changes to a published package
- [ ] No secrets/credentials committed
