import { z } from 'zod'

export type TimelineProvider = string

export type TimelinePermissionScope =
  | { type: 'session'; sessionId: string }
  | { type: 'workspace'; workspaceId: string }
  | { type: 'source'; sourceSlug: string }
  | { type: 'skill'; skillSlug: string }
  | { type: 'automation'; automationId: string }
  | { type: 'tool-call'; callId: string }

export type TimelineCommandOrigin =
  | { type: 'user'; id?: string }
  | { type: 'automation'; id: string }
  | { type: 'scheduler'; id?: string }
  | { type: 'host'; id?: string }
  | { type: 'replay'; id?: string }
  | { type: 'system'; id?: string }

export interface ToolIntent {
  kind: string
  command?: string
  baseCommand?: string
  path?: string
  toolName?: string
  name?: string
  method?: string
  url?: string
}

export interface TimelinePermissionRequest {
  requestId: string
  toolName: string
  scope?: TimelinePermissionScope
  input?: Record<string, unknown>
  reason?: string
  intent?: ToolIntent
  /** Human-readable prompt sentence for the SDK `title`. */
  title?: string
  /** Short noun phrase (SDK `display_name`). */
  displayName?: string
  /** Subtitle / detail (SDK `description`). */
  description?: string
  /** Reason from a PreToolUse hook's `permissionDecision: 'ask'`. */
  decisionReason?: string
  /** Sub-agent identifier when the request originates inside a Task-spawned
   * sub-agent (SDK `agent_id`). Absent on the main thread. */
  agentId?: string
  /** File path that triggered the request when a tool tried to access a path
   * outside allowed directories (SDK `blocked_path`). */
  blockedPath?: string
  /** Permission-rule updates the SDK suggests the host could persist on allow
   * (SDK `suggestions`). Opaque rule blobs — pass through verbatim. */
  suggestions?: unknown[]
}

export interface TimelinePermissionResolution {
  allowed: boolean
  remember?: boolean
  reason?: string
}

export type TimelineToolStatus = 'pending' | 'running' | 'completed' | 'failed'

