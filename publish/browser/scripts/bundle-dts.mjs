#!/usr/bin/env node
/**
 * bundle-dts.mjs — roll up tsup-generated per-entry .d.ts into self-contained
 * bundles with @weft/* workspace types inlined, via dts-bundle-generator.
 *
 * Replaces the prior naive concatenator, which inlined every .d.ts under each
 * @weft package's dist/ — including internal-only subfiles — producing
 * duplicate top-level type aliases (e.g. `SessionStatus` declared once as
 * `string` in protocol/dto and once as a literal union in types/session) that
 * errored TS2300 "Duplicate identifier" under `skipLibCheck: false`. Because
 * @weft/* are workspace-only (unpublished), their declarations MUST be inlined
 * into the published bundle; dts-bundle-generator follows the EXPORT graph and
 * tree-shakes, so internal-only declarations no longer leak and the bundle
 * stays tsc-clean (~90% smaller than the old concat output).
 *
 * ESM-only since the 1.0-track: tsup emits only .d.ts (no .d.cts). Output
 * overwrites the entry .d.ts in place via a temp file (dts-bundle-generator
 * cannot read and write the same path).
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = resolve(__dirname, '..')
const REPO_ROOT = resolve(PKG_ROOT, '..', '..')
const DIST = resolve(PKG_ROOT, 'dist')

const ENTRIES = ['index', 'chat', 'providers-flitro', 'action-bridge']
const failures = []

// dts-bundle-generator ships its own bin; with pnpm it may be hoisted to the
// package or the workspace root node_modules/.bin.
function findBin() {
  const candidates = [
    resolve(PKG_ROOT, 'node_modules', '.bin', 'dts-bundle-generator'),
    resolve(REPO_ROOT, 'node_modules', '.bin', 'dts-bundle-generator'),
  ]
  for (const c of candidates) if (existsSync(c)) return c
  return 'dts-bundle-generator' // fall back to PATH (pnpm run prepends .bin)
}

const bin = findBin()

function run(entry) {
  const outFile = resolve(DIST, `${entry}.d.ts`)
  if (!existsSync(outFile)) {
    failures.push(`${entry}.d.ts missing — run tsup first`)
    return
  }
  const tmp = resolve(DIST, `.${entry}.d.ts.tmp`)
  rmSync(tmp, { force: true })

  // --no-check: skip dts-bundle-generator's post-write validation (it searches
  // for a tsconfig next to the output and errors off-tree). We verify the
  // bundle via assert-exports + a consumer tsc pass instead.
  // --export-referenced-types=false: only export symbols the entry explicitly
  // exports. The default (true) also surfaces types that are merely *referenced*
  // by exports, which collides here — e.g. @weft/ui's `type Session =
  // ProtocolSession` alias inlines to `type Session = <interface Session>`,
  // and a type alias + interface of the same name cannot coexist in one file
  // (TS2484). The chat entry is `export * from '@weft/ui'` + `export * from
  // '@weft/chat'`, so every explicitly-exported symbol stays public; only
  // ambiguous/leaked internals (like that `Session` alias — not imported by any
  // app consumer) are dropped.
  // Defaults already inline @weft/* workspace packages (resolved through pnpm
  // symlinks) and keep react / react-dom as external imports.
  try {
    execFileSync(bin, ['--no-check', '--silent', '--export-referenced-types=false', '-o', tmp, outFile], {
      cwd: PKG_ROOT,
      stdio: 'inherit',
    })
  } catch {
    failures.push(`${entry}.d.ts: dts-bundle-generator failed`)
    rmSync(tmp, { force: true })
    return
  }

  if (!existsSync(tmp)) {
    failures.push(`${entry}.d.ts: dts-bundle-generator produced no output`)
    return
  }

  // Guard: @weft/* must be fully inlined — they are unpublished workspace
  // packages, so any leftover `from '@weft/…'` would be an unresolvable ref.
  const bundled = readFileSync(tmp, 'utf8')
  const leftover = bundled.match(/from\s+['"]@weft\//g)
  if (leftover) {
    failures.push(
      `${entry}.d.ts: ${leftover.length} @weft/* import(s) not inlined — ` +
        `bundle would emit unresolvable refs`,
    )
    rmSync(tmp, { force: true })
    return
  }

  renameSync(tmp, outFile)
  console.log(`  ✓ ${entry}.d.ts rolled up (${(bundled.length / 1024).toFixed(1)} KB)`)
}

for (const entry of ENTRIES) run(entry)

if (failures.length > 0) {
  console.error('bundle-dts: FAILED')
  for (const f of failures) console.error(`  ✗ ${f}`)
  process.exit(1)
}
console.log(`Bundled ${ENTRIES.length} DTS files.`)
