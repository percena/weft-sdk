import type { AgentEvent } from '@weft/core'
import type { AgentEventStream } from './types.ts'

export class PushAgentEventStream implements AgentEventStream {
  private connected = false
  private listeners: {
    onEvent: (event: AgentEvent) => void
    onError?: (error: Error) => void
    onClose?: () => void
  } | null = null

  connect(
    onEvent: (event: AgentEvent) => void,
    onError?: (error: Error) => void,
    onClose?: () => void,
  ): void {
    this.listeners = { onEvent, onError, onClose }
    this.connected = true
  }

  disconnect(): void {
    this.listeners = null
    this.connected = false
  }

  isConnected(): boolean {
    return this.connected
  }

  emit(event: AgentEvent): void {
    this.listeners?.onEvent(event)
  }

  fail(error: Error): void {
    this.listeners?.onError?.(error)
  }

  close(): void {
    this.connected = false
    this.listeners?.onClose?.()
  }
}
