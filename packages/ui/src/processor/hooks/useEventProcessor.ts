/**
 * Event Processor Hook
 *
 * Provides the event processor for use in React apps.
 * Manages streaming state per session and returns processed events.
 *
 * Accepts an EventSource (WebSocket, SSE, in-process) instead of
 * Electron IPC (window.electronAPI). Uses React useState/useRef
 * instead of Jotai atoms for state management.
 */

import { useCallback, useRef, useState, useEffect } from 'react'
import type { AgentEvent as CoreAgentEvent } from '@weft/core'
import type { EventSource } from '../event-source'
import { processEvent } from '../processor'
import { mapCoreEventToProcessorEvent } from '../event-mapper'
import type { SessionState, Effect, StreamingState } from '../types'
import type { Session } from '../types'
import { createEmptySession } from '../helpers'

interface UseEventProcessorOptions {
  /** EventSource to receive agent events from */
  eventSource: EventSource
  /** Session ID to associate with incoming events */
  sessionId: string
  /** Workspace ID for creating new sessions */
  workspaceId: string
  /** Workspace name for creating new sessions */
  workspaceName?: string
  /** Callback for side effects (permissions, toasts, etc.) */
  onEffect?: (effect: Effect) => void
  /** Callback for errors from the event source */
  onError?: (error: Error) => void
  /** Callback when event source disconnects */
  onClose?: () => void
}

interface UseEventProcessorResult {
  /** Current session state (messages, processing status, etc.) */
  session: Session | null
  /** Current streaming state for the session */
  streamingState: StreamingState | null
  /**
   * Process an agent event and return the updated session + any side effects
   *
   * @param event - The core AgentEvent to process
   * @returns Updated session and any side effects to execute
   */
  processAgentEvent: (
    event: CoreAgentEvent,
  ) => { session: Session; effects: Effect[] }

  /**
   * Clear streaming state for the session (e.g., on error or complete)
   */
  clearStreamingState: () => void

  /**
   * Get current streaming state (for debugging/testing)
   */
  getStreamingState: () => StreamingState | null

  /**
   * Whether the event source is currently connected
   */
  isConnected: boolean
}

/**
 * Hook that provides the event processor connected to an EventSource.
 *
 * Manages streaming state per session using React useRef (not Jotai atoms).
 * All event processing goes through pure functions.
 *
 * Connects to the EventSource on mount and disconnects on unmount.
 */
export function useEventProcessor(
  options: UseEventProcessorOptions,
): UseEventProcessorResult {
  const { eventSource, sessionId, workspaceId, workspaceName, onEffect, onError, onClose } = options

  // Session state (React state so UI re-renders on changes)
  const [session, setSession] = useState<Session | null>(null)
  const sessionRef = useRef<Session | null>(null)

  // Streaming state per session (ref for accumulation, not UI-triggering)
  const streamingStates = useRef<Map<string, StreamingState>>(new Map())

  // Connection state
  const [isConnected, setIsConnected] = useState(false)

  // Track processed event count for debugging
  const processedCount = useRef(0)

  const processAgentEvent = useCallback((
    event: CoreAgentEvent,
  ): { session: Session; effects: Effect[] } => {
    const processorEvent = mapCoreEventToProcessorEvent(event, sessionId)

    // Create empty session if needed
    const currentSession = sessionRef.current ?? createEmptySession(sessionId, workspaceId, workspaceName ?? '')

    // Build current state
    const currentState: SessionState = {
      session: currentSession,
      streaming: streamingStates.current.get(sessionId) ?? null,
    }

    // Process through pure function
    const result = processEvent(currentState, processorEvent)

    // Update streaming state ref
    if (result.state.streaming) {
      streamingStates.current.set(sessionId, result.state.streaming)
    } else {
      streamingStates.current.delete(sessionId)
    }

    // Update React state
    sessionRef.current = result.state.session
    setSession(result.state.session)

    return {
      session: result.state.session,
      effects: result.effects,
    }
  }, [sessionId, workspaceId, workspaceName])

  // Connect to EventSource on mount, disconnect on unmount
  useEffect(() => {
    eventSource.connect(
      (coreEvent: CoreAgentEvent) => {
        const result = processAgentEvent(coreEvent)

        processedCount.current++

        // Execute side effects via callback
        for (const effect of result.effects) {
          onEffect?.(effect)
        }
      },
      (error: Error) => {
        onError?.(error)
      },
      () => {
        setIsConnected(false)
        onClose?.()
      },
    )

    setIsConnected(true)

    return () => {
      eventSource.disconnect()
      setIsConnected(false)
    }
  }, [eventSource, processAgentEvent, onEffect, onError, onClose])

  const clearStreamingState = useCallback(() => {
    streamingStates.current.delete(sessionId)
  }, [sessionId])

  const getStreamingState = useCallback(() => {
    return streamingStates.current.get(sessionId) ?? null
  }, [sessionId])

  return {
    session,
    streamingState: streamingStates.current.get(sessionId) ?? null,
    processAgentEvent,
    clearStreamingState,
    getStreamingState,
    isConnected,
  }
}
