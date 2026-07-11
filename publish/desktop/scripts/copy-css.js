import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const STYLES_DTS = `// Type declaration for the '@percena/weft-node/styles{,/core}' side-effect entry.
// Importing it injects the theme CSS (custom properties); there are no
// runtime exports.
export {}
`

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(pkgRoot, '..', '..')
const dest = resolve(pkgRoot, 'dist', 'styles')
mkdirSync(dest, { recursive: true })

const rawTheme = resolve(repoRoot, 'packages', 'ui', 'src', 'styles', 'index.css')

if (!existsSync(rawTheme)) {
  console.error('✗ Source CSS not found:', rawTheme)
  process.exit(1)
}

cpSync(rawTheme, resolve(dest, 'index.css'))
console.log('✓ Copied raw theme CSS → dist/styles/')

// core.css: math-free variant (katex @import stripped) for the opt-in
// `./styles/core` subpath. Integrators who don't render math skip the KaTeX
// font fetches entirely.
const KATEX_IMPORT_RE = /^\s*@import\s+["']katex\/dist\/katex\.min\.css["'];?\s*$/gm
const coreSource = readFileSync(rawTheme, 'utf8').replace(KATEX_IMPORT_RE, '')
if (coreSource.includes('katex/dist/katex.min.css')) {
  console.error('✗ could not strip katex @import from raw theme for core.css')
  process.exit(1)
}
writeFileSync(resolve(dest, 'core.css'), coreSource, 'utf8')
console.log('✓ Wrote core.css (math-free) → dist/styles/')

writeFileSync(resolve(dest, 'index.d.ts'), STYLES_DTS, 'utf8')
writeFileSync(resolve(dest, 'core.d.ts'), STYLES_DTS, 'utf8')
console.log('✓ Wrote styles/index.d.ts + core.d.ts (side-effect type declarations)')

const fontsSource = resolve(dirname(rawTheme), 'fonts')
const fontsDest = resolve(dest, 'fonts')
if (existsSync(fontsSource)) {
  cpSync(fontsSource, fontsDest, { recursive: true })
  console.log('✓ Copied KaTeX fonts → dist/styles/fonts/')
}
