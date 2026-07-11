import { describe, expect, test, beforeEach, afterEach } from 'vitest'
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  createConfigWatcherManager,
  type ConfigWatchEventInput,
} from '@weft/host-services'

const TEST_DIR = join(tmpdir(), `weft-watcher-test-${Date.now()}`)

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true })
})

afterEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true })
})

describe('Config File Watcher', () => {
  test('creates watcher manager in stopped state', () => {
    const watcher = createConfigWatcherManager({
      workspaceId: 'ws-1',
      files: [],
      callbacks: { onConfigChange: () => {} },
    })
    expect(watcher.watching).toBe(false)
  })

  test('start activates watching', () => {
    const configPath = join(TEST_DIR, 'permissions.json')
    writeFileSync(configPath, '{}')

    const watcher = createConfigWatcherManager({
      workspaceId: 'ws-1',
      files: [{ path: configPath, kind: 'policy' }],
      callbacks: { onConfigChange: () => {} },
    })

    watcher.start()
    expect(watcher.watching).toBe(true)
    watcher.stop()
    expect(watcher.watching).toBe(false)
  })

  test('detects file update', async () => {
    const configPath = join(TEST_DIR, 'permissions.json')
    writeFileSync(configPath, '{"v":1}')

    const events: ConfigWatchEventInput[] = []

    const watcher = createConfigWatcherManager({
      workspaceId: 'ws-1',
      files: [{ path: configPath, kind: 'policy' }],
      callbacks: {
        onConfigChange(event) { events.push(event) },
      },
      debounceMs: 50,
    })

    watcher.start()

    await new Promise(resolve => setTimeout(resolve, 50))

    writeFileSync(configPath, '{"v":2}')

    await new Promise(resolve => setTimeout(resolve, 500))

    watcher.stop()

    expect(events.length).toBeGreaterThanOrEqual(1)
    const event = events[0]!
    expect(event.configKind).toBe('policy')
    expect(event.action).toBe('updated')
    expect(event.source).toBe('file_watcher')
    expect(event.previousHash).toBeDefined()
    expect(event.nextHash).toBeDefined()
    expect(event.previousHash).not.toBe(event.nextHash)
  })

  test('does not fire for unchanged files', async () => {
    const configPath = join(TEST_DIR, 'unchanged.json')
    writeFileSync(configPath, '{"v":1}')

    const events: ConfigWatchEventInput[] = []

    const watcher = createConfigWatcherManager({
      workspaceId: 'ws-1',
      files: [{ path: configPath, kind: 'source' }],
      callbacks: {
        onConfigChange(event) { events.push(event) },
      },
      debounceMs: 50,
    })

    watcher.start()
    await new Promise(resolve => setTimeout(resolve, 150))
    watcher.stop()

    expect(events).toHaveLength(0)
  })

  test('handles non-existent file gracefully', () => {
    const watcher = createConfigWatcherManager({
      workspaceId: 'ws-1',
      files: [{ path: join(TEST_DIR, 'nope.json'), kind: 'skill' }],
      callbacks: { onConfigChange: () => {} },
    })

    expect(() => watcher.start()).not.toThrow()
    watcher.stop()
  })

  test('stop clears watchers and timers', () => {
    const configPath = join(TEST_DIR, 'stoptest.json')
    writeFileSync(configPath, '{}')

    const watcher = createConfigWatcherManager({
      workspaceId: 'ws-1',
      files: [{ path: configPath, kind: 'policy' }],
      callbacks: { onConfigChange: () => {} },
    })

    watcher.start()
    watcher.stop()
    expect(watcher.watching).toBe(false)
  })
})
