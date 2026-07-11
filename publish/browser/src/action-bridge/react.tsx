/**
 * @weft/action-bridge/react — React glue for the action bridge.
 *
 * ```tsx
 * <button {...weftAction('submit-form', form.id)}>Submit</button>
 * <ActionReplayLayer source={eventSource} eventName="agent-action"
 *   map={toWeftActionEvent} onReplayed={refresh} />
 * ```
 */

import { useEffect, useRef } from 'react'
import {
  createActionBridge,
  weftAction,
  type ActionBridge,
  type ActionBridgeOptions,
  type ConnectOptions,
  type EventSourceLike,
  type WeftActionEvent,
} from './core.ts'

export { weftAction }
export type { WeftActionEvent }

export interface ActionReplayLayerProps<TRaw = unknown> extends Omit<ActionBridgeOptions, 'document'> {
  /** Event emitter carrying action descriptors (EventSource, WebSocket, …). */
  source?: EventSourceLike
  /** SSE event name on `source` (default `weft-action`). */
  eventName?: string
  /** Translate raw payloads into descriptors; return null to ignore. */
  map?: ConnectOptions<TRaw>['map']
}

/** Hook variant: returns the bridge so the host can `dispatch` directly. */
export function useActionBridge(options: Omit<ActionBridgeOptions, 'document'> = {}): ActionBridge {
  const bridgeRef = useRef<ActionBridge | null>(null)
  const optionsRef = useRef(options)
  optionsRef.current = options
  if (!bridgeRef.current) {
    bridgeRef.current = createActionBridge({
      ...options,
      onReplayed: (event) => optionsRef.current.onReplayed?.(event),
    })
  }
  useEffect(() => {
    return () => {
      bridgeRef.current?.dispose()
      bridgeRef.current = null
    }
  }, [])
  return bridgeRef.current
}

/**
 * Mounts an action bridge for the lifetime of the component and subscribes it
 * to `source`. Renders nothing — the automated live cursor manages its own DOM.
 */
export function ActionReplayLayer<TRaw = unknown>(props: ActionReplayLayerProps<TRaw>): null {
  const { source, eventName, map, ...bridgeOptions } = props
  const bridge = useActionBridge(bridgeOptions)
  const mapRef = useRef(map)
  mapRef.current = map

  useEffect(() => {
    if (!source) return
    return bridge.connect<TRaw>(source, {
      eventName,
      map: mapRef.current ? (raw) => mapRef.current?.(raw) ?? null : undefined,
    })
  }, [bridge, source, eventName])

  return null
}
