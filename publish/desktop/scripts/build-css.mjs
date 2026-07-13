#!/usr/bin/env node
/**
 * Precompile the chat panel CSS for the desktop SDK so hosts (e.g. the
 * chat-playground Electron app) need no Tailwind toolchain of their own.
 *
 * Mirrors publish/browser/scripts/build-css.mjs but sources the desktop
 * package's own dist bundles (which use chunked names, so we @source every
 * dist/*.js). The compiled CSS is therefore complete by construction — every
 * class name the desktop-bundled TurnCard / chat panel emits is generated.
 *
 * Without this step the desktop package would ship only the raw UI theme
 * (unprocessed `@import "tailwindcss"` + `@source` directives), which a
 * consumer's browser cannot use directly — manifesting as unstyled chat
 * panels (oversized icons, missing layout) while the host's own Tailwind-styled
 * UI renders fine.
 *
 * Two entrypoints are emitted:
 *   - styles/index.css — full theme INCLUDING KaTeX (math) @font-face + woff2
 *     fonts. Default for `import '@percena/weft-node/styles'`.
 *   - styles/core.css  — panel theme only, no KaTeX. Opt-in subpath
 *     `import '@percena/weft-node/styles/core'`.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, statSync, readFileSync, writeFileSync, cpSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(pkgRoot, '..', '..')
const require = createRequire(import.meta.url)

const uiCss = resolve(repoRoot, 'packages', 'ui', 'src', 'styles', 'index.css')
const distDir = resolve(pkgRoot, 'dist')
const stylesDir = resolve(distDir, 'styles')
const output = resolve(stylesDir, 'index.css')
const coreOutput = resolve(stylesDir, 'core.css')
const fontsOutput = resolve(stylesDir, 'fonts')

if (!existsSync(uiCss)) {
  console.error(`✗ UI theme CSS not found: ${uiCss}`)
  process.exit(1)
}

// Resolve the tailwindcss CLI binary. It ships via @tailwindcss/cli; with pnpm
// it may be hoisted to either the package or the workspace root node_modules.
function findTailwindBin() {
  const candidates = [
    resolve(pkgRoot, 'node_modules', '.bin', 'tailwindcss'),
    resolve(repoRoot, 'node_modules', '.bin', 'tailwindcss'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  throw new Error(
    `tailwindcss CLI binary not found. Install @tailwindcss/cli in publish/desktop.`,
  )
}

const katexCss = (() => {
  try {
    return require.resolve('katex/dist/katex.min.css')
  } catch {
    console.error('✗ katex not resolvable; add katex to publish/desktop devDependencies')
    process.exit(1)
  }
})()
const katexFonts = resolve(dirname(katexCss), 'fonts')

// Build a temp input that imports the UI theme and sources every dist bundle
// so Tailwind generates exactly the utilities the chat panel emits. Desktop
// uses chunked bundle names (chunk-*.js), so source all dist/*.js rather than a
// fixed named list.
const buildDir = resolve(pkgRoot, '.css-build')
const input = resolve(buildDir, 'input.css')
const coreInput = resolve(buildDir, 'core-input.css')
const uiCoreCss = resolve(buildDir, 'ui-core.css') // ui theme w/ the katex @import stripped
mkdirSync(buildDir, { recursive: true })

const sourceBundles = readdirSync(distDir)
  .filter((name) => name.endsWith('.js'))
  .map((name) => resolve(distDir, name))
  .filter(existsSync)

if (sourceBundles.length === 0) {
  console.error('✗ No dist/*.js bundles found to @source — run tsup first.')
  process.exit(1)
}

function writeInput(path, themeImport) {
  writeFileSync(
    path,
    [
      `@import ${JSON.stringify(themeImport)};`,
      ...sourceBundles.map((p) => `@source ${JSON.stringify(p)};`),
      '',
    ].join('\n'),
  )
}
writeInput(input, uiCss)

// Strip the katex @import from the UI theme for the core (math-free) build.
const KATEX_IMPORT_RE = /^\s*@import\s+["']katex\/dist\/katex\.min\.css["'];?\s*$/gm
const uiCoreSource = readFileSync(uiCss, 'utf8').replace(KATEX_IMPORT_RE, '')
if (uiCoreSource.includes('katex/dist/katex.min.css')) {
  console.error('✗ could not strip katex @import from UI theme for core.css')
  process.exit(1)
}
writeFileSync(uiCoreCss, uiCoreSource, 'utf8')
writeInput(coreInput, uiCoreCss)

const bin = findTailwindBin()
function runTailwind(infile, outfile) {
  execFileSync(bin, ['-i', infile, '-o', outfile, '--minify'], {
    cwd: pkgRoot,
    env: {
      ...process.env,
      NODE_OPTIONS: [process.env.NODE_OPTIONS, '--no-deprecation'].filter(Boolean).join(' '),
    },
    stdio: 'inherit',
  })
}
runTailwind(input, output)
runTailwind(coreInput, coreOutput)

const size = statSync(output).size
if (size < 10_000) {
  console.error(`✗ ${output} is suspiciously small (${size} bytes) — Tailwind likely saw no sources`)
  process.exit(1)
}
const coreSize = statSync(coreOutput).size
if (coreSize < 10_000) {
  console.error(`✗ ${coreOutput} is suspiciously small (${coreSize} bytes) — Tailwind likely saw no sources`)
  process.exit(1)
}

// Ship KaTeX math fonts in woff2 only — keep only the woff2 src per @font-face.
const srcRe =
  /(url\([^)]*\.woff2\)format\(["']?woff2["']?\)),url\([^)]*\.woff\)format\(["']?woff["']?\),url\([^)]*\.ttf\)format\(["']?truetype["']?\)/g
let cssSource = readFileSync(output, 'utf8')
const beforeFaces = (cssSource.match(/@font-face/g) || []).length
cssSource = cssSource.replace(srcRe, '$1')
const leftoverWoff = (cssSource.match(/format\(["']?woff["']?\)/g) || []).length
const leftoverTtf = (cssSource.match(/format\(["']?truetype["']?\)/g) || []).length
if (leftoverWoff !== 0 || leftoverTtf !== 0) {
  console.error(
    `✗ @font-face strip left ${leftoverWoff} woff + ${leftoverTtf} truetype format() refs ` +
      `(${beforeFaces} faces) — KaTeX CSS @font-face structure changed?`,
  )
  process.exit(1)
}
writeFileSync(output, cssSource)

// core.css must be math-free.
const coreSource = readFileSync(coreOutput, 'utf8')
if (coreSource.includes('KaTeX_')) {
  const faces = (coreSource.match(/KaTeX_[A-Za-z-]+/g) || []).length
  console.error(
    `✗ core.css references KaTeX (${faces} font rule(s)) — the katex @import was not fully stripped; ` +
      `core.css must be math-free (integrators opting out of KaTeX expect no KaTeX font fetches).`,
  )
  process.exit(1)
}

if (!existsSync(katexFonts)) {
  console.error(`✗ KaTeX fonts not found: ${katexFonts}`)
  process.exit(1)
}
rmSync(fontsOutput, { recursive: true, force: true })
mkdirSync(fontsOutput, { recursive: true })
const woff2Fonts = readdirSync(katexFonts).filter((name) => /^KaTeX_.*\.woff2$/.test(name))
for (const name of woff2Fonts) {
  cpSync(resolve(katexFonts, name), resolve(fontsOutput, name))
}
const fontCount = readdirSync(fontsOutput).filter((name) => /^KaTeX_/.test(name)).length
if (fontCount === 0) {
  console.error(`✗ KaTeX woff2 fonts were not copied to ${fontsOutput}`)
  process.exit(1)
}

rmSync(buildDir, { recursive: true, force: true })

const SIDE_EFFECT_DTS =
  `// Type declaration for the '@percena/weft-node/styles{,/core}' side-effect entries.\n` +
  `// Importing injects the precompiled theme CSS; there are no runtime exports.\n` +
  `export {}\n`
writeFileSync(resolve(stylesDir, 'index.d.ts'), SIDE_EFFECT_DTS, 'utf8')
writeFileSync(resolve(stylesDir, 'core.d.ts'), SIDE_EFFECT_DTS, 'utf8')

console.log(`✓ Precompiled dist/styles/index.css (${(size / 1024).toFixed(1)} KB, @font-face src stripped to woff2)`)
console.log(`✓ Precompiled dist/styles/core.css (${(coreSize / 1024).toFixed(1)} KB, math-free — no KaTeX)`)
console.log(`✓ Copied ${fontCount} KaTeX woff2 fonts → dist/styles/fonts/`)
console.log(`✓ Wrote dist/styles/index.d.ts + core.d.ts (side-effect type declarations)`)
