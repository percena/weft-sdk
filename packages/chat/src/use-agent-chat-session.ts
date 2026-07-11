import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentEvent as CoreAgentEvent } from '@weft/core'
import type { PlatformActions, Turn } from '@weft/ui'
import { groupMessagesByTurn } from '@weft/ui'
import {
  mapTimelineEnvelopeToProcessorEvent,
  processEvent,
  useEventProcessor,
  type Session,
  type SessionState,
} from '@weft/ui'
import type { TimelineEnvelope } from '@weft/timeline'
import { mergeTimelineIncremental, sortTimeline } from '@weft/timeline'
import type {
  AgentRuntime,
  AgentRuntimeState,
  AgentRuntimeStatus,
  PermissionResponseDetail,
  RuntimeCapabilityReport,
  SendMessageOptions,
} from '@weft/runtime-core'

export interface ChatAuthDetection {
  provider: string
  configured: boolean
  source?: string
  error?: string
}

export interface ChatRuntimeState {
  status: 'idle' | 'preflighting' | 'running' | 'ready' | 'failed' | string
}

export interface ChatEventSource {
  connect(onEvent: (event: CoreAgentEvent) => void, onError?: (error: Error) => void, onClose?: () => void): void
  disconnect(): void
  isConnected(): boolean
}

export interface ChatCommandSink {
  sendMessage(message: string): Promise<void>
  abort(reason?: string): Promise<void>
  respondToPermission(requestId: string, allowed: boolean, remember?: boolean, detail?: PermissionResponseDetail): Promise<void>
}

export interface ChatSessionRuntime {
  sessionId: string
  provider: string
  events: ChatEventSource
  commands: ChatCommandSink
  preflight(): Promise<ChatAuthDetection>
  getState(): ChatRuntimeState
}

export interface AgentChatSessionModel {
  session: Session | null
  turns: Turn[]
  isRunning: boolean
  auth: ChatAuthDetection | null
  error: Error | null
  sendMessage(message: string): Promise<void>
  abort(): Promise<void>
  respondToPermission(requestId: string, allowed: boolean, remember?: boolean, detail?: PermissionResponseDetail): Promise<void>
}

export interface UseAgentChatSessionOptions {
  runtime: ChatSessionRuntime
  workspaceId?: string
  workspaceName?: string
}

export interface TimelineChatPanelModel {
  session: Session
  turns: Turn[]
}

export type TimelineDetailKind =
  | 'permission'
  | 'runtime'
  | 'source'
  | 'skill'
  | 'automation'
  | 'host'
  | 'tool'

export interface TimelineDetailItem {
  id: string
  kind: TimelineDetailKind
  title: string
  summary?: string
  status?: string
  timestamp: number
  detail: unknown
  envelope: TimelineEnvelope
}

export interface TimelineAgentChatSessionModel extends TimelineChatPanelModel {
  timeline: TimelineEnvelope[]
  isRunning: boolean
  isConnected: boolean
  isReconnecting: boolean
  hasGap: boolean
  capabilityReport: RuntimeCapabilityReport | null
  error: Error | null
  sendMessage(message: string, options?: SendMessageOptions): Promise<void>
  abort(): Promise<void>
  respondToPermission(requestId: string, allowed: boolean, remember?: boolean, detail?: PermissionResponseDetail): Promise<void>
}

export interface UseTimelineAgentChatSessionOptions {
  runtime: AgentRuntime
  workspaceId?: string
  workspaceName?: string
}

export function createAgentChatPanelModel(args: {
  session: Session | null
  runtime: ChatSessionRuntime
  auth?: ChatAuthDetection | null
  error?: Error | null
}): Pick<AgentChatSessionModel, 'turns' | 'isRunning' | 'auth' | 'error'> {
  return {
    turns: args.session ? groupMessagesByTurn(args.session.messages) : [],
    isRunning: args.runtime.getState().status === 'running' || args.runtime.getState().status === 'preflighting',
    auth: args.auth ?? null,
    error: args.error ?? null,
  }
}

export function createAgentChatPanelModelFromTimeline(args: {
  timeline: TimelineEnvelope[]
  sessionId: string
  workspaceId: string
  workspaceName?: string
}): TimelineChatPanelModel {
  const ordered = sortTimeline(args.timeline)
  let state: SessionState = {
    session: {
      id: args.sessionId,
      workspaceId: args.workspaceId,
      workspaceName: args.workspaceName ?? '',
      lastMessageAt: ordered.at(-1)?.timestamp ?? Date.now(),
      messages: [],
      isProcessing: false,
    },
    streaming: null,
  }

  for (const envelope of ordered.filter(isChatTranscriptTimelineEnvelope)) {
    state = processEvent(state, mapTimelineEnvelopeToProcessorEvent(envelope)).state
  }

  return {
    session: state.session,
    turns: groupMessagesByTurn(state.session.messages),
  }
}

function isChatTranscriptTimelineEnvelope(envelope: TimelineEnvelope): boolean {
  if (!envelope.item) return false
  switch (envelope.item.type) {
    case 'user_message':
    case 'assistant_message_delta':
    case 'assistant_message':
    case 'reasoning_delta':
    case 'reasoning':
    case 'tool_call':
    case 'tool_output_delta':
    case 'tool_result':
    case 'permission_requested':
    case 'turn_completed':
    case 'turn_interrupted':
    case 'turn_failed':
      return true

    case 'runtime_capability_report':
    case 'runtime_fallback':
    case 'permission_resolved':
    case 'permission_policy_changed':
    case 'source_state_changed':
    case 'skill_activated':
    case 'automation_triggered':
    case 'automation_action_result':
    case 'host_state_changed':
    case 'turn_started':
    case 'session_status':
    case 'compaction_started':
    case 'compaction_boundary':
      return false

    default:
      return false
  }
}

export function createTimelineAgentChatPanelModel(args: {
  timeline: TimelineEnvelope[]
  sessionId: string
  workspaceId: string
  workspaceName?: string
  runtimeState: AgentRuntimeState
  capabilityReport: RuntimeCapabilityReport | null
  error: Error | null
}): Pick<TimelineAgentChatSessionModel, 'session' | 'turns' | 'isRunning' | 'capabilityReport' | 'error'> {
  const model = createAgentChatPanelModelFromTimeline({
    timeline: args.timeline,
    sessionId: args.sessionId,
    workspaceId: args.workspaceId,
    workspaceName: args.workspaceName,
  })

  return {
    ...model,
    isRunning: args.runtimeState.status === 'running' ||
      args.runtimeState.status === 'preflighting' ||
      args.runtimeState.status === 'starting' ||
      args.runtimeState.status === 'waiting_for_permission',
    capabilityReport: args.capabilityReport,
    error: args.error,
  }
}

export function createTimelineDetailItems(timeline: TimelineEnvelope[]): TimelineDetailItem[] {
  return sortTimeline(timeline)
    .flatMap((envelope) => timelineEnvelopeToDetailItem(envelope))
}

// A buffered timeline event plus whether it triggers an epoch rotation reset.
// Rotation is detected eagerly at ingest time (see useTimelineAgentChatSession)
// so these fold helpers stay pure and can run inside a React state updater.
export interface BufferedTimelineEvent {
  envelope: TimelineEnvelope
  rotated: boolean
}

