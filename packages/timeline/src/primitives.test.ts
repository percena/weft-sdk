import { describe, expect, it } from 'vitest'
import {
  fetchTimeline,
  mergeTimeline,
  mergeTimelineIncremental,
  readTurnFailedError,
  sortTimeline,
  type TimelineEnvelope,
  type TimelineItem,
} from './index.js'

// session contract: the @weft/timeline primitives had zero tests, and the session contract fixes
// (sortTimeline's non-causal `epoch.localeCompare`, hasGap's leading-edge-only
// check) are exactly the kind of change that regresses silently without unit
// coverage. These pin the POST-FIX behavior — do not regress to the unsound
// `localeCompare` / leading-edge-only primitives.

const statusItem: TimelineItem = { type: 'session_status', status: 'running' }

function env(epoch: string, seq: number, overrides: Partial<TimelineEnvelope> = {}): TimelineEnvelope {
  return {
    sessionId: 's1',
    provider: 'flitro',
    seq,
    epoch,
    timestamp: 1000 + seq,
    item: statusItem,
    ...overrides,
  }
}

// ── sortTimeline (session contract) ─────────────────────────────────────────────────────

describe('sortTimeline (session contract)', () => {
  it('orders by seq within a single epoch', () => {
    const sorted = sortTimeline([env('E1', 3), env('E1', 1), env('E1', 2)])
    expect(sorted.map(e => e.seq)).toEqual([1, 2, 3])
  })

  it('does NOT use epoch.localeCompare — groups epochs by first-seen insertion order', () => {
    // Epoch strings are opaque + non-causal (random bootID). localeCompare
    // would order E1/E2 alphabetically (E1 < E2) regardless of arrival; the
    // consumer must preserve insertion order. Insert E2 BEFORE E1 so any
    // alphabetical sort would misorder (E1 first) — insertion order keeps E2
    // first, proving localeCompare is not the comparator.
    const sorted = sortTimeline([env('E2', 1), env('E1', 1), env('E2', 2), env('E1', 2)])
    expect(sorted.map(e => `${e.epoch}:${e.seq}`)).toEqual([
      'E2:1',
      'E2:2',
      'E1:1',
      'E1:2',
    ])
  })

  it('within an epoch group, seqs are ascending even when interleaved on input', () => {
    const sorted = sortTimeline([env('E1', 5), env('E2', 2), env('E1', 1), env('E2', 1)])
    expect(sorted.map(e => `${e.epoch}:${e.seq}`)).toEqual([
      'E1:1',
      'E1:5',
      'E2:1',
      'E2:2',
    ])
  })

  it('returns a new array (does not mutate input) and handles empty', () => {
    const input: TimelineEnvelope[] = []
    expect(sortTimeline(input)).toEqual([])
    const same = sortTimeline([env('E1', 1)])
    expect(same).not.toBe(input)
  })
})

// ── fetchTimeline + hasGap (session contract) ───────────────────────────────────────────

