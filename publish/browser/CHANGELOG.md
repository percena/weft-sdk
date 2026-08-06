# @percena/weft

## 1.1.0

### Minor Changes

- 90cae9d: Run budgets can now be set from the public SDK surface, not just the low-level
  `WeftApiClient.createRun` call. A `budget` option
  (`{ maxSteps?, maxTokens?, maxWallTimeSec? }`, typed as `RunBudget`) is
  accepted:

  - per message, via `SendMessageOptions.budget`;
  - as a session-level default, via `CreateFlitroEmbedRuntimeOptions.budget`
    (also on `CreateFlitroProviderRuntimeOptions` / `CreateFlitroDriverOptions`).

  The Flitro runtime-driver forwards it to the server when creating a run
  (serialized to `max_steps` / `max_tokens` / `max_wall_time_sec`), so hosts can
  cap long agentic flows client-side. A per-message budget wins over the session
  default, mirroring `permissionMode`. The option is honored by the Flitro
  driver; other providers may ignore it.

## 1.0.4

### Patch

- Transport errors from the Flitro HTTP client now carry stable, branchable
  names. A request that exceeds the configured timeout rejects with an Error
  whose `name` is `'WeftTimeoutError'`; a 2xx response whose body fails JSON
  parsing rejects with an Error whose `name` is `'WeftParseError'` (original
  parse error on `cause`). A timeout that fires while the body is still
  streaming is no longer masked as a parse error — it rethrows as
  `WeftTimeoutError`. The errors stay plain `Error` (not new subclasses), so
  existing catch logic is unaffected.
- Documents the `quota_exceeded` (HTTP 402) and
  `identity_binding_required` (HTTP 403) stable codes on `WeftHttpError`.
- Removes the `publishConfig.provenance` key from the manifest: provenance
  attestations are minted only via the OIDC CI release workflow, not the local
  break-glass publish path.

## 1.0.3

### Patch

- Version-only republish of 1.0.2 — the package contents (`dist`, styles,
  types) are identical to 1.0.2 except for the `version` field. The release
  was cut to advance the `latest` line alongside repo-side updates to the
  `integrate-weft-kit` skill templates and demo apps, which are not part of
  this npm package.
- Retroactive entry (added 2026-07-31): 1.0.3 originally shipped without a
  changeset or CHANGELOG entry. The publish tooling now refuses a `latest`
  publish whose version has no CHANGELOG entry, so this cannot recur.

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
