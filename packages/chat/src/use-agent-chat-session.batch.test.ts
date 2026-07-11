import { describe, expect, test, vi } from 'vitest'
import type { TimelineEnvelope, TimelineItem } from '@weft/timeline'
import type { SessionState } from '@weft/ui'
import {
  catchupBatch,
  foldBatchIntoSessionState,
  foldBatchIntoTimeline,
  type BufferedTimelineEvent,
} from './use-agent-chat-session.ts'

// rAF batching must be behaviour-preserving: folding a frame's worth of events
// in one flush must produce exactly what the unbatched path (flush-per-event)
// produced. These tests pin that equivalence, plus the T5 rotation reset.

function envelope(epoch: string, seq: number, item: TimelineItem): TimelineEnvelope {
  return {
    sessionId: 'session-1',
    provider: 'flitro',
    seq,
    epoch,
    timestamp: seq,
    item,
  }
}

function userMessage(epoch: string, seq: number, id: string): BufferedTimelineEvent {
  return {
    envelope: envelope(epoch, seq, {
      type: 'user_message',
      messageId: id,
      text: `m${seq}`,
    } as unknown as TimelineItem),
    rotated: false,
  }
}

function metaEvent(epoch: string, seq: number): BufferedTimelineEvent {
  return {
    envelope: envelope(epoch, seq, { type: 'compaction_started' } as TimelineItem),
    rotated: false,
  }
}

function createInitial(): SessionState {
  return {
    session: {
      id: 'session-1',
      workspaceId: 'ws',
      workspaceName: 'ws',
      lastMessageAt: 0,
      messages: [],
      isProcessing: false,
    },
    streaming: null,
  }
}

// Reference implementation: the pre-batching path applied one event per flush.
function sequentialTimeline(batch: BufferedTimelineEvent[]): TimelineEnvelope[] {
  return batch.reduce<TimelineEnvelope[]>(
    (acc, ev) => foldBatchIntoTimeline(acc, [ev]),
    [],
  )
}

function sequentialSessionState(batch: BufferedTimelineEvent[]): SessionState {
  return batch.reduce<SessionState>(
    (acc, ev) => foldBatchIntoSessionState(acc, [ev], createInitial),
    createInitial(),
  )
}

describe('rAF batch folding — equivalence with the unbatched path', () => {
  test('a mixed burst folds to the same timeline whether batched or one-at-a-time', () => {
    const batch = [
      userMessage('e1', 1, 'a'),
      metaEvent('e1', 2),
      userMessage('e1', 3, 'b'),
      userMessage('e1', 4, 'c'),
    ]
    expect(foldBatchIntoTimeline([], batch)).toEqual(sequentialTimeline(batch))
  })

  test('a mixed burst folds to the same session state whether batched or one-at-a-time', () => {
    const batch = [
      userMessage('e1', 1, 'a'),
      metaEvent('e1', 2),
      userMessage('e1', 3, 'b'),
    ]
    const batched = foldBatchIntoSessionState(createInitial(), batch, createInitial)
    expect(batched.session.messages).toEqual(sequentialSessionState(batch).session.messages)
    // Every user_message transition was applied — none dropped by batching.
    expect(batched.session.messages).toHaveLength(2)
  })

  test('duplicate server envelopes in one batch dedupe like the unbatched path', () => {
    const batch = [userMessage('e1', 1, 'a'), userMessage('e1', 1, 'a')]
    const folded = foldBatchIntoTimeline([], batch)
    expect(folded).toHaveLength(1)
    expect(folded).toEqual(sequentialTimeline(batch))
  })

  test('a same-epoch burst merges the timeline once per frame', () => {
    const sortSpy = vi.spyOn(Array.prototype, 'sort')
    try {
      foldBatchIntoTimeline([], [
        userMessage('e1', 1, 'a'),
        userMessage('e1', 2, 'b'),
        userMessage('e1', 3, 'c'),
      ])
      expect(sortSpy).toHaveBeenCalledTimes(1)
    } finally {
      sortSpy.mockRestore()
    }
  })
})

