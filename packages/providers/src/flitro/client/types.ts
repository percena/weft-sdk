/**
 * Structural timeline types.
 *
 * These mirror `@weft/timeline`'s `TimelineEnvelope` and `@weft/runtime-core`'s
 * `AgentTimelineStream` so this package stays zero-dependency. TypeScript's
 * structural typing keeps them interchangeable with the Weft originals: the
 * `item` payload is left as `unknown` here (the SSE protocol does not constrain
 * it), and `@weft/providers/flitro` narrows it when bridging into a runtime.
 */

export interface TimelineEnvelope<TItem = unknown> {
  sessionId: string
  provider: string
  seq: number
  epoch: string
  timestamp: number
  item: TItem
  rawRef?: unknown
}

export interface TimelineStream {
  connect(
    onEvent: (event: TimelineEnvelope) => void,
    onError?: (error: Error) => void,
    onClose?: () => void,
  ): void
  disconnect(): void
  isConnected(): boolean
}
