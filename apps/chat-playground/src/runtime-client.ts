/**
 * RuntimeClient — IPC-backed bridge to the local desktop agent runtime.
 *
 * Replaces the former remote HTTP/WebSocket client. Same exported surface
 * (onStateChange / connectLiveSession / sendMessage / disconnect / getState +
 * createRuntimeClientState) so the rest of the renderer is unchanged: the
 * only swap is the data source — from a remote host server to the in-process
 * Electron main driving `@percena/weft-node/runtime`.
 *
 * Timeline envelopes produced by the local runtime are applied through the
 * same processor (`processEvent` + `mapTimelineEnvelopeToProcessorEvent`) so
 * the turn-card UI renders local agent turns identically to the fixture path.
 */
import { mapTimelineEnvelopeToProcessorEvent, type ChatEvent, type SessionState, processEvent } from '@percena/weft-node/chat'
import type { PermissionMode } from '@percena/weft-node'
import { groupMessagesByTurn, type Turn } from '@percena/weft-node/chat'
import type { TimelineEnvelope } from '@percena/weft-node'
import type { ReasoningEffort } from './live-session-store'
import { isChatTranscriptTimelineEnvelope } from './timeline-transcript'
import { getDesktopApi, type WeftDesktopApi } from '../shared/ipc-contract'

export interface RuntimeClientOptions {
  /** UI session id; seeded into the local runtime so envelopes round-trip keyed by it. */
  sessionId: string
  /** Injectable for tests; defaults to the preload-exposed `window.weftDesktop`. */
  api?: WeftDesktopApi
}

export interface RuntimeClientConnectOptions {
  provider: 'claude' | 'codex'
  cwd: string
  model?: string
  reasoningEffort?: ReasoningEffort
  permissionMode?: PermissionMode
  /** Accepted for UI compatibility; the local runtime sources/attachments are not yet wired. */
  sourceSlugs?: string[]
  attachments?: Array<{ path: string; name?: string }>
}

export interface RuntimeClientSendOptions {
  model?: string
  reasoningEffort?: ReasoningEffort
  permissionMode?: PermissionMode
  /** Accepted for UI compatibility; cwd is fixed at session start for the local runtime. */
  cwd?: string
  sourceSlugs?: string[]
  attachments?: Array<{ path: string; name?: string }>
}

export interface RuntimeClientState {
  sessionState: SessionState
  turns: Turn[]
  timeline: TimelineEnvelope[]
  isConnected: boolean
  isReconnecting: boolean
  hasGap: boolean
  isRunning: boolean
  error: string | null
  capabilityReport: unknown | null
}

export function createRuntimeClientState(
  sessionId: string,
  workspaceId: string = 'demo-workspace',
  workspaceName: string = 'Demo Workspace',
): SessionState {
  return {
    session: {
      id: sessionId,
      workspaceId,
      workspaceName,
      lastMessageAt: 0,
      lastUsedAt: 0,
      messages: [],
      isProcessing: false,
    },
    streaming: null,
  }
}

export class RuntimeClient {
  private readonly api: WeftDesktopApi | undefined
  private readonly sessionId: string
  private timeline: TimelineEnvelope[] = []
  private sessionState: SessionState
  private _onStateChange: ((state: RuntimeClientState) => void) | null = null
  private _error: string | null = null
  private _connected = false
  private _capabilityReport: unknown | null = null
  /** Unsubscribers for main→renderer subscriptions. */
  private readonly unsubscribers: Array<() => void> = []
  /** Seen envelope keys (`epoch:seq`) for O(1) dedup — scanning the timeline
   * per envelope would be O(n²) over a stream where every delta is an envelope. */
  private readonly seenEnvelopeKeys = new Set<string>()
  /** Turns grouped from the current sessionState; recomputed only when
   * sessionState changes (processEvent returns a new state object). */
  private turnsCache: { source: SessionState; turns: Turn[] } | null = null

  constructor(options: RuntimeClientOptions) {
    this.sessionId = options.sessionId
    this.api = options.api ?? getDesktopApi()
    this.sessionState = createRuntimeClientState(options.sessionId)
  }

  onStateChange(handler: (state: RuntimeClientState) => void): void {
    this._onStateChange = handler
  }

