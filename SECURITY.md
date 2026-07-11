# Security Policy

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Instead, report them privately:

- GitHub: use **Security → Report a vulnerability** (private vulnerability
  reporting) on [github.com/percena/weft-sdk](https://github.com/percena/weft-sdk).
- Or email: **info@percena.co**

Please include a clear description, reproduction steps, and the affected
package (`@percena/weft` or `@percena/weft-node`) and version.

## Scope

This policy covers the `weft-sdk` repository. The Go control plane `weftd`
has its own security policy in its repository.

## Supported versions

Only the latest minor release line receives security fixes.

## Secret scanning

The repository is scanned with [gitleaks](https://github.com/gitleaks/gitleaks)
on every push and pull request (`.github/workflows/ci.yml`, `secret-scan` job)
across **all refs** (`fetch-depth: 0`).

If gitleaks reports a finding, the CI `secret-scan` job fails and the PR is
blocked. To re-run locally:

```bash
brew install gitleaks   # or: go install github.com/gitleaks/gitleaks/v8@latest
gitleaks detect --source . --report-format json --report-path /tmp/gitleaks.json --redact --log-opts="--all"
```

## Bundle purity

`@percena/weft` (browser) is **pure** — no `node:*` imports may leak into
`publish/browser/dist` (enforced by `assert-exports.mjs` + the `browser-canary`
build). `publishConfig.provenance` is enabled for npm [provenance](https://docs.npmjs.com/generating-provenance-statements)
(SLSA) on publish. Markdown rendered by the SDK is sanitized with
`rehype-sanitize` (dangerous HTML/CSS tokens stripped before render).
