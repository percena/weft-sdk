/**
 * Event Source Interface
 *
 * Generic abstraction for receiving SessionEvent streams.
 * Replaces Electron IPC (window.electronAPI.onSessionEvent) with
 * a provider-agnostic interface that works in any runtime:
 * - WebSocket (browser/server)
 * - HTTP SSE (server)
 * - stdin/stdout (CLI)
 * - In-process (testing)
 */

import type { AgentEvent } from '@weft/core';

/**
 * Event source callback — receives events from the source.
 */
export type EventSourceCallback = (event: AgentEvent) => void;

/**
 * Error callback — receives errors from the source.
 */
export type EventSourceErrorCallback = (error: Error) => void;

/**
 * Close callback — called when the source is disconnected.
 */
export type EventSourceCloseCallback = () => void;

/**
 * Generic event source interface.
 * Implementations provide events from different transports.
 */
export interface EventSource {
  /**
   * Start receiving events.
   * @param onEvent - Callback for each AgentEvent
   * @param onError - Callback for transport errors
   * @param onClose - Callback when source disconnects
   */
  connect(
    onEvent: EventSourceCallback,
    onError?: EventSourceErrorCallback,
    onClose?: EventSourceCloseCallback,
  ): void;

  /**
   * Stop receiving events and clean up resources.
   */
  disconnect(): void;

  /**
   * Check if the source is currently connected.
   */
  isConnected(): boolean;
}

/**
 * WebSocket-based EventSource implementation.
 * Receives SessionEvent messages over a WebSocket connection.
 */
export class WebSocketEventSource implements EventSource {
  private ws: WebSocket | null = null;
  private connected: boolean = false;
  private url: string;
  private protocols?: string | string[];

  constructor(url: string, protocols?: string | string[]) {
    this.url = url;
    this.protocols = protocols;
  }

  connect(
    onEvent: EventSourceCallback,
    onError?: EventSourceErrorCallback,
    onClose?: EventSourceCloseCallback,
  ): void {
    this.ws = new WebSocket(this.url, this.protocols);

    this.ws.onmessage = (msg) => {
      try {
        const event = JSON.parse(msg.data as string) as AgentEvent;
        onEvent(event);
      } catch (e) {
        onError?.(new Error(`Failed to parse event: ${e}`));
      }
    };

    this.ws.onerror = (e) => {
      onError?.(new Error(`WebSocket error: ${e}`));
    };

    this.ws.onclose = () => {
      this.connected = false;
      onClose?.();
    };

    this.ws.onopen = () => {
      this.connected = true;
    };
  }

  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
      this.connected = false;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }
}

/**
 * SSE (Server-Sent Events) EventSource implementation.
 * Receives SessionEvent messages over an HTTP SSE connection.
 */
export class SSEEventSource implements EventSource {
  private source: globalThis.EventSource | null = null;
  private connected: boolean = false;
  private url: string;

  constructor(url: string) {
    this.url = url;
  }

  connect(
    onEvent: EventSourceCallback,
    onError?: EventSourceErrorCallback,
    _onClose?: EventSourceCloseCallback,
  ): void {
    this.source = new globalThis.EventSource(this.url);

    this.source.onmessage = (msg) => {
      try {
        const event = JSON.parse(msg.data as string) as AgentEvent;
        onEvent(event);
      } catch (e) {
        onError?.(new Error(`Failed to parse SSE event: ${e}`));
      }
    };

    this.source.onerror = () => {
      this.connected = false;
      onError?.(new Error('SSE connection error'));
    };

    this.source.onopen = () => {
      this.connected = true;
    };
  }

  disconnect(): void {
    if (this.source) {
      this.source.close();
      this.source = null;
      this.connected = false;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }
}

/**
 * In-process EventSource for testing.
 * Events are pushed directly via enqueue().
 */
export class InProcessEventSource implements EventSource {
  private listeners: {
    onEvent: EventSourceCallback;
    onError?: EventSourceErrorCallback;
    onClose?: EventSourceCloseCallback;
  } | null = null;
  private connected: boolean = false;

  connect(
    onEvent: EventSourceCallback,
    onError?: EventSourceErrorCallback,
    onClose?: EventSourceCloseCallback,
  ): void {
    this.listeners = { onEvent, onError, onClose };
    this.connected = true;
  }

  disconnect(): void {
    this.listeners = null;
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Push an event directly to the connected listener.
   * Useful for testing and in-process scenarios.
   */
  enqueue(event: AgentEvent): void {
    if (this.listeners) {
      this.listeners.onEvent(event);
    }
  }

  /**
   * Simulate an error.
   */
  simulateError(error: Error): void {
    if (this.listeners?.onError) {
      this.listeners.onError(error);
    }
  }

  /**
   * Simulate a disconnect.
   */
  simulateClose(): void {
    if (this.listeners?.onClose) {
      this.listeners.onClose();
    }
    this.connected = false;
  }
}