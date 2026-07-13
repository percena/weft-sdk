import {
  createRuntimeExtensionContext,
  initialRuntimeState,
  reduceRuntimeState,
  type AgentRuntime,
  type AgentRuntimeState,
  type CommandOrigin,
  type PermissionResponseDetail,
  type RuntimeAction,
  type RuntimeCapabilityReport,
  type RuntimeExtensionContext,
  type SendMessageOptions,
} from '@weft/runtime-core'
import {
  createTimelineCursor,
  fetchTimeline,
  type TimelineEnvelope,
  type TimelineFetchRequest,
  type TimelineFetchResult,
  type TimelineItem,
  type TimelineRawRef,
  type TimelineSequencer,
} from '@weft/timeline'
import { PushTimelineStream } from './push-timeline-stream.ts'

export interface ProviderRuntimeDriverInput {
  message: string
  options?: SendMessageOptions
  origin?: CommandOrigin
}

export interface ProviderRuntimeDriver {
  sendMessage(input: ProviderRuntimeDriverInput, sequencer: TimelineSequencer): Promise<void>
  abort?(reason?: string): Promise<void>
  respondToPermission?(
    requestId: string,
    allowed: boolean,
    remember?: boolean,
    detail?: PermissionResponseDetail,
  ): Promise<void>
  /** Resume a suspended host-side tool (e.g. OpenAI function-calling model).
   *  Mirrors `AgentCommandSink.resumeTool`. */
  resumeTool?(runId: string, resumeData: Record<string, unknown>): Promise<void>
  dispose?(): Promise<void>
}

/**
 * Completion model for a provider runtime.
 *
 * - `'eager'` (default): the driver's `sendMessage` resolves only once the whole
 *   turn is done, so the scaffold dispatches `complete` on resolve. Used by the
 *   claude / codex "local producer" runtimes.
 * - `'deferred'`: the driver returns immediately (fire-and-forget transport) and
 *   the turn completes when a `turn_completed` / `turn_interrupted` /
 *   `turn_failed` timeline item arrives — typically streamed from a remote
 *   server (the flitro SSE "replica" model). The scaffold does NOT dispatch
 *   `complete` on resolve; `syncStateFromTimelineItem` dispatches it when the
 *   terminal item lands and drains the message queue.
 */
export type RuntimeCompletionMode = 'eager' | 'deferred'

export interface RuntimeScaffoldConfig {
  provider: string
  sessionId: string
  epoch?: string
  now?: () => number
  report: RuntimeCapabilityReport
  extensions?: RuntimeExtensionContext
  getDriver: () => ProviderRuntimeDriver | undefined | Promise<ProviderRuntimeDriver | undefined>
  onDispose?: () => void | Promise<void>
  /** See {@link RuntimeCompletionMode}. */
  completion?: RuntimeCompletionMode
  /** Deferred mode: called to actually send a message. Invoked for the accepted
   *  message and for each queued message drained on turn completion. The host
   *  owns the transport (e.g. POST a run + any pre-send policy); the scaffold
   *  owns state. If omitted, the scaffold calls `driver.sendMessage` directly. */
  onMessageDrained?: (input: ProviderRuntimeDriverInput, sequencer: TimelineSequencer) => Promise<void>
  /** Deferred mode: lazily resolve the runtime's sessionId (e.g. create the
   *  server session on first send). Called once before the first message is
   *  sent. May also return an updated epoch (e.g. `provider-${sessionId}`). */
  resolveSessionId?: () => Promise<string | { sessionId: string; epoch?: string }>
  /** Remote timeline fetch for gap filling (replica mode). Called when the local
   *  in-memory buffer has no items for the requested cursor. */
  remoteTimelineFetch?: (request: TimelineFetchRequest) => Promise<TimelineFetchResult | undefined>
  /** Side-effect hook invoked when a `tool_suspended` item is ingested, so the
   *  host can run client-side tool execution and resume via `submitToolOutputs`. */
  onToolSuspended?: (item: Extract<TimelineItem, { type: 'tool_suspended' }>) => void
  /** Dedup ingested envelopes by `epoch:seq` (SSE replay safety). Default false. */
  dedup?: boolean
  /**
   * session contract: soft cap on the in-memory `timeline[]` buffer + the dedup
   * `seenKeys` set. Without a cap both grow without bound for the lifetime of
   * a long single-epoch session (a memory leak). When the cap is exceeded the
   * OLDEST entries are evicted (ring-buffer semantics) — the most-recent
   * envelopes (which the reconnect cursor + local `fetchTimeline` gap-fill
   * read off) are always retained. The chat hook's React timeline state is
   * separate and unbounded (it holds the display history), so capping the
   * scaffold's buffer does not lose rendered messages. Default 1000.
   */
  historyCap?: number
}