// foldBatchIntoTimeline applies a frame's worth of buffered events to the
// timeline in one pass. It is exactly equivalent to applying each event
// individually (merge, or reset-to-[envelope] on rotation) — the rAF batch just
// coalesces the React commits. Pure: no side effects, safe as a state updater.
export function foldBatchIntoTimeline(
  current: TimelineEnvelope[],
  batch: BufferedTimelineEvent[],
): TimelineEnvelope[] {
  let next = current
  let incoming: TimelineEnvelope[] = []

  for (const { envelope, rotated } of batch) {
    if (rotated) {
      // Discard pending old-epoch incoming not yet merged. Drop old-epoch
      // SERVER envelopes (seq > 0) — the new epoch's replay is authoritative.
      // Preserve local meta-events (seq <= 0: capability report, warnings,
      // send-failure notices) from both the accumulated timeline and the
      // pending incoming — they are client-origin UI state, not part of the
      // server's replayed history, and re-minting would duplicate (T5-7:
      // previously `next = [envelope]` wiped the capability report on a fresh
      // session's first server event).
      const localMeta = [
        ...next.filter(env => env.seq <= 0),
        ...incoming.filter(env => env.seq <= 0),
      ]
      incoming = []
      next = [...localMeta, envelope]
      continue
    }
    incoming.push(envelope)
  }

  if (incoming.length > 0) {
    // P2 (07-02) residual: mergeTimelineIncremental exploits the invariant that
    // `next` is already sorted + deduped (a previous merge/rebuild output) to
    // skip the O(n) Map rebuild + full re-sort on the common streaming path
    // (same-epoch, strictly-higher seqs → non-overlapping append). Falls back
    // to the general merge for overlap/new-epoch/mixed cases. See
    // @weft/timeline mergeTimelineIncremental + its equivalence test.
    next = mergeTimelineIncremental(next, incoming)
  }

  return next
}

// foldBatchIntoSessionState folds a frame's worth of buffered events through the
// event processor in order. session contract: dedup by `epoch:seq` so an overlapping
// catchup batch (the same envelopes arriving via BOTH the onClose fetch and the
// SSE reconnect replay) does not double-append delta text — processEvent
// accumulates deltas into messages, so a delta folded twice appends its text
// twice. The scaffold's `ingest` dedups at the buffer level
// (runtime-scaffold.ts:211-213); this chat-layer fold was the unguarded path.
// The seen-set rides on `SessionState.processedKeys` so the fold stays a PURE
// state updater (copy-on-write: the input Set is never mutated, so React
// StrictMode's double-invoke is idempotent). Reset to a fresh set on a rotation
// (a new epoch's seqs are fresh). Local meta-events (seq <= 0) are never deduped
// (client-origin, may legitimately recur). Pure given a pure createInitial factory.
//
// session contract: `processedKeys` is capped (PROCESSED_KEYS_CAP) so a long single-epoch
// session can't leak memory through the dedup set. Eviction is OLDEST-first (Set
// iterates in insertion order) — a duplicate of an evicted key would only arrive
// from overlapping catchup near the recent cursor (well within the cap), and an
// epoch-rotation replay resets the set, so the cap is safe.
const PROCESSED_KEYS_CAP = 1000

export function foldBatchIntoSessionState(
  current: SessionState,
  batch: BufferedTimelineEvent[],
  createInitial: () => SessionState,
): SessionState {
  let s = current
  // Copy-on-write: never mutate the input Set. A fresh copy per fold keeps the
  // updater pure (StrictMode double-invoke produces equivalent states).
  let seen = new Set(current.processedKeys ?? [])
  for (const { envelope, rotated } of batch) {
    if (rotated) {
      s = createInitial()
      seen = new Set()
    }
    const key = `${envelope.epoch}:${envelope.seq}`
    if (envelope.seq > 0) {
      if (seen.has(key)) continue
      seen.add(key)
      // session contract: ring-buffer cap. Evict the oldest key (insertion order) so the
      // dedup set is bounded across a long single-epoch session.
      if (seen.size > PROCESSED_KEYS_CAP) {
        const oldest = seen.values().next().value
        if (oldest !== undefined) seen.delete(oldest)
      }
    }
    if (isChatTranscriptTimelineEnvelope(envelope)) {
      s = processEvent(s, mapTimelineEnvelopeToProcessorEvent(envelope)).state
    }
  }
  return { ...s, processedKeys: seen }
}

// catchupBatch builds a fold-ready batch from a catchup snapshot (the
// fetchTimeline result on a full-close reconnect), computing per-item rotation
// flags the same way the live onEvent path does — so the onClose catchup is
// rotation-aware: a catchup delivered under a new epoch resets old-epoch state
// instead of merging onto it and producing ghosts. `prevEpoch` is the epoch the
// client was pinned to before the catchup (lastCursorRef.epoch). Pure: no side
// effects, safe to test in isolation and to run inside a React state updater.
export function catchupBatch(
  items: TimelineEnvelope[],
  prevEpoch: string | null,
): BufferedTimelineEvent[] {
  let prev = prevEpoch
  const out: BufferedTimelineEvent[] = []
  for (const envelope of items) {
    const rotated = envelope.seq > 0 && prev !== null && prev !== envelope.epoch
    if (envelope.seq > 0) prev = envelope.epoch
    out.push({ envelope, rotated })
  }
  return out
}