describe('fetchTimeline + hasGap (session contract)', () => {
  it('advances the cursor within an epoch and reports no gap when contiguous', () => {
    const timeline = [env('E1', 1), env('E1', 2), env('E1', 3), env('E1', 4)]
    const result = fetchTimeline(timeline, { cursor: { epoch: 'E1', afterSeq: 1 }, limit: 2 })
    expect(result.items.map(e => e.seq)).toEqual([2, 3])
    expect(result.nextCursor).toEqual({ epoch: 'E1', afterSeq: 3 })
    expect(result.hasGap).toBe(false)
  })

  it('detects a LEADING gap (first seq > afterSeq + 1)', () => {
    // afterSeq=0 → expect first seq 1; timeline starts at 3.
    const timeline = [env('E1', 3), env('E1', 4)]
    const result = fetchTimeline(timeline, { cursor: { epoch: 'E1', afterSeq: 0 } })
    expect(result.hasGap).toBe(true)
  })

  it('detects an INTERIOR gap (the previous leading-edge-only check missed this)', () => {
    // afterSeq=0 → expect 1,2,3… but the timeline is 1,2,4,5 (missing 3).
    const timeline = [env('E1', 1), env('E1', 2), env('E1', 4), env('E1', 5)]
    const result = fetchTimeline(timeline, { cursor: { epoch: 'E1', afterSeq: 0 } })
    expect(result.hasGap).toBe(true)
    // Mirrors flitro's handlers_session_extras.go:242-252 contiguity walk.
  })

  it('reports no gap for a contiguous full page', () => {
    const timeline = [env('E1', 1), env('E1', 2), env('E1', 3)]
    const result = fetchTimeline(timeline, { cursor: { epoch: 'E1', afterSeq: 0 } })
    expect(result.hasGap).toBe(false)
    expect(result.items.map(e => e.seq)).toEqual([1, 2, 3])
  })

  it('returns empty (no items, no gap) when the cursor is past the end', () => {
    const timeline = [env('E1', 1), env('E1', 2)]
    const result = fetchTimeline(timeline, { cursor: { epoch: 'E1', afterSeq: 5 } })
    expect(result.items).toEqual([])
    expect(result.nextCursor).toEqual({ epoch: 'E1', afterSeq: 5 })
    expect(result.hasGap).toBe(false)
  })

  it('returns empty for a stale (cross-epoch) cursor — the scaffold falls back to remote', () => {
    // Deliberate: the strict epoch filter returns empty so the scaffold's
    // fetchTimeline method falls back to remoteTimelineFetch (which, with transport contract,
    // sends the stale epoch → flitro replays from 0 under the new epoch).
    // Relaxing the filter here would short-circuit that catchup with possibly
    // incomplete local items.
    const timeline = [env('E2', 1), env('E2', 2)]
    const result = fetchTimeline(timeline, { cursor: { epoch: 'E1', afterSeq: 0 } })
    expect(result.items).toEqual([])
    expect(result.hasGap).toBe(false)
  })

  it('honors the limit and advances the cursor to the last returned seq', () => {
    const timeline = [env('E1', 1), env('E1', 2), env('E1', 3), env('E1', 4), env('E1', 5)]
    const result = fetchTimeline(timeline, { cursor: { epoch: 'E1', afterSeq: 0 }, limit: 3 })
    expect(result.items.map(e => e.seq)).toEqual([1, 2, 3])
    expect(result.nextCursor.afterSeq).toBe(3)
  })
})

// ── mergeTimeline (session contract) ───────────────────────────────────────────────────

describe('mergeTimeline (session contract)', () => {
  it('dedups by epoch:seq (no cross-epoch key collision)', () => {
    // seq 1 under E1 and seq 1 under E2 are DISTINCT keys — both kept.
    const merged = mergeTimeline([env('E1', 1)], [env('E2', 1)])
    expect(merged).toHaveLength(2)
    expect(merged.map(e => `${e.epoch}:${e.seq}`).sort()).toEqual(['E1:1', 'E2:1'])
  })

  it('drops a genuine same-epoch duplicate', () => {
    const merged = mergeTimeline([env('E1', 1)], [env('E1', 1)])
    expect(merged).toHaveLength(1)
  })

  it('merges non-overlapping seqs within an epoch in seq order', () => {
    const merged = mergeTimeline([env('E1', 1), env('E1', 3)], [env('E1', 2)])
    expect(merged.map(e => e.seq)).toEqual([1, 2, 3])
  })

  it('incoming item wins on a same-key conflict (latest snapshot)', () => {
    const existing = env('E1', 1, { timestamp: 1 })
    const incoming = env('E1', 1, { timestamp: 99 })
    const merged = mergeTimeline([existing], [incoming])
    expect(merged).toHaveLength(1)
    expect(merged[0].timestamp).toBe(99)
  })
})

// ── mergeTimelineIncremental (P2 07-02 residual) ────────────────────────────
// The incremental fast path MUST be bit-for-bit equal to mergeTimeline for
// every input. The invariant it exploits (existing is pre-sorted + deduped) is
// the caller's responsibility, so the tests build a pre-sorted+deduped
// `existing` (via mergeTimeline itself) and then assert equivalence across the
// cases the fast path must handle and the cases that must fall back.

