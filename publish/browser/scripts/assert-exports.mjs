#!/usr/bin/env node
/**
 * assert-exports.mjs — publish-pipeline guards.
 *
 * 1. Every package.json#exports subpath must resolve to existing dist files.
 * 2. The browser-safe entry (providers-flitro) and its chunk graph must be
 *    free of Node builtins and Node-only dependencies — this is the canary
 *    that keeps integrators from ever needing aliases/stubs/process shims.
 * 3. The browser-safe entry is actually imported and every value export
 *    declared in its .d.ts must exist at runtime (the EN_FALLBACK class of
 *    d.ts/runtime divergence fails the build here).
 */

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const DIST = path.join(ROOT, 'dist')

const failures = []

// ── 1. exports map completeness ─────────────────────────────────────────────

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

function collectTargets(value, out = []) {
  if (typeof value === 'string') out.push(value)
  else if (value && typeof value === 'object') {
    for (const v of Object.values(value)) collectTargets(v, out)
  }
  return out
}

for (const [subpath, value] of Object.entries(pkg.exports)) {
  for (const target of collectTargets(value)) {
    if (!fs.existsSync(path.join(ROOT, target))) {
      failures.push(`exports["${subpath}"] points to missing file: ${target}`)
    }
  }
}

// ── 2. browser cleanliness of the flitro provider entry ────────────────────

