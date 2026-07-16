import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { RuntimeCapabilityReport } from '@weft/runtime-core'
import {
  createTimelineCursor,
  type TimelineEnvelope,
  type TimelineItem,
} from '@weft/timeline'
import { createProviderRuntimeScaffold, type ProviderRuntimeScaffold } from '../runtime-scaffold.ts'

// X-C shared cross-repo contract test (the 07-02 acceptance gate).
//
// The 07-02 lesson: this cluster fails when patched per-hop. This test drives
// the full replay-reliability flow against the scaffold with a MOCK flitro that
// controls epoch + buffered history + captures fetch requests, so the coupled
// pair (transport contract fetch-sends-epoch + session contract replay-state-suppression) is verified
// together. It FAILS if any piece is patched without the other:
// - transport contract without session contract: the fetch returns full replayed history on epoch
//    mismatch → that history drives syncStateFromTimelineItem → wedged state.
// - session contract without the epoch send: the catchup fetch never sends epoch → flitro returns
//    empty on a stale cursor → the gap is never backfilled.
//
// The Go sides (flitro FN-8 pagination, fetch-handler T5 epoch reset + hasGap,
// weftd epoch round-trip) have their own per-hop tests; this test owns the
// CONSUMER behavior (the SDK), per the design doc.

const report = { selected: 'app-server' } as unknown as RuntimeCapabilityReport

// Mock flitro state: the server's current epoch + its buffered durable history
// + a capture of fetch requests (so transport contract's "the fetch carries epoch" is
// verifiable). flitro's fetch handler resets afterSeq=0 when reqEpoch !=
// SessionEpoch (handlers_session_extras.go:217) — the mock mirrors that.
let mockEpoch: string
let mockBuffered: TimelineEnvelope[]
let fetchRequests: Array<{ afterSeq: number; epoch?: string }>

function envelope(epoch: string, seq: number, item: TimelineItem): TimelineEnvelope {
  return { sessionId: 's1', provider: 'flitro', seq, epoch, timestamp: seq, item }
}

function delta(epoch: string, seq: number): TimelineEnvelope {
  return envelope(epoch, seq, {
    type: 'assistant_message_delta',
    text: `d${seq}`,
    messageId: 'm1',
    turnId: 't1',
  })
}

function turnCompleted(epoch: string, seq: number): TimelineEnvelope {
  return envelope(epoch, seq, { type: 'turn_completed', turnId: 't1' })
}

function turnFailed(epoch: string, seq: number): TimelineEnvelope {
  return envelope(epoch, seq, { type: 'turn_failed', turnId: 't1', error: { message: 'fail' } })
}

function permissionRequested(epoch: string, seq: number, requestId: string): TimelineEnvelope {
  return envelope(epoch, seq, {
    type: 'permission_requested',
    request: { requestId, toolName: 'bash' },
  })
}

function permissionResolved(epoch: string, seq: number, requestId: string): TimelineEnvelope {
  return envelope(epoch, seq, {
    type: 'permission_resolved',
    requestId,
    resolution: { allowed: true },
  })
}

function toolSuspended(epoch: string, seq: number, callId: string): TimelineEnvelope {
  return envelope(epoch, seq, {
    type: 'tool_suspended',
    callId,
    name: 'client_http_request',
    suspendData: { method: 'GET', url: 'https://example/api/x' },
    turnId: 't1',
  })
}

function toolResumed(epoch: string, seq: number, callId: string): TimelineEnvelope {
  return envelope(epoch, seq, {
    type: 'tool_resumed',
    callId,
    name: 'client_http_request',
    turnId: 't1',
  })
}

function toolResult(epoch: string, seq: number, callId: string): TimelineEnvelope {
  return envelope(epoch, seq, {
    type: 'tool_result',
    callId,
    result: { ok: true },
    turnId: 't1',
  })
}

/**
 * Build a replay batch under `epoch` with a mid-history turn_failed (seq = mid)
 * superseded by a final turn_completed (seq = count). Pre-session contract, the mid
 * turn_failed wedges state at `failed` (the reducer's `error` is unconditional,
 * and a later `turn_completed` is a no-op from `failed`). Post-session contract, the
 * replay-mode `replay_reconcile` makes the terminal marker win → `ready`.
 */
function replayWithMidFail(epoch: string, count: number): TimelineEnvelope[] {
  const mid = Math.floor(count / 2)
  const items: TimelineEnvelope[] = []
  for (let i = 1; i <= count; i++) {
    if (i === mid) items.push(turnFailed(epoch, i))
    else if (i === count) items.push(turnCompleted(epoch, i))
    else items.push(delta(epoch, i))
  }
  return items
}