describe('mergeTimelineIncremental — equivalence with mergeTimeline', () => {
  // Build a pre-sorted + deduped `existing` (the invariant the fast path
  // requires) by running it through mergeTimeline once.
  function sorted(existing: TimelineEnvelope[]): TimelineEnvelope[] {
    return mergeTimeline(existing, [])
  }

  it('empty incoming returns existing unchanged (O(1) identity, no re-sort)', () => {
    const existing = sorted([env('E1', 1), env('E1', 2)])
    const result = mergeTimelineIncremental(existing, [])
    // Identity: no copy, no re-sort — the very array reference is returned.
    expect(result).toBe(existing)
    expect(result).toEqual(mergeTimeline(existing, []))
  })

  it('empty existing delegates to mergeTimeline (sort + dedup incoming)', () => {
    const incoming = [env('E1', 3), env('E1', 1), env('E1', 3)]
    expect(mergeTimelineIncremental([], incoming)).toEqual(mergeTimeline([], incoming))
  })

  it('same-epoch append (seqs > last) — the streaming fast path', () => {
    const existing = sorted([env('E1', 1), env('E1', 2), env('E1', 3)])
    const incoming = [env('E1', 4), env('E1', 5), env('E1', 6)]
    expect(mergeTimelineIncremental(existing, incoming)).toEqual(mergeTimeline(existing, incoming))
  })

  it('same-epoch append with internal duplicates (last-write-wins within incoming)', () => {
    const existing = sorted([env('E1', 1), env('E1', 2)])
    const incoming = [
      env('E1', 3, { timestamp: 1 }),
      env('E1', 4),
      env('E1', 3, { timestamp: 99 }), // duplicate seq 3 → wins
    ]
    const result = mergeTimelineIncremental(existing, incoming)
    expect(result).toEqual(mergeTimeline(existing, incoming))
    expect(result.filter(e => e.seq === 3)).toHaveLength(1)
    expect(result.find(e => e.seq === 3)?.timestamp).toBe(99)
  })

  it('incoming unsorted within the same epoch is sorted on the fast path', () => {
    const existing = sorted([env('E1', 1)])
    const incoming = [env('E1', 5), env('E1', 3), env('E1', 4)]
    expect(mergeTimelineIncremental(existing, incoming)).toEqual(mergeTimeline(existing, incoming))
  })

  it('overlap with existing (a re-delivered seq ≤ last) falls back to dedup', () => {
    const existing = sorted([env('E1', 1), env('E1', 2), env('E1', 3)])
    const incoming = [env('E1', 2, { timestamp: 77 }), env('E1', 4)] // 2 collides
    const result = mergeTimelineIncremental(existing, incoming)
    expect(result).toEqual(mergeTimeline(existing, incoming))
    expect(result).toHaveLength(4)
    expect(result.find(e => e.seq === 2)?.timestamp).toBe(77)
  })

  it('a new epoch in incoming falls back (cannot prove append-only)', () => {
    const existing = sorted([env('E1', 1), env('E1', 2)])
    const incoming = [env('E2', 1), env('E2', 2)] // new epoch — sortTimeline appends it after E1
    expect(mergeTimelineIncremental(existing, incoming)).toEqual(mergeTimeline(existing, incoming))
  })

  it('mixed-epoch incoming falls back', () => {
    const existing = sorted([env('E1', 1)])
    const incoming = [env('E1', 2), env('E2', 1)] // two epochs in one batch
    expect(mergeTimelineIncremental(existing, incoming)).toEqual(mergeTimeline(existing, incoming))
  })

  it('incoming with a seq equal to last.seq (same key) falls back to dedup', () => {
    const existing = sorted([env('E1', 3)])
    const incoming = [env('E1', 3, { timestamp: 5 })] // exact key collision
    const result = mergeTimelineIncremental(existing, incoming)
    expect(result).toEqual(mergeTimeline(existing, incoming))
    expect(result).toHaveLength(1)
  })

  it('a long same-epoch append (simulating streaming into a long session)', () => {
    // existing = 500 envelopes E1:1..500; incoming = a frame's worth E1:501..505.
    const existing = sorted(
      Array.from({ length: 500 }, (_, i) => env('E1', i + 1)),
    )
    const incoming = Array.from({ length: 5 }, (_, i) => env('E1', 501 + i))
    const result = mergeTimelineIncremental(existing, incoming)
    expect(result).toEqual(mergeTimeline(existing, incoming))
    expect(result.length).toBe(505)
    // Order preserved: existing prefix untouched, incoming tail appended.
    expect(result[499]?.seq).toBe(500)
    expect(result[500]?.seq).toBe(501)
  })
})

describe('readTurnFailedError', () => {
  it('collapses empty message to the turn failed fallback', () => {
    expect(readTurnFailedError({ message: '' })).toEqual({ message: 'turn failed' })
    expect(readTurnFailedError(new Error(''))).toEqual({ message: 'turn failed' })
  })

  it('preserves non-empty message and typed code/status', () => {
    expect(readTurnFailedError({
      message: 'Weft HTTP 409: unusable',
      code: 'llm_connection_unusable',
      status: 409,
    })).toEqual({
      message: 'Weft HTTP 409: unusable',
      code: 'llm_connection_unusable',
      status: 409,
    })
  })

  it('accepts a bare non-empty string error', () => {
    expect(readTurnFailedError('boom')).toEqual({ message: 'boom' })
  })
})
