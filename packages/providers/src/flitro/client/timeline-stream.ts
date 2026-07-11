/**
 * WeftSseTimelineStream
 *
 * Consumes the session-scoped SSE timeline endpoint and exposes it as
 * a Weft TimelineStream. Handles reconnection with cursor tracking.
 */

import type { TimelineEnvelope, TimelineStream } from './types.ts'
import { parseTimelineEnvelope } from '@weft/timeline'

export interface WeftSseTimelineStreamOptions {
  /** Full URL to the session timeline SSE endpoint */
  url: string
  /** Reconnect delay in ms (default: 1500) */
  reconnectDelayMs?: number
  /** Maximum reconnect attempts (default: 20) */
  maxReconnectAttempts?: number
  /** Starting afterSeq cursor for gap-aware reconnection */
  initialAfterSeq?: number
  now?: () => number
  /**
   * Returns the current Authorization bearer (e.g. a scoped token that
   * may rotate).
   */
  getBearerToken?: () => string
  /**
   * Called when the stream is rejected with HTTP 401. Return a fresh token to
   * resume streaming (also update the HTTP client), or undefined to give up.
   */
  onTokenExpired?: () => Promise<string | undefined> | string | undefined
}

export class WeftSseTimelineStream implements TimelineStream {
  private listeners = new Set<{
    onEvent: (event: TimelineEnvelope) => void
    onError?: (error: Error) => void
    onClose?: () => void
  }>()
  private eventSource: EventSource | null = null
  private disposed = false
  private reconnectAttempts = 0
  private afterSeq: number
  // T5: last-seen server epoch, sent on reconnect so Flitro can detect a
  // per-boot epoch rotation (restart) and replay durable history from seq 0
  // instead of silently dropping it against our stale afterSeq.
  private epoch = ''
  // Native EventSource cannot set headers or observe HTTP status codes, so
  // scoped tokens travel as a ?token= query param (re-read on every reconnect
  // to pick up rotation); onTokenExpired is only actionable in the fetch-based
  // stream, which is what createTimelineStream returns.
  private readonly getBearerToken?: () => string
  private readonly options: Required<Omit<WeftSseTimelineStreamOptions, 'getBearerToken' | 'onTokenExpired'>>

  constructor(options: WeftSseTimelineStreamOptions) {
    this.afterSeq = options.initialAfterSeq ?? 0
    this.getBearerToken = options.getBearerToken
    this.options = {
      url: options.url,
      reconnectDelayMs: options.reconnectDelayMs ?? 1500,
      maxReconnectAttempts: options.maxReconnectAttempts ?? 20,
      initialAfterSeq: this.afterSeq,
      now: options.now ?? (() => Date.now()),
    }
  }

  connect(
    onEvent: (event: TimelineEnvelope) => void,
    onError?: (error: Error) => void,
    onClose?: () => void,
  ): void {
    // connect() after disconnect() revives the stream: components that tear
    // down on unmount (or React StrictMode's mount→unmount→mount) can simply
    // reconnect instead of holding a permanently dead stream.
    this.disposed = false
    this.listeners.add({ onEvent, onError, onClose })
    if (!this.eventSource) {
      this.reconnectAttempts = 0
      this.openEventSource()
    }
  }

  disconnect(): void {
    this.disposed = true
    this.closeEventSource()
    for (const listener of this.listeners) {
      listener.onClose?.()
    }
    this.listeners.clear()
  }

  isConnected(): boolean {
    return this.eventSource?.readyState === EventSource.OPEN
  }

  private trackCursor(envelope: TimelineEnvelope): void {
    const next = advanceReconnectCursor(this.epoch, this.afterSeq, envelope)
    this.epoch = next.epoch
    this.afterSeq = next.afterSeq
  }

  private openEventSource(): void {
    if (this.disposed) return

    // Native EventSource doesn't support custom headers, so we pass the token
    // as a query param.
    let url = this.options.url
    if (this.afterSeq > 0) {
      const sep = url.includes('?') ? '&' : '?'
      url += `${sep}after_seq=${this.afterSeq}`
    }
    if (this.epoch) {
      const sep = url.includes('?') ? '&' : '?'
      url += `${sep}epoch=${encodeURIComponent(this.epoch)}`
    }
    const bearer = this.getBearerToken?.()
    if (bearer) {
      const sep = url.includes('?') ? '&' : '?'
      url += `${sep}token=${encodeURIComponent(bearer)}`
    }

    try {
      this.eventSource = new EventSource(url)
    } catch (err) {
      this.emitError(err instanceof Error ? err : new Error(String(err)))
      return
    }

    this.eventSource.addEventListener('timeline', (e: MessageEvent) => {
      try {
        // session contract/X-B: validate + leniently decode (replaces the unvalidated
        // `as` cast). A malformed or shape-skewed frame is thrown → caught →
        // skipped, instead of silently mis-decoding into undefined fields.
        const envelope = parseTimelineEnvelope(JSON.parse(e.data))
        this.trackCursor(envelope)
        this.reconnectAttempts = 0
        for (const listener of this.listeners) {
          listener.onEvent(envelope)
        }
      } catch {
        // malformed/unvalidated frame; skip
      }
    })

    this.eventSource.onerror = () => {
      this.closeEventSource()
      if (!this.disposed) {
        this.scheduleReconnect()
      }
    }
  }