function replayWithMidPermission(epoch: string, count: number): TimelineEnvelope[] {
  const req = Math.floor(count / 3)
  const resolved = Math.floor((2 * count) / 3)
  const items: TimelineEnvelope[] = []
  for (let i = 1; i <= count; i++) {
    if (i === req) items.push(permissionRequested(epoch, i, 'r1'))
    else if (i === resolved) items.push(permissionResolved(epoch, i, 'r1'))
    else if (i === count) items.push(turnCompleted(epoch, i))
    else items.push(delta(epoch, i))
  }
  return items
}

function makeScaffold(
  initialEpoch: string,
  opts: { onToolSuspended?: (item: { callId: string; name: string }) => void } = {},
): ProviderRuntimeScaffold {
  return createProviderRuntimeScaffold({
    provider: 'flitro',
    sessionId: 's1',
    epoch: initialEpoch,
    report,
    completion: 'deferred',
    dedup: true,
    getDriver: () => undefined,
    onToolSuspended: opts.onToolSuspended as Parameters<typeof createProviderRuntimeScaffold>[0]['onToolSuspended'],
    remoteTimelineFetch: async request => {
      fetchRequests.push({
        afterSeq: request.cursor?.afterSeq ?? 0,
        epoch: request.cursor?.epoch,
      })
      // Mirror flitro's fetch handler (handlers_session_extras.go:217): a
      // cursor epoch that doesn't match this process's epoch → afterSeq = 0
      // (replay durable history from 0). With transport contract the SDK sends its last-seen
      // epoch; without the epoch send it sends none → reqEpoch is undefined → no reset →
      // returns items with seq > stale afterSeq (empty under the new epoch).
      const reqEpoch = request.cursor?.epoch
      const effectiveAfter =
        reqEpoch && reqEpoch !== mockEpoch ? 0 : request.cursor?.afterSeq ?? 0
      const items = mockBuffered.filter(e => e.seq > effectiveAfter)
      return {
        items,
        nextCursor: createTimelineCursor({
          epoch: mockEpoch,
          afterSeq: items.at(-1)?.seq ?? effectiveAfter,
        }),
        hasGap: false,
      }
    },
  })
}

beforeEach(() => {
  mockEpoch = 'E1'
  mockBuffered = []
  fetchRequests = []
})

describe('X-C contract — session contract replay state suppression (the wedge fix)', () => {
  it('a replayed mid-history turn_failed does NOT wedge — the terminal turn_completed wins (step 6)', () => {
    const scaffold = makeScaffold('E1')
    // Step 1: live E1 history ending turn_completed → ready.
    scaffold.dispatch({ type: 'send_message', message: 'hi' })
    scaffold.appendEnvelope(turnCompleted('E1', 1))
    expect(scaffold.getState().status).toBe('ready')

    // Steps 5-6: server restarts (E2); the SSE reconnect replays durable
    // history under E2. The replay includes a mid turn_failed superseded by a
    // final turn_completed. The first E2 envelope triggers the epoch rotation
    // (ingest drops E1, enters replay mode).
    const replay = replayWithMidFail('E2', 20)
    for (const env of replay) scaffold.appendEnvelope(env)

    // session contract: terminal marker wins → ready, NOT wedged at failed.
    expect(scaffold.getState().status).toBe('ready')
    // Rotation dropped the old-epoch E1 server envelope; timeline is E2-only.
    expect(scaffold.timeline.every(e => e.epoch === 'E2')).toBe(true)
    expect(scaffold.timeline).toHaveLength(20)
  })

  it('a replayed mid-history permission_requested later resolved does NOT leave state in waiting_for_permission (step 6)', () => {
    const scaffold = makeScaffold('E1')
    scaffold.dispatch({ type: 'send_message', message: 'hi' })
    scaffold.appendEnvelope(turnCompleted('E1', 1))

    const replay = replayWithMidPermission('E2', 21)
    for (const env of replay) scaffold.appendEnvelope(env)

    // The resolved permission reconciles to `running`; the final
    // turn_completed reconciles to `ready`. Not waiting_for_permission.
    expect(scaffold.getState().status).not.toBe('waiting_for_permission')
    expect(scaffold.getState().status).toBe('ready')
  })
})

describe('X-C contract — session contract live state machine NOT regressed (step 8)', () => {
  it('after armReplay, a LIVE turn_failed drives state to failed (replay suppression is replay-only)', () => {
    const scaffold = makeScaffold('E1')
    scaffold.dispatch({ type: 'send_message', message: 'hi' })
    scaffold.appendEnvelope(turnCompleted('E1', 1))

    // Replay under E2 (ends ready, terminal wins).
    for (const env of replayWithMidFail('E2', 20)) scaffold.appendEnvelope(env)
    expect(scaffold.getState().status).toBe('ready')

    // armReplay clears replay mode → live dispatching resumes.
    scaffold.armReplay()

    // Live E2 turn_failed (seq 21). This is NOT replay → dispatches the live
    // `error` action → failed (unconditional). session contract only suppresses REPLAY.
    scaffold.appendEnvelope(turnFailed('E2', 21))
    expect(scaffold.getState().status).toBe('failed')
  })
})

