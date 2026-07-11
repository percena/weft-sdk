/**
 * Build Validation Script
 *
 * Verifies that all published packages produce correct dist output:
 * - @percena/weft (browser facade) is ESM-only: .js + .d.ts per entry (no
 *   .cjs/.d.cts since 0.5.0-next.0); @percena/weft-node (desktop facade) is
 *   ESM-only too (no .cjs/.d.cts); @weft/* internal packages still ship dual
 *   ESM (.js) + CJS (.cjs) + DTS (.d.ts, .d.cts)
 * - CSS copied for @weft/ui
 * - No .ts extension leaks in .d.ts files
 * - Key exports are importable
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

interface PackageCheck {
  name: string
  dir: string
  expectedFiles: string[]
  smokeImport?: string
  smokeExport?: string
}

const standardDist = ['index.js', 'index.cjs', 'index.d.ts', 'index.d.cts']

const packages: PackageCheck[] = [
  // Phase 1 packages
  { name: '@weft/timeline', dir: 'packages/timeline/dist', expectedFiles: standardDist,
    smokeImport: 'packages/timeline/dist/index.js', smokeExport: 'createTimelineSequencer' },
  { name: '@weft/core', dir: 'packages/core/dist',
    expectedFiles: [
      ...standardDist,
      'types/index.js', 'types/index.cjs', 'types/index.d.ts', 'types/index.d.cts',
      'utils/index.js', 'utils/index.cjs', 'utils/index.d.ts', 'utils/index.d.cts',
    ],
    smokeImport: 'packages/core/dist/index.js', smokeExport: 'generateMessageId' },
  { name: '@weft/runtime-core', dir: 'packages/runtime-core/dist', expectedFiles: standardDist,
    smokeImport: 'packages/runtime-core/dist/index.js', smokeExport: 'reduceRuntimeState' },
  { name: '@weft/ui', dir: 'packages/ui/dist',
    expectedFiles: [
      ...standardDist,
      'lib/en-fallback.js', 'lib/en-fallback.cjs', 'lib/en-fallback.d.ts', 'lib/en-fallback.d.cts',
      'styles/index.css',
    ] },
  { name: '@weft/chat', dir: 'packages/chat/dist', expectedFiles: standardDist },

  // Phase 2 packages
  { name: '@weft/host-services', dir: 'packages/host-services/dist', expectedFiles: standardDist },
  { name: '@weft/policy', dir: 'packages/policy/dist', expectedFiles: standardDist },
  { name: '@weft/automations', dir: 'packages/automations/dist', expectedFiles: standardDist },
  { name: '@weft/adapter', dir: 'packages/adapter/dist',
    expectedFiles: [
      ...standardDist,
      'auth/index.js', 'auth/index.cjs', 'auth/index.d.ts', 'auth/index.d.cts',
    ] },
  { name: '@weft/sources', dir: 'packages/sources/dist', expectedFiles: standardDist },
  { name: '@weft/skills', dir: 'packages/skills/dist', expectedFiles: standardDist },
  { name: '@weft/cli-runtime', dir: 'packages/cli-runtime/dist', expectedFiles: standardDist },
  { name: '@weft/providers', dir: 'packages/providers/dist',
    expectedFiles: [
      'flitro.js', 'flitro.cjs', 'flitro.d.ts', 'flitro.d.cts',
      'claude.js', 'claude.cjs', 'claude.d.ts', 'claude.d.cts',
      'codex.js', 'codex.cjs', 'codex.d.ts', 'codex.d.cts',
      'factory.js', 'factory.cjs', 'factory.d.ts', 'factory.d.cts',
      'shared.js', 'shared.cjs', 'shared.d.ts', 'shared.d.cts',
    ] },

  // Publish facades — both ESM-only since 0.5.0-next.0 (no .cjs/.d.cts).
  { name: '@percena/weft', dir: 'publish/browser/dist',
    expectedFiles: [
      'index.js', 'index.d.ts',
      'chat.js', 'chat.d.ts',
      'providers-flitro.js', 'providers-flitro.d.ts',
      'action-bridge.js', 'action-bridge.d.ts',
      'styles/index.css',
      'styles/index.d.ts',
    ] },
  { name: '@percena/weft-node', dir: 'publish/desktop/dist',
    expectedFiles: [
      'index.js', 'index.d.ts',
      'chat.js', 'chat.d.ts',
      'providers-claude.js', 'providers-claude.d.ts',
      'providers-codex.js', 'providers-codex.d.ts',
      'providers-flitro.js', 'providers-flitro.d.ts',
      'runtime.js', 'runtime.d.ts',
      'cli-runtime.js', 'cli-runtime.d.ts',
      'skills.js', 'skills.d.ts',
      'sources.js', 'sources.d.ts',
      'automations.js', 'automations.d.ts',
      'policy.js', 'policy.d.ts',
      'styles/index.css',
      'styles/index.d.ts',
    ] },
]

let passed = 0
let failed = 0

function check(condition: boolean, message: string): void {
  if (condition) {
    passed++
    console.log(`  ✅ ${message}`)
  } else {
    failed++
    console.error(`  ❌ ${message}`)
  }
}

function findDtsFiles(dir: string): string[] {
  const results: string[] = []
  if (!existsSync(dir)) return results
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      results.push(...findDtsFiles(fullPath))
    } else if (entry.name.endsWith('.d.ts') || entry.name.endsWith('.d.cts')) {
      results.push(fullPath)
    }
  }
  return results
}

for (const pkg of packages) {
  console.log(`\n📦 ${pkg.name}`)
  const distDir = join(ROOT, pkg.dir)

  check(existsSync(distDir), `dist/ directory exists`)

  for (const file of pkg.expectedFiles) {
    const filePath = join(distDir, file)
    const exists = existsSync(filePath)
    check(exists, `${file} exists`)
    if (exists && !file.endsWith('.css')) {
      const stat = statSync(filePath)
      check(stat.size > 0, `${file} is non-empty (${stat.size} bytes)`)
    }
  }

  const dtsFiles = findDtsFiles(distDir)
  let tsExtensionLeaks = 0
  for (const dtsFile of dtsFiles) {
    const content = readFileSync(dtsFile, 'utf-8')
    const tsImportPattern = /(?:from|import)\s+['"]([^'"]*\.ts)['"]/g
    let match
    while ((match = tsImportPattern.exec(content)) !== null) {
      if (!match[1].endsWith('.d.ts') && !match[1].endsWith('.cts')) {
        tsExtensionLeaks++
      }
    }
  }
  check(tsExtensionLeaks === 0, `No .ts extension leaks in ${dtsFiles.length} .d.ts files`)
}

// Import smoke tests
console.log('\n🧪 Import smoke tests')

const smokeTests = packages.filter((p) => p.smokeImport && p.smokeExport)
for (const pkg of smokeTests) {
  try {
    const mod = await import(join(ROOT, pkg.smokeImport!))
    check(typeof mod[pkg.smokeExport!] === 'function', `${pkg.name} exports ${pkg.smokeExport}`)
  } catch (e) {
    check(false, `${pkg.name} import failed: ${e}`)
  }
}

// Additional sub-path smoke tests
try {
  const coreUtils = await import(join(ROOT, 'packages/core/dist/utils/index.js'))
  check(typeof coreUtils.normalizePath === 'function', '@weft/core/utils exports normalizePath')
} catch (e) {
  check(false, `@weft/core/utils import failed: ${e}`)
}

try {
  const adapterAuth = await import(join(ROOT, 'packages/adapter/dist/auth/index.js'))
  check(typeof adapterAuth === 'object', '@weft/adapter/auth exports successfully')
} catch (e) {
  check(false, `@weft/adapter/auth import failed: ${e}`)
}

// Desktop runtime facade — provider-owned auth detection re-exports (@weft/adapter)
try {
  const desktopRuntime = await import(join(ROOT, 'publish/desktop/dist/runtime.js'))
  check(typeof desktopRuntime.createHostAgentRuntime === 'function', '@percena/weft-node/runtime exports createHostAgentRuntime')
  check(typeof desktopRuntime.readClaudeAuth === 'function', '@percena/weft-node/runtime exports readClaudeAuth')
  check(typeof desktopRuntime.readCodexAuth === 'function', '@percena/weft-node/runtime exports readCodexAuth')
} catch (e) {
  check(false, `@percena/weft-node/runtime import failed: ${e}`)
}

// Summary
console.log(`\n${'═'.repeat(50)}`)
console.log(`Results: ${passed} passed, ${failed} failed`)
console.log(`Packages: ${packages.length} validated (14 internal + 2 publish facades, e2e-tests excluded)`)
if (failed > 0) {
  process.exit(1)
}
console.log('🎉 All build validation checks passed!')
