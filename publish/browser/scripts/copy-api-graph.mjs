#!/usr/bin/env node
/**
 * copy-api-graph.mjs — fold the build-time API dependency-graph analyzer
 * (an internal workspace-only package) into the published
 * `@percena/weft` tarball so integrators get ONE package, not two.
 *
 * Why copy (not tsup-bundle): the analyzer is already built self-contained
 * (tsup splitting:false → analyzer.js + cli.js each inline `generateGraph`,
 * zero cross-entry imports, zero runtime deps — only node:crypto/fs/url).
 * Copying its built ESM + d.ts into publish/browser/dist avoids a new tsup
 * entry, a bundle-dts-generator pass, and a shebang dance (cli.js keeps its
 * `#!/usr/bin/env node`). The browser-safe entries (providers-flitro.js /
 * chat.js) never import this code, so assert-exports' node-cleanliness gate
 * stays green.
 *
 * Result: @percena/weft gains `./api-graph` (import { generateGraph }) and the
 * `weft-api-graph` bin — the skill generates a per-spec graph via
 * `npx weft-api-graph … --verified` with NO extra devDep on the integrator's
 * side. The analyzer package stays internal (monorepo source) and is never
 * published to npm.
 */
import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PKG_DIST = resolve(__dirname, '..', 'dist')
const API_GRAPH_DIST = resolve(__dirname, '..', '..', '..', 'packages', 'api-graph', 'dist')

const COPIES = [
  ['analyzer.js', 'api-graph.js'],
  ['analyzer.d.ts', 'api-graph.d.ts'],
  ['cli.js', 'api-graph-cli.js'], // self-contained ESM bin, shebang preserved
]

const failures = []
if (!existsSync(API_GRAPH_DIST)) {
  console.error(`[copy-api-graph] source missing: ${API_GRAPH_DIST} — run build:L0 (the analyzer) first`)
  process.exit(1)
}
mkdirSync(PKG_DIST, { recursive: true })
for (const [src, dst] of COPIES) {
  const from = resolve(API_GRAPH_DIST, src)
  const to = resolve(PKG_DIST, dst)
  if (!existsSync(from)) { failures.push(`missing source: ${src}`); continue }
  cpSync(from, to)
  console.error(`[copy-api-graph] ${src} → dist/${dst}`)
}
if (failures.length) {
  console.error('[copy-api-graph] FAIL: ' + failures.join('; '))
  process.exit(1)
}
