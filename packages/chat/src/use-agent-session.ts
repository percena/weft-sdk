/**
 * useAgentSession — runtime-agnostic hook for managing an agent session.
 *
 * The hook is provider-agnostic: the caller supplies a `createRuntime`
 * factory that returns any `AgentRuntime` implementation (Flitro, Claude
 * Code, Codex, or a custom one).  The hook wraps it in a deferred
 * lifecycle suitable for React 19 StrictMode.
 */

import { useEffect, useMemo, useRef } from 'react'
import { initialRuntimeState, type AgentRuntime, type AgentRuntimeKind, } from '@weft/runtime-core'

export interface UseAgentSessionOptions {
  /** Stable session identifier — runtime is recreated when this changes. */
  sessionId: string
  /** Factory that produces the `AgentRuntime`. Called lazily on first interaction. */
  createRuntime: () => AgentRuntime
  /** Provider name surfaced in the returned `AgentSession` (default `"agent"`). */
  provider?: string
  /** Runtime kind surfaced before the real runtime is created (default `"app-server"`). */
  runtimeKind?: AgentRuntimeKind
}

export interface AgentSession {
  runtime: AgentRuntime
  sessionId: string
}

export function useAgentSession(options: UseAgentSessionOptions): AgentSession {
  const createRuntimeRef = useRef(options.createRuntime)
  createRuntimeRef.current = options.createRuntime

  const runtime = useMemo(() => {
    return createDeferredAgentRuntime({
      provider: options.provider ?? 'agent',
      runtimeKind: options.runtimeKind ?? 'app-server',
      sessionId: options.sessionId,
      createRuntime: () => createRuntimeRef.current(),
    })
  }, [options.sessionId, options.runtimeKind, options.provider])

  useEffect(() => {
    return () => {
      void runtime.disposeIfCreated()
    }
  }, [runtime])

  return { runtime, sessionId: options.sessionId }
}

export interface DeferredAgentRuntimeOptions {
  provider: string
  runtimeKind: AgentRuntime['runtimeKind']
  sessionId: string
  createRuntime: () => AgentRuntime
}

export interface DeferredAgentRuntime extends AgentRuntime {
  /**
   * Disposes the underlying runtime if one was created. Revivable: a later
   * `connect`/`sendMessage` lazily creates a fresh runtime, so this is safe
   * as a React effect cleanup under StrictMode's simulated remount. Use
   * `commands.dispose()` for terminal disposal.
   */
  disposeIfCreated(): Promise<void>
}

export function createDeferredAgentRuntime(options: DeferredAgentRuntimeOptions): DeferredAgentRuntime {
  let runtime: AgentRuntime | null = null
  let disposed = false

  const getRuntime = (): AgentRuntime => {
    if (disposed) {
      throw new Error('Agent runtime has been disposed')
    }
    runtime ??= options.createRuntime()
    return runtime
  }

  return {
    get sessionId() {
      return runtime?.sessionId ?? options.sessionId
    },

    get provider() {
      return runtime?.provider ?? options.provider
    },

    get runtimeKind() {
      return runtime?.runtimeKind ?? options.runtimeKind
    },

    events: {
      connect(onEvent, onError, onClose) {
        getRuntime().events.connect(onEvent, onError, onClose)
      },

      disconnect() {
        runtime?.events.disconnect()
      },

      isConnected() {
        return runtime?.events.isConnected() ?? false
      },
    },

    commands: {
      sendMessage(message, sendOptions) {
        return getRuntime().commands.sendMessage(message, sendOptions)
      },

      abort(reason) {
        return getRuntime().commands.abort(reason)
      },

      respondToPermission(requestId, allowed, remember, detail) {
        return getRuntime().commands.respondToPermission(requestId, allowed, remember, detail)
      },

      async resumeTool(runId, resumeData) {
        const commands = getRuntime().commands
        if (!commands.resumeTool) {
          throw new Error(`resumeTool is not supported by the ${options.provider} runtime`)
        }
        await commands.resumeTool(runId, resumeData)
      },

      dispose() {
        disposed = true
        const current = runtime
        runtime = null
        return current?.commands.dispose() ?? Promise.resolve()
      },
    },

    preflight() {
      return getRuntime().preflight()
    },

    fetchTimeline(request) {
      return getRuntime().fetchTimeline(request)
    },

    getState() {
      return runtime?.getState() ?? {
        status: initialRuntimeState.status,
        acceptedMessages: [],
        queuedMessages: [],
      }
    },

    async disposeIfCreated() {
      if (!runtime) return
      // Detach before the async dispose so a concurrent connect (e.g. a
      // StrictMode remount) creates a fresh runtime instead of racing the
      // one being torn down. Deliberately leaves `disposed` untouched.
      const current = runtime
      runtime = null
      await current.commands.dispose()
    },
  }
}
