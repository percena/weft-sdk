#!/usr/bin/env node
/**
 * Toggle publishConfig.provenance on a package.json.
 *
 * Usage:
 *   node provenance-toggle.mjs <package.json> false
 *   node provenance-toggle.mjs <package.json> true
 *   node provenance-toggle.mjs <package.json> get
 */
import { readFileSync, writeFileSync } from 'node:fs'

const [pkgPath, action] = process.argv.slice(2)
if (!pkgPath || !action) {
  console.error('usage: provenance-toggle.mjs <package.json> true|false|get')
  process.exit(2)
}

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
pkg.publishConfig = pkg.publishConfig || {}

if (action === 'get') {
  console.log(String(pkg.publishConfig.provenance))
  process.exit(0)
}

if (action !== 'true' && action !== 'false') {
  console.error('action must be true|false|get')
  process.exit(2)
}

const next = action === 'true'
const prev = pkg.publishConfig.provenance
pkg.publishConfig.provenance = next
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
console.log(JSON.stringify({ path: pkgPath, from: prev, to: next }))
