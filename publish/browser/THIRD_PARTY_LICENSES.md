# Third-Party Licenses — `@percena/weft`

`@percena/weft` is MIT-licensed (see `LICENSE`). Its published `dist/` bundle inlines
third-party code from the dependencies of the `@weft/*` workspace packages
(ui, sources, core, timeline, skills, …) — those copies retain their original
licenses. This file is the attribution inventory for the inlined third-party code.

Each package's full license notice ships in `node_modules/<package>/LICENSE`.
Reproduce the complete, up-to-date inventory with:

```sh
pnpm licenses list --filter '@percena/weft'
```

## Inlined third-party packages

| Package | License | Author / Source |
|---|---|---|
| zod | MIT | Colin McDonnell — https://github.com/colinhacks/zod |
| gray-matter | MIT | Jon Schlinkert — https://github.com/jonschlinkert/gray-matter |
| js-yaml | MIT | Vitaly Puzrin — https://github.com/nodeca/js-yaml |
| katex | MIT | Khan Academy — https://github.com/KaTeX/KaTeX |
| react-markdown | MIT | Titus Wormer — https://github.com/remarkjs/react-markdown |
| remark-gfm | MIT | Titus Wormer — https://github.com/remarkjs/remark-gfm |
| remark-math | MIT | Junyoung Choi — https://github.com/remarkjs/remark-math |
| rehype-raw | MIT | Titus Wormer — https://github.com/rehypejs/rehype-raw |
| rehype-sanitize | MIT | Titus Wormer — https://github.com/rehypejs/rehype-sanitize |
| rehype-katex | MIT | Titus Wormer — https://github.com/remarkjs/rehype-katex |
| @shikijs/core, engine-javascript, langs, themes | MIT | Pine Tsu / Shiki — https://github.com/shikijs/shiki |
| i18next | MIT | i18next — https://www.i18next.com |
| react-i18next | MIT | i18next — https://github.com/i18next/react-i18next |
| lucide-react | ISC | Eric Fennis — https://lucide.dev |
| motion | MIT | Matt Perry — https://github.com/motiondivision/motion |
| entities | BSD-2-Clause | Felix Boehm — https://github.com/fb55/entities |
| hast-util-* / unist-util-* / micromark-* | MIT / ISC | unified/syntax-tree collective — https://github.com/syntax-tree |

> Note: several of the above (react-markdown, rehype-*, remark-*, @shikijs/*,
> i18next, react-i18next, lucide-react, motion) are also declared as runtime
> `dependencies` of `@percena/weft` (see `package.json`), so npm installs them
> directly and their licenses travel with the install. This inventory exists so
> the copies bundled *inside* `dist/` (notably zod, gray-matter, js-yaml, katex,
> and the unified/syntax-tree utilities pulled in via the `@weft/*` packages)
> are also attributed, as required by their licenses.

## Verification + follow-up

This table was generated for the 1.0.0 release. If you add or upgrade a bundled
dependency, regenerate via `pnpm licenses list --filter '@percena/weft'` and
update this file. The full per-package LICENSE texts are preserved in
`node_modules/`; a future hardening step is to bundle the full license texts
into `dist/` alongside this inventory.

`publishConfig.provenance` (SLSA) is enabled in source; it takes effect only
when publishing from CI with npm OIDC provenance (see `SECURITY.md`).
