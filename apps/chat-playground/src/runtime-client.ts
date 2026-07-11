import { mapTimelineEnvelopeToProcessorEvent, type ChatEvent, type SessionState, processEvent } from '@weft/ui'
import type { PermissionMode } from '@weft/core'
import { groupMessagesByTurn, type Turn, } from '@weft/ui'
import type { TimelineEnvelope, TimelineCursor } from '@weft/timeline'
import type { ReasoningEffort } from './live-session-store'
import { isChatTranscriptTimelineEnvelope } from './timeline-transcript'

export interface RuntimeClientOptions {
  baseUrl: string
  sessionId: string
  workspaceId?: string
  workspaceName?: string
}

export interface RuntimeClientConnectOptions {
  provider: 'claude' | 'codex'
  cwd: string
  model?: string
  reasoningEffort?: ReasoningEffort
  permissionMode?: PermissionMode
  sourceSlugs?: string[]
  attachments?: Array<{ path: string; name?: string }>
}

export interface RuntimeClientSendOptions {
  model?: string
  reasoningEffort?: ReasoningEffort
  permissionMode?: PermissionMode
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
      messages: [],
      isProcessing: false,
    },
    streaming: null,
  }
}

export class RuntimeClient {
  private baseUrl: string
  private sessionId: string
  private ws: WebSocket | null = null
  private timeline: TimelineEnvelope[] = []
  private sessionState: SessionState
  private _onStateChange: ((state: RuntimeClientState) => void) | null = null
  private lastCursor: TimelineCursor | null = null
  private isReconnecting = false
  private hasGap = false
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private reconnectAttempt = 0
  private disposed = false
  private _error: string | null = null
  private localSeq = 0

  // Exponential backoff schedule: 250ms, 500ms, 1000ms, 2000ms
  private static readonly BACKOFF_MS = [250, 500, 1000, 2000]

