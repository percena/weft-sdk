import { watch, existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import type { FSWatcher } from 'node:fs'
import type { ConfigKind, ConfigWatchAction, ConfigWatchEventInput } from './config.ts'

export interface WatchedConfigFile {
  path: string
  kind: ConfigKind
}

export interface ConfigWatcherCallbacks {
  onConfigChange(event: ConfigWatchEventInput): void
  onError?(error: Error): void
}

export interface ConfigWatcherManager {
  start(): void
  stop(): void
  readonly watching: boolean
}

export interface CreateConfigWatcherOptions {
  workspaceId: string
  files: WatchedConfigFile[]
  callbacks: ConfigWatcherCallbacks
  debounceMs?: number
  now?: () => number
}

export function createConfigWatcherManager(
  options: CreateConfigWatcherOptions,
): ConfigWatcherManager {
  const watchers: FSWatcher[] = []
  const hashes = new Map<string, string>()
  const debounceMs = options.debounceMs ?? 300
  const now = options.now ?? Date.now
  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()
  let active = false

  function hashFile(path: string): string | undefined {
    try {
      if (!existsSync(path)) return undefined
      const content = readFileSync(path, 'utf-8')
      return createHash('sha256').update(content).digest('hex').slice(0, 16)
    } catch {
      return undefined
    }
  }

  function handleChange(file: WatchedConfigFile): void {
    const existing = debounceTimers.get(file.path)
    if (existing) clearTimeout(existing)

    debounceTimers.set(file.path, setTimeout(() => {
      debounceTimers.delete(file.path)
      if (!active) return

      const previousHash = hashes.get(file.path)
      const nextHash = hashFile(file.path)

      if (previousHash === nextHash) return

      let action: ConfigWatchAction
      if (!previousHash && nextHash) action = 'created'
      else if (previousHash && !nextHash) action = 'deleted'
      else action = 'updated'

      if (nextHash) {
        hashes.set(file.path, nextHash)
      } else {
        hashes.delete(file.path)
      }

      options.callbacks.onConfigChange({
        workspaceId: options.workspaceId,
        configPath: file.path,
        configKind: file.kind,
        action,
        source: 'file_watcher',
        timestamp: now(),
        previousHash,
        nextHash,
      })
    }, debounceMs))
  }

  return {
    get watching() { return active },

    start() {
      if (active) return
      active = true

      for (const file of options.files) {
        const initialHash = hashFile(file.path)
        if (initialHash) hashes.set(file.path, initialHash)

        try {
          const watcher = watch(file.path, { persistent: false }, () => {
            handleChange(file)
          })
          watcher.on('error', (err) => {
            options.callbacks.onError?.(err)
          })
          watchers.push(watcher)
        } catch {
          // File may not exist yet — that's fine, we'll detect creation
          // by watching the parent directory in a future enhancement
        }
      }
    },

    stop() {
      active = false
      for (const watcher of watchers) {
        watcher.close()
      }
      watchers.length = 0
      for (const timer of debounceTimers.values()) {
        clearTimeout(timer)
      }
      debounceTimers.clear()
    },
  }
}
