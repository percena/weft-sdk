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