// createFlushScheduler owns the rAF-batching mechanism: a pending queue, a
// scheduled flag, and the rAF/setTimeout handles. Extracted from the hook so
// the scheduling logic (coalesce a frame's worth of events into one flush,
// rAF→setTimeout fallback for Node/SSR, cleanup flush so the last frame is not
// lost, double-schedule dedup) is unit-testable without a React renderer.
// requestAnimationFrame/setTimeout are injectable for deterministic tests; the
// defaults resolve the globals lazily so Node/SSR (no rAF) falls back to a
// macrotask, matching the pre-extraction behavior.
export interface FlushScheduler {
  push(envelope: TimelineEnvelope, rotated: boolean): void
  schedule(): void
  flush(): void
  dispose(): void
}

export function createFlushScheduler(options: {
  flush: (batch: BufferedTimelineEvent[]) => void
  requestAnimationFrame?: (cb: () => void) => number
  cancelAnimationFrame?: (handle: number) => void
  setTimeout?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimeout?: (handle: ReturnType<typeof setTimeout>) => void
}): FlushScheduler {
  const raf =
    options.requestAnimationFrame ??
    (typeof requestAnimationFrame === 'function' ? requestAnimationFrame : undefined)
  const cancelRaf =
    options.cancelAnimationFrame ??
    (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : undefined)
  const setTimeoutFn = options.setTimeout ?? setTimeout
  const clearTimeoutFn = options.clearTimeout ?? clearTimeout

  const pending: BufferedTimelineEvent[] = []
  let scheduled = false
  let rafHandle: number | undefined
  let timerHandle: ReturnType<typeof setTimeout> | undefined

  const flush = () => {
    scheduled = false
    if (pending.length === 0) return
    const batch = pending.splice(0, pending.length)
    options.flush(batch)
  }

  return {
    push(envelope, rotated) {
      pending.push({ envelope, rotated })
    },
    schedule() {
      if (scheduled) return
      scheduled = true
      if (raf) {
        rafHandle = raf(flush)
      } else {
        timerHandle = setTimeoutFn(flush, 0)
      }
    },
    flush,
    dispose() {
      if (rafHandle !== undefined && cancelRaf) {
        cancelRaf(rafHandle)
      }
      if (timerHandle !== undefined) {
        clearTimeoutFn(timerHandle)
      }
      scheduled = false
      flush()
    },
  }
}

export function useAgentChatSession(options: UseAgentChatSessionOptions): AgentChatSessionModel {
  const { runtime, workspaceId = 'local-workspace', workspaceName = 'Local Workspace' } = options
  const [auth, setAuth] = useState<ChatAuthDetection | null>(null)
  const [error, setError] = useState<Error | null>(null)

  const processor = useEventProcessor({
    eventSource: runtime.events,
    sessionId: runtime.sessionId,
    workspaceId,
    workspaceName,
    onError: setError,
  })

  const sendMessage = useCallback(async (message: string) => {
    setError(null)
    try {
      if (!auth) {
        const detection = await runtime.preflight()
        setAuth(detection)
        if (!detection.configured) {
          throw new Error(detection.error ?? `${runtime.provider} auth is not configured`)
        }
      }
      await runtime.commands.sendMessage(message)
    } catch (err) {
      setError(err as Error)
      throw err
    }
  }, [auth, runtime])

  const abort = useCallback(async () => {
    await runtime.commands.abort('User aborted')
  }, [runtime])

  const respondToPermission = useCallback(async (requestId: string, allowed: boolean, remember?: boolean, detail?: PermissionResponseDetail) => {
    await runtime.commands.respondToPermission(requestId, allowed, remember, detail)
  }, [runtime])

  const model = useMemo(
    () => createAgentChatPanelModel({ session: processor.session, runtime, auth, error }),
    [processor.session, runtime, auth, error],
  )

  return {
    session: processor.session,
    turns: model.turns,
    isRunning: model.isRunning,
    auth,
    error,
    sendMessage,
    abort,
    respondToPermission,
  }
}