  private closeEventSource(): void {
    this.eventSource?.close()
    this.eventSource = null
  }

  private scheduleReconnect(): void {
    if (this.disposed) return
    if (this.reconnectAttempts >= this.options.maxReconnectAttempts) {
      this.emitError(new Error(`Weft SSE: max reconnect attempts (${this.options.maxReconnectAttempts}) reached`))
      return
    }
    this.reconnectAttempts++
    const delay = Math.min(
      this.options.reconnectDelayMs * this.reconnectAttempts,
      30_000,
    )
    setTimeout(() => this.openEventSource(), delay)
  }

  private emitError(err: Error): void {
    for (const listener of this.listeners) {
      listener.onError?.(err)
    }
  }
}

/**
 * In Node.js environments (Node 18+) EventSource may not be available globally.
 * This minimal polyfill wraps the fetch API for SSE consumption.
 */
export class WeftFetchSseTimelineStream implements TimelineStream {
  private listeners = new Set<{
    onEvent: (event: TimelineEnvelope) => void
    onError?: (error: Error) => void
    onClose?: () => void
  }>()
  private abortController: AbortController | null = null
  private connected = false
  private disposed = false
  private afterSeq: number
  // T5: last-seen server epoch, sent on reconnect (see WeftSseTimelineStream).
  private epoch = ''
  private reconnectAttempts = 0
  private tokenOverride = ''
  private readonly getBearerToken?: () => string
  private readonly onTokenExpired?: WeftSseTimelineStreamOptions['onTokenExpired']
  private readonly options: Required<Omit<WeftSseTimelineStreamOptions, 'getBearerToken' | 'onTokenExpired'>>

  constructor(options: WeftSseTimelineStreamOptions) {
    this.afterSeq = options.initialAfterSeq ?? 0
    this.getBearerToken = options.getBearerToken
    this.onTokenExpired = options.onTokenExpired
    this.options = {
      url: options.url,
      reconnectDelayMs: options.reconnectDelayMs ?? 1500,
      maxReconnectAttempts: options.maxReconnectAttempts ?? 20,
      initialAfterSeq: this.afterSeq,
      now: options.now ?? (() => Date.now()),
    }
  }

  connect(
    onEvent: (event: TimelineEnvelope) => void,
    onError?: (error: Error) => void,
    onClose?: () => void,
  ): void {
    // Revivable after disconnect() — see WeftSseTimelineStream.connect.
    this.disposed = false
    this.listeners.add({ onEvent, onError, onClose })
    if (!this.connected) {
      this.connected = true
      this.reconnectAttempts = 0
      this.startFetch()
    }
  }

  disconnect(): void {
    this.disposed = true
    this.connected = false
    this.abortController?.abort(new Error('SSE stream disconnected'))
    for (const listener of this.listeners) {
      listener.onClose?.()
    }
    this.listeners.clear()
  }

  isConnected(): boolean {
    return this.connected && !this.disposed
  }

  private trackCursor(envelope: TimelineEnvelope): void {
    const next = advanceReconnectCursor(this.epoch, this.afterSeq, envelope)
    this.epoch = next.epoch
    this.afterSeq = next.afterSeq
  }

  private buildUrl(): string {
    let url = this.options.url
    if (this.afterSeq > 0) {
      url += `${url.includes('?') ? '&' : '?'}after_seq=${this.afterSeq}`
    }
    if (this.epoch) {
      url += `${url.includes('?') ? '&' : '?'}epoch=${encodeURIComponent(this.epoch)}`
    }
    return url
  }

  private buildHeaders(): Record<string, string> {
    const h: Record<string, string> = { Accept: 'text/event-stream' }
    const bearer = this.tokenOverride || this.getBearerToken?.()
    if (bearer) h.Authorization = `Bearer ${bearer}`
    return h
  }