export type TimelineItem =
  | { type: 'user_message'; text: string; messageId: string; turnId?: string }
  | { type: 'assistant_message_delta'; text: string; messageId: string; turnId: string }
  | { type: 'assistant_message'; text: string; messageId: string; turnId: string }
  | { type: 'reasoning_delta'; text: string; messageId: string; turnId: string }
  | { type: 'reasoning'; text: string; messageId: string; turnId: string }
  | { type: 'tool_call'; callId: string; name: string; status: TimelineToolStatus; detail?: unknown; turnId?: string }
  | { type: 'tool_output_delta'; callId: string; text: string; stream?: 'stdout' | 'stderr' | string; turnId?: string }
  | { type: 'tool_result'; callId: string; result: unknown; isError?: boolean; turnId?: string }
  | { type: 'permission_requested'; request: TimelinePermissionRequest }
  | { type: 'permission_resolved'; requestId: string; resolution: TimelinePermissionResolution; detail?: unknown }
  | { type: 'permission_policy_changed'; policy: unknown }
  | { type: 'source_state_changed'; source: unknown }
  | { type: 'skill_activated'; skill: unknown }
  | { type: 'host_state_changed'; state: unknown }
  | { type: 'automation_triggered'; automation: { automationId: string; origin: TimelineCommandOrigin; detail?: unknown } }
  | { type: 'automation_action_result'; result: unknown }
  | { type: 'runtime_capability_report'; report: unknown }
  | { type: 'runtime_fallback'; reason: string; from?: string; to: string }
  | { type: 'turn_started'; turnId: string }
  | {
      type: 'turn_completed'
      turnId: string
      usage?: unknown
      structuredOutput?: unknown
      /** Total cost of the turn in USD (SDK `ResultMessage.total_cost_usd`). */
      costUsd?: number
      /** Wall-clock duration of the turn in ms (SDK `duration_ms`). */
      durationMs?: number
      /** API-side wall-clock duration in ms (SDK `duration_api_ms`). */
      durationApiMs?: number
      /** Number of conversation turns in the query (SDK `num_turns`). */
      numTurns?: number
      /** Final text result of the turn, when the SDK returns one (SDK `result`). */
      result?: string
      /** Provider session id the turn belongs to (SDK `session_id`). */
      sessionId?: string
      /** Tool use deferred by a PreToolUse hook returning `defer`; the caller
       * inspects this to decide whether to resume (SDK `deferred_tool_use`). */
      deferredToolUse?: unknown
      /** Per-model usage breakdown (SDK `modelUsage`). */
      modelUsage?: unknown
      /** Permission denials accumulated during the turn (SDK `permission_denials`). */
      permissionDenials?: unknown
      /** HTTP status of a failing API call when `subtype === 'success'` but the
       * turn errored (e.g. 429/500/529); SDK `api_error_status`. */
      apiErrorStatus?: number
      /** Time to first token in ms (SDK `ttft_ms`). */
      ttftMs?: number
      /** Why the query loop terminated (SDK `terminal_reason`). */
      terminalReason?: string
      /** Fast-mode state at turn end (SDK `fast_mode_state`). */
      fastModeState?: string
      /** Provenance of the result message (SDK `origin`). */
      origin?: unknown
    }
  /** `error` stays `unknown` on the wire: producers emit provider-specific
   * shapes (native SDK result payloads, codex app-server errors, the runtime
   * scaffold's `{message, code?, status?}`). Consume it through
   * {@link readTurnFailedError} instead of casting. */
  | { type: 'turn_failed'; turnId: string; error: unknown }
  | { type: 'turn_interrupted'; turnId: string }
  | { type: 'session_status'; status: string }
  | { type: 'tool_suspended'; callId: string; name: string; stepId?: string; suspendData?: unknown; turnId?: string }
  | { type: 'tool_resumed'; callId: string; name: string; stepId?: string; turnId?: string }
  | { type: 'compaction_started' }
  | { type: 'compaction_boundary'; summary?: string }
  | {
      type: 'task_event'
      taskId: string
      /** Which task-lifecycle message produced this item. */
      phase: 'started' | 'progress' | 'updated' | 'notification'
      /** Terminal/non-terminal status (`completed`/`failed`/`stopped`/`killed`/
       * `pending`/`running`/`paused`), when the SDK reports one. */
      status?: string
      description?: string
      usage?: unknown
      /** Raw lifecycle patch / payload (e.g. `task_updated.patch`), opaque. */
      detail?: unknown
      turnId?: string
    }
  | { type: 'rate_limit'; info: unknown; turnId?: string }

export interface TimelineRawRef {
  providerEventType?: string
  logPath?: string
  offset?: number
}

export interface TimelineEnvelope {
  sessionId: string
  provider: TimelineProvider
  seq: number
  epoch: string
  timestamp: number
  /** Wire-protocol version (X-B). Producers stamp `v` on every frame; consumers
   * read it to detect producer/consumer skew instead of silently mis-decoding.
   * Optional so pre-X-B producers (no `v` field) still decode. */
  v?: number
  item: TimelineItem
  rawRef?: TimelineRawRef
}

/**
 * TIMELINE_PROTOCOL_VERSION (X-B) is the highest wire-protocol version this SDK
 * knows how to decode. Mirrors flitro's `timeline.ProtocolVersion`. A producer
 * stamping a higher `v` is forward-skew — {@link parseTimelineEnvelope} logs it
 * once and still decodes leniently (the SDK never throws on a newer frame; it
 * just makes the skew observable). Bump when a new envelope field needs explicit
 * SDK handling; additive fields the SDK can ignore keep the version.
 */
export const TIMELINE_PROTOCOL_VERSION = 1

/**
 * TimelineEnvelopeSchema (X-B / session contract) is a LENIENT zod schema for the wire
 * envelope. It replaces the prior unvalidated `JSON.parse(...) as
 * TimelineEnvelope` cast at the SSE/fetch decode sites — a malformed or
 * shape-skewed frame is now caught (and skipped) instead of silently
 * mis-decoding into an object with `undefined` fields.
 *
 * Leniency choices:
 *  - `.passthrough()` — unknown fields are kept, not stripped/rejected. A
 *    producer adding a field does not break older SDKs.
 *  - `item: z.unknown()` — the item is a large discriminated union; validating
 *    every variant here would be brittle and duplicate the reducer. The item is
 *    validated at the reducer/event-mapper; here it is forwarded opaquely (the
 *    SDK already handles unknown item variants gracefully).
 *  - `v` is optional — pre-X-B producers (no `v` field) still decode.
 *  - `provider` is `z.string()` (not a literal union) — future providers decode.
 */
