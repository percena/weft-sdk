/**
 * Electron main process for the chat-playground desktop demo.
 *
 * Drives the local Coding Agent runtime (@percena/weft-node/runtime) in-process
 * — no server, no remote URL. The renderer (existing React UI) talks to this
 * process over IPC; this process owns the agent runtime, streams TimelineEnvelope
 * events to the renderer, and forwards send / abort / permission decisions.
 *
 * See docs §6. This is the Stack-B reference demo: a Node main process reusing
 * the weft-node runtime directly, with the React chat UI in the renderer.
 */
import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { readdirSync, statSync } from 'node:fs'
import {
  createHostAgentRuntime,
  detectRuntimeCandidates,
} from '@percena/weft-node/runtime'
import type { HostAgentRuntimeResult } from '@percena/weft-node/runtime'
import type { TimelineEnvelope } from '@percena/weft-node'
import {
  IPC,
  type StartSessionOptions,
  type StartSessionResult,
  type SendMessageOptions,
  type RespondPermissionOptions,
  type AbortOptions,
  type DisconnectOptions,
  type FsBrowseResult,
  type FsEntry,
  type LocalProvider,
} from '../shared/ipc-contract'

const __dirname = dirname(fileURLToPath(import.meta.url))

/** Active runtimes keyed by the UI session id (seeded into the runtime). */
const runtimes = new Map<string, HostAgentRuntimeResult & { disposed: boolean }>()

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: '#0b0c0f',
    title: 'Weft Desktop Demo',
    webPreferences: {
      preload: join(__dirname, '..', 'preload', 'index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  // Open external links in the system browser, not inside the demo window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  // Dev: electron-vite serves the renderer from a Vite dev server.
  // Prod: load the built renderer from the packaged output directory.
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void mainWindow.loadURL(devUrl)
  } else {
    void mainWindow.loadFile(join(__dirname, '..', 'renderer', 'index.html'))
  }

  // Tear down every live runtime when the window closes so no provider
  // subprocess or in-flight turn keeps running unobserved. On macOS the app
  // stays resident after the last window closes (window-all-closed keeps it
  // alive on darwin), so without this the runtime + subprocess would leak —
  // silently consuming provider API credit with no live UI — until an
  // explicit quit fires before-quit. disconnect() never touches the window
  // (only runtime.events/commands), and every events.connect callback guards
  // on mainWindow.isDestroyed(), so teardown is race-free against the stream.
  mainWindow.on('closed', () => {
    mainWindow = null
    for (const id of [...runtimes.keys()]) {
      void disconnect(id)
    }
  })
}

function resolveProviderOptions(options: StartSessionOptions) {
  const common = {
    model: options.model,
    reasoningEffort: options.reasoningEffort,
    permissionMode: options.permissionMode,
  }
  return options.provider === 'claude'
    ? { claude: common }
    : { codex: common }
}

async function startSession(options: StartSessionOptions): Promise<StartSessionResult> {
  // Tear down any prior runtime for this session id (e.g. reconnect after error).
  await disconnect(options.sessionId)

  const detected = await detectRuntimeCandidates({ provider: options.provider as LocalProvider })
  const result = createHostAgentRuntime({
    provider: options.provider as LocalProvider,
    cwd: options.cwd,
    sessionId: options.sessionId,
    candidates: detected.candidates,
    auth: detected.auth,
    allowFallback: true,
    ...resolveProviderOptions(options),
  })

  const entry = { ...result, disposed: false }
  runtimes.set(options.sessionId, entry)

  // Stream every TimelineEnvelope to the renderer as it is produced.
  result.runtime.events.connect(
    (envelope: TimelineEnvelope) => {
      if (!mainWindow || mainWindow.isDestroyed()) return
      mainWindow.webContents.send(IPC.ENVELOPE, {
        sessionId: options.sessionId,
        envelope,
      })
    },
    (error: Error) => {
      if (!mainWindow || mainWindow.isDestroyed()) return
      mainWindow.webContents.send(IPC.STREAM_ERROR, {
        sessionId: options.sessionId,
        error: error.message,
      })
    },
    () => {
      if (!mainWindow || mainWindow.isDestroyed()) return
      mainWindow.webContents.send(IPC.STREAM_CLOSED, {
        sessionId: options.sessionId,
        closed: true,
      })
    },
  )

  // Preflight returns the capability report (provider / selected backend /
  // fallback / auth). Forward once so the UI can render it without parsing the
  // timeline. The same report also arrives as a timeline envelope.
  let capabilityReport: unknown
  try {
    capabilityReport = await result.runtime.preflight()
    if (!mainWindow?.isDestroyed()) {
      mainWindow?.webContents.send(IPC.CAPABILITY, {
        sessionId: options.sessionId,
        report: capabilityReport,
      })
    }
  } catch {
    // preflight failure is non-fatal; the runtime may still serve turns.
  }

  return { ok: true, capabilityReport }
}

