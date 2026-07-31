#!/usr/bin/env node
/**
 * Manage publishConfig.provenance on a package.json.
 *
 * The publish manifests intentionally carry NO `publishConfig.provenance`:
 * metadata must match reality, and the local skill path publishes WITHOUT
 * attestations (only the OIDC release.yml CI path can mint provenance, and it
 * enables it via publish flags, not the manifest). `clear` is the canonical
 * pre-local-publish action; `true`/`false` remain for manual repair only.
 *
 * Usage:
 *   node provenance-toggle.mjs <package.json> clear   # remove the key (canonical)
 *   node provenance-toggle.mjs <package.json> get     # print current value
 *   node provenance-toggle.mjs <package.json> false
 *   node provenance-toggle.mjs <package.json> true
 */
import { readFileSync, writeFileSync } from 'node:fs'

const [pkgPath, action] = process.argv.slice(2)
if (!pkgPath || !action) {
  console.error('usage: provenance-toggle.mjs <package.json> clear|get|true|false')
  process.exit(2)
}

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
pkg.publishConfig = pkg.publishConfig || {}

if (action === 'get') {
  console.log(String(pkg.publishConfig.provenance))
  process.exit(0)
}

if (action === 'clear') {
  const prev = pkg.publishConfig.provenance
  delete pkg.publishConfig.provenance
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
  console.log(JSON.stringify({ path: pkgPath, from: prev, to: undefined }))
  process.exit(0)
}

if (action !== 'true' && action !== 'false') {
  console.error('action must be clear|get|true|false')
  process.exit(2)
}

const next = action === 'true'
const prev = pkg.publishConfig.provenance
pkg.publishConfig.provenance = next
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
console.log(JSON.stringify({ path: pkgPath, from: prev, to: next }))