export const TimelineEnvelopeSchema = z
  .object({
    sessionId: z.string(),
    provider: z.string(),
    seq: z.number(),
    epoch: z.string(),
    timestamp: z.number(),
    v: z.number().optional(),
    item: z.unknown(),
    rawRef: z
      .object({
        providerEventType: z.string().optional(),
        logPath: z.string().optional(),
        offset: z.number().optional(),
      })
      .optional(),
  })
  .passthrough()

/**
 * parseTimelineEnvelope (X-B / session contract) validates + leniently decodes a raw JSON
 * value as a {@link TimelineEnvelope}. Throws (zod) on a structurally malformed
 * frame — callers wrap in try/catch and skip the frame, same as malformed JSON.
 * Reads `v` and warns ONCE per process on forward skew (producer newer than the
 * SDK knows), so producer/consumer skew is observable instead of silent.
 */
export function parseTimelineEnvelope(raw: unknown): TimelineEnvelope {
  const parsed = TimelineEnvelopeSchema.parse(raw)
  if (
    typeof parsed.v === 'number' &&
    parsed.v > TIMELINE_PROTOCOL_VERSION &&
    !timelineSkewWarned
  ) {
    timelineSkewWarned = true
    // eslint-disable-next-line no-console
    console.warn(
      `[weft] timeline producer protocol version ${parsed.v} exceeds SDK known max ${TIMELINE_PROTOCOL_VERSION}; decoding leniently. Update @weft/timeline when the producer contract changes.`,
    )
  }
  // SDK-R-6: spread `parsed` so passthrough extras (unknown envelope-level
  // fields the lenient .passthrough() schema kept) survive on the returned
  // object, instead of being validated-then-dropped by re-projecting only the
  // known fields. The explicit overwrites below are type-narrowing casts on the
  // SAME values (provider/item/rawRef), not filtering — spreading first
  // preserves everything zod kept, matching the X-B "unknown fields are kept"
  // comment on the schema.
  return {
    ...parsed,
    provider: parsed.provider as TimelineProvider,
    item: parsed.item as TimelineItem,
    rawRef: parsed.rawRef as TimelineRawRef | undefined,
  }
}

// timelineSkewWarned dedups the forward-skew warning to one log per process so a
// long-lived stream of newer frames does not spam the console.
let timelineSkewWarned = false

export interface TimelineCursor {
  epoch: string
  afterSeq: number
}

export interface TimelineFetchRequest {
  cursor?: TimelineCursor
  limit?: number
}

export interface TimelineFetchResult {
  items: TimelineEnvelope[]
  nextCursor: TimelineCursor
  hasGap: boolean
}

export interface CreateTimelineSequencerOptions {
  sessionId: string
  provider: TimelineProvider
  epoch: string
  startSeq?: number
  now?: () => number
}

export interface TimelineSequencer {
  append(item: TimelineItem, rawRef?: TimelineRawRef): TimelineEnvelope
}

export function createTimelineSequencer(options: CreateTimelineSequencerOptions): TimelineSequencer {
  let seq = options.startSeq ?? 0
  const now = options.now ?? Date.now

  return {
    append(item, rawRef) {
      seq += 1
      return appendTimelineItem({
        sessionId: options.sessionId,
        provider: options.provider,
        epoch: options.epoch,
        seq,
        timestamp: now(),
        item,
        rawRef,
      })
    },
  }
}

export function appendTimelineItem(envelope: TimelineEnvelope): TimelineEnvelope {
  return {
    ...envelope,
    rawRef: envelope.rawRef ? { ...envelope.rawRef } : undefined,
  }
}

export function createTimelineCursor(cursor: TimelineCursor): TimelineCursor {
  return {
    epoch: cursor.epoch,
    afterSeq: cursor.afterSeq,
  }
}

