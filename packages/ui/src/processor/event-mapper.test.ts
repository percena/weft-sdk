import { describe, expect, it } from 'vitest'
import { mapTimelineEnvelopeToProcessorEvent } from './event-mapper.ts'
import type { TimelineEnvelope } from '@weft/timeline'

function envelopeWith(
  item: TimelineEnvelope['item'],
  overrides: Partial<TimelineEnvelope> = {},
): TimelineEnvelope {
  return {
    sessionId: 'sess-1',
    provider: 'flitro',
    seq: 1,
    epoch: 'e1',
    timestamp: 1000,
    item,
    ...overrides,
  }
}

describe('mapTimelineEnvelopeToProcessorEvent — X-E(b) permission_resolved', () => {
  it('maps a granted resolution to a typed permission_resolved event', () => {
    const env = envelopeWith({
      type: 'permission_resolved',
      requestId: 'req-1',
      resolution: { allowed: true, reason: 'admin approved' },
    })
    const got = mapTimelineEnvelopeToProcessorEvent(env)
    expect(got.type).toBe('permission_resolved')
    expect(got).toMatchObject({ sessionId: 'sess-1', timestamp: 1000 })
    if (got.type !== 'permission_resolved') throw new Error('expected permission_resolved')
    expect(got.requestId).toBe('req-1')
    expect(got.allowed).toBe(true)
    expect(got.reason).toBe('admin approved')
    // Pre-formatted outcome preserves the pre-X-E(b) transcript line.
    expect(got.message).toBe('Permission granted: admin approved')
    // Must NOT be the pre-session contract generic placeholder nor a bare info event.
    expect(got.message).not.toContain('Timeline event')
  })

  it('maps a denied resolution without a reason', () => {
    const env = envelopeWith({
      type: 'permission_resolved',
      requestId: 'req-2',
      resolution: { allowed: false },
    })
    const got = mapTimelineEnvelopeToProcessorEvent(env)
    if (got.type !== 'permission_resolved') throw new Error('expected permission_resolved')
    expect(got.allowed).toBe(false)
    expect(got.reason).toBeUndefined()
    expect(got.message).toBe('Permission denied')
  })

  it('still surfaces the reason when denied', () => {
    const env = envelopeWith({
      type: 'permission_resolved',
      requestId: 'req-3',
      resolution: { allowed: false, reason: 'policy blocked' },
    })
    const got = mapTimelineEnvelopeToProcessorEvent(env)
    if (got.type !== 'permission_resolved') throw new Error('expected permission_resolved')
    expect(got.message).toBe('Permission denied: policy blocked')
  })

  it('surfaces the structured detail payload verbatim (X-E(a) forward-compat)', () => {
    const detail = { updatedInput: { command: 'rm -rf /tmp/x' }, updatedPermissions: [{ rule: 'allow' }] }
    const env = envelopeWith({
      type: 'permission_resolved',
      requestId: 'req-4',
      resolution: { allowed: true, reason: 'rewrite applied' },
      detail,
    })
    const got = mapTimelineEnvelopeToProcessorEvent(env)
    if (got.type !== 'permission_resolved') throw new Error('expected permission_resolved')
    expect(got.detail).toEqual(detail)
  })

  it('detail is undefined when the producer omits it', () => {
    const env = envelopeWith({
      type: 'permission_resolved',
      requestId: 'req-5',
      resolution: { allowed: true },
    })
    const got = mapTimelineEnvelopeToProcessorEvent(env)
    if (got.type !== 'permission_resolved') throw new Error('expected permission_resolved')
    expect(got.detail).toBeUndefined()
  })

  it('coerces a missing allowed to false (safe fallback)', () => {
    // Defensive: the timeline type requires resolution.allowed, but the mapper
    // reads it with optional chaining — undefined must never leak as truthy.
    const env = envelopeWith({
      type: 'permission_resolved',
      requestId: 'req-6',
      resolution: { allowed: undefined as unknown as boolean },
    })
    const got = mapTimelineEnvelopeToProcessorEvent(env)
    if (got.type !== 'permission_resolved') throw new Error('expected permission_resolved')
    expect(got.allowed).toBe(false)
    expect(got.message).toBe('Permission denied')
  })
})