  private async startFetch(): Promise<void> {
    if (this.disposed) return
    this.abortController = new AbortController()

    try {
      const response = await fetch(this.buildUrl(), {
        headers: this.buildHeaders(),
        signal: this.abortController.signal,
      })

      if (response.status === 401 && this.onTokenExpired) {
        const fresh = await this.onTokenExpired()
        if (fresh) this.tokenOverride = fresh
      }

      if (!response.ok || !response.body) {
        throw new Error(`Weft SSE: HTTP ${response.status}`)
      }

      this.reconnectAttempts = 0
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const envelopes = parseSseBuffer(buffer)
        buffer = envelopes.remainder
        for (const envelope of envelopes.items) {
          this.trackCursor(envelope)
          for (const listener of this.listeners) {
            listener.onEvent(envelope)
          }
        }
      }

      // Server closed the stream unexpectedly — reconnect.
      if (!this.disposed) {
        this.connected = false
        this.scheduleReconnect()
      }
    } catch (err) {
      if (this.disposed) return
      if (err instanceof Error && err.name === 'AbortError') return
      this.connected = false
      this.scheduleReconnect()
    }
  }

  private scheduleReconnect(): void {
    if (this.disposed) return
    if (this.reconnectAttempts >= this.options.maxReconnectAttempts) {
      this.emitError(new Error(`Weft SSE: max reconnect attempts reached`))
      return
    }
    this.reconnectAttempts++
    const delay = Math.min(this.options.reconnectDelayMs * this.reconnectAttempts, 30_000)
    setTimeout(() => {
      this.connected = true
      this.startFetch()
    }, delay)
  }

  private emitError(err: Error): void {
    for (const listener of this.listeners) listener.onError?.(err)
  }
}

export interface ParseResult {
  items: TimelineEnvelope[]
  remainder: string
  /**
   * Last SSE `id:` field seen in a dispatched frame (mirrors the native
   * EventSource `lastEventId` surface). session contract: previously the parser silently
   * dropped `id:`; it is now captured per the HTML SSE spec so a producer that
   * stamps `id:` is observable. Not yet wired into the fetch reconnect's
   * `Last-Event-ID` header — flitro's cursor model is `after_seq` query params,
   * and flitro does not currently emit `id:`; the capture is forward-compatible
   * plumbing for a provider that does.
   */
  lastEventId?: string
}

// advanceReconnectCursor computes the next {epoch, afterSeq} to pin from one
// envelope. Same epoch → monotonic advance (seq > afterSeq). Epoch rotation
// (Flitro restart → new bootID) → the new seq space restarts at 1, numerically
// BELOW our old afterSeq, so a plain `seq > afterSeq` guard would never advance
// and the next reconnect would send a stale-high after_seq under the new
// (now-matching) epoch, making Flitro filter the whole replay out again. On
// rotation we adopt the new epoch and reset afterSeq to the new seq space. (T5.)
export function advanceReconnectCursor(
  epoch: string,
  afterSeq: number,
  envelope: TimelineEnvelope,
): { epoch: string; afterSeq: number } {
  if (envelope.epoch && epoch !== '' && envelope.epoch !== epoch) {
    return { epoch: envelope.epoch, afterSeq: envelope.seq }
  }
  const nextEpoch = envelope.epoch || epoch
  const nextSeq = envelope.seq > afterSeq ? envelope.seq : afterSeq
  return { epoch: nextEpoch, afterSeq: nextSeq }
}

/**
 * Parse a chunk of an SSE byte stream into dispatched timeline envelopes.
 *
 * session contract: the previous hand-rolled parser split on `\n\n` only, so a server
 * emitting CRLF (`\r\n\r\n`) line endings never framed — every chunk piled into
 * one unparsed block. It also kept only the last `data:` line (the SSE spec
 * joins multiple `data:` lines with `\n`) and silently dropped `id:`. This
 * implementation follows the HTML spec's "interpret a Content-Type" event
 * stream algorithm closely enough to be wire-correct for the frames flitro (and
 * any spec-compliant SSE producer) emits:
 *
 * - Line endings `\r\n`, `\r`, `\n` are all honored (normalized to `\n` first).
 *   Frames are separated by a blank line (two consecutive line endings).
 * - A field line is `name[: value]`; exactly one leading space after the colon
 *   is stripped. A line starting with `:` is a comment (skipped).
 * - Multiple `data:` lines within a frame are joined with `\n` (a trailing
 *   empty `data:` line contributes a final `\n`, matching the spec's
 *   "append U+000A then strip one trailing newline" rule).
 * - `id:` sets the frame's last event id (returned as `lastEventId` — the last
 *   one seen across all dispatched frames).
 * - `event:` selects the event type; only `timeline` frames are decoded.
 *
 * The trailing incomplete frame (after the last blank line) is returned as
 * `remainder` so the caller can prepend the next chunk.
 */
