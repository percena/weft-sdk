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
import { readdirSync, readFileSync, statSync } from 'node:fs'
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
  type ListModelsResult,
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

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}

/** Normalize a raw effort value to the ReasoningEffort union, or undefined. */
function normalizeEffort(value: string | undefined): string | undefined {
  if (!value) return undefined
  const v = value.trim().toLowerCase()
  return ['low', 'medium', 'high', 'xhigh', 'max'].includes(v) ? v : undefined
}

/**
 * Read the `env` block from ~/.claude/settings.json (+ settings.local.json).
 *
 * The claude CLI applies this env block to its own process + children, but the
 * Electron main process is launched from a plain terminal and does NOT inherit
 * these vars — so reading process.env alone returns nothing for a compatible
 * gateway configured via settings.json. This surfaces the values the claude CLI
 * actually uses (ANTHROPIC_BASE_URL / token / model mapping / effort).
 */
function loadClaudeSettingsEnv(): Record<string, string> {
  const dir = process.env['CLAUDE_CONFIG_DIR'] || join(homedir(), '.claude')
  const merged: Record<string, string> = {}
  for (const name of ['settings.json', 'settings.local.json']) {
    try {
      const raw = readFileSync(join(dir, name), 'utf-8')
      const env = (JSON.parse(raw) as { env?: Record<string, string> }).env
      if (env && typeof env === 'object') Object.assign(merged, env)
    } catch {
      // missing or invalid file → skip
    }
  }
  return merged
}

/** Resolve a claude config value: process.env wins, then ~/.claude/settings.json env. */
function claudeEnv(key: string, settingsEnv: Record<string, string>): string | undefined {
  return process.env[key] || settingsEnv[key] || undefined
}

/**
 * Discover the real model list for a provider's compatible API endpoint.
 *
 * Hardcoded ids are wrong here: a compatible Anthropic/OpenAI endpoint serves
 * whatever the gateway exposes (e.g. glm-5.2, deepseek-v4-flash, qwen3-max),
 * NOT the official Anthropic/OpenAI catalog. We try the gateway's /v1/models
 * first (both Anthropic-native and OpenAI response shapes); on failure we fall
 * back to the provider's own config (env vars for Claude, ~/.codex/config.toml
 * for Codex) so the picker still shows real, reachable model ids. The renderer
 * defaults the picker to the provider's active model (`defaultModel`) and sends
 * it explicitly; if nothing is discoverable the picker is empty and turns send
 * no model so the SDK falls back to its own default.
 */
