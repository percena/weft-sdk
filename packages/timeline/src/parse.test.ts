import { describe, expect, it, vi, afterEach } from 'vitest'
import {
  parseTimelineEnvelope,
  TIMELINE_PROTOCOL_VERSION,
  type TimelineEnvelope,
} from './index.js'

// Reset the module-level skew-warning dedup flag between tests by importing a
// fresh module each time would be cleaner, but the flag is process-global by
// design (warn once per process). Tests that assert the warning re-import after
// resetting via vi.resetModules; the no-warn tests run first while the flag is
// still false.
afterEach(() => {
  vi.restoreAllMocks()
})

const validFrame = (overrides: Partial<Record<string, unknown>> = {}): unknown => ({
  sessionId: 'sess-1',
  provider: 'flitro',
  seq: 7,
  epoch: 'flitro-sess-1-boot-g0',
  timestamp: 1751750000000,
  v: 1,
  item: { type: 'session_status', status: 'running' },
  rawRef: { providerEventType: 'run.started' },
  ...overrides,
})

describe('parseTimelineEnvelope (X-B / session contract)', () => {
  it('decodes a valid envelope with the version field', () => {
    const env = parseTimelineEnvelope(validFrame())
    expect(env.sessionId).toBe('sess-1')
    expect(env.seq).toBe(7)
    expect(env.epoch).toBe('flitro-sess-1-boot-g0')
    expect(env.v).toBe(1)
    expect(env.item).toEqual({ type: 'session_status', status: 'running' })
    expect(env.rawRef?.providerEventType).toBe('run.started')
  })

  it('decodes a pre-X-B envelope (no `v` field) leniently', () => {
    const env = parseTimelineEnvelope(validFrame({ v: undefined }))
    // delete v to simulate a pre-X-B producer
    const frame = validFrame()
    delete (frame as Record<string, unknown>).v
    const env2 = parseTimelineEnvelope(frame)
    expect(env.v).toBeUndefined()
    expect(env2.v).toBeUndefined()
    expect(env2.seq).toBe(7)
  })

  it('is lenient: unknown envelope fields do not throw', () => {
    const env = parseTimelineEnvelope(
      validFrame({ futureField: 'x', another: 42 } as Record<string, unknown>),
    )
    expect(env.seq).toBe(7) // still decoded correctly
  })

  it('SDK-R-6: preserves passthrough extras on the returned envelope (not validated-then-dropped)', () => {
    // The schema is .passthrough() so unknown fields survive validation; the
    // return must spread them through instead of re-projecting only known
    // fields. A terminal consumer that reads an unknown field should see it.
    const env = parseTimelineEnvelope(
      validFrame({ futureField: 'x', another: 42 } as Record<string, unknown>),
    ) as TimelineEnvelope & { futureField?: unknown; another?: unknown }
    expect(env.futureField).toBe('x')
    expect(env.another).toBe(42)
    // Known fields still present and correctly typed.
    expect(env.seq).toBe(7)
    expect(env.sessionId).toBe('sess-1')
  })

  it('is lenient: unknown item variants are forwarded opaquely', () => {
    const env = parseTimelineEnvelope(
      validFrame({ item: { type: 'some_new_item_type', whatever: true } }),
    )
    // The item is forwarded verbatim (validated at the reducer, not here).
    expect((env.item as { type: string }).type).toBe('some_new_item_type')
  })

  it('throws on a structurally malformed frame (missing required field)', () => {
    const malformed = validFrame()
    delete (malformed as Record<string, unknown>).seq
    expect(() => parseTimelineEnvelope(malformed)).toThrow()
  })

  it('throws when a required field has the wrong type', () => {
    expect(() => parseTimelineEnvelope(validFrame({ seq: 'not-a-number' }))).toThrow()
    expect(() => parseTimelineEnvelope(validFrame({ epoch: 123 }))).toThrow()
  })

  it('rawRef is optional', () => {
    const frame = validFrame()
    delete (frame as Record<string, unknown>).rawRef
    const env = parseTimelineEnvelope(frame)
    expect(env.rawRef).toBeUndefined()
  })

  it('returns a value assignable to TimelineEnvelope (type-level smoke test)', () => {
    const env: TimelineEnvelope = parseTimelineEnvelope(validFrame())
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const _typecheck: TimelineEnvelope = env
    expect(env).toBeDefined()
  })
})

describe('parseTimelineEnvelope — X-B forward-skew detection', () => {
  it('warns once when the producer stamps a higher unknown version', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // Reset the process-global dedup flag by isolating the module.
    vi.resetModules()
    // Re-import to get a fresh `timelineSkewWarned = false`.
    return import('./index.js').then(({ parseTimelineEnvelope: fresh, TIMELINE_PROTOCOL_VERSION: pv }) => {
      fresh(validFrame({ v: pv + 41 }))
      fresh(validFrame({ v: pv + 41 })) // second frame — must NOT warn again
      fresh(validFrame({ v: pv + 1 }))
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn.mock.calls[0][0]).toEqual(expect.stringContaining('exceeds SDK known max'))
    })
  })

  it('does not warn when the version is at or below the known max', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.resetModules()
    return import('./index.js').then(({ parseTimelineEnvelope: fresh, TIMELINE_PROTOCOL_VERSION: pv }) => {
      fresh(validFrame({ v: pv }))
      fresh(validFrame({ v: pv - 1 }))
      fresh(validFrame({ v: undefined }))
      expect(warn).not.toHaveBeenCalled()
    })
  })

  it('still decodes the higher-version frame leniently (does not throw)', () => {
    vi.resetModules()
    return import('./index.js').then(({ parseTimelineEnvelope: fresh, TIMELINE_PROTOCOL_VERSION: pv }) => {
      const env = fresh(validFrame({ v: pv + 100 }))
      expect(env.v).toBe(pv + 100)
      expect(env.seq).toBe(7)
    })
  })
})

// Sanity: the SDK known max mirrors the flitro producer constant (1 today).
describe('TIMELINE_PROTOCOL_VERSION', () => {
  it('matches the flitro ProtocolVersion (X-B contract)', () => {
    // Both sides must agree on the current version. Bump flitro's
    // timeline.ProtocolVersion AND this constant in the same change.
    expect(TIMELINE_PROTOCOL_VERSION).toBe(1)
  })
})
