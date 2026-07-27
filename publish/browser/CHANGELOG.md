# @percena/weft

## 1.0.2

### Minor

- Export `WeftHttpError` from the browser Flitro provider entry with stable
  weftd error codes.
- Preserve structured error fields on synthetic `turn_failed` timeline items.
- Export `readTurnFailedError` / `TurnFailedErrorInfo` from the root entry as
  the supported way to consume `turn_failed.error` (no more casting `unknown`).
- Reject immediately-drained deferred sends with the original typed error.

## 1.0.0

First stable, production-ready release of the browser-safe Weft Agentic Chat
SDK — the first open-source release.

### Major

- The public surface is frozen as the stable v1 contract:
  `.` / `./chat` / `./providers/flitro` / `./action-bridge` / `./styles`
  (plus `./styles/core`, a math-free subpath that opts out of the ~296 KB
  KaTeX woff2 font payload when math isn't rendered).
- **ESM-only:** `.js` + `.d.ts` (no `.cjs` / `.d.cts`).
  `require('@percena/weft')` throws `ERR_REQUIRE_ESM`. All documented usage
  and the `integrate-weft-kit` skill templates use ESM `import`; bundler
  consumers (Vite / webpack 5 / Next.js / Rollup) are unaffected.
- Bundled `.d.ts` via `dts-bundle-generator --export-referenced-types=false`
  (single-file type declarations; no internal `@weft/*` path leakage into the
  published surface).
- `rehype-sanitize` is an external dependency (never bundled) — the XSS gate
  for rendered agent markdown stays resolvable from the consumer's
  `node_modules`. An `assert-exports` build guard fails the build if a tsup
  change ever silently bundles or drops it.
- Peer deps: `react` / `react-dom` `^18.2.0 || ^19.0.0` (no React-19-only
  APIs are used). `engines.node >= 18`.
- KaTeX fonts are woff2-only (~0.41 MB packed, down from ~1.58 MB).

### Notes

- The browser SDK's embed runtime (`@percena/weft/providers/flitro`) connects
  the chat panel to the hosted Weft control plane (`weftd`). See the repository
  README for the control-plane dependency.
