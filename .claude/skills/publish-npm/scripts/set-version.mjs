#!/usr/bin/env node
/**
 * Set package.json "version" field in place.
 * Usage: node set-version.mjs <package.json> <version>
 */
import { readFileSync, writeFileSync } from 'node:fs'

const [pkgPath, version] = process.argv.slice(2)
if (!pkgPath || !version) {
  console.error('usage: set-version.mjs <package.json> <version>')
  process.exit(2)
}
if (!/^\d+\.\d+\.\d+([.-][0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`refusing non-semver-ish version: ${version}`)
  process.exit(2)
}

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
const prev = pkg.version
pkg.version = version
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
console.log(JSON.stringify({ path: pkgPath, from: prev, to: version }))