  getState(): RuntimeClientState {
    if (this.turnsCache?.source !== this.sessionState) {
      this.turnsCache = {
        source: this.sessionState,
        turns: groupMessagesByTurn(this.sessionState.session.messages),
      }
    }
    const turns = this.turnsCache.turns
    return {
      sessionState: this.sessionState,
      turns,
      timeline: this.timeline,
      isConnected: this._connected,
      // The local runtime is in-process; there is no reconnect/replay concept.
      isReconnecting: false,
      hasGap: false,
      isRunning: this.sessionState.session.isProcessing,
      error: this._error,
      capabilityReport: this._capabilityReport,
    }
  }

  async connectLiveSession(options: RuntimeClientConnectOptions): Promise<void> {
    if (!this.api) {
      throw new Error('Desktop runtime bridge is not available (window.weftDesktop). Run under Electron.')
    }
    this.subscribeStreams()
    this._connected = true
    this._error = null
    this.emitState()

    const result = await this.api.startSession({
      sessionId: this.sessionId,
      provider: options.provider,
      cwd: options.cwd,
      ...(options.model ? { model: options.model } : {}),
      ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
      ...(options.permissionMode ? { permissionMode: options.permissionMode } : {}),
    })
    if (!result.ok) {
      this._connected = false
      this._error = result.error ?? 'Failed to start the local agent runtime'
      this.emitState()
      throw new Error(this._error)
    }
  }

  async sendMessage(message: string, options: RuntimeClientSendOptions = {}): Promise<void> {
    if (!this.api) {
      throw new Error('Desktop runtime bridge is not available.')
    }
    // The local runtime echoes a `user_message` envelope on accept, so the
    // user bubble renders from the timeline — no optimistic local append.
    await this.api.sendMessage({
      sessionId: this.sessionId,
      message,
      ...(options.model ? { model: options.model } : {}),
      ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
      ...(options.permissionMode ? { permissionMode: options.permissionMode } : {}),
    })
  }

  async abort(reason?: string): Promise<void> {
    if (!this.api) return
    try {
      await this.api.abort({ sessionId: this.sessionId, ...(reason ? { reason } : {}) })
    } catch (err) {
      this._error = (err as Error).message
      this.emitState()
    }
  }

  async respondToPermission(requestId: string, allowed: boolean, remember?: boolean): Promise<void> {
    if (!this.api) return
    try {
      await this.api.respondToPermission({
        sessionId: this.sessionId,
        requestId,
        allowed,
        ...(remember !== undefined ? { remember } : {}),
      })
    } catch (err) {
      this._error = (err as Error).message
      this.emitState()
    }
  }

  disconnect(): void {
    for (const unsubscribe of this.unsubscribers) {
      try { unsubscribe() } catch { /* ignore */ }
    }
    this.unsubscribers.length = 0
    this._connected = false
    if (this.api) {
      void this.api.disconnect({ sessionId: this.sessionId }).catch(() => {})
    }
    this.emitState()
  }

  // ----- internals -----

  private subscribeStreams(): void {
    if (!this.api) return
    this.unsubscribers.push(
      this.api.onEnvelope((event) => {
        if (event.sessionId !== this.sessionId) return
        this.applyTimelineEnvelope(event.envelope as TimelineEnvelope)
      }),
      this.api.onCapability((event) => {
        if (event.sessionId !== this.sessionId) return
        this._capabilityReport = event.report
        this.emitState()
      }),
      this.api.onStreamError((event) => {
        if (event.sessionId !== this.sessionId) return
        this._error = event.error ?? 'Local runtime stream error'
        this.emitState()
      }),
      this.api.onStreamClosed((event) => {
        if (event.sessionId !== this.sessionId) return
        this._connected = false
        if (event.error) this._error = event.error
        this.emitState()
      }),
    )
  }

  private applyTimelineEnvelope(envelope: TimelineEnvelope): void {
    // Dedup by epoch+seq (the runtime replays capability/turn history under a
    // stable epoch; guards against any duplicate main→renderer delivery).
    const key = `${envelope.epoch}:${envelope.seq}`
    if (this.seenEnvelopeKeys.has(key)) {
      return
    }
    this.seenEnvelopeKeys.add(key)
    this.timeline.push(envelope)

    if (isChatTranscriptTimelineEnvelope(envelope)) {
      const event: ChatEvent = mapTimelineEnvelopeToProcessorEvent(envelope)
      const result = processEvent(this.sessionState, event)
      this.sessionState = result.state
    }

    this.emitState()
  }

  private emitState(): void {
    if (this._onStateChange) {
      this._onStateChange(this.getState())
    }
  }
}
