import type { AgentRuntimeStatus } from './contract.ts'

/**
 * Runtime state machine — the canonical reducer for AgentRuntime lifecycle.
 * Kept separate from the contract types so the public contract surface
 * (contract.ts) stays a pure type module.
 */

export interface AgentRuntimeState {
  status: AgentRuntimeStatus
  acceptedMessages: string[]
  queuedMessages: string[]
  lastError?: string
  waitingPermissionRequestId?: string
}

export type RuntimeAction =
  | { type: 'preflight_start' }
  | { type: 'preflight_ok' }
  | { type: 'preflight_error'; error: string }
  | { type: 'starting' }
  | { type: 'send_message'; message: string }
  | { type: 'permission_request'; requestId: string }
  | { type: 'permission_response' }
  | { type: 'turn_completed' }
  | { type: 'complete' }
  | { type: 'abort'; reason?: string }
  | { type: 'error'; error: string }
  | { type: 'dispose' }
  | {
      type: 'replay_reconcile'
      /**
       * The status implied by the LAST terminal marker in a replayed-history
       * batch (session contract). `ready` for a final turn_completed/turn_interrupted,
       * `failed` for a final turn_failed, `waiting_for_permission` (+ requestId)
       * for an unresolved permission_requested, `running` for a final
       * permission_resolved (turn resumed).
       */
      status: AgentRuntimeStatus
      requestId?: string
      /**
       * SDK-R-4: optional error message carried when reconciling to `failed`
       * (from a replayed `turn_failed`). Without this the UI shows a failed
       * status with no `lastError` message.
       */
      error?: string
    }

export const initialRuntimeState: AgentRuntimeState = {
  status: 'idle',
  acceptedMessages: [],
  queuedMessages: [],
}

/**
 * Canonical state machine reducer for AgentRuntime lifecycle.
 *
 * Transitions follow the architecture spec:
 *   idle → preflighting → ready → starting → running
 *   running → waiting_for_permission → running
 *   running → turn_completed → ready
 *   running → ready (via complete with empty queue)
 *   any → failed / disposed
 *   any non-disposed → ready (via abort)
 *
 * `send_message` while running enqueues (session manager semantics).
 * `complete` drains the queue: if a queued message exists, it is
 * immediately accepted and the state stays running.
 */