export function parseSseBuffer(buffer: string): ParseResult {
  const items: TimelineEnvelope[] = []
  let lastEventId: string | undefined
  // SDK-R-1: hold back a trailing CR before normalizing so a CRLF pair (\r\n)
  // split across chunk boundaries (chunk N ending in \r, chunk N+1 starting
  // with \n) rejoins instead of becoming a spurious \n\n frame boundary. If we
  // normalized a lone trailing \r to \n, the next chunk's leading \n would
  // concatenate to \n\n — a blank line that never existed on the wire — and the
  // envelope would be silently dropped (the `event:` line frames as data-less
  // and is skipped; the `data:` line lands in a frame with no event type and is
  // dropped). Per the HTML SSE spec's "if the last character is CR, hold it"
  // rule, strip a trailing \r from the buffer we normalize and re-append it to
  // the returned remainder so the pair rejoins across the chunk boundary.
  //
  // Refinement: do NOT hold when the trailing \r is immediately preceded by
  // another \r. A \r\r sequence is a bare-CR blank line regardless of whether
  // the second \r is a bare CR or the first half of a CRLF (a\r\r ≡ a\r + \r,
  // and a\r\r\n ≡ a\r + \r\n — both are "a" then a blank line), so holding it
  // would suppress a real frame boundary on a complete bare-CR frame. Holding
  // only a \r that could be the FIRST half of a CRLF (not preceded by \r) closes
  // the split-boundary hole without regressing bare-CR framing.
  const endsWithCr = buffer.length > 0 && buffer.charCodeAt(buffer.length - 1) === 0x0d
  const prevIsCr = buffer.length >= 2 && buffer.charCodeAt(buffer.length - 2) === 0x0d
  const holdTrailingCr = endsWithCr && !prevIsCr
  const work = holdTrailingCr ? buffer.slice(0, -1) : buffer
  // Normalize SSE line endings (\r\n → \n, then bare \r → \n) so the
  // \n\n frame split + per-line split are uniform under CRLF/CR/LF servers.
  const normalized = work.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const blocks = normalized.split('\n\n')
  let remainder = blocks.pop() ?? ''
  if (holdTrailingCr) remainder += '\r'

  for (const block of blocks) {
    let eventType = ''
    const dataLines: string[] = []
    let id: string | undefined
    for (const line of block.split('\n')) {
      // Comment line (starts with U+003A COLON) — skip per spec.
      if (line.startsWith(':')) continue
      const colon = line.indexOf(':')
      const field = colon === -1 ? line : line.slice(0, colon)
      // Strip exactly one leading space after the colon (spec: "if value starts
      // with U+0020 SPACE, remove it"). `data:` and `data: ` are equivalent.
      let value = colon === -1 ? '' : line.slice(colon + 1)
      if (value.startsWith(' ')) value = value.slice(1)
      if (field === 'event') {
        eventType = value
      } else if (field === 'data') {
        dataLines.push(value)
      } else if (field === 'id') {
        id = value
      }
      // `retry` and unknown fields are not consumed by this stream.
    }
    if (id !== undefined) lastEventId = id
    // Multiple `data:` lines join with `\n`. A trailing empty `data:` line
    // yields a trailing `\n` in the joined string, matching the spec's
    // "append U+000A, then if the data buffer's last char is U+000A, strip it"
    // — `['a', ''].join('\n')` === `'a\n'`, same as the spec's `a\n` → strip → `a`.
    const data = dataLines.join('\n')
    if (eventType === 'timeline' && data) {
      try {
        // session contract/X-B: validate + leniently decode (replaces the unvalidated
        // `as` cast). Malformed/skewed frames are skipped, not mis-decoded.
        items.push(parseTimelineEnvelope(JSON.parse(data)))
      } catch {
        // skip malformed
      }
    }
  }

  return { items, remainder, lastEventId }
}

/**
 * Create an SSE stream for the timeline endpoint.
 * Always uses the fetch-based implementation so credentials are sent via
 * Authorization header rather than URL query parameters.
 */
export function createTimelineStream(
  options: WeftSseTimelineStreamOptions,
): TimelineStream {
  return new WeftFetchSseTimelineStream(options)
}