export function useTimelineAgentChatSession(
  options: UseTimelineAgentChatSessionOptions,
): TimelineAgentChatSessionModel {
  const { runtime, workspaceId = 'local-workspace', workspaceName = 'Local Workspace' } = options
  const [timeline, setTimeline] = useState<TimelineEnvelope[]>([])
  // Maintain session state incrementally — each incoming event is processed
  // via processEvent(current, event) instead of replaying the full timeline.
  // This matches the architecture of the Zustand-based web app (chat-store.ts)
  // and avoids the O(n) full-replay that caused main-thread blocking.
  const createInitialSessionState = (): SessionState => ({
    session: {
      id: runtime.sessionId,
      workspaceId,
      workspaceName,
      lastMessageAt: 0,
      messages: [],
      isProcessing: false,
    },
    streaming: null,
  })
  const [sessionState, setSessionState] = useState<SessionState>(createInitialSessionState)
  const [capabilityReport, setCapabilityReport] = useState<RuntimeCapabilityReport | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [isReconnecting, setIsReconnecting] = useState(false)
  const [hasGap, setHasGap] = useState(false)
  // session contract: mirror the reducer's runtime status into React state so `isRunning`
  // (read during render) is reactive. The reducer state is mutated by the
  // scaffold's `dispatch` (from `syncStateFromTimelineItem` during ingest, and
  // from the command paths) without triggering a React re-render — reading
  // `runtime.getState()` directly during render meant `isRunning` was stale
  // until some OTHER state (timeline/sessionState) happened to change. The
  // flush (runs on every batch of timeline events) + the command-resolution
  // points below re-sync the status, so the UI reflects transitions at most one
  // frame late — no worse than the prior stale behavior, and correct where it
  // was previously stuck (e.g. `sendMessage` → `running` before the first
  // stream event, `abort` → `ready`, `error` → `failed`).
  const [runtimeStatus, setRuntimeStatus] = useState<AgentRuntimeStatus>(
    () => runtime.getState().status,
  )

  // Track the last cursor for catchup after reconnect
  const lastCursorRef = useRef<{ epoch: string; afterSeq: number } | null>(null)

  useEffect(() => {
    let catchupAbort = false

    // rAF batching (Tier-1 latency): rapid token streaming delivers many SSE
    // events per animation frame. Committing setTimeline + setSessionState per
    // event triggers a full re-render each time. We coalesce a frame's worth of
    // envelopes into ONE pair of state commits. Rotation detection and the
    // reconnect cursor stay EAGER (below) so onClose catchup reads an accurate
    // cursor and StrictMode never double-mutates the ref; only the render
    // commits defer. Every buffered envelope is still folded through
    // processEvent in order, so no permission/turn state-machine transition is
    // dropped — it is delayed by at most one frame. The scheduling mechanism
    // lives in createFlushScheduler so it is unit-testable without a React
    // renderer. P2 (07-02) residual: the per-flush merge itself is now
    // incremental (mergeTimelineIncremental — O(m) on the streaming fast path,
    // falls back to the general O((n+m) log(n+m)) merge for overlap/new-epoch)
    // and groupMessagesByTurn is memoized on the messages array reference so
    // flushes that don't add/update a message skip the regroup entirely.
    //
    // session contract: a debounced `armReplay` clears replay-suppression mode after the
    // replay burst ends. During a burst, flushes fire every ~16ms (rAF); we
    // cancel+reschedule so armReplay only fires after ARM_REPLAY_QUIET_MS with
    // no new items → live dispatching (turn_completed+complete+drain, error,
    // onToolSuspended) resumes. Calling it every flush would clear replayMode
    // mid-replay and reintroduce the turn_failed wedge for multi-flush replays.
    // The replay burst is fast (buffered history drained in well under a
    // second); live turn events are spaced (seconds), so the quiet window
    // reliably separates them. Edge: a live turn resuming within the quiet
    // window dispatches replay_reconcile instead of complete+drain — harmless
    // when the message queue is empty (the common post-reconnect case).
    let armReplayTimer: ReturnType<typeof setTimeout> | undefined
    const ARM_REPLAY_QUIET_MS = 500
    const scheduler = createFlushScheduler({
      flush: batch => {
        setTimeline(current => foldBatchIntoTimeline(current, batch))
        setSessionState(current =>
          foldBatchIntoSessionState(current, batch, createInitialSessionState),
        )
        setIsReconnecting(false)
        // session contract: the scaffold dispatched reducer actions while folding this
        // batch (syncStateFromTimelineItem runs at ingest time, before the
        // hook's onEvent queued it); re-sync the mirrored status so render
        // reflects turn_failed/turn_completed/permission transitions.
        setRuntimeStatus(runtime.getState().status)
        if (armReplayTimer) clearTimeout(armReplayTimer)
        armReplayTimer = setTimeout(() => {
          armReplayTimer = undefined
          runtime.armReplay?.()
        }, ARM_REPLAY_QUIET_MS)
      },
    })

    const onEvent = (envelope: TimelineEnvelope) => {
      // Epoch rotation (Flitro restart): the server replays its full durable
      // history under a new epoch (T5). Because timeline + sessionState are keyed
      // by epoch:seq, merging the replay onto the old-epoch state would render
      // the whole conversation twice. Drop all old-epoch-derived state so the
      // authoritative replay rebuilds it cleanly. Only real server events
      // (seq > 0) drive a rotation; local meta-events (seq 0) never do.
      const prev = lastCursorRef.current
      const rotated = envelope.seq > 0 && prev !== null && prev.epoch !== envelope.epoch
      // session contract: only advance the reconnect cursor for real server events (seq > 0).
      // A seq=0 local meta-event (capability report, tool-suspension warning,
      // send-failure notice) must not rewind afterSeq to 0 — otherwise the next
      // onClose catchup re-fetches the whole epoch from the start.
      if (envelope.seq > 0) {
        lastCursorRef.current = { epoch: envelope.epoch, afterSeq: envelope.seq }
      }

      scheduler.push(envelope, rotated)
      scheduler.schedule()
    }

    const onError = (err: Error) => {
      setError(err)
      // session contract: a terminal transport error may have driven the reducer to
      // `failed`; re-sync so `isRunning` reflects it without waiting for a
      // flush (the error path doesn't always emit a timeline envelope).
      setRuntimeStatus(runtime.getState().status)
    }

    const onClose = () => {
      const state = runtime.getState()
      // session contract: mirror the status read here too — a `disposed`/`failed` close
      // is the basis for the reconnect decision and the rendered `isRunning`.
      setRuntimeStatus(state.status)
      if (state.status !== 'disposed' && state.status !== 'failed') {
        setIsReconnecting(true)

        if (lastCursorRef.current) {
          runtime.fetchTimeline({ cursor: lastCursorRef.current })
            .then((result) => {
              if (catchupAbort) return
              if (result.items.length > 0) {
                // Flush any pending live batch first so a pending rotation is
                // applied before the catchup folds — otherwise the catchup
                // could fold onto pre-rotation state and a subsequent rotation
                // flush would drop it (INT-5). Then route the catchup through
                // the same fold helpers as the live path (catchupBatch computes
                // rotation flags), so a catchup under a new epoch resets
                // old-epoch state instead of merging onto it (ghosts).
                scheduler.flush()
                const batch = catchupBatch(result.items, lastCursorRef.current?.epoch ?? null)
                setTimeline(current => foldBatchIntoTimeline(current, batch))
                setSessionState(current =>
                  foldBatchIntoSessionState(current, batch, createInitialSessionState),
                )
                const last = result.items[result.items.length - 1]
                if (last && last.seq > 0) {
                  lastCursorRef.current = { epoch: last.epoch, afterSeq: last.seq }
                }
              }
              if (result.hasGap) {
                setHasGap(true)
              }
            })
            .catch((catchupErr: Error) => {
              if (catchupAbort) return
              setError(catchupErr)
            })
        }
      }
    }

    runtime.events.connect(onEvent, onError, onClose)

    return () => {
      catchupAbort = true
      // Cancel any scheduled frame, then flush synchronously so a buffered batch
      // (e.g. the final tokens of a turn that arrived just before teardown) is
      // not lost on unmount/dispose or a runtime swap.
      scheduler.dispose()
      if (armReplayTimer) clearTimeout(armReplayTimer)
      runtime.events.disconnect()
    }
  }, [runtime, createInitialSessionState])

  const sendMessage = useCallback(async (message: string, options?: SendMessageOptions) => {
    setError(null)
    setHasGap(false)
    try {
      const report = capabilityReport ?? await runtime.preflight()
      setCapabilityReport(report)
      if (!report.auth.configured) {
        throw new Error(report.auth.error ?? `${runtime.provider} auth is not configured`)
      }
      await runtime.commands.sendMessage(message, options)
    } catch (err) {
      setError(err as Error)
      throw err
    } finally {
      // session contract: re-sync the mirrored status — sendMessage dispatched
      // send_message (→ running) or error (→ failed) in the reducer; without
      // this the rendered `isRunning` would be stale until the next flush.
      setRuntimeStatus(runtime.getState().status)
    }
  }, [capabilityReport, runtime])

  const abort = useCallback(async () => {
    await runtime.commands.abort('User aborted')
    // session contract: abort dispatched `abort` (→ ready); re-sync so `isRunning`
    // flips false without waiting for a flush that may never come (no stream
    // event follows a user-initiated abort).
    setRuntimeStatus(runtime.getState().status)
  }, [runtime])

  const respondToPermission = useCallback(async (requestId: string, allowed: boolean, remember?: boolean, detail?: PermissionResponseDetail) => {
    await runtime.commands.respondToPermission(requestId, allowed, remember, detail)
    // session contract: permission_response dispatched `permission_response` (→ running);
    // re-sync so the UI flips back to `isRunning` promptly.
    setRuntimeStatus(runtime.getState().status)
  }, [runtime])

  const turns = useMemo(
    // P2 (07-02) residual: dep on the messages ARRAY reference, not the
    // SessionState wrapper. foldBatchIntoSessionState always returns a NEW
    // SessionState (it rebuilds the processedKeys Set), so a dep on
    // `sessionState` re-ran groupMessagesByTurn on EVERY flush — even flushes
    // whose batch carried no chat-transcript events (capability reports,
    // permission events, status, deduped catchup) and thus left
    // `session.messages` referentially unchanged. processEvent preserves the
    // messages array reference for events that don't add/update a message
    // (e.g. turn_completed only flips session flags), so this dep skips the
    // O(n) regroup whenever messages didn't actually change. Matches the
    // pattern already used in ChatTranscript.tsx.
    () => groupMessagesByTurn(sessionState.session.messages),
    [sessionState.session.messages],
  )

  // session contract: derive `isRunning` from the mirrored `runtimeStatus` (a React
  // state) instead of a non-reactive `runtime.getState()` read during render.
  // The mirror is re-synced by the flush (every timeline batch) and by each
  // command-resolution point above, so transitions are reflected at most one
  // frame late — previously the read was stale until an unrelated setState
  // happened to re-render.
  const isRunning = runtimeStatus === 'running' ||
    runtimeStatus === 'preflighting' ||
    runtimeStatus === 'starting' ||
    runtimeStatus === 'waiting_for_permission'

  const isConnected = runtime.events.isConnected()

  return {
    session: sessionState.session,
    turns,
    timeline,
    isRunning,
    isConnected,
    isReconnecting,
    hasGap,
    capabilityReport,
    error,
    sendMessage,
    abort,
    respondToPermission,
  }
}

