# Third-Party Licenses — `@percena/weft-node`

`@percena/weft-node` is MIT-licensed (see `LICENSE`). Its published `dist/` bundle
inlines third-party code from the dependencies of the `@weft/*` workspace
packages (skills, sources, automations, adapter, ui, core, timeline, …) — those
copies retain their original licenses. This file is the attribution inventory
for the inlined third-party code and bundled assets.

Each package's full license notice ships in `node_modules/<package>/LICENSE`.
Reproduce the complete, up-to-date inventory with:

```sh
pnpm licenses list --filter '@percena/weft-node'
```

## Inlined third-party packages and assets

| Package | License | Author / Source |
|---|---|---|
| zod | MIT | Colin McDonnell — https://github.com/colinhacks/zod |
| gray-matter | MIT | Jon Schlinkert — https://github.com/jonschlinkert/gray-matter |
| js-yaml | MIT | Vitaly Puzrin — https://github.com/nodeca/js-yaml |
| section-matter | MIT | Jon Schlinkert — https://github.com/jonschlinkert/section-matter |
| extend-shallow | MIT | Jon Schlinkert — https://github.com/jonschlinkert/extend-shallow |
| kind-of | MIT | Jon Schlinkert — https://github.com/jonschlinkert/kind-of |
| strip-bom-string | MIT | Jon Schlinkert — https://github.com/jonschlinkert/strip-bom-string |
| katex (fonts + compiled `@font-face` CSS under `dist/styles/`) | MIT | Khan Academy — https://github.com/KaTeX/KaTeX |

> Note: the package's runtime `dependencies` (react-markdown, remark-*,
> rehype-*, @shikijs/*, i18next, react-i18next, lucide-react, motion — see
> `package.json`) are installed by npm rather than bundled, so their license
> texts travel with the install in `node_modules/`. This inventory covers the
> copies bundled *inside* `dist/`: zod, gray-matter and its small helper
> dependencies, js-yaml (pulled in via the `@weft/*` packages, which are
> compiled into the bundle), and the KaTeX woff2 fonts + compiled font CSS
> shipped under `dist/styles/` for the math-capable stylesheet entry.

## Verification + follow-up

This table reflects the actual `dist/` contents (verified by scanning the
bundles for inlined package code and external import specifiers). If you add
or upgrade a bundled dependency, regenerate via
`pnpm licenses list --filter '@percena/weft-node'` and update this file. The
full per-package LICENSE texts are preserved in `node_modules/`; a future
hardening step is to bundle the full license texts into `dist/` alongside this
inventory.

npm provenance (SLSA) attestations are minted only when a release is published
through the CI OIDC release workflow (see `SECURITY.md`); releases published
through the local break-glass path carry no attestations.