describe('X-C contract — transport contract fetch sends epoch (step 3)', () => {
  it('the catchup fetch carries the last-seen epoch; flitro resets afterSeq on mismatch', async () => {
    const scaffold = makeScaffold('E1')
    scaffold.dispatch({ type: 'send_message', message: 'hi' })
    scaffold.appendEnvelope(turnCompleted('E1', 1))
    // The client's last-seen cursor after the E1 live phase.
    // (lastCursorRef in the real hook tracks the last server seq.)

    // Server restarts: new epoch E2, buffer holds 10 E2 envelopes.
    mockEpoch = 'E2'
    mockBuffered = Array.from({ length: 10 }, (_, i) => delta('E2', i + 1))

    // Step 3: catchup fetch with the stale E1 cursor.
    const result = await scaffold.fetchTimeline({
      cursor: { epoch: 'E1', afterSeq: 1 },
    })

    // transport contract: the SDK's fetch request carried epoch=E1 (its last-seen epoch).
    expect(fetchRequests).toHaveLength(1)
    expect(fetchRequests[0].epoch).toBe('E1')
    expect(fetchRequests[0].afterSeq).toBe(1)

    // flitro saw reqEpoch(E1) != SessionEpoch(E2) → afterSeq=0 → replayed all
    // 10 E2 envelopes from seq 1 (the gap is backfilled, not empty).
    expect(result.items).toHaveLength(10)
    expect(result.items.every(e => e.epoch === 'E2')).toBe(true)
    expect(result.items[0].seq).toBe(1)
    // The response's nextCursor carries the server's current epoch (E2) so the
    // SDK can detect the rollover.
    expect(result.nextCursor.epoch).toBe('E2')
  })

  it('without the epoch send the fetch would be epoch-blind (the broken intermediate the 07-02 lesson warns about)', async () => {
    // This test documents the pre-fix failure: if the SDK did NOT send epoch,
    // reqEpoch is undefined → the mock (mirroring flitro) does NOT reset
    // afterSeq → returns items with seq > stale afterSeq (empty under E2).
    // It passes post-transport contract because the SDK now sends epoch.
    const scaffold = makeScaffold('E1')
    scaffold.appendEnvelope(turnCompleted('E1', 1))
    mockEpoch = 'E2'
    mockBuffered = Array.from({ length: 10 }, (_, i) => delta('E2', i + 1))

    const result = await scaffold.fetchTimeline({
      cursor: { epoch: 'E1', afterSeq: 1 },
    })
    // Post-fix: epoch is sent → reset → 10 items. (Pre-transport contract this would be 0.)
    expect(result.items).toHaveLength(10)
  })
})

describe('X-C contract — epoch rollover reset (step 5, T5)', () => {
  it('on the first new-epoch envelope, ingest rotates: drops old-epoch server envelopes, resets dedup', () => {
    const scaffold = makeScaffold('E1')
    scaffold.appendEnvelope(delta('E1', 1))
    scaffold.appendEnvelope(delta('E1', 2))
    expect(scaffold.timeline).toHaveLength(2)

    // E2 replay: rotation drops E1, accepts E2 from seq 1.
    scaffold.appendEnvelope(delta('E2', 1))
    scaffold.appendEnvelope(delta('E2', 2))
    scaffold.appendEnvelope(delta('E2', 3))

    // No E1 ghosts; E2 seqs 1-3 only.
    expect(scaffold.timeline.every(e => e.epoch === 'E2')).toBe(true)
    expect(scaffold.timeline.map(e => e.seq)).toEqual([1, 2, 3])
  })
})

