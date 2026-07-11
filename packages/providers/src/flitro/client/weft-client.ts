/**
 * WeftClient — the public L2 ("headless") contract.
 *
 * A thin namespaced facade over WeftHttpClient + the SSE timeline stream:
 *
 * ```ts
 * const client = new WeftClient({ server, token })
 * const stream = client.timeline.subscribe(sessionId)   // SSE, auto-reconnect
 * for await (const envelope of stream) render(envelope)
 * await client.runs.create(sessionId, { message: 'Summarize the latest changes' })
 * ```
 */

import {
  WeftHttpClient,
  type WeftHttpClientOptions,
  type WeftRun,
  type WeftSession,
  type WeftPatchSessionOptions,
  type WeftTimelineFetchResult,
} from './http-client.ts'
import {
  WeftFetchSseTimelineStream,
  type WeftSseTimelineStreamOptions,
} from './timeline-stream.ts'
import type { TimelineEnvelope, TimelineStream } from './types.ts'
import type { PermissionResponseDetail } from '@weft/runtime-core'

export interface WeftClientOptions {
  /** Base URL of the agent server, e.g. https://agents.example.com */
  server: string
  /**
   * Scoped session token.
   */
  token?: string
  /** Request timeout in milliseconds (default 30000). */
  timeout?: number
  /**
   * Called on HTTP 401 with a scoped token. Return a fresh token (e.g. by
   * re-asking your backend) to retry once; return undefined to surface the 401.
   */
  onTokenExpired?: WeftHttpClientOptions['onTokenExpired']
}

export interface TimelineSubscription extends TimelineStream, AsyncIterable<TimelineEnvelope> {}

class TimelineSubscriptionImpl implements TimelineSubscription {
  constructor(private readonly stream: WeftFetchSseTimelineStream) {}

  connect(
    onEvent: (event: TimelineEnvelope) => void,
    onError?: (error: Error) => void,
    onClose?: () => void,
  ): void {
    this.stream.connect(onEvent, onError, onClose)
  }

  disconnect(): void {
    this.stream.disconnect()
  }

  isConnected(): boolean {
    return this.stream.isConnected()
  }

  [Symbol.asyncIterator](): AsyncIterator<TimelineEnvelope> {
    const queue: TimelineEnvelope[] = []
    let notify: (() => void) | null = null
    let done = false
    let failure: Error | null = null

    const wake = () => {
      notify?.()
      notify = null
    }
    this.stream.connect(
      (event) => {
        queue.push(event)
        wake()
      },
      (error) => {
        failure = error
        done = true
        wake()
      },
      () => {
        done = true
        wake()
      },
    )

    return {
      next: async (): Promise<IteratorResult<TimelineEnvelope>> => {
        while (queue.length === 0) {
          if (failure) throw failure
          if (done) return { value: undefined, done: true }
          await new Promise<void>((resolve) => {
            notify = resolve
          })
        }
        return { value: queue.shift() as TimelineEnvelope, done: false }
      },
      return: async (): Promise<IteratorResult<TimelineEnvelope>> => {
        this.stream.disconnect()
        return { value: undefined, done: true }
      },
    }
  }
}

export class WeftClient {
  /** The underlying 1:1 HTTP client, for endpoints not wrapped below. */
  readonly http: WeftHttpClient
  private readonly options: WeftClientOptions

  constructor(options: WeftClientOptions) {
    this.options = options
    this.http = new WeftHttpClient({
      baseUrl: options.server,
      timeout: options.timeout,
      token: options.token,
      onTokenExpired: options.onTokenExpired
        ? async () => {
            const fresh = await options.onTokenExpired?.()
            return fresh
          }
        : undefined,
    })
  }

  /** Replace the scoped token (e.g. after a backend-driven refresh). */
  setToken(token: string): void {
    this.http.setToken(token)
  }

  readonly sessions = {
    get: (sessionId: string): Promise<WeftSession> => this.http.getSession(sessionId),
    patch: (sessionId: string, patch: WeftPatchSessionOptions): Promise<WeftSession> =>
      this.http.patchSession(sessionId, patch),
    respondToPermission: (
      sessionId: string,
      requestId: string,
      allowed: boolean,
      options?: { remember?: boolean; comment?: string; detail?: PermissionResponseDetail },
    ) => this.http.respondToPermission(sessionId, requestId, allowed, options),
  }

  readonly runs = {
    create: (
      sessionId: string,
      options: { message: string } & NonNullable<Parameters<WeftHttpClient['createRun']>[2]>,
    ): Promise<WeftRun> => {
      const { message, ...rest } = options
      return this.http.createRun(sessionId, message, rest)
    },
    cancel: (sessionId: string, runId: string) => this.http.cancelRun(sessionId, runId),
    submitToolOutputs: (
      sessionId: string,
      runId: string,
      outputs: { toolCallId: string; output: unknown; isError?: boolean }[],
    ) => this.http.submitToolOutputs(sessionId, runId, outputs),
  }

  readonly timeline = {
    fetch: (sessionId: string, afterSeq?: number, limit?: number): Promise<WeftTimelineFetchResult> =>
      this.http.fetchTimeline(sessionId, afterSeq, limit),
    /**
     * Subscribe to the session's SSE timeline. Reconnects automatically with
     * cursor tracking; usable both callback-style (`connect`) and as an
     * async iterable (`for await`).
     */
    subscribe: (
      sessionId: string,
      options?: Partial<Omit<WeftSseTimelineStreamOptions, 'url'>>,
    ): TimelineSubscription => {
      const stream = new WeftFetchSseTimelineStream({
        url: this.http.timelineUrl(sessionId),
        getBearerToken: () => this.http.getBearerToken(),
        onTokenExpired: this.options.onTokenExpired
          ? async () => {
              const fresh = await this.options.onTokenExpired?.()
              if (fresh) this.http.setToken(fresh)
              return fresh
            }
          : undefined,
        ...options,
      })
      return new TimelineSubscriptionImpl(stream)
    },
  }
}