export function fetchTimeline(
  timeline: TimelineEnvelope[],
  request: TimelineFetchRequest = {},
): TimelineFetchResult {
  const ordered = sortTimeline(timeline)
  const cursor = request.cursor ?? cursorFromTimelineStart(ordered)
  const items = ordered
    .filter(item => item.epoch === cursor.epoch && item.seq > cursor.afterSeq)
    .slice(0, request.limit)
  const lastSeq = items.at(-1)?.seq ?? cursor.afterSeq

  // session contract: hasGap detects BOTH a leading gap (first returned seq > afterSeq+1)
  // AND any interior gap (a seq != expected where expected walks afterSeq+1,
  // prev+1, …). Matches the server's canonical contiguity contract so the SDK
  // + server agree on what a gap is. The previous leading-edge-only check
  // missed interior gaps, so a
  // catchup batch with a hole in the middle reported hasGap=false and the SDK
  // never backfilled the missing seqs.
  let hasGap = false
  if (items.length > 0) {
    let expected = cursor.afterSeq + 1
    for (const item of items) {
      if (item.seq !== expected) {
        hasGap = true
        break
      }
      expected = item.seq + 1
    }
  }

  return {
    items,
    nextCursor: {
      epoch: cursor.epoch,
      afterSeq: lastSeq,
    },
    hasGap,
  }
}

export function mergeTimeline(
  existing: TimelineEnvelope[],
  incoming: TimelineEnvelope[],
): TimelineEnvelope[] {
  const byKey = new Map<string, TimelineEnvelope>()
  for (const item of [...existing, ...incoming]) {
    byKey.set(timelineKey(item), item)
  }
  return sortTimeline([...byKey.values()])
}

/**
 * mergeTimelineIncremental (P2 07-02 residual) is a STRICT-SUPERSET fast path
 * of {@link mergeTimeline} for the rAF flush fold path, where `existing` is
 * GUARANTEED already sorted + deduped (it is a previous merge/rebuild output —
 * see `foldBatchIntoTimeline`, which is the sole caller and maintains that
 * invariant). It produces a result bit-for-bit equal to
 * `mergeTimeline(existing, incoming)` for every input, but avoids the O(n)
 * Map rebuild + full re-sort on the common streaming path.
 *
 * The common case during token streaming is: `incoming` is a frame's worth of
 * new envelopes, all in the SAME epoch as `existing`'s last item, with seqs
 * strictly greater than `existing`'s last seq (monotonically increasing server
 * seqs). In that case the result is a non-overlapping append — no dedup needed
 * against `existing`, no re-sort of `existing` — so the work is O(m) (plus the
 * unavoidable O(n+m) array copy) instead of O((n+m) log(n+m)) + a size-(n+m)
 * Map allocation every rAF flush. "Long-session jank" is precisely this cost
 * recurring each frame as n grows.
 *
 * Any case the fast path cannot prove safe — overlap with `existing` (a
 * re-delivered seq ≤ last seq), a new epoch, mixed-epoch incoming, or an empty
 * `existing` — falls back to the general {@link mergeTimeline}, which is
 * correct for arbitrary input. The fast path is therefore an optimization
 * under a documented invariant, NOT a behavior change: the
 * {@link mergeTimelineIncremental equivalence test} in primitives.test.ts
 * asserts deep-equality with `mergeTimeline` across append, overlap, new-epoch,
 * internal-duplicate, and empty cases.
 *
 * `incoming.length === 0` short-circuits to `existing` unchanged (O(1)) — a
 * flush whose batch had only rotations (which reset `next` directly) or only
 * non-merge events reaches the merge with an empty `incoming` and must not
 * pay for a re-sort. This matches the general merge's empty-input result
 * (`sortTimeline(existing)` === `existing` because `existing` is pre-sorted)
 * without the O(n log n) re-sort.
 *
 * @param existing - MUST be already sorted + deduped (caller invariant).
 * @param incoming - Arbitrary; the fast path activates only when provably safe.
 */
