import type { AgentTimelineStream } from '@weft/runtime-core'
import type { TimelineEnvelope } from '@weft/timeline'

export class PushTimelineStream implements AgentTimelineStream {
  private listeners = new Set<{
    onEvent: (event: TimelineEnvelope) => void
    onError?: (error: Error) => void
    onClose?: () => void
  }>()

  // Transport-connected state. Defaults to true: in-process
  // (local) providers have no transport to die, so they are always connected.
  // A remote-SSE provider (flitro) flips this false when its transport gives up
  // (max reconnect attempts reached) and true again when it (re)connects — so
  // the hook's `isConnected` (read off runtime.events.isConnected()) reflects
  // the actual transport, not merely whether a listener is subscribed.
  private connected = true

  // session contract: connect returns a per-listener unsubscribe. Previously a listener
  // could only be removed by disconnect() — which tears down ALL listeners and
  // fires every onClose. A second subscriber (e.g. a devtools panel or a
  // parallel hook) had no way to tear down without killing the stream for
  // everyone. The returned function removes ONLY this listener; onClose is NOT
  // fired (onClose is the disconnect/teardown signal — a single unsubscriber
  // is not a teardown). Returning `() => void` is assignable to the
  // `AgentTimelineStream.connect(): void` interface (a more specific return is
  // allowed), so the interface contract is preserved.
  connect(
    onEvent: (event: TimelineEnvelope) => void,
    onError?: (error: Error) => void,
    onClose?: () => void,
  ): () => void {
    const listener = { onEvent, onError, onClose }
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  disconnect(): void {
    for (const l of this.listeners) l.onClose?.()
    this.listeners.clear()
  }

  isConnected(): boolean {
    return this.connected
  }

  // setConnected lets a remote-transport driver report its live state.
  // Local/in-process providers never call this (stay default-connected).
  setConnected(connected: boolean): void {
    this.connected = connected
  }

  emit(event: TimelineEnvelope): void {
    for (const l of this.listeners) l.onEvent(event)
  }

  emitError(error: Error): void {
    for (const l of this.listeners) l.onError?.(error)
  }
}
