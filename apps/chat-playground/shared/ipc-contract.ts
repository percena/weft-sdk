/**
 * IPC contract shared between the Electron main process, the preload bridge,
 * and the renderer's runtime client. Pure types + channel-name constants —
 * no runtime dependencies, safe to import from any of the three contexts.
 */

export const IPC = {
  // Renderer → main (invoke, request/response)
  START_SESSION: 'desktop:startSession',
  SEND_MESSAGE: 'desktop:sendMessage',
  ABORT: 'desktop:abort',
  RESPOND_PERMISSION: 'desktop:respondToPermission',
  DISCONNECT: 'desktop:disconnect',
  FS_BROWSE: 'desktop:fsBrowse',
  LIST_MODELS: 'desktop:listModels',
  // Main → renderer (send, one-way events)
  ENVELOPE: 'desktop:envelope',
  CAPABILITY: 'desktop:capability',
  STREAM_ERROR: 'desktop:streamError',
  STREAM_CLOSED: 'desktop:streamClosed',
} as const

/** Permission mode literal union (mirrors @percena/weft-node PermissionMode). */
export type LocalPermissionMode = 'explore' | 'ask' | 'auto'
export type LocalProvider = 'claude' | 'codex'

export interface StartSessionOptions {
  sessionId: string
  provider: LocalProvider
  cwd: string
  model?: string
  reasoningEffort?: string
  permissionMode?: LocalPermissionMode
}

export interface StartSessionResult {
  /** True when the runtime was created and the timeline stream connected. */
  ok: boolean
  /** Capability report (provider/selected/fallback/auth) from preflight. */
  capabilityReport?: unknown
  /** Error message if the runtime could not be created. */
  error?: string
}

export interface SendMessageOptions {
  sessionId: string
  message: string
  model?: string
  reasoningEffort?: string
  permissionMode?: LocalPermissionMode
}

export interface RespondPermissionOptions {
  sessionId: string
  requestId: string
  allowed: boolean
  remember?: boolean
}

export interface AbortOptions {
  sessionId: string
  reason?: string
}

export interface DisconnectOptions {
  sessionId: string
}

export interface FsEntry {
  name: string
  path: string
  type: 'file' | 'directory'
  size?: number
}

export interface FsBrowseResult {
  currentPath: string
  parentPath: string | null
  entries: FsEntry[]
  reason?: string
}

/**
 * Discovered model list for a provider's compatible API endpoint.
 *
 * The playground does NOT hardcode model ids — a compatible Anthropic/OpenAI
 * endpoint may serve any model (e.g. glm-5.2, deepseek-v4-flash, qwen3-max).
 * The main process discovers the real list and returns it here so the renderer
 * can populate the model picker. `source` mirrors the shared
 * `ProviderModelSource` (`@weft/runtime-core`) produced identically by every
 * discovery site:
 *  - 'gateway': GET {base_url}/v1/models on the endpoint succeeded (live list)
 *  - 'config':  read from local/stored config — NOT probed (claude settings.json
 *    env block, codex ~/.codex/config.toml). A static fallback the picker
 *    treats the same regardless of provider.
 *  - 'none':    nothing discoverable; the picker stays empty and turns send no
 *    model (the SDK uses its own default)
 *
 * `defaultModel` is the provider's own default (e.g. ANTHROPIC_MODEL or the
 * codex config.toml `model`), surfaced so the picker can default to the model
 * the user is currently using rather than a generic "Default" entry.
 * `defaultEffort` is the provider's active reasoning effort (e.g.
 * CLAUDE_CODE_EFFORT_LEVEL or codex config.toml `model_reasoning_effort`),
 * surfaced so the effort picker can likewise default to the active value.
 */
export interface ListModelsResult {
  models: string[]
  source: 'gateway' | 'config' | 'none'
  defaultModel?: string
  defaultEffort?: string
}

export interface EnvelopeEvent {
  sessionId: string
  envelope: unknown
}

export interface StreamEndEvent {
  sessionId: string
  error?: string
  closed?: boolean
}

export interface CapabilityEvent {
  sessionId: string
  report: unknown
}

/**
 * The renderer-facing surface exposed by the preload bridge
 * (`window.weftDesktop`). Plain, electron-free types so the renderer typecheck
 * does not pull in the `electron` package.
 */
export interface WeftDesktopApi {
  startSession(options: StartSessionOptions): Promise<StartSessionResult>
  sendMessage(options: SendMessageOptions): Promise<void>
  abort(options: AbortOptions): Promise<void>
  respondToPermission(options: RespondPermissionOptions): Promise<void>
  disconnect(options: DisconnectOptions): Promise<void>
  fsBrowse(path?: string): Promise<FsBrowseResult>
  listModels(provider: LocalProvider): Promise<ListModelsResult>
  onEnvelope(handler: (event: EnvelopeEvent) => void): () => void
  onCapability(handler: (event: CapabilityEvent) => void): () => void
  onStreamError(handler: (event: StreamEndEvent) => void): () => void
  onStreamClosed(handler: (event: StreamEndEvent) => void): () => void
}

/** Runtime-guarded accessor; undefined when not running under Electron. */
export function getDesktopApi(): WeftDesktopApi | undefined {
  return typeof window !== 'undefined'
    ? (window as unknown as { weftDesktop?: WeftDesktopApi }).weftDesktop
    : undefined
}