const FORBIDDEN = [
  /from\s*["']node:[^"']+["']/,
  /require\(\s*["']node:[^"']+["']\s*\)/,
  /from\s*["'](child_process|fs|os|path|crypto|readline|http|https|net|tls)["']/,
  /from\s*["']bash-parser["']/,
  /@anthropic-ai\/claude-agent-sdk/,
  /@weft\/skills(?:\/|['"]|$)/,
  /@weft\/sources(?:\/|['"]|$)/,
  /@weft\/automations(?:\/|['"]|$)/,
]

function walkChunkGraph(entryFile, seen = new Set()) {
  if (seen.has(entryFile)) return seen
  seen.add(entryFile)
  const source = fs.readFileSync(path.join(DIST, entryFile), 'utf8')
  for (const pattern of FORBIDDEN) {
    const match = source.match(pattern)
    if (match) {
      failures.push(`browser-safe entry pulls in Node-only code: ${entryFile} → ${match[0]}`)
    }
  }
  // Follow relative chunk imports (tsup code splitting).
  for (const m of source.matchAll(/from\s*["'](\.\/[^"']+)["']/g)) {
    const next = path.normalize(m[1])
    if (fs.existsSync(path.join(DIST, next))) walkChunkGraph(next, seen)
  }
  return seen
}

// Both browser entries must be clean: the flitro provider AND the chat UI.
for (const browserEntry of ['providers-flitro.js', 'chat.js']) {
  if (fs.existsSync(path.join(DIST, browserEntry))) {
    walkChunkGraph(browserEntry)
  } else {
    failures.push(`dist/${browserEntry} is missing`)
  }
}

// The chat UI cannot be imported under Node (css imports), so assert its
// known-regression export statically (declared in d.ts since 0.2.4 but
// missing at runtime until 0.2.6).
if (fs.existsSync(path.join(DIST, 'chat.js'))) {
  const chatSource = fs.readFileSync(path.join(DIST, 'chat.js'), 'utf8')
  const exported = [...chatSource.matchAll(/^export\s*\{([^}]+)\}/gm)]
    .flatMap(m => m[1].split(','))
    .map(piece => (piece.trim().split(/\s+as\s+/)[1] ?? piece.trim()))
  if (!exported.includes('EN_FALLBACK')) {
    failures.push('chat: EN_FALLBACK is declared in d.ts but not exported by dist/chat.js')
  }
}

// ── 3. d.ts vs runtime export parity for the flitro entry ──────────────────

function collectTypeOnlyNames(source, dir) {
  const typeOnly = new Set()
  for (const m of source.matchAll(/(?:declare\s+)?(?:interface|type)\s+([A-Za-z_$][\w$]*)/gm)) {
    typeOnly.add(m[1])
  }
  // Also scan imported chunk d.ts files — tsup code-splits types into chunks
  // and re-exports interfaces without the `type` prefix.
  for (const m of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"](\.[^'"]+\.d\.[cm]?ts)['"]/gm)) {
    const chunkPath = path.join(dir, m[2])
    if (!fs.existsSync(chunkPath)) continue
    const chunkSource = fs.readFileSync(chunkPath, 'utf8')
    for (const cm of chunkSource.matchAll(/(?:declare\s+)?(?:interface|type)\s+([A-Za-z_$][\w$]*)/gm)) {
      typeOnly.add(cm[1])
    }
    // Map aliased imports: `import { a as Foo }` — Foo is type-only if the
    // chunk defines it as interface/type.
    for (const piece of m[1].split(',')) {
      const parts = piece.trim().split(/\s+as\s+/)
      if (parts.length === 2) {
        const alias = parts[1].trim()
        if (typeOnly.has(alias)) continue
        // The original name is mangled; check if the alias is an interface in the chunk.
        for (const cm of chunkSource.matchAll(/(?:declare\s+)?(?:interface|type)\s+([A-Za-z_$][\w$]*)/gm)) {
          if (cm[1] === alias) typeOnly.add(alias)
        }
      }
    }
  }
  // Chunk imports via .js extension (tsup d.ts uses .js for chunk references)
  for (const m of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"](\.[^'"]+\.js)['"]/gm)) {
    const dtsPath = path.join(dir, m[2].replace(/\.js$/, '.d.ts'))
    if (!fs.existsSync(dtsPath)) continue
    const chunkSource = fs.readFileSync(dtsPath, 'utf8')
    for (const piece of m[1].split(',')) {
      const parts = piece.trim().split(/\s+as\s+/)
      const alias = (parts.length === 2 ? parts[1] : parts[0]).trim()
      if (!alias) continue
      if (chunkSource.match(new RegExp(`(?:declare\\s+)?(?:interface|type)\\s+${alias}\\b`))) {
        typeOnly.add(alias)
      }
    }
  }
  return typeOnly
}

function declaredValueExportsFromFile(filePath) {
  const source = fs.readFileSync(filePath, 'utf8')
  const dir = path.dirname(filePath)
  const names = new Set()
  const typeOnly = collectTypeOnlyNames(source, dir)
  for (const m of source.matchAll(/^export\s+(?:declare\s+)?(?:const|let|function|class|enum)\s+([A-Za-z_$][\w$]*)/gm)) {
    names.add(m[1])
  }
  // Brace exports without a from-clause (tsup dts emits `declare …` plus a
  // final `export { … }`). Re-exports from other packages are skipped: they
  // may be type-only without a `type` prefix and are verified via their own
  // package d.ts when in scope.
  for (const m of source.matchAll(/^export\s*\{([^}]+)\}\s*;?\s*$/gm)) {
    for (const piece of m[1].split(',')) {
      const name = piece.trim()
      if (!name || name.startsWith('type ')) continue
      const resolved = (name.split(/\s+as\s+/)[1] ?? name).trim()
      if (!typeOnly.has(resolved)) names.add(resolved)
    }
  }
  return names
}

// The contract of the entry is the union of value exports of the packages its
// source re-exports (the bundled d.ts over-declares: bundle-dts inlines whole
// dependency packages, a pre-existing cosmetic issue shared by all entries).
const entrySource = fs.readFileSync(path.join(ROOT, 'src', 'providers-flitro.ts'), 'utf8')
const reexported = [...entrySource.matchAll(/export \* from '@weft\/([^']+)'/g)].map(m => m[1])

if (fs.existsSync(path.join(DIST, 'providers-flitro.js'))) {
  const mod = await import(pathToFileURL(path.join(DIST, 'providers-flitro.js')).href)
  for (const pkgDir of reexported) {
    let pkgDts = path.join(ROOT, '..', '..', 'packages', pkgDir, 'dist', 'index.d.ts')
    if (!fs.existsSync(pkgDts) && pkgDir.includes('/')) {
      const [pkg, entry] = pkgDir.split('/')
      pkgDts = path.join(ROOT, '..', '..', 'packages', pkg, 'dist', `${entry}.d.ts`)
    }
    if (!fs.existsSync(pkgDts)) {
      failures.push(`providers-flitro: cannot verify @weft/${pkgDir} (missing ${pkgDts})`)
      continue
    }
    for (const name of declaredValueExportsFromFile(pkgDts)) {
      if (mod[name] === undefined) {
        failures.push(`providers-flitro: @weft/${pkgDir} declares ${name} but it is undefined at runtime`)
      }
    }
  }
}

// ── 4. public source files must not import private/server code ──────────────

function scanSourceFile(relativePath) {
  const filePath = path.join(ROOT, relativePath)
  if (!fs.existsSync(filePath)) {
    failures.push(`source entry missing: ${relativePath}`)
    return
  }
  const source = fs.readFileSync(filePath, 'utf8')
  for (const pattern of FORBIDDEN) {
    const match = source.match(pattern)
    if (match) {
      failures.push(`public source imports private/server code: ${relativePath} -> ${match[0]}`)
    }
  }
}

// Derive source entries from tsup.config.ts so new entries are guarded automatically.
const tsupSource = fs.readFileSync(path.join(ROOT, 'tsup.config.ts'), 'utf8')
const sourceEntries = [...tsupSource.matchAll(/'src\/[^']+'/g)].map(m => m[0].slice(1, -1))
if (sourceEntries.length === 0) {
  failures.push('could not derive source entries from tsup.config.ts')
}
for (const sourceEntry of sourceEntries) {
  scanSourceFile(sourceEntry)
}

// ── 5. rehype-sanitize must be external, not bundled (XSS-critical) ─────────
// `rehype-sanitize` is the XSS gate for rendered agent markdown (Markdown.tsx
// wires `[rehypeSanitize, sanitizeSchema]` after `rehypeRaw`). It MUST stay an
// external import resolved from the consumer's node_modules — if a tsup/
// externalization change ever silently bundles it (or drops it from deps), a
// future rebuild could ship a dist where the sanitize plugin is missing or
// stale, regressing XSS protection with no other signal. Guard it:
//   (a) it is declared in package.json#dependencies;
//   (b) some dist chunk imports it as an external bare specifier; and
//   (c) no dist chunk inlined its source (no `node_modules/.pnpm/rehype-sanitize`
//       path leaked into the bundle).
if (!Object.prototype.hasOwnProperty.call(pkg.dependencies, 'rehype-sanitize')) {
  failures.push('package.json#dependencies omits rehype-sanitize (XSS-critical markdown sanitizer)')
}

const distFiles = fs.readdirSync(DIST).filter((f) => f.endsWith('.js'))
let sanitizeExternal = false
let sanitizeBundled = false
for (const f of distFiles) {
  const src = fs.readFileSync(path.join(DIST, f), 'utf8')
  if (/from\s*["']rehype-sanitize["']/.test(src)) sanitizeExternal = true
  if (/node_modules\/\.pnpm\/rehype-sanitize@|node_modules\/rehype-sanitize\//.test(src)) {
    sanitizeBundled = true
  }
}
if (!sanitizeExternal) {
  failures.push('rehype-sanitize is not imported as an external dependency in any dist chunk — it may have been dropped from the bundle (XSS regression)')
}
if (sanitizeBundled) {
  failures.push('rehype-sanitize source was bundled into a dist chunk (expected external) — rehype-sanitize must be an external dependency, not inlined')
}

// ── report ──────────────────────────────────────────────────────────────────

if (failures.length > 0) {
  console.error('assert-exports: FAILED')
  for (const failure of failures) console.error(`  ✗ ${failure}`)
  process.exit(1)
}
console.log('assert-exports: all export, browser-cleanliness, and runtime-parity checks passed')