export function reduceRuntimeState(
  state: AgentRuntimeState = initialRuntimeState,
  action: RuntimeAction,
): AgentRuntimeState {
  switch (action.type) {
    case 'preflight_start':
      return { ...state, status: 'preflighting', lastError: undefined }

    case 'preflight_ok':
      return { ...state, status: 'ready', lastError: undefined }

    case 'preflight_error':
      return { ...state, status: 'failed', lastError: action.error }

    case 'starting':
      if (state.status === 'ready' || state.status === 'idle') {
        return { ...state, status: 'starting' }
      }
      return state

    case 'send_message':
      // session contract: a `send_message` must not silently resurrect a terminal state.
      // Previously the generic else-branch accepted ANY non-running/non-waiting
      // status (including `failed` and `disposed`) → `running`, so a send from
      // `failed` quietly un-failed the runtime and a send from `disposed`
      // re-animated a torn-down one. Terminal states require an explicit reset
      // (`abort` → `ready`) first; the scaffold's `sendMessage` does exactly
      // that before dispatching `send_message`, so the live retry-after-error
      // UX is preserved while the reducer stays guarded. This does NOT affect
      // the X-C `replay_reconcile` path (a separate action that sets status
      // unconditionally) — `send_message` is never dispatched in replay mode.
      if (state.status === 'running' || state.status === 'waiting_for_permission') {
        return {
          ...state,
          queuedMessages: [...state.queuedMessages, action.message],
        }
      }
      if (state.status === 'failed' || state.status === 'disposed') {
        // Terminal: drop the message rather than resurrect. The live send path
        // (scaffold.sendMessage) dispatches `abort` first when it detects
        // `failed`, so this no-op only fires if a caller bypasses the scaffold
        // (defense-in-depth).
        return state
      }
      return {
        ...state,
        status: 'running',
        acceptedMessages: [...state.acceptedMessages, action.message],
      }

    case 'permission_request':
      return {
        ...state,
        status: 'waiting_for_permission',
        waitingPermissionRequestId: action.requestId,
      }

    case 'permission_response':
      return {
        ...state,
        status: 'running',
        waitingPermissionRequestId: undefined,
      }

    case 'turn_completed':
      if (state.status === 'running') {
        return { ...state, status: 'turn_completed' }
      }
      return state

    case 'complete': {
      // A `complete` signal (sendMessage resolved) must not clobber a terminal
      // failed/disposed state. A driver may emit `turn_failed` and then resolve,
      // which dispatches `error` (→ failed) followed by `complete`; without this
      // guard the `complete` would incorrectly reset to ready.
      if (state.status === 'failed' || state.status === 'disposed') {
        return state
      }
      if (state.status === 'turn_completed') {
        const [nextMessage, ...remaining] = state.queuedMessages
        if (nextMessage) {
          return {
            ...state,
            status: 'running',
            acceptedMessages: [...state.acceptedMessages, nextMessage],
            queuedMessages: remaining,
          }
        }
        return { ...state, status: 'ready' }
      }

      const [nextMessage, ...remaining] = state.queuedMessages
      if (nextMessage) {
        return {
          ...state,
          status: 'running',
          acceptedMessages: [...state.acceptedMessages, nextMessage],
          queuedMessages: remaining,
        }
      }
      return { ...state, status: 'ready' }
    }

    case 'abort':
      return {
        ...state,
        status: 'ready',
        lastError: action.reason,
        queuedMessages: [],
        waitingPermissionRequestId: undefined,
      }

    case 'error':
      return { ...state, status: 'failed', lastError: action.error }

    case 'dispose':
      return {
        ...state,
        status: 'disposed',
        queuedMessages: [],
        waitingPermissionRequestId: undefined,
      }

    case 'replay_reconcile':
      // session contract: dispatched ONLY by the scaffold's replay-mode state sync after a
      // replayed-history batch (a reconnect/restart replay under a new epoch).
      // It UNCONDITIONALLY sets the status to the terminal marker implied by
      // the replayed history, bypassing the guarded live transitions. Without
      // it, a replayed `turn_failed` (→ error → failed) wedges: a later
      // replayed `turn_completed` is a no-op from `failed` (the reducer guards
      // `turn_completed` to `running`), so the terminal marker does NOT win.
      // `replay_reconcile` overwrites unconditionally, so the LAST terminal
      // marker wins. The live path never dispatches this — its per-item
      // dispatches are unchanged, so the live state machine is NOT regressed.
      // SDK-R-4: clear the reducer-visible queue on reconcile — the scaffold's
      // pendingQueue is the source of truth for drained sends, and a rotation
      // invalidates queued messages from the pre-rotation turn. Without this
      // the reducer's queuedMessages could disagree with the scaffold's
      // pendingQueue after a rotation (replay-driven ingest never drains).
      // Carry an optional `error` so a reconciled-to-failed status surfaces a
      // message (previously failed-with-no-lastError).
      return {
        ...state,
        status: action.status,
        waitingPermissionRequestId: action.requestId,
        queuedMessages: [],
        ...(action.status === 'failed' && action.error !== undefined
          ? { lastError: action.error }
          : {}),
      }

    default:
      // SDK-R-5: an unrecognized action makes the reducer return `undefined`
      // without a default, and every subsequent `getState().status` throws. TS
      // exhaustiveness protects same-version builds, but a consumer wiring a
      // custom action (or a stale dist receiving a newer action) would
      // hard-crash instead of no-op. Return state unchanged for unknown actions.
      return state
  }
}