async function listModels(provider: LocalProvider): Promise<ListModelsResult> {
  if (provider === 'claude') {
    // claude config lives in ~/.claude/settings.json's env block (applied by the
    // claude CLI to its own children) — the Electron main process is launched
    // from a plain terminal and does NOT inherit those vars, so merge settings
    // env in as a fallback to process.env. ANTHROPIC_BASE_URL is set for a
    // compatible gateway; absent for official Anthropic auth, where we default
    // to the real api.anthropic.com so an ANTHROPIC_API_KEY user still gets the
    // live /v1/models catalog. (Pure claude-CLI oauth exposes no key we can
    // use, so that path falls through to source 'none' — the app then sends no
    // model and the SDK uses its own default.)
    const settingsEnv = loadClaudeSettingsEnv()
    const base = (claudeEnv('ANTHROPIC_BASE_URL', settingsEnv)?.replace(/\/+$/, '') || 'https://api.anthropic.com')
    const token = claudeEnv('ANTHROPIC_AUTH_TOKEN', settingsEnv) || claudeEnv('ANTHROPIC_API_KEY', settingsEnv)
    const defaultModel = claudeEnv('ANTHROPIC_MODEL', settingsEnv)
    const defaultEffort = normalizeEffort(claudeEnv('CLAUDE_CODE_EFFORT_LEVEL', settingsEnv) || claudeEnv('CLAUDE_EFFORT', settingsEnv))
    if (token) {
      try {
        const res = await fetch(`${base}/v1/models`, {
          headers: {
            'x-api-key': token,
            'authorization': `Bearer ${token}`,
            'anthropic-version': '2023-06-01',
          },
        })
        if (res.ok) {
          const json = (await res.json()) as { data?: Array<{ id?: string }> }
          const ids = unique((json.data ?? []).map(m => m.id).filter((v): v is string => !!v))
          if (ids.length) {
            return { models: ids, source: 'gateway', defaultModel, defaultEffort }
          }
        }
      } catch {
        // endpoint doesn't implement /v1/models (e.g. DashScope returns 404) → env fallback
      }
    }
    const envModels = unique([
      defaultModel,
      claudeEnv('ANTHROPIC_DEFAULT_SONNET_MODEL', settingsEnv),
      claudeEnv('ANTHROPIC_DEFAULT_OPUS_MODEL', settingsEnv),
      claudeEnv('ANTHROPIC_DEFAULT_HAIKU_MODEL', settingsEnv),
      claudeEnv('ANTHROPIC_DEFAULT_FABLE_MODEL', settingsEnv),
    ].filter((v): v is string => !!v))
    return {
      models: envModels,
      source: envModels.length ? 'env' : 'none',
      defaultModel,
      defaultEffort,
    }
  }

  // codex — read ~/.codex/config.toml + ~/.codex/auth.json.
  // Codex uses an OpenAI-compatible endpoint (config.toml [model_providers.X]
  // base_url + env_key), so discovery is the same as Anthropic: GET /v1/models.
  const codexDir = process.env['CODEX_HOME'] || join(homedir(), '.codex')
  let baseUrl = ''
  let envKey = ''
  let configModel = ''
  let configEffort = ''
  try {
    const toml = readFileSync(join(codexDir, 'config.toml'), 'utf-8')
    const providerMatch = toml.match(/^model_provider\s*=\s*"([^"]+)"/m)
    const activeProvider = providerMatch?.[1] ?? ''
    const modelMatch = toml.match(/^model\s*=\s*"([^"]+)"/m)
    configModel = modelMatch?.[1] ?? ''
    const effortMatch = toml.match(/^model_reasoning_effort\s*=\s*"([^"]+)"/m)
    configEffort = effortMatch?.[1] ?? ''
    if (activeProvider) {
      // Extract the provider block as a line scan: from the header line up to
      // the next top-level [section]. (A regex with `$` in multiline mode would
      // match the header's own line-end and capture nothing, which is why we
      // don't use lookahead-with-$ here.)
      const lines = toml.split(/\r?\n/)
      const headerRe = new RegExp(`^\\[model_providers\\.${activeProvider.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]\\s*$`)
      let inBlock = false
      const blockLines: string[] = []
      for (const line of lines) {
        if (inBlock) {
          if (/^\s*\[/.test(line)) break // next section header ends the block
          blockLines.push(line)
        } else if (headerRe.test(line)) {
          inBlock = true
        }
      }
      const block = blockLines.join('\n')
      const baseMatch = block.match(/^base_url\s*=\s*"([^"]+)"/m)
      baseUrl = baseMatch?.[1]?.replace(/\/+$/, '') ?? ''
      const envKeyMatch = block.match(/^env_key\s*=\s*"([^"]+)"/m)
      envKey = envKeyMatch?.[1] ?? ''
    }
  } catch {
    // no config → no discovery
  }
  // Resolve the API key: provider env_key first, then OPENAI_API_KEY env,
  // then ~/.codex/auth.json (where `codex login` stores it for the built-in
  // OpenAI provider).
  let token = ''
  if (envKey) token = process.env[envKey] || ''
  if (!token) token = process.env['OPENAI_API_KEY'] || ''
  if (!token) {
    try {
      const auth = JSON.parse(readFileSync(join(codexDir, 'auth.json'), 'utf-8')) as { OPENAI_API_KEY?: string }
      token = auth.OPENAI_API_KEY ?? ''
    } catch { /* ignore */ }
  }
  // No custom provider block (baseUrl empty) means the built-in OpenAI
  // provider — default to the real api.openai.com/v1 so an OPENAI_API_KEY user
  // still gets the live /v1/models catalog. (Codex-CLI oauth login exposes no
  // key we can use here; that path falls through to the config model fallback.)
  if (!baseUrl && token) baseUrl = 'https://api.openai.com/v1'
  if (baseUrl && token) {
    // OpenAI-compatible base_url conventionally ends in /v1 (so the models
    // endpoint is {base}/models); some gateways omit the /v1 suffix (then it's
    // {base}/v1/models). Try the likely one first, fall back to the other.
    const candidates = baseUrl.toLowerCase().endsWith('/v1')
      ? [`${baseUrl}/models`, `${baseUrl}/v1/models`]
      : [`${baseUrl}/v1/models`, `${baseUrl}/models`]
    for (const url of candidates) {
      try {
        const res = await fetch(url, { headers: { 'authorization': `Bearer ${token}` } })
        if (!res.ok) continue
        const json = (await res.json()) as { data?: Array<{ id?: string }> }
        const ids = unique((json.data ?? []).map(m => m.id).filter((v): v is string => !!v))
        if (ids.length) {
          // The configured default may not appear in /v1/models (some gateways
          // alias it); surface it explicitly so the user can still pick it.
          const merged = unique([...(configModel ? [configModel] : []), ...ids])
          if (merged.length) {
            return { models: merged, source: 'gateway', defaultModel: configModel || undefined, defaultEffort: normalizeEffort(configEffort) }
          }
        }
      } catch {
        // try next candidate
      }
    }
    // fall through to config
  }
  return {
    models: configModel ? [configModel] : [],
    source: configModel ? 'config' : 'none',
    defaultModel: configModel || undefined,
    defaultEffort: normalizeEffort(configEffort),
  }
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
  ipcMain.handle(IPC.LIST_MODELS, (_event, provider: LocalProvider) =>
    listModels(provider))
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