export type { PlatformActions }

function timelineEnvelopeToDetailItem(envelope: TimelineEnvelope): TimelineDetailItem[] {
  const { item } = envelope
  const id = `${envelope.epoch}:${envelope.seq}:${item.type}`

  switch (item.type) {
    case 'permission_requested':
      return [{
        id,
        kind: 'permission',
        title: `Permission requested: ${item.request.toolName}`,
        summary: item.request.reason,
        status: 'requested',
        timestamp: envelope.timestamp,
        detail: item.request,
        envelope,
      }]

    case 'permission_resolved':
      return [{
        id,
        kind: 'permission',
        title: `Permission ${item.resolution.allowed ? 'allowed' : 'denied'}`,
        summary: item.resolution.reason,
        status: item.resolution.allowed ? 'allowed' : 'denied',
        timestamp: envelope.timestamp,
        detail: item.resolution,
        envelope,
      }]

    case 'runtime_capability_report':
      return [{
        id,
        kind: 'runtime',
        title: 'Runtime capability report',
        summary: summarizeCapabilityReport(item.report),
        timestamp: envelope.timestamp,
        detail: item.report,
        envelope,
      }]

    case 'runtime_fallback':
      return [{
        id,
        kind: 'runtime',
        title: `Runtime fallback: ${item.to}`,
        summary: item.reason,
        status: 'degraded',
        timestamp: envelope.timestamp,
        detail: {
          from: item.from,
          to: item.to,
          reason: item.reason,
        },
        envelope,
      }]

    case 'source_state_changed':
      return [{
        id,
        kind: 'source',
        title: `Source state changed: ${extractDisplayName(item.source, 'source')}`,
        summary: extractStatus(item.source),
        timestamp: envelope.timestamp,
        detail: item.source,
        envelope,
      }]

    case 'skill_activated':
      return [{
        id,
        kind: 'skill',
        title: `Skill activated: ${extractDisplayName(item.skill, 'skill')}`,
        summary: extractStatus(item.skill),
        timestamp: envelope.timestamp,
        detail: item.skill,
        envelope,
      }]

    case 'automation_triggered':
      return [{
        id,
        kind: 'automation',
        title: `Automation triggered: ${item.automation.automationId}`,
        summary: item.automation.origin.type,
        timestamp: envelope.timestamp,
        detail: item.automation,
        envelope,
      }]

    case 'automation_action_result':
      return [{
        id,
        kind: 'automation',
        title: 'Automation action result',
        summary: extractStatus(item.result),
        timestamp: envelope.timestamp,
        detail: item.result,
        envelope,
      }]

    case 'host_state_changed':
      return [{
        id,
        kind: 'host',
        title: `Host state changed: ${extractDisplayName(item.state, 'host')}`,
        summary: extractStatus(item.state),
        timestamp: envelope.timestamp,
        detail: item.state,
        envelope,
      }]

    case 'tool_call':
      return [{
        id,
        kind: 'tool',
        title: `Tool call: ${item.name}`,
        summary: item.status,
        status: item.status,
        timestamp: envelope.timestamp,
        detail: item.detail ?? { callId: item.callId, name: item.name, status: item.status },
        envelope,
      }]

    case 'tool_result':
      return [{
        id,
        kind: 'tool',
        title: `Tool result: ${item.callId}`,
        status: item.isError ? 'failed' : 'completed',
        timestamp: envelope.timestamp,
        detail: item.result,
        envelope,
      }]

    default:
      return []
  }
}

function extractDisplayName(value: unknown, fallback: string): string {
  if (!value || typeof value !== 'object') return fallback
  const record = value as Record<string, unknown>
  for (const key of ['sourceSlug', 'skillSlug', 'name', 'id', 'kind']) {
    if (typeof record[key] === 'string' && record[key].length > 0) {
      return record[key]
    }
  }
  return fallback
}

function extractStatus(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  for (const key of ['status', 'state', 'reason']) {
    if (typeof record[key] === 'string' && record[key].length > 0) {
      return record[key]
    }
  }
  return undefined
}

function summarizeCapabilityReport(report: unknown): string | undefined {
  if (!report || typeof report !== 'object') return undefined
  const record = report as Record<string, unknown>
  const selected = typeof record.selected === 'string' ? record.selected : undefined
  const fallbackReason = typeof record.fallbackReason === 'string' ? record.fallbackReason : undefined
  return fallbackReason ?? selected
}