describe('rAF batch folding — T5 epoch rotation mid-batch', () => {
  test('rotation drops old-epoch envelopes from the timeline (no double render)', () => {
    const batch: BufferedTimelineEvent[] = [
      userMessage('e1', 5, 'old-a'),
      userMessage('e1', 6, 'old-b'),
      { ...userMessage('e2', 1, 'new-a'), rotated: true },
      userMessage('e2', 2, 'new-b'),
    ]
    const folded = foldBatchIntoTimeline([userMessage('e1', 4, 'old-0').envelope], batch)
    // Only the post-rotation epoch survives.
    expect(folded.every(e => e.epoch === 'e2')).toBe(true)
    expect(folded.map(e => e.seq)).toEqual([1, 2])
  })

  test('rotation resets session state to fresh initial mid-batch', () => {
    const batch: BufferedTimelineEvent[] = [
      userMessage('e1', 5, 'old-a'),
      { ...userMessage('e2', 1, 'new-a'), rotated: true },
      userMessage('e2', 2, 'new-b'),
    ]
    const folded = foldBatchIntoSessionState(createInitial(), batch, createInitial)
    // old-a was discarded on rotation; only the two new-epoch messages remain.
    expect(folded.session.messages).toHaveLength(2)
    expect(folded.session.messages.map(m => m.id)).toEqual(['new-a', 'new-b'])
  })

  test('rotation preserves local meta-events (seq 0) already in the timeline (T5-7)', () => {
    // Fresh session: preflight appended the capability report (seq 0, old
    // epoch) before the first server event arrived. The rotation must drop
    // old-epoch SERVER envelopes (seq > 0) but keep the local cap-report.
    const capReport = metaEvent('e1', 0)
    const batch: BufferedTimelineEvent[] = [
      { ...userMessage('e2', 1, 'new-a'), rotated: true },
      userMessage('e2', 2, 'new-b'),
    ]
    const folded = foldBatchIntoTimeline([capReport.envelope], batch)
    expect(folded.filter(e => e.seq === 0)).toHaveLength(1)
    expect(folded.filter(e => e.seq === 0)[0].item.type).toBe('compaction_started')
    expect(folded.filter(e => e.epoch === 'e2').map(e => e.seq)).toEqual([1, 2])
  })

  test('rotation preserves local meta-events (seq 0) arriving in the same frame (T5-7)', () => {
    // The cap-report and the first (rotating) server event land in one batch.
    const capReport = metaEvent('e1', 0)
    const batch: BufferedTimelineEvent[] = [
      capReport,
      { ...userMessage('e2', 1, 'new-a'), rotated: true },
      userMessage('e2', 2, 'new-b'),
    ]
    const folded = foldBatchIntoTimeline([], batch)
    expect(folded.filter(e => e.seq === 0)).toHaveLength(1)
    expect(folded.filter(e => e.epoch === 'e2').map(e => e.seq)).toEqual([1, 2])
  })
})

describe('catchupBatch — rotation-aware onClose catchup (INT-5)', () => {
  test('flags a rotation when the catchup epoch differs from the pinned epoch', () => {
    const items = [userMessage('e2', 1, 'a').envelope, userMessage('e2', 2, 'b').envelope]
    const batch = catchupBatch(items, 'e1')
    expect(batch.map(b => b.rotated)).toEqual([true, false])
  })

  test('does not flag a rotation when the catchup epoch matches the pinned epoch', () => {
    const items = [userMessage('e2', 1, 'a').envelope, userMessage('e2', 2, 'b').envelope]
    const batch = catchupBatch(items, 'e2')
    expect(batch.every(b => !b.rotated)).toBe(true)
  })

  test('does not flag a rotation when there is no pinned epoch (first-ever catchup)', () => {
    const items = [userMessage('e2', 1, 'a').envelope]
    const batch = catchupBatch(items, null)
    expect(batch.every(b => !b.rotated)).toBe(true)
  })

  test('local meta-events (seq 0) do not drive rotation and do not advance prevEpoch', () => {
    const items = [
      metaEvent('e1', 0).envelope,
      userMessage('e2', 1, 'a').envelope,
    ]
    // prevEpoch is 'e1'; the seq-0 item neither rotates nor advances prevEpoch,
    // so the e2 seq-1 item is the one that rotates vs 'e1'.
    const batch = catchupBatch(items, 'e1')
    expect(batch.map(b => b.rotated)).toEqual([false, true])
  })

  test('folding a catchup batch under a new epoch resets old-epoch state (no ghosts)', () => {
    // End-to-end INT-5 fix: catchup returns new-epoch items; folding via
    // catchupBatch + foldBatchIntoTimeline resets old-epoch state instead of
    // merging onto it (which would render the old conversation twice).
    const oldState = [userMessage('e1', 5, 'old').envelope]
    const items = [userMessage('e2', 1, 'new').envelope]
    const batch = catchupBatch(items, 'e1')
    const folded = foldBatchIntoTimeline(oldState, batch)
    expect(folded.every(e => e.epoch === 'e2')).toBe(true)
    expect(folded.map(e => e.seq)).toEqual([1])
  })
})

