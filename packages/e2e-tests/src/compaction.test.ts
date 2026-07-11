import { describe, expect, test } from 'vitest'
import { createTimelineSequencer, type TimelineItem } from '@weft/timeline'

describe('Session Compaction Lifecycle — Timeline Types', () => {
  test('compaction_started item can be appended to timeline', () => {
    const sequencer = createTimelineSequencer({
      sessionId: 'sess-1',
      provider: 'claude',
      epoch: 'epoch-1',
    })

    const item: TimelineItem = { type: 'compaction_started' }
    const envelope = sequencer.append(item)

    expect(envelope.item.type).toBe('compaction_started')
    expect(envelope.seq).toBe(1)
    expect(envelope.sessionId).toBe('sess-1')
  })

  test('compaction_boundary item can be appended with optional summary', () => {
    const sequencer = createTimelineSequencer({
      sessionId: 'sess-1',
      provider: 'claude',
      epoch: 'epoch-1',
    })

    const item: TimelineItem = { type: 'compaction_boundary', summary: 'Context compacted' }
    const envelope = sequencer.append(item)

    expect(envelope.item.type).toBe('compaction_boundary')
    if (envelope.item.type === 'compaction_boundary') {
      expect(envelope.item.summary).toBe('Context compacted')
    }
  })

  test('compaction_boundary without summary', () => {
    const sequencer = createTimelineSequencer({
      sessionId: 'sess-1',
      provider: 'claude',
      epoch: 'epoch-1',
    })

    const item: TimelineItem = { type: 'compaction_boundary' }
    const envelope = sequencer.append(item)

    expect(envelope.item.type).toBe('compaction_boundary')
    if (envelope.item.type === 'compaction_boundary') {
      expect(envelope.item.summary).toBeUndefined()
    }
  })

  test('compaction events integrate into timeline sequence', () => {
    const sequencer = createTimelineSequencer({
      sessionId: 'sess-1',
      provider: 'claude',
      epoch: 'epoch-1',
    })

    const e1 = sequencer.append({ type: 'turn_started', turnId: 'turn-1' })
    const e2 = sequencer.append({
      type: 'assistant_message',
      text: 'Hello',
      messageId: 'msg-1',
      turnId: 'turn-1',
    })
    const e3 = sequencer.append({ type: 'compaction_started' })
    const e4 = sequencer.append({ type: 'compaction_boundary', summary: 'Compacted' })
    const e5 = sequencer.append({ type: 'turn_started', turnId: 'turn-2' })

    expect(e1.seq).toBe(1)
    expect(e2.seq).toBe(2)
    expect(e3.seq).toBe(3)
    expect(e4.seq).toBe(4)
    expect(e5.seq).toBe(5)

    expect(e3.item.type).toBe('compaction_started')
    expect(e4.item.type).toBe('compaction_boundary')
  })
})