async function sendMessage(options: SendMessageOptions): Promise<void> {
  const entry = runtimes.get(options.sessionId)
  if (!entry || entry.disposed) {
    throw new Error('Session is not running')
  }
  await entry.runtime.commands.sendMessage(options.message, {
    ...(options.model ? { model: options.model } : {}),
    ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort as 'low' | 'medium' | 'high' | 'xhigh' | 'max' } : {}),
    ...(options.permissionMode ? { permissionMode: options.permissionMode } : {}),
  })
}

async function abortTurn(options: AbortOptions): Promise<void> {
  const entry = runtimes.get(options.sessionId)
  if (!entry || entry.disposed) return
  await entry.runtime.commands.abort(options.reason)
}

async function respondToPermission(options: RespondPermissionOptions): Promise<void> {
  const entry = runtimes.get(options.sessionId)
  if (!entry || entry.disposed) return
  await entry.runtime.commands.respondToPermission(
    options.requestId,
    options.allowed,
    options.remember,
  )
}

async function disconnect(sessionId: string): Promise<void> {
  const entry = runtimes.get(sessionId)
  if (!entry) return
  entry.disposed = true
  try {
    entry.runtime.events.disconnect()
  } catch {
    // ignore — best-effort teardown
  }
  try {
    await entry.runtime.commands.dispose()
  } catch {
    // ignore — best-effort teardown
  }
  runtimes.delete(sessionId)
}

async function disconnectHandler(options: DisconnectOptions): Promise<void> {
  await disconnect(options.sessionId)
}

/** Browse the local filesystem (replaces the demo's former remote /fs/browse). */
async function fsBrowse(path?: string): Promise<FsBrowseResult> {
  const target = path ?? homedir()
  try {
    const entries = readdirSync(target, { withFileTypes: true })
        .filter((dirent) => dirent.name !== '.DS_Store')
        .map<FsEntry>((dirent) => {
          const fullPath = resolve(target, dirent.name)
          let size: number | undefined
          let type: 'file' | 'directory' = 'directory'
          try {
            const stat = statSync(fullPath)
            type = dirent.isDirectory() ? 'directory' : 'file'
            if (type === 'file') size = stat.size
          } catch {
            type = dirent.isDirectory() ? 'directory' : 'file'
          }
          return { name: dirent.name, path: fullPath, type, ...(size !== undefined ? { size } : {}) }
        })
        .sort((a, b) => {
          if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
          return a.name.localeCompare(b.name)
        })
    const parent = dirname(target)
    return {
      currentPath: target,
      parentPath: parent === target ? null : parent,
      entries,
    }
  } catch (err) {
    return {
      currentPath: target,
      parentPath: null,
      entries: [],
      reason: (err as Error).message,
    }
  }
}

function registerIpc(): void {
  ipcMain.handle(IPC.START_SESSION, (_event, options: StartSessionOptions) =>
    startSession(options).catch((err: Error) => ({ ok: false, error: err.message })) as Promise<StartSessionResult>,
  )
  ipcMain.handle(IPC.SEND_MESSAGE, (_event, options: SendMessageOptions) =>
    sendMessage(options))
  ipcMain.handle(IPC.ABORT, (_event, options: AbortOptions) =>
    abortTurn(options))
  ipcMain.handle(IPC.RESPOND_PERMISSION, (_event, options: RespondPermissionOptions) =>
    respondToPermission(options))
  ipcMain.handle(IPC.DISCONNECT, (_event, options: DisconnectOptions) =>
    disconnectHandler(options),
  )
  ipcMain.handle(IPC.FS_BROWSE, (_event, path?: string) => fsBrowse(path))
}

app.whenReady().then(() => {
  registerIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  // On macOS apps usually stay open until explicit quit; the demo follows suit.
  if (process.platform !== 'darwin') app.quit()
})

// Best-effort cleanup of any live runtimes on quit.
app.on('before-quit', () => {
  for (const id of [...runtimes.keys()]) {
    void disconnect(id)
  }
})