describe('foldBatchIntoSessionState — session contract catchup dedup', () => {
  test('folding the same batch twice does not double-append (dedup by epoch:seq)', () => {
    // The real scenario: an overlapping catchup batch — the same envelopes
    // arrive via BOTH the onClose fetch and the SSE reconnect replay. Without
    // dedup, the second fold re-processes every envelope and processEvent
    // double-appends delta text into messages.
    const batch: BufferedTimelineEvent[] = [
      userMessage('e1', 1, 'a'),
      userMessage('e1', 2, 'b'),
    ]
    const first = foldBatchIntoSessionState(createInitial(), batch, createInitial)
    expect(first.session.messages).toHaveLength(2)
    const second = foldBatchIntoSessionState(first, batch, createInitial)
    // Second fold sees every key in processedKeys → skips → state unchanged.
    expect(second.session.messages).toHaveLength(2)
    expect(second.session.messages).toEqual(first.session.messages)
  })

  test('an overlapping catchup batch (a subset already folded) only appends the new items', () => {
    const firstBatch: BufferedTimelineEvent[] = [
      userMessage('e1', 1, 'a'),
      userMessage('e1', 2, 'b'),
    ]
    const overlapBatch: BufferedTimelineEvent[] = [
      userMessage('e1', 2, 'b'), // already folded — must be skipped
      userMessage('e1', 3, 'c'), // new — must be appended
    ]
    const first = foldBatchIntoSessionState(createInitial(), firstBatch, createInitial)
    const second = foldBatchIntoSessionState(first, overlapBatch, createInitial)
    expect(second.session.messages.map(m => m.id)).toEqual(['a', 'b', 'c'])
  })

  test('rotation resets the dedup set so a new epoch re-folds from scratch', () => {
    // seq 1 under e1 folded; then a rotation to e2 + e2:1 must PROCESS (not
    // dedup against the old e1:1, which shares the seq but a different epoch).
    const e1Batch: BufferedTimelineEvent[] = [userMessage('e1', 1, 'old')]
    const rotatedBatch: BufferedTimelineEvent[] = [
      { ...userMessage('e2', 1, 'new'), rotated: true },
    ]
    const first = foldBatchIntoSessionState(createInitial(), e1Batch, createInitial)
    expect(first.session.messages.map(m => m.id)).toEqual(['old'])
    const second = foldBatchIntoSessionState(first, rotatedBatch, createInitial)
    expect(second.session.messages.map(m => m.id)).toEqual(['new'])
  })

  test('local meta-events (seq 0) do not pollute the dedup set', () => {
    // seq-0 items are client-origin (capability report, warnings) and may
    // legitimately recur — the dedup guard (seq > 0) skips them entirely.
    const batch: BufferedTimelineEvent[] = [metaEvent('e1', 0), metaEvent('e1', 0)]
    const folded = foldBatchIntoSessionState(createInitial(), batch, createInitial)
    expect(folded.processedKeys?.size ?? 0).toBe(0)
  })
})

describe('foldBatchIntoSessionState — session contract processedKeys cap', () => {
  test('caps the processedKeys dedup set (oldest evicted) for a long single-epoch session', () => {
    // 1001 distinct seqs under one epoch: the dedup set is capped at
    // PROCESSED_KEYS_CAP (1000), evicting the oldest key. The set never grows
    // unbounded across a long session.
    const batch: BufferedTimelineEvent[] = []
    for (let seq = 1; seq <= 1001; seq++) {
      // metaEvent (compaction_started) is NOT a chat-transcript envelope, so
      // processEvent is skipped — the test stays fast and isolates the cap.
      batch.push(metaEvent('e1', seq))
    }
    const folded = foldBatchIntoSessionState(createInitial(), batch, createInitial)
    expect(folded.processedKeys?.size).toBe(1000)
    // The oldest key (e1:1) is evicted; the most recent (e1:1001) is retained.
    expect(folded.processedKeys?.has('e1:1')).toBe(false)
    expect(folded.processedKeys?.has('e1:1001')).toBe(true)
  })

  test('rotation resets the cap (a new epoch folds from scratch)', () => {
    // Fill to the cap under e1, then rotate to e2 — the new epoch's set starts
    // fresh, so e2:1 is processed even though e1 was at the cap.
    const e1Batch: BufferedTimelineEvent[] = []
    for (let seq = 1; seq <= 1000; seq++) e1Batch.push(metaEvent('e1', seq))
    const e1Folded = foldBatchIntoSessionState(createInitial(), e1Batch, createInitial)
    expect(e1Folded.processedKeys?.size).toBe(1000)

    const rotatedBatch: BufferedTimelineEvent[] = [
      { ...metaEvent('e2', 1), rotated: true },
      metaEvent('e2', 2),
    ]
    const folded = foldBatchIntoSessionState(e1Folded, rotatedBatch, createInitial)
    expect(folded.processedKeys?.size).toBe(2)
    expect(folded.processedKeys?.has('e2:1')).toBe(true)
    expect(folded.processedKeys?.has('e2:2')).toBe(true)
  })
})