  constructor(options: RuntimeClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '')
    this.sessionId = options.sessionId
    this.sessionState = createRuntimeClientState(
      options.sessionId,
      options.workspaceId ?? 'demo-workspace',
      options.workspaceName ?? 'Demo Workspace',
    )
  }

  onStateChange(handler: (state: RuntimeClientState) => void): void {
    this._onStateChange = handler
  }

  getState(): RuntimeClientState {
    const turns = groupMessagesByTurn(this.sessionState.session.messages)
    return {
      sessionState: this.sessionState,
      turns,
      timeline: this.timeline,
      isConnected: this.ws !== null && this.ws.readyState === WebSocket.OPEN,
      isReconnecting: this.isReconnecting,
      hasGap: this.hasGap,
      isRunning: this.sessionState.session.isProcessing,
      error: this._error,
      capabilityReport: null,
    }
  }

  async createSession(options: RuntimeClientConnectOptions): Promise<void> {
    const response = await fetch(`${this.baseUrl}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: options.provider,
        cwd: options.cwd,
        ...(options.model ? { model: options.model } : {}),
        ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
        ...(options.permissionMode ? { permissionMode: options.permissionMode } : {}),
        ...(options.sourceSlugs ? { sourceSlugs: options.sourceSlugs } : {}),
        ...(options.attachments ? { attachments: options.attachments } : {}),
        candidates: options.provider === 'claude'
          ? [{ kind: 'native-sdk', available: true }, { kind: 'cli-fallback', available: true }]
          : [{ kind: 'app-server', available: true }, { kind: 'cli-fallback', available: true }],
        auth: { mode: 'provider-owned', configured: true, source: 'demo-connection' },
      }),
    })
    const result = await response.json() as { sessionId: string; reason?: string }
    if (!response.ok) {
      throw new Error(result.reason ?? `Failed to create session: ${response.status}`)
    }
    this.sessionId = result.sessionId
  }

  async connectLiveSession(options: RuntimeClientConnectOptions): Promise<void> {
    await this.createSession(options)
    this.connectStream()
  }

  connectStream(): void {
    this.disposed = false
    this.reconnectAttempt = 0
    this.isReconnecting = false
    this.hasGap = false
    this.connectWebSocket()
  }

  disconnect(): void {
    this.disposed = true
    this._error = null
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
    this.ws?.close(1000, 'client disconnect')
    this.ws = null
    this.isReconnecting = false
  }

  async sendMessage(message: string, options: RuntimeClientSendOptions = {}): Promise<void> {
    this.appendLocalUserMessage(message)

    const response = await fetch(`${this.baseUrl}/sessions/${this.sessionId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message,
        ...(options.model ? { model: options.model } : {}),
        ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
        ...(options.permissionMode ? { permissionMode: options.permissionMode } : {}),
        ...(options.cwd ? { cwd: options.cwd } : {}),
        ...(options.sourceSlugs ? { sourceSlugs: options.sourceSlugs } : {}),
        ...(options.attachments ? { attachments: options.attachments } : {}),
      }),
    })
    if (!response.ok) {
      const error = await response.json() as { reason?: string }
      throw new Error(error.reason ?? `Failed to send message: ${response.status}`)
    }
  }

  // ===== Private methods =====

  protected createWebSocket(url: string): WebSocket {
    return new WebSocket(url)
  }

  private connectWebSocket(): void {
    if (this.disposed) return

    const wsUrl = `${this.baseUrl.replace(/^http/, 'ws')}/sessions/${this.sessionId}/stream`
    this.ws = this.createWebSocket(wsUrl)

    this.ws.onmessage = (event) => {
      const envelope = JSON.parse(event.data as string) as TimelineEnvelope
      this.handleTimelineEnvelope(envelope)
    }

    this.ws.onerror = (event) => {
      this._error = event instanceof ErrorEvent ? event.message : 'WebSocket connection error'
      // Note: onerror is always followed by onclose in browsers;
      // onclose may overwrite with a more generic message, but onerror fires first
      // so the UI briefly shows the more specific error before onclose updates it.
      this.emitState()
    }

    this.ws.onclose = (closeEvent) => {
      this.ws = null

      // Normal close (1000) — don't reconnect
      if (closeEvent.code === 1000 || this.disposed) {
        this._error = null
        this.emitState()
        return
      }

      // Abnormal close — preserve more specific onerror message if onclose reason is empty
      this._error = closeEvent.reason || this._error || `WebSocket closed unexpectedly (code ${closeEvent.code})`
      this.isReconnecting = true
      this.emitState()

      // Fetch missed events via HTTP catchup before reconnecting
      this.catchupFromServer()

      // Schedule WebSocket reconnect with exponential backoff
      const backoffIndex = Math.min(this.reconnectAttempt, RuntimeClient.BACKOFF_MS.length - 1)
      const delay = RuntimeClient.BACKOFF_MS[backoffIndex]
      this.reconnectAttempt++

      this.reconnectTimer = setTimeout(() => {
        if (!this.disposed) {
          this.connectWebSocket()
        }
      }, delay)
    }

    this.ws.onopen = () => {
      this.isReconnecting = false
      this.reconnectAttempt = 0
      this._error = null
      this.emitState()
    }
  }

  private async catchupFromServer(): Promise<void> {
    if (!this.lastCursor) return

    try {
      const response = await fetch(`${this.baseUrl}/sessions/${this.sessionId}/timeline`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cursor: this.lastCursor }),
      })

      if (!response.ok) return

      const result = await response.json() as { items: TimelineEnvelope[]; hasGap: boolean }

      if (result.items && result.items.length > 0) {
        // Merge catchup items into timeline (deduplicated by epoch+seq)
        const existingKeys = new Set(this.timeline.map(e => `${e.epoch}:${e.seq}`))
        for (const envelope of result.items) {
          const key = `${envelope.epoch}:${envelope.seq}`
          if (!existingKeys.has(key)) {
            this.handleTimelineEnvelope(envelope)
          }
        }
      }

      if (result.hasGap) {
        this.hasGap = true
      }
    } catch {
      // Catchup failure is not fatal — stream will resume on reconnect
    }
  }

  private handleTimelineEnvelope(envelope: TimelineEnvelope): void {
    // Save cursor for potential catchup later
    this.lastCursor = { epoch: envelope.epoch, afterSeq: envelope.seq }

    this.applyTimelineEnvelope(envelope)
  }

  private appendLocalUserMessage(message: string): void {
    this.localSeq += 1
    this.applyTimelineEnvelope({
      sessionId: this.sessionId,
      provider: 'local',
      epoch: '0000-local',
      seq: this.localSeq,
      timestamp: Date.now(),
      item: {
        type: 'user_message',
        text: message,
        messageId: `local-user-${this.localSeq}`,
        turnId: `local-turn-${this.localSeq}`,
      },
    })
  }

  private applyTimelineEnvelope(envelope: TimelineEnvelope): void {
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