export interface ProviderRuntimeScaffold extends AgentRuntime {
  readonly sequencer: TimelineSequencer
  readonly timeline: TimelineEnvelope[]
  readonly stream: PushTimelineStream
  dispatch(action: RuntimeAction): void
  appendFailure(message: string): void
  /** Ingest a pre-built envelope verbatim (replica mode — e.g. an envelope
   *  streamed from a remote server, whose `seq`/`epoch` must be preserved).
   *  Shares the dedup set + state sync + buffer with {@link sequencer.append}. */
  appendEnvelope(envelope: TimelineEnvelope): void
  /** session contract: clear replay-suppression mode after a replayed-history batch so
   *  live state dispatching (turn_completed+complete+drain, error, permission_*,
   *  onToolSuspended) resumes. No-op when not in replay mode. */
  armReplay(): void
}

export function createProviderRuntimeScaffold(config: RuntimeScaffoldConfig): ProviderRuntimeScaffold {
  const extensions = createRuntimeExtensionContext(config.extensions)
  const timeline: TimelineEnvelope[] = []
  const stream = new PushTimelineStream()
  const completion: RuntimeCompletionMode = config.completion ?? 'eager'
  const isDeferred = completion === 'deferred'
  const now = config.now ?? (() => Date.now())
  // session contract: ring-buffer cap for the in-memory timeline + dedup set. Default
  // 1000 — a safety net for long single-epoch sessions, not a frequent eviction.
  const historyCap = config.historyCap ?? 1000

  // Mutable session identity — eager runtimes never mutate these; deferred
  // (replica) runtimes update them via `resolveSessionId` when the server
  // session is created on first send.
  let currentSessionId = config.sessionId
  let currentEpoch = config.epoch ?? 'default'
  let seq = 0
  const seenKeys = new Set<string>()

  // Deferred-mode message queue. Mirrors the reducer's `queuedMessages`
  // (strings, for getState observability) but retains per-message `options`
  // so drained sends keep their per-turn overrides (permissionMode, model…).
  const pendingQueue: ProviderRuntimeDriverInput[] = []

  let state: AgentRuntimeState = initialRuntimeState
  let driverRef: ProviderRuntimeDriver | undefined
  let sessionResolved = !config.resolveSessionId
  let disposed = false
  // session contract: replay-suppression mode. Set to true when `ingest` detects an epoch
  // rotation (the server replaying durable history under a new epoch after a
  // restart/idle-eviction). While true, `syncStateFromTimelineItem` folds for
  // TRANSCRIPT only — per-item state dispatches are replaced with an
  // unconditional `replay_reconcile` from the terminal marker, so the LAST
  // terminal marker wins and a mid-history `turn_failed` can't wedge. Cleared
  // by `armReplay()` (the chat hook after a flush, or the contract test
  // explicitly) so live dispatching resumes.
  let replayMode = false
  // Fallback armReplay timer: scheduled when a tool_suspended is tracked during
  // a replay, so armReplay fires even if the host's flush-based timer never
  // does (a client-side tool suspension pauses the run → no further flushes).
  // See `syncReplayState`'s tool_suspended case + `armReplayInternal`.
  const ARM_REPLAY_FALLBACK_MS = 500
  let pendingArmReplayTimer: ReturnType<typeof setTimeout> | undefined
  // SDK-R-2: tool_suspended items seen during a replay that have no matching
  // tool_resumed/tool_result later in the SAME replay. On `armReplay()` these
  // are re-fired via onToolSuspended so a page reload while a run sat in
  // Flitro's Suspended state still resumes the run (otherwise the replayed
  // tool_suspended is suppressed and the run wedges until Flitro's 2h sweeper).
  // Keyed by callId; cleared by tool_resumed/tool_result with the same callId,
  // and reset wholesale on epoch rotation (a new replay batch starts fresh).
  const replaySuspended = new Map<string, Extract<TimelineItem, { type: 'tool_suspended' }>>()

  function dispatch(action: RuntimeAction): void {
    state = reduceRuntimeState(state, action)
  }

  // session contract: during a replayed-history batch (post epoch-rotation), state-sync
  // folds for transcript only. Each terminal marker dispatches an UNCONDITIONAL
  // `replay_reconcile` (the live reducer's guarded `error`/`turn_completed`
  // would wedge: turn_failed→failed, then turn_completed is a no-op from
  // failed). `replay_reconcile` overwrites unconditionally, so the LAST terminal
  // marker wins. `tool_suspended` is tracked (SDK-R-2) for re-fire on
  // `armReplay()` — it is NOT dispatched live during replay (the suspension was
  // already handled when it first happened; re-firing mid-replay would duplicate
  // client-side tool execution AND the replay may not yet have the matching
  // tool_resumed that resolves it). Live dispatching (`turn_completed`+complete+
  // drain, `error`, `permission_request`, onToolSuspended) resumes after
  // `armReplay()`.
  function syncReplayState(item: TimelineItem): void {
    // Reset the fallback armReplay timer on each replay event while a
    // suspension is tracked, so it fires ARM_REPLAY_FALLBACK_MS after the
    // LAST event in the batch — matching the host's flush-based timer — not
    // mid-batch after the tool_suspended. Without this, a long fast replay
    // (total > ARM_REPLAY_FALLBACK_MS) would let the fallback fire mid-batch,
    // exiting replay suppression before later events (e.g. a turn_failed) are
    // replay_reconcile'd (risking the session contract turn_failed→failed wedge).
    if (pendingArmReplayTimer !== undefined) {
      clearTimeout(pendingArmReplayTimer)
      pendingArmReplayTimer = setTimeout(armReplayInternal, ARM_REPLAY_FALLBACK_MS)
    }
    switch (item.type) {
      case 'turn_completed':
      case 'turn_interrupted':
        dispatch({ type: 'replay_reconcile', status: 'ready' })
        return
      case 'turn_failed':
        // SDK-R-4: carry the error so the reconciled-to-failed status surfaces
        // a message (the reducer sets lastError from action.error).
        dispatch({ type: 'replay_reconcile', status: 'failed', error: turnFailedErrorMessage(item.error) })
        return
      case 'permission_requested':
        dispatch({ type: 'replay_reconcile', status: 'waiting_for_permission', requestId: item.request.requestId })
        return
      case 'permission_resolved':
        dispatch({ type: 'replay_reconcile', status: 'running' })
        return
      case 'tool_resumed':
        // SDK-R-2: tool_resumed resolves an outstanding tool_suspended — drop
        // it from the re-fire map so armReplay doesn't re-fire a suspension
        // that's already been resumed.
        replaySuspended.delete(item.callId)
        dispatch({ type: 'replay_reconcile', status: 'running' })
        return
      case 'tool_suspended':
        // SDK-R-2: track for re-fire on armReplay. If a matching tool_resumed /
        // tool_result arrives later in the SAME replay, the entry is dropped.
        replaySuspended.set(item.callId, item)
        // Fallback re-fire: armReplay is normally driven by the host (the chat
        // hook's debounced flush timer, ~500ms after the replay batch settles).
        // But a run that has suspended on a client-side tool is paused waiting
        // for the very tool-output the suspension produces — no further events
        // arrive, the host's flush never fires again, armReplay never runs, and
        // the run wedges at the first tool call. The session→run epoch
        // transition (flitro-<sid> → flitro-<sid>-<bootID>-g0) makes the run's
        // first batch a "replay", so the LIVE tool_suspended is tracked here
        // and never re-fired by the host. This scaffold-level fallback timer
        // guarantees armReplay fires even when the host's flush-based timer
        // doesn't. Idempotent: armReplayInternal clears the timer and is a
        // no-op if the host already armed replay. Cleared on dispose.
        if (pendingArmReplayTimer === undefined) {
          pendingArmReplayTimer = setTimeout(armReplayInternal, ARM_REPLAY_FALLBACK_MS)
        }
        return
      case 'tool_result':
        // SDK-R-2: a tool_result for a suspended call resolves the suspension.
        replaySuspended.delete(item.callId)
        return
      case 'session_status':
        if (item.status === 'running') dispatch({ type: 'replay_reconcile', status: 'running' })
        else if (item.status === 'ended') dispatch({ type: 'replay_reconcile', status: 'ready' })
        return
      default:
        // Observational items (deltas, tool_call, …) do not drive state.
        return
    }
  }

  function syncStateFromTimelineItem(item: TimelineItem): void {
    if (replayMode) {
      syncReplayState(item)
      return
    }
    switch (item.type) {
      case 'permission_requested':
        dispatch({ type: 'permission_request', requestId: item.request.requestId })
        return
      case 'permission_resolved':
        dispatch({ type: 'permission_response' })
        return
      case 'turn_completed':
        dispatch({ type: 'turn_completed' })
        if (isDeferred) drainOnCompletion()
        return
      case 'turn_interrupted':
        // A server-initiated interrupt (not a user abort) ends the turn without
        // failure; treat it like a normal completion for state purposes.
        dispatch({ type: 'turn_completed' })
        if (isDeferred) drainOnCompletion()
        return
      case 'turn_failed':
        // A driver/server-reported turn failure drives the runtime into the
        // failed state. `appendFailure` is only for unexpected exceptions; a
        // structured turn_failed carries its own payload.
        dispatch({ type: 'error', error: turnFailedErrorMessage(item.error) })
        if (isDeferred) drainOnCompletion()
        return
      case 'tool_suspended':
        config.onToolSuspended?.(item)
        return
      case 'tool_resumed':
        dispatch({ type: 'permission_response' })
        return
      case 'session_status':
        if (item.status === 'running') {
          dispatch({ type: 'starting' })
        } else if (item.status === 'ended') {
          // Run was canceled externally; return to ready so the UI isn't stuck.
          dispatch({ type: 'abort' })
        }
        return
      default:
        // Observational items (assistant_message_delta, tool_call, …) do not
        // drive the runtime state machine.
        return
    }
  }

  /** Shared ingestion: dedup → state sync → buffer → emit. Both the producer
   *  path (`sequencer.append`) and the replica path (`appendEnvelope`) funnel
   *  through here so they share one dedup set and one state machine. */
  function ingest(envelope: TimelineEnvelope): void {
    if (config.dedup && envelope.seq > 0) {
      // Epoch rotation (C6): a real server envelope (seq > 0) arriving under an
      // epoch that differs from the one we're pinned to means the server-owned
      // seq space restarted (e.g. Flitro rotates `flitro-<sid>` →
      // `flitro-<sid>-<bootID>` on boot). The new epoch's seqs restart from 1,
      // so keep them out of the stale epoch's dedup keyspace: adopt the new
      // epoch and clear `seenKeys` so the fresh seqs are accepted from scratch
      // instead of being silently dropped. Local meta-events (seq <= 0, see the
      // sequencer below) never reach this branch, so they cannot drive rotation.
      if (envelope.epoch && envelope.epoch !== currentEpoch) {
        currentEpoch = envelope.epoch
        seenKeys.clear()
        // SDK-R-2: a new replay batch starts fresh — drop any suspended-tool
        // tracking from a prior (superseded) replay so armReplay doesn't re-fire
        // stale suspensions that belong to the previous epoch's replay.
        replaySuspended.clear()
        // session contract: the new epoch means the server is replaying durable history
        // (restart / idle-eviction). Enter replay-suppression mode so the
        // replayed items fold for transcript only — a replayed turn_failed
        // must not wedge the live state machine. Cleared by armReplay().
        replayMode = true
        // The new epoch's replay is the authoritative full history; drop the
        // stale old-epoch SERVER envelopes (seq > 0) so local catchup
        // (fetchTimeline fallback) and any consumer rebuilding from `timeline`
        // don't carry duplicates keyed under the old epoch (T5 — the server
        // replays durable history from 0). Preserve local meta-events
        // (seq <= 0: capability report, tool-suspension warnings, send-failure
        // notices) — they are client-origin UI state, not part of the server's
        // replayed history, and re-minting would duplicate. (T5-7: previously
        // `timeline.length = 0` wiped the capability report on a fresh
        // session's first server event, because the scaffold's initial epoch
        // lacks the server's bootID so the first server event always rotates.)
        for (let i = timeline.length - 1; i >= 0; i--) {
          if (timeline[i].seq > 0) timeline.splice(i, 1)
        }
      }
      const key = `${envelope.epoch || envelope.sessionId || 'unknown'}:${envelope.seq}`
      if (seenKeys.has(key)) return
      seenKeys.add(key)
      // session contract: cap the dedup set (ring-buffer). Evict the OLDEST key (Set
      // iterates in insertion order) so a long single-epoch session can't leak
      // memory. Evicting a key only risks re-accepting a duplicate of an
      // envelope > cap entries old — duplicates arrive from overlapping
      // catchup near the recent cursor (well within the cap), and an
      // epoch-rotation replay clears the set entirely, so the cap is safe.
      if (seenKeys.size > historyCap) {
        const oldest = seenKeys.values().next().value
        if (oldest !== undefined) seenKeys.delete(oldest)
      }
    }
    syncStateFromTimelineItem(envelope.item)
    timeline.push(envelope)
    // session contract: cap the in-memory timeline buffer (ring-buffer). Drop the OLDEST
    // envelope so the most-recent ones (the reconnect cursor + the local
    // `fetchTimeline` gap-fill read off them) are always retained. The chat
    // hook maintains its own React timeline state (unbounded display history),
    // so this does not lose rendered messages; only the scaffold's internal
    // gap-fill buffer is bounded. On epoch rotation the old-epoch server
    // envelopes are already dropped above, so this cap bounds the within-epoch
    // growth.
    if (timeline.length > historyCap) {
      // splice(0, n) drops n from the front; n is the overflow (keep behavior
      // stable near the boundary by evicting only what exceeds the cap).
      timeline.splice(0, timeline.length - historyCap)
    }
    stream.emit(envelope)
  }

  function drainOnCompletion(): void {
    // `complete` advances a queued message to accepted + running (if any), then
    // we actually send it. Fire-and-forget — the host's send owns error surfacing.
    dispatch({ type: 'complete' })
    const next = pendingQueue.shift()
    if (next) void sendDrained(next)
  }

  /** A2: eager-mode queue drain. The caller has already dispatched `complete`
   *  (which promoted the queued message to accepted + running in the reducer);
   *  this sends the parked input and chains the next drain on resolve.
   *  Fire-and-forget relative to the original `sendMessage` promise — each
   *  send's promise semantics stay "resolves when its own turn completes".
   *  Stops draining on failure (state is `failed`; the user must retry). */
  function drainEagerQueue(): void {
    const next = pendingQueue.shift()
    if (!next) return
    void (async () => {
      try {
        const driver = await ensureDriver()
        if (!driver) return
        await driver.sendMessage(next, sequencer)
        dispatch({ type: 'complete' })
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        const alreadyFailed = state.status === 'failed'
        dispatch({ type: 'error', error })
        if (!alreadyFailed) appendFailure(error)
        pendingQueue.length = 0
        return
      }
      drainEagerQueue()
    })()
  }

  const sequencer: TimelineSequencer = {
    append(item: TimelineItem, rawRef?: TimelineRawRef) {
      // C5: in replica/deferred mode (Flitro), the SERVER owns the positive seq
      // space under `currentEpoch`. Everything minted locally here — capability
      // report, tool-suspension status warnings, send-failure notices — is a
      // client-origin meta-event, NOT a server timeline entry. If such an event
      // took a positive seq in the server's epoch it would enter the
      // `epoch:seq` dedup keyspace and either (a) poison the set so the server's
      // real envelope at that seq is dropped, or (b) collide with an
      // already-seen server key and vanish. So local events are minted at the
      // reserved seq 0, which `ingest`'s dedup guard (`dedup && seq > 0`) skips
      // entirely; they still render in arrival order (pushed to the buffer) but
      // never touch the server keyspace. Eager (local-producer) runtimes own the
      // whole seq space, so they keep minting a monotonic positive seq.
      const localSeq = isDeferred ? 0 : ++seq
      const envelope: TimelineEnvelope = {
        sessionId: currentSessionId,
        provider: config.provider,
        seq: localSeq,
        epoch: currentEpoch,
        timestamp: now(),
        item,
        rawRef: rawRef ? { ...rawRef } : undefined,
      }
      ingest(envelope)
      return envelope
    },
  }

  function appendFailure(message: string): void {
    sequencer.append({
      type: 'turn_failed',
      turnId: 'provider-runtime',
      error: { message },
    })
  }

  function appendEnvelope(envelope: TimelineEnvelope): void {
    ingest(envelope)
  }

  async function ensureDriver(): Promise<ProviderRuntimeDriver | undefined> {
    if (driverRef) return driverRef
    driverRef = await config.getDriver() ?? undefined
    return driverRef
  }

  async function ensureResolvedSession(): Promise<void> {
    if (sessionResolved) return
    sessionResolved = true
    const resolved = await config.resolveSessionId?.()
    if (typeof resolved === 'string') {
      currentSessionId = resolved
    } else if (resolved) {
      currentSessionId = resolved.sessionId
      if (resolved.epoch) currentEpoch = resolved.epoch
    }
  }

  async function sendDrained(input: ProviderRuntimeDriverInput): Promise<void> {
    try {
      if (config.onMessageDrained) {
        await config.onMessageDrained(input, sequencer)
      } else {
        const driver = await ensureDriver()
        await driver?.sendMessage(input, sequencer)
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      // If the send failed before the server reported a structured turn_failed,
      // surface a generic failure. Don't clobber an already-failed state set by
      // a structured turn_failed item.
      const alreadyFailed = state.status === 'failed'
      dispatch({ type: 'error', error })
      if (!alreadyFailed) appendFailure(error)
    }
  }

  // SDK-R-2 / SDK-R-3: the internal arm-replay path. Clears replay-suppression
  // mode and resumes live dispatching. Called by the public `armReplay()` (the
  // chat hook's debounced quiet-window timer, or an explicit test call) AND as
  // a fallback by `commands.sendMessage` (SDK-R-3: a user send is
  // definitionally live, so headless consumers that never call armReplay still
  // exit suppression on the next send).
  //
  // SDK-R-2: on arming, re-fire `onToolSuspended` for suspensions seen during
  // the replay that were never resolved by a matching tool_resumed/tool_result
  // later in the SAME replay. A page reload while a run sat in Flitro's
  // Suspended state replays the tool_suspended item; without this re-fire the
  // run wedges until Flitro's 2h suspended_timeout sweeper. Idempotent on the
  // Flitro side: submitToolOutputs for an already-resumed call is rejected
  // harmlessly. Also drain queued messages if the reconciled status is `ready`
  // and the queue is non-empty — a live turn_completed that arrived during the
  // suppression window reconciled to `ready` but skipped drainOnCompletion,
  // stranding queued sends until the next live completion (which may never come
  // if the turn is already done).
  function armReplayInternal(): void {
    if (pendingArmReplayTimer !== undefined) {
      clearTimeout(pendingArmReplayTimer)
      pendingArmReplayTimer = undefined
    }
    if (!replayMode) return
    replayMode = false
    for (const item of replaySuspended.values()) {
      config.onToolSuspended?.(item)
    }
    replaySuspended.clear()
    if (isDeferred && state.status === 'ready' && pendingQueue.length > 0) {
      drainOnCompletion()
    }
  }

  return {
    get sessionId() { return currentSessionId },
    provider: config.provider,
    runtimeKind: config.report.selected ?? 'app-server',
    events: stream,
    sequencer,
    timeline,
    stream,
    dispatch,
    appendFailure,
    appendEnvelope,
    armReplay: () => {
      armReplayInternal()
    },

    commands: {
      async sendMessage(message: string, sendOptions?: SendMessageOptions) {
        if (disposed) throw new Error(`${config.provider} runtime is disposed`)
        // SDK-R-3: a user send is definitionally live — exit replay-suppression
        // mode so subsequent live dispatching (turn_completed+complete+drain,
        // error, onToolSuspended) resumes. The chat hook arms via a debounced
        // quiet-window timer, but headless consumers (direct
        // createFlitroProviderRuntime usage without the React hook) never call
        // armReplay and would stay suppressed for the process lifetime. Arming
        // on send closes that gap; no-op when not in replay mode.
        armReplayInternal()
        const input: ProviderRuntimeDriverInput = {
          message,
          options: sendOptions,
          origin: sendOptions?.commandOrigin ?? extensions.commandOrigin,
        }

        if (isDeferred) {
          await ensureResolvedSession()
          await ensureDriver()
          // session contract: the reducer guards `send_message` from `failed` (no
          // resurrection). A user retrying after a turn_failed must reset to
          // `ready` first — dispatch `abort` (clears lastError + queue) so the
          // subsequent `send_message` legitimately transitions → `running`.
          // `disposed` is rejected above; `replay_reconcile` is a separate
          // action and is untouched.
          if (state.status === 'failed') {
            dispatch({ type: 'abort' })
            pendingQueue.length = 0
          }
          const shouldQueue = state.status !== 'ready' && state.status !== 'idle' && state.status !== 'preflighting'
          dispatch({ type: 'send_message', message })
          if (shouldQueue) {
            pendingQueue.push(input)
            return
          }
          await sendDrained(input)
          return
        }

        // Eager mode: the driver drives the whole turn synchronously.
        const driver = await ensureDriver()
        if (!driver) {
          const error = `${config.provider} provider driver is not attached`
          dispatch({ type: 'error', error })
          appendFailure(error)
          throw new Error(error)
        }

        // session contract: explicit reset before send from `failed` (see deferred-mode
        // note above) — the reducer no longer resurrects `failed` via
        // `send_message`, so dispatch `abort` (→ `ready`, clears lastError)
        // first to preserve the retry-after-error UX.
        if (state.status === 'failed') {
          dispatch({ type: 'abort' })
          pendingQueue.length = 0
        }
        // A2 fix: a send while a turn is in flight must QUEUE, not race. The
        // reducer already files it into `queuedMessages`; previously the code
        // still called `driver.sendMessage` immediately, running two
        // concurrent query loops on one driver (activeQuery/activeSequencer
        // overwrite, abort targeting the wrong turn, interleaved timeline)
        // while the queued copy was later double-drained by `complete`. Now
        // the input parks in `pendingQueue` and `drainEagerQueue` sends it
        // after the current turn resolves — matching deferred-mode semantics.
        const shouldQueue = state.status !== 'ready' && state.status !== 'idle' && state.status !== 'preflighting'
        dispatch({ type: 'send_message', message })
        if (shouldQueue) {
          pendingQueue.push(input)
          return
        }
        try {
          await driver.sendMessage(input, sequencer)
          dispatch({ type: 'complete' })
          drainEagerQueue()
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err)
          // If the driver already reported a structured turn_failed, state is
          // already `failed` and a `turn_failed` item already exists — don't
          // append a duplicate generic one. Capture pre-dispatch state so a
          // driver that throws without reporting still gets a turn_failed item.
          const alreadyFailed = state.status === 'failed'
          dispatch({ type: 'error', error })
          if (!alreadyFailed) appendFailure(error)
          throw err
        }
      },

      async abort(reason?: string) {
        dispatch({ type: 'abort', reason })
        // Both modes use pendingQueue now (A2): clear it so an abort cancels
        // queued sends in eager mode too.
        pendingQueue.length = 0
        await (await ensureDriver())?.abort?.(reason)
      },

      async respondToPermission(
        requestId: string,
        allowed: boolean,
        remember?: boolean,
        detail?: PermissionResponseDetail,
      ) {
        await (await ensureDriver())?.respondToPermission?.(requestId, allowed, remember, detail)
        // A6: only transition waiting_for_permission → running when this
        // response matches the outstanding request. Drivers append a
        // `permission_resolved` item on a real resolution (which also syncs
        // state), so an unmatched requestId (driver no-op) must not force the
        // state machine out of waiting.
        if (
          state.status === 'waiting_for_permission'
          && (state.waitingPermissionRequestId === undefined
            || state.waitingPermissionRequestId === requestId)
        ) {
          dispatch({ type: 'permission_response' })
        }
      },

      async resumeTool(runId: string, resumeData: Record<string, unknown>) {
        await (await ensureDriver())?.resumeTool?.(runId, resumeData)
      },

      async dispose() {
        if (disposed) return
        disposed = true
        if (pendingArmReplayTimer !== undefined) {
          clearTimeout(pendingArmReplayTimer)
          pendingArmReplayTimer = undefined
        }
        dispatch({ type: 'dispose' })
        pendingQueue.length = 0
        stream.disconnect()
        await driverRef?.dispose?.()
        await config.onDispose?.()
      },
    },

    async preflight() {
      dispatch({ type: 'preflight_ok' })
      if (!config.report.selected) {
        dispatch({ type: 'preflight_error', error: config.report.error ?? 'No runtime selected' })
      }
      // The capability report is a local meta-event. `sequencer.append` now
      // mints it at the reserved seq 0 in replica/deferred mode (see C5 note on
      // the sequencer), so it never collides with the server's positive seq
      // space; eager runtimes get a normal monotonic seq. One path, both modes.
      sequencer.append({ type: 'runtime_capability_report', report: config.report })
      return config.report
    },

    async fetchTimeline(request: TimelineFetchRequest): Promise<TimelineFetchResult> {
      if (!request.cursor && timeline.length === 0) {
        // No local items and no cursor: try the remote (replica) source, or
        // return empty. Keeps the "nothing yet" fast path for eager runtimes.
        if (config.remoteTimelineFetch) {
          const remote = await config.remoteTimelineFetch(request).catch(() => undefined)
          if (remote) return remote
        }
        return {
          items: [],
          nextCursor: createTimelineCursor({ epoch: currentEpoch, afterSeq: 0 }),
          hasGap: false,
        }
      }
      const local = fetchTimeline(timeline, request)
      if (local.items.length > 0 || !config.remoteTimelineFetch) return local
      // Local buffer had no items for this cursor — fall back to the server.
      const remote = await config.remoteTimelineFetch(request).catch(() => undefined)
      return remote ?? local
    },

    getState() {
      return state
    },
  }
}

function turnFailedErrorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string' && message) return message
  }
  return 'turn failed'
}
