import { describe, it, expect } from 'vitest'
import { readFileSync, mkdtempSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCli } from './cli.js'

// The real shop OpenAPI spec — the same fixture shop.test.ts uses to validate
// the analyzer. Exercising runCli against it covers the --verified CLI path on
// a non-trivial spec (15 nodes, 18 edges).
const specPath = fileURLToPath(new URL('../fixtures/shop-openapi.json', import.meta.url))
const tmpDir = mkdtempSync(join(tmpdir(), 'weft-api-graph-cli-'))

describe('weft-api-graph CLI (runCli)', () => {
  it('--verified / -v signs the fail-open draft (graph + every edge)', () => {
    const out = join(tmpDir, 'verified.json')
    expect(runCli([specPath, 'shop', out, '--verified'])).toBe(0)
    const g = JSON.parse(readFileSync(out, 'utf8'))
    expect(g.verified).toBe(true)
    expect(g.edges.length).toBeGreaterThan(0)
    expect(g.edges.every((e: { verified?: boolean }) => e.verified === true)).toBe(true)
    expect(g.nodes.length).toBe(15)
    expect(g.edges.length).toBe(18)
  })

  it('-v is equivalent to --verified', () => {
    const out = join(tmpDir, 'v-short.json')
    expect(runCli([specPath, 'shop', out, '-v'])).toBe(0)
    const g = JSON.parse(readFileSync(out, 'utf8'))
    expect(g.verified).toBe(true)
    expect(g.edges.every((e: { verified?: boolean }) => e.verified === true)).toBe(true)
  })

  it('without --verified emits verified:false (PR-review draft)', () => {
    const out = join(tmpDir, 'draft.json')
    expect(runCli([specPath, 'shop', out])).toBe(0)
    const g = JSON.parse(readFileSync(out, 'utf8'))
    expect(g.verified).toBe(false)
    // No edge is signed in the draft (review hasn't happened yet).
    expect(g.edges.some((e: { verified?: boolean }) => e.verified === true)).toBe(false)
  })

  it('flags may appear anywhere among positionals', () => {
    const out = join(tmpDir, 'flag-first.json')
    expect(runCli(['--verified', specPath, 'shop', out])).toBe(0)
    const g = JSON.parse(readFileSync(out, 'utf8'))
    expect(g.verified).toBe(true)
  })

  it('returns 1 (usage error) on missing positional args', () => {
    expect(runCli([])).toBe(1)
    expect(runCli([specPath])).toBe(1) // toolset missing
    // --verified alone is not enough (no spec/toolset)
    expect(runCli(['--verified'])).toBe(1)
  })
})