export function mergeTimelineIncremental(
  existing: TimelineEnvelope[],
  incoming: TimelineEnvelope[],
): TimelineEnvelope[] {
  if (incoming.length === 0) return existing
  if (existing.length === 0) return mergeTimeline(existing, incoming)

  const last = existing[existing.length - 1]
  // Fast path: every incoming envelope shares the last epoch AND has a seq
  // strictly greater than existing's last seq. existing is sorted+deduped, so
  // its last item is the max (epoch, seq); same-epoch + strictly-greater seqs
  // therefore CANNOT collide with any existing key → no dedup vs existing.
  let canAppend = true
  for (const env of incoming) {
    if (env.epoch !== last.epoch || env.seq <= last.seq) {
      canAppend = false
      break
    }
  }
  if (!canAppend) return mergeTimeline(existing, incoming)

  // Dedup WITHIN incoming (last-write-wins by epoch:seq), then sort by seq
  // (single-epoch → seq is the full sort key). Result = existing ++ sorted tail.
  const byKey = new Map<string, TimelineEnvelope>()
  for (const env of incoming) byKey.set(timelineKey(env), env)
  const sortedIncoming = [...byKey.values()].sort((a, b) => a.seq - b.seq)
  return [...existing, ...sortedIncoming]
}

function cursorFromTimelineStart(timeline: TimelineEnvelope[]): TimelineCursor {
  return {
    epoch: timeline[0]?.epoch ?? 'default',
    afterSeq: 0,
  }
}

/**
 * sortTimeline (session contract) orders envelopes for display/fold. Epoch strings are
 * OPAQUE + NON-CAUSAL (random bootID — `flitro-<sid>-<bootID>-g<gen>`), so
 * `epoch.localeCompare` is not a valid cross-epoch ordering: two epochs could
 * sort either way regardless of which actually came first, misordering the
 * timeline at a rotation boundary.
 *
 * The consumer holds ONE epoch post-reset (the scaffold's `ingest` + the chat
 * hook's `foldBatchIntoTimeline` both splice out old-epoch server envelopes on
 * rotation), so within the array the causal order is just `seq`. For the
 * transient multi-epoch case (a rotation in flight), preserve FIRST-SEEN epoch
 * insertion order — do NOT claim a causal cross-epoch order the consumer can't
 * establish — then sort by `seq` within each epoch. The insertion-order map is
 * built from the input array, so this is a pure function.
 */
export function sortTimeline(timeline: TimelineEnvelope[]): TimelineEnvelope[] {
  const epochOrder = new Map<string, number>()
  for (const item of timeline) {
    if (!epochOrder.has(item.epoch)) epochOrder.set(item.epoch, epochOrder.size)
  }
  return [...timeline].sort((left, right) => {
    const lo = epochOrder.get(left.epoch) ?? 0
    const ro = epochOrder.get(right.epoch) ?? 0
    if (lo !== ro) return lo - ro
    return left.seq - right.seq
  })
}

function timelineKey(item: TimelineEnvelope): string {
  return `${item.epoch}:${item.seq}`
}

/**
 * Structured fields a `turn_failed` item's `error` may carry. The SDK's
 * runtime scaffold emits `{message, code?, status?}` for synthetic failures
 * (e.g. a rejected send): `code` is the thrower's stable machine-readable
 * category when it provided one — weftd codes like `llm_connection_unusable`
 * via `WeftHttpError` — and `status` the HTTP status. Other producers emit
 * different shapes, so `error` stays `unknown` on the wire and
 * {@link readTurnFailedError} is the supported way to consume it.
 */
export interface TurnFailedErrorInfo {
  message: string
  code?: string
  status?: number
}

/**
 * Safely read a `turn_failed` item's `error` into {@link TurnFailedErrorInfo}.
 * Duck-types the scaffold's `{message, code?, status?}` shape; for any other
 * producer shape it still yields a usable `message` (falling back to
 * `'turn failed'`) with `code`/`status` set only when present and well-typed.
 */
export function readTurnFailedError(error: unknown): TurnFailedErrorInfo {
  if (typeof error === 'string' && error) return { message: error }
  if (!error || typeof error !== 'object') return { message: 'turn failed' }
  const { message, code, status } = error as { message?: unknown; code?: unknown; status?: unknown }
  return {
    message: typeof message === 'string' && message ? message : 'turn failed',
    ...(typeof code === 'string' && code ? { code } : {}),
    ...(typeof status === 'number' ? { status } : {}),
  }
}