describe('SDK-R-2 — replayed tool_suspended is re-fired on armReplay (the reload-during-suspension fix)', () => {
  it('re-fires onToolSuspended for an unresolved tool_suspended seen during replay', () => {
    const suspended = vi.fn()
    const scaffold = makeScaffold('E1', { onToolSuspended: suspended })
    scaffold.dispatch({ type: 'send_message', message: 'hi' })
    scaffold.appendEnvelope(turnCompleted('E1', 1))

    // Server restart (E2); the replay includes a tool_suspended with NO matching
    // tool_resumed/tool_result later in the replay. Pre-SDK-R-2, the replayed
    // tool_suspended is suppressed and never re-fired → the run wedges until
    // the server-side suspension timeout (~2h).
    const replay = [
      delta('E2', 1),
      toolSuspended('E2', 2, 'call-1'),
      delta('E2', 3),
      turnCompleted('E2', 4),
    ]
    for (const env of replay) scaffold.appendEnvelope(env)

    // During replay, onToolSuspended must NOT fire (suppressed).
    expect(suspended).not.toHaveBeenCalled()

    // armReplay re-fires the outstanding suspension.
    scaffold.armReplay()
    expect(suspended).toHaveBeenCalledOnce()
    expect(suspended).toHaveBeenCalledWith(expect.objectContaining({ callId: 'call-1' }))
  })

  it('does NOT re-fire a tool_suspended that was resolved by a later tool_resumed in the same replay', () => {
    const suspended = vi.fn()
    const scaffold = makeScaffold('E1', { onToolSuspended: suspended })
    scaffold.dispatch({ type: 'send_message', message: 'hi' })
    scaffold.appendEnvelope(turnCompleted('E1', 1))

    const replay = [
      delta('E2', 1),
      toolSuspended('E2', 2, 'call-2'),
      toolResumed('E2', 3, 'call-2'),
      turnCompleted('E2', 4),
    ]
    for (const env of replay) scaffold.appendEnvelope(env)

    scaffold.armReplay()
    // Resolved by tool_resumed → not outstanding → not re-fired.
    expect(suspended).not.toHaveBeenCalled()
  })

  it('does NOT re-fire a tool_suspended that was resolved by a later tool_result in the same replay', () => {
    const suspended = vi.fn()
    const scaffold = makeScaffold('E1', { onToolSuspended: suspended })
    scaffold.dispatch({ type: 'send_message', message: 'hi' })
    scaffold.appendEnvelope(turnCompleted('E1', 1))

    const replay = [
      delta('E2', 1),
      toolSuspended('E2', 2, 'call-3'),
      toolResult('E2', 3, 'call-3'),
      turnCompleted('E2', 4),
    ]
    for (const env of replay) scaffold.appendEnvelope(env)

    scaffold.armReplay()
    expect(suspended).not.toHaveBeenCalled()
  })

  it('drains queued messages on armReplay when the reconciled status is ready and the queue is non-empty', async () => {
    const onMessageDrained = vi.fn(async () => {})
    const scaffold = createProviderRuntimeScaffold({
      provider: 'flitro',
      sessionId: 's1',
      epoch: 'E1',
      report,
      completion: 'deferred',
      dedup: true,
      getDriver: () => undefined,
      onMessageDrained,
    })
    // 'first' send: deferred mode, idle → running; sendDrained fires
    // onMessageDrained('first') immediately.
    await scaffold.commands.sendMessage('first')
    expect(scaffold.getState().status).toBe('running')

    // 'second' send while running → queued in pendingQueue (the scaffold's
    // drain source of truth) and the reducer's queuedMessages.
    await scaffold.commands.sendMessage('second')
    expect(scaffold.getState().status).toBe('running')

    // E2 replay: rotation enters suppression; the final turn_completed
    // reconciles to `ready` but drainOnCompletion is suppressed → 'second'
    // strands in pendingQueue.
    scaffold.appendEnvelope(delta('E2', 1))
    scaffold.appendEnvelope(turnCompleted('E2', 2))
    expect(scaffold.getState().status).toBe('ready')

    scaffold.armReplay()
    // SDK-R-2: the stranded 'second' is drained (sent) on armReplay.
    expect(onMessageDrained).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'second' }),
      expect.anything(),
    )
  })
})

describe('SDK-R-3 — sendMessage arms replay for non-hook (headless) consumers', () => {
  it('a sendMessage while in replay mode arms replay (exits suppression)', async () => {
    const suspended = vi.fn()
    const onMessageDrained = vi.fn(async () => {})
    const scaffold = createProviderRuntimeScaffold({
      provider: 'flitro',
      sessionId: 's1',
      epoch: 'E1',
      report,
      completion: 'deferred',
      dedup: true,
      getDriver: () => ({ sendMessage: vi.fn(async () => {}) }),
      onMessageDrained,
      onToolSuspended: suspended as Parameters<typeof createProviderRuntimeScaffold>[0]['onToolSuspended'],
    })
    scaffold.dispatch({ type: 'send_message', message: 'hi' })
    scaffold.appendEnvelope(turnCompleted('E1', 1))

    // E2 replay with an unresolved tool_suspended → enters suppression.
    for (const env of [delta('E2', 1), toolSuspended('E2', 2, 'call-x'), turnCompleted('E2', 3)]) {
      scaffold.appendEnvelope(env)
    }
    expect(suspended).not.toHaveBeenCalled()

    // A user send is definitionally live — arming on send re-fires the
    // outstanding suspension and drains. Headless consumers that never call
    // armReplay() directly still exit suppression via sendMessage.
    await scaffold.commands.sendMessage('next')
    expect(suspended).toHaveBeenCalledWith(expect.objectContaining({ callId: 'call-x' }))
  })
})
