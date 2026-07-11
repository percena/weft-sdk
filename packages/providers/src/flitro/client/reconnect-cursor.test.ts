import { describe, expect, test } from 'vitest'

import { advanceReconnectCursor } from './timeline-stream.ts'
import type { TimelineEnvelope } from './types.ts'

function env(epoch: string, seq: number): TimelineEnvelope {
  return { sessionId: 's1', provider: 'flitro', epoch, seq, timestamp: 0, item: { type: 'info' } } as TimelineEnvelope
}

describe('advanceReconnectCursor (T5)', () => {
  test('first-ever server envelope pins the epoch and afterSeq', () => {
    expect(advanceReconnectCursor('', 0, env('flitro-s1-b1', 3))).toEqual({
      epoch: 'flitro-s1-b1',
      afterSeq: 3,
    })
  })

  test('same epoch advances afterSeq monotonically', () => {
    expect(advanceReconnectCursor('flitro-s1-b1', 3, env('flitro-s1-b1', 4))).toEqual({
      epoch: 'flitro-s1-b1',
      afterSeq: 4,
    })
  })

  test('same epoch does not regress afterSeq on a lower/duplicate seq', () => {
    expect(advanceReconnectCursor('flitro-s1-b1', 5, env('flitro-s1-b1', 2))).toEqual({
      epoch: 'flitro-s1-b1',
      afterSeq: 5,
    })
  })

  test('epoch rotation resets afterSeq to the new (lower) seq space', () => {
    // The crux: after a restart the new seqs are BELOW the old cursor. A plain
    // monotonic guard would keep afterSeq=5 and the next reconnect would send a
    // stale-high after_seq under the now-matching epoch → permanent loss.
    expect(advanceReconnectCursor('flitro-s1-b1', 5, env('flitro-s1-b2', 1))).toEqual({
      epoch: 'flitro-s1-b2',
      afterSeq: 1,
    })
  })
})
