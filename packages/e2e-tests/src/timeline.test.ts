import { describe, expect, test } from 'vitest'

import {
  appendTimelineItem,
  createTimelineCursor,
  createTimelineSequencer,
  fetchTimeline,
  mergeTimeline,
  type TimelineEnvelope,
} from '@weft/timeline'

describe('Timeline — canonical envelope and replay contract', () => {
  test('assigns monotonic seq values inside a stable session epoch', () => {
    const sequencer = createTimelineSequencer({
      sessionId: 'session-1',
      provider: 'codex',
      epoch: 'epoch-a',
      now: () => 1_000,
    })

    const first = sequencer.append({ type: 'turn_started', turnId: 'turn-1' })
    const second = sequencer.append({
      type: 'assistant_message_delta',
      turnId: 'turn-1',
      messageId: 'message-1',
      text: 'hello',
    })

    expect(first).toEqual({
      sessionId: 'session-1',
      provider: 'codex',
      epoch: 'epoch-a',
      seq: 1,
      timestamp: 1_000,
      item: { type: 'turn_started', turnId: 'turn-1' },
    })
    expect(second.seq).toBe(2)
    expect(second.epoch).toBe('epoch-a')
  })

  test('fetches timeline items after a cursor and reports the next cursor', () => {
    const timeline: TimelineEnvelope[] = [
      appendTimelineItem({
        sessionId: 'session-1',
        provider: 'claude',
        epoch: 'epoch-a',
        seq: 1,
        timestamp: 1_000,
        item: { type: 'turn_started', turnId: 'turn-1' },
      }),
      appendTimelineItem({
        sessionId: 'session-1',
        provider: 'claude',
        epoch: 'epoch-a',
        seq: 2,
        timestamp: 1_001,
        item: {
          type: 'permission_requested',
          request: {
            requestId: 'permission-1',
            toolName: 'Write',
            scope: { type: 'session', sessionId: 'session-1' },
          },
        },
      }),
      appendTimelineItem({
        sessionId: 'session-1',
        provider: 'claude',
        epoch: 'epoch-a',
        seq: 3,
        timestamp: 1_002,
        item: {
          type: 'permission_resolved',
          requestId: 'permission-1',
          resolution: { allowed: true, remember: false },
        },
      }),
    ]

    const result = fetchTimeline(timeline, {
      cursor: createTimelineCursor({ epoch: 'epoch-a', afterSeq: 1 }),
    })

    expect(result.items.map(item => item.seq)).toEqual([2, 3])
    expect(result.nextCursor).toEqual({ epoch: 'epoch-a', afterSeq: 3 })
    expect(result.hasGap).toBe(false)
  })

  test('merges replayed timeline batches without duplicating epoch and seq pairs', () => {
    const existing: TimelineEnvelope[] = [
      appendTimelineItem({
        sessionId: 'session-1',
        provider: 'codex',
        epoch: 'epoch-a',
        seq: 1,
        timestamp: 1_000,
        item: { type: 'turn_started', turnId: 'turn-1' },
      }),
    ]
    const replayed: TimelineEnvelope[] = [
      existing[0],
      appendTimelineItem({
        sessionId: 'session-1',
        provider: 'codex',
        epoch: 'epoch-a',
        seq: 2,
        timestamp: 1_001,
        item: {
          type: 'automation_triggered',
          automation: {
            automationId: 'daily-review',
            origin: { type: 'automation', id: 'daily-review' },
          },
        },
      }),
    ]

    const merged = mergeTimeline(existing, replayed)

    expect(merged.map(item => item.seq)).toEqual([1, 2])
    expect(merged[1]?.item.type).toBe('automation_triggered')
  })

  test('reports hasGap=true when seq values are missing between cursor and first result', () => {
    // Construct a timeline with seq 1, 3 (gap at seq 2)
    const timeline: TimelineEnvelope[] = [
      appendTimelineItem({
        sessionId: 'session-1', provider: 'claude', epoch: 'epoch-a',
        seq: 1, timestamp: 1_000,
        item: { type: 'turn_started', turnId: 'turn-1' },
      }),
      appendTimelineItem({
        sessionId: 'session-1', provider: 'claude', epoch: 'epoch-a',
        seq: 3, timestamp: 1_002,
        item: { type: 'assistant_message_delta', text: 'hello', messageId: 'msg-1', turnId: 'turn-1' },
      }),
    ]

    // Fetch from afterSeq=0 — items are seq 1 and 3. session contract: hasGap now detects
    // INTERIOR gaps (not just a leading gap), so even though the first item is
    // exactly afterSeq+1 (=1, no leading gap), the missing seq 2 between items
    // 1 and 3 is reported as a gap. The pre-session contract leading-edge-only check
    // missed this and returned false (mirrors flitro's contiguity walk at
    // handlers_session_extras.go:242-252).
    const resultStart = fetchTimeline(timeline, {
      cursor: createTimelineCursor({ epoch: 'epoch-a', afterSeq: 0 }),
    })
    expect(resultStart.hasGap).toBe(true) // interior gap: seq 2 missing between 1 and 3

    // Fetch from afterSeq=1 — firstSeq is 3, which is > 1+1, so gap detected
    const resultGap = fetchTimeline(timeline, {
      cursor: createTimelineCursor({ epoch: 'epoch-a', afterSeq: 1 }),
    })
    expect(resultGap.items.map(item => item.seq)).toEqual([3])
    expect(resultGap.hasGap).toBe(true) // seq 2 is missing
  })

  test('represents host metadata changes as replayable timeline items', () => {
    const sequencer = createTimelineSequencer({
      sessionId: 'session-1',
      provider: 'host',
      epoch: 'epoch-a',
      now: () => 1_000,
    })

    const envelope = sequencer.append({
      type: 'host_state_changed',
      state: {
        kind: 'session_metadata',
        sessionId: 'session-1',
        labels: ['scheduled'],
        status: 'needs-review',
      },
    })

    expect(envelope.item).toEqual({
      type: 'host_state_changed',
      state: {
        kind: 'session_metadata',
        sessionId: 'session-1',
        labels: ['scheduled'],
        status: 'needs-review',
      },
    })
  })
})
