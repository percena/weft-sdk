import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, test } from 'vitest'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))

function publishDistPath(fileName: string): string {
  return resolve(repoRoot, 'publish/browser/dist', fileName)
}

function publishPackageJson(): {
  exports?: Record<string, unknown>
} {
  return JSON.parse(readFileSync(resolve(repoRoot, 'publish/browser/package.json'), 'utf8'))
}

describe('@percena/weft publish contract', () => {
  test('exports map contains only Tenant-facing subpaths', () => {
    const packageJson = publishPackageJson()
    // Node-only and platform-internal subpaths must NOT be in the exports map.
    expect(packageJson.exports?.['./server']).toBeUndefined()
    expect(packageJson.exports?.['./skills']).toBeUndefined()
    expect(packageJson.exports?.['./skills/browser']).toBeUndefined()
    expect(packageJson.exports?.['./sources']).toBeUndefined()
    expect(packageJson.exports?.['./automations']).toBeUndefined()
    expect(packageJson.exports?.['./factory']).toBeUndefined()
    expect(packageJson.exports?.['./providers']).toBeUndefined()
    expect(packageJson.exports?.['./auth']).toBeUndefined()
    expect(packageJson.exports?.['./local-runtime']).toBeUndefined()
    // Tenant-facing surface.
    expect(packageJson.exports?.['.']).toBeDefined()
    expect(packageJson.exports?.['./chat']).toBeDefined()
    expect(packageJson.exports?.['./providers/flitro']).toBeDefined()
    expect(packageJson.exports?.['./action-bridge']).toBeDefined()
    expect(packageJson.exports?.['./styles']).toBeDefined()
  })

  test('root entry exports only Tenant-facing runtime types and React integration', async () => {
    const root = await import(pathToFileURL(publishDistPath('index.js')).href)
    // Tenant-facing: hosted-mode React hooks and components.
    expect(typeof root.useAgentSession).toBe('function')
    expect(typeof root.TimelineAgentChatPanel).toBe('function')
    expect(typeof root.createFlitroEmbedRuntime).toBe('function')
    expect(typeof root.EN_FALLBACK).toBe('object')
    // Must NOT leak backend / platform-internal surface.
    expect(root.createPermissionPolicy).toBeUndefined()
    expect(root.evaluateToolPolicy).toBeUndefined()
    expect(root.resolvePathMentions).toBeUndefined()
    expect(root.parseMentions).toBeUndefined()
    expect(root.selectRuntimeCandidate).toBeUndefined()
    expect(root.invokeSessionTool).toBeUndefined()
  })

  test('typed-error surface is exported at runtime (WeftHttpError + readTurnFailedError)', async () => {
    // The documented error-handling contract: hosts branch on
    // `error instanceof WeftHttpError && error.code === '…'` for immediate
    // sends, and read queued-send failures via `readTurnFailedError`. A
    // bundling change that drops either silently breaks every integrator's
    // error path, so assert them at runtime, not just in the d.ts.
    const flitro = await import(pathToFileURL(publishDistPath('providers-flitro.js')).href)
    expect(typeof flitro.WeftHttpError).toBe('function')
    expect(typeof flitro.readTurnFailedError).toBe('function')
    const root = await import(pathToFileURL(publishDistPath('index.js')).href)
    expect(typeof root.readTurnFailedError).toBe('function')
  })

  test('root entry is browser-safe — no node: imports', () => {
    const output = readFileSync(publishDistPath('index.js'), 'utf8')
    expect(output).not.toMatch(/from ["']node:/)
    expect(output).not.toMatch(/require\(["']node:/)
  })

  test('publish outputs do not bundle gray-matter javascript eval parser', () => {
    for (const fileName of ['skills.js', 'server.js']) {
      const filePath = publishDistPath(fileName)
      try {
        const output = readFileSync(filePath, 'utf8')
        expect(output).not.toMatch(/return eval\(/)
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException)?.code
        if (code !== 'ENOENT') throw err
      }
    }
  })

  test('action-bridge subpath re-exports React glue', async () => {
    const ab = await import(pathToFileURL(publishDistPath('action-bridge.js')).href)
    expect(typeof ab.weftAction).toBe('function')
    expect(typeof ab.createActionBridge).toBe('function')
    expect(typeof ab.ActionReplayLayer).toBe('function')
    expect(typeof ab.useActionBridge).toBe('function')
  })

  test('chat output does not pull in full shiki language bundles through diff rendering', () => {
    const output = readFileSync(publishDistPath('chat.js'), 'utf8')
    expect(output).not.toContain('@pierre/diffs')
    expect(output).not.toContain('bundledLanguagesInfo')
    expect(output).not.toContain('emacs-lisp')
  })

  test('no @percena transitive dependencies in published package', () => {
    const packageJson = publishPackageJson()
    const deps = Object.keys((packageJson as Record<string, Record<string, string>>).dependencies ?? {})
    const percenaDeps = deps.filter(d => d.startsWith('@percena/'))
    expect(percenaDeps).toEqual([])
  })

  test('root .d.ts exports the shared timeline types', () => {
    const dts = readFileSync(publishDistPath('index.d.ts'), 'utf8')
    expect(dts).toContain('PermissionMode')
    expect(dts).toContain('TimelineEnvelope')
  })

  test('chat entry exports the shared processor + grouping surface', async () => {
    const chat = await import(pathToFileURL(publishDistPath('chat.js')).href)
    expect(typeof chat.processEvent).toBe('function')
    expect(typeof chat.mapTimelineEnvelopeToProcessorEvent).toBe('function')
    expect(typeof chat.groupMessagesByTurn).toBe('function')
    const dts = readFileSync(publishDistPath('chat.d.ts'), 'utf8')
    expect(dts).toContain('SessionState')
    expect(dts).toContain('ChatEvent')
  })

  test('dist emits no server surface (no createServer / listen)', () => {
    const distDir = resolve(repoRoot, 'publish/browser/dist')
    for (const file of readdirSync(distDir).filter(f => f.endsWith('.js'))) {
      const output = readFileSync(resolve(distDir, file), 'utf8')
      expect(output).not.toMatch(/\bcreateServer\b/)
      expect(output).not.toMatch(/\.listen\s*\(/)
    }
  })
})

function desktopDistPath(fileName: string): string {
  return resolve(repoRoot, 'publish/desktop/dist', fileName)
}

function desktopPackageJson(): {
  exports?: Record<string, unknown>
  dependencies?: Record<string, string>
} {
  return JSON.parse(readFileSync(resolve(repoRoot, 'publish/desktop/package.json'), 'utf8'))
}

// Subpaths the desktop (@percena/weft-node) package must expose. Mirrors
// publish/desktop/package.json#exports.
const desktopSubpaths = [
  '.', './chat',
  './providers/claude', './providers/codex',
  './runtime', './cli-runtime',
  './skills', './sources', './automations', './policy',
  './styles',
]

// Entry dist files the desktop build must emit (one per non-styles subpath).
const desktopDistFiles = [
  'index.js', 'chat.js',
  'providers-claude.js', 'providers-codex.js',
  'runtime.js', 'cli-runtime.js',
  'skills.js', 'sources.js', 'automations.js', 'policy.js',
]

describe('@percena/weft-node publish contract', () => {
  test('exports map exposes the full Node/desktop surface', () => {
    const exports = desktopPackageJson().exports ?? {}
    for (const subpath of desktopSubpaths) {
      expect(exports[subpath]).toBeDefined()
    }
  })

  test('every desktop entry dist file is emitted and non-empty', () => {
    for (const file of desktopDistFiles) {
      const filePath = desktopDistPath(file)
      expect(existsSync(filePath)).toBe(true)
      const size = statSync(filePath).size
      expect(size).toBeGreaterThan(0)
    }
  })

  test('SDK-free entries do not require the optional Claude SDK', () => {
    // providers-claude.d.ts is the normal Claude provider entry; it must stay
    // SDK-import-free so Codex-only and CLI-fallback hosts load without the
    // optional peer. Only the explicit ./providers/claude/sdk subpath may
    // reference @anthropic-ai/claude-agent-sdk.
    for (const file of ['runtime.d.ts', 'providers-codex.d.ts', 'providers-claude.d.ts']) {
      const declaration = readFileSync(desktopDistPath(file), 'utf8')
      expect(declaration).not.toContain("from '@anthropic-ai/claude-agent-sdk'")
      expect(declaration).not.toContain("from \"@anthropic-ai/claude-agent-sdk\"")
    }
  })

  test('no @percena transitive dependencies in desktop package', () => {
    const deps = Object.keys(desktopPackageJson().dependencies ?? {})
    const percenaDeps = deps.filter(d => d.startsWith('@percena/'))
    expect(percenaDeps).toEqual([])
  })

  test('desktop root entry loads and exports the shared chat surface', async () => {
    const root = await import(pathToFileURL(desktopDistPath('index.js')).href)
    expect(typeof root.useAgentSession).toBe('function')
    expect(typeof root.TimelineAgentChatPanel).toBe('function')
    expect(typeof root.EN_FALLBACK).toBe('object')
    // Local-only package: the remote-client runtime symbol must NOT leak here.
    expect(root.createFlitroEmbedRuntime).toBeUndefined()
    // Must NOT leak backend / platform-internal surface.
    expect(root.createPermissionPolicy).toBeUndefined()
    expect(root.evaluateToolPolicy).toBeUndefined()
    expect(root.selectRuntimeCandidate).toBeUndefined()
  })

  test('desktop runtime entry is local-only — no flitro surface leaks through ./runtime', async () => {
    // §5/§9: @percena/weft-node is local-only (claude + codex). The remote
    // weftd-client (flitro) runtime must not leak through ./runtime any more
    // than through the removed ./providers/flitro subpath. Guards the
    // HostRuntimeProvider union, the options type, and the built symbol
    // namespace against the flitro branch regressing back into the factory.
    const dts = readFileSync(desktopDistPath('runtime.d.ts'), 'utf8')
    expect(dts).not.toContain('HostRuntimeFlitroOptions')
    expect(dts).not.toContain('flitro?: HostRuntimeFlitroOptions')
    expect(dts).not.toMatch(/HostRuntimeProvider\s*=\s*[^;]*flitro/)

    const runtime = await import(pathToFileURL(desktopDistPath('runtime.js')).href)
    expect(typeof runtime.createHostAgentRuntime).toBe('function')
    expect(typeof runtime.detectRuntimeCandidates).toBe('function')
    expect(typeof runtime.readClaudeAuth).toBe('function')
    expect(typeof runtime.readCodexAuth).toBe('function')
    // The flitro provider/remote-client runtimes must not be re-exported here.
    expect(runtime.createFlitroProviderRuntime).toBeUndefined()
    expect(runtime.createFlitroEmbedRuntime).toBeUndefined()
  })

  test('desktop root .d.ts exports the shared timeline types', () => {
    const dts = readFileSync(desktopDistPath('index.d.ts'), 'utf8')
    expect(dts).toContain('PermissionMode')
    expect(dts).toContain('TimelineEnvelope')
  })

  test('desktop chat entry exports the shared processor + grouping surface', async () => {
    const chat = await import(pathToFileURL(desktopDistPath('chat.js')).href)
    expect(typeof chat.processEvent).toBe('function')
    expect(typeof chat.mapTimelineEnvelopeToProcessorEvent).toBe('function')
    expect(typeof chat.groupMessagesByTurn).toBe('function')
    const dts = readFileSync(desktopDistPath('chat.d.ts'), 'utf8')
    expect(dts).toContain('SessionState')
    expect(dts).toContain('ChatEvent')
  })

  test('desktop dist emits no server surface (no createServer / listen)', () => {
    const distDir = resolve(repoRoot, 'publish/desktop/dist')
    for (const file of readdirSync(distDir).filter(f => f.endsWith('.js'))) {
      const output = readFileSync(resolve(distDir, file), 'utf8')
      expect(output).not.toMatch(/\bcreateServer\b/)
      expect(output).not.toMatch(/\.listen\s*\(/)
    }
  })
})
