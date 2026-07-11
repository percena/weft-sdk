import { describe, expect, test, vi } from 'vitest'
import type { TimelineEnvelope, TimelineItem } from '@weft/timeline'
import { createFlushScheduler } from './use-agent-chat-session.ts'

// These tests pin the rAF-batching mechanism extracted from the hook — the
// parts the fold-helper tests don't cover: coalescing into one flush per frame,
// the rAF→setTimeout fallback for Node/SSR, cleanup flushing the pending batch
// so the last frame is not lost, and double-schedule dedup. The scheduler's
// timers are injected so tests are deterministic and need no React renderer.

function env(seq: number, epoch = 'e'): TimelineEnvelope {
  return {
    sessionId: 's',
    provider: 'flitro',
    seq,
    epoch,
    timestamp: seq,
    item: { type: 'compaction_started' } as TimelineItem,
  }
}

describe('createFlushScheduler — rAF batching', () => {
  test('coalesces a frame burst into one flush (one commit per frame)', () => {
    const flush = vi.fn()
    const frames: Array<() => void> = []
    const scheduler = createFlushScheduler({
      flush,
      requestAnimationFrame: cb => {
        frames.push(cb)
        return frames.length
      },
      cancelAnimationFrame: () => {},
    })

    scheduler.push(env(1), false)
    scheduler.push(env(2), false)
    scheduler.push(env(3), false)
    scheduler.schedule()
    scheduler.schedule() // dedup: a second schedule within the same frame is a no-op

    expect(frames).toHaveLength(1) // one rAF armed, not three
    expect(flush).not.toHaveBeenCalled()

    frames[0]!() // fire the frame

    expect(flush).toHaveBeenCalledTimes(1)
    const batch = flush.mock.calls[0]![0]
    expect(batch.map((b: { envelope: TimelineEnvelope }) => b.envelope.seq)).toEqual([1, 2, 3])
    expect(batch.map((b: { rotated: boolean }) => b.rotated)).toEqual([false, false, false])
  })

  test('falls back to setTimeout(0) when requestAnimationFrame is unavailable (Node/SSR)', () => {
    const flush = vi.fn()
    const timers: Array<{ cb: () => void; ms: number }> = []
    const scheduler = createFlushScheduler({
      flush,
      // No requestAnimationFrame injected; the global is absent in the node
      // vitest environment, so the scheduler must take the macrotask fallback.
      requestAnimationFrame: undefined,
      setTimeout: (cb, ms) => {
        timers.push({ cb, ms })
        return 0 as unknown as ReturnType<typeof setTimeout>
      },
      clearTimeout: () => {},
    })

    scheduler.push(env(1), false)
    scheduler.schedule()

    expect(timers).toHaveLength(1)
    expect(timers[0]!.ms).toBe(0)
    expect(flush).not.toHaveBeenCalled()

    timers[0]!.cb()
    expect(flush).toHaveBeenCalledTimes(1)
  })

  test('dispose cancels the scheduled frame and flushes pending synchronously (no lost frame)', () => {
    const flush = vi.fn()
    const cancelled: number[] = []
    const frames: Array<() => void> = []
    const scheduler = createFlushScheduler({
      flush,
      requestAnimationFrame: cb => {
        frames.push(cb)
        return 42
      },
      cancelAnimationFrame: h => {
        cancelled.push(h)
      },
    })

    scheduler.push(env(1), false)
    scheduler.schedule()
    scheduler.dispose()

    // The pending batch was drained synchronously on dispose.
    expect(flush).toHaveBeenCalledTimes(1)
    expect(flush.mock.calls[0]![0]).toHaveLength(1)
    // The scheduled rAF was cancelled so it cannot fire after teardown.
    expect(cancelled).toContain(42)
    // And firing the cancelled frame afterward must not double-flush.
    frames[0]!()
    expect(flush).toHaveBeenCalledTimes(1)
  })

  test('flush is a no-op when nothing is pending (no spurious React commits)', () => {
    const flush = vi.fn()
    const scheduler = createFlushScheduler({
      flush,
      requestAnimationFrame: () => 1,
      cancelAnimationFrame: () => {},
    })
    scheduler.flush()
    expect(flush).not.toHaveBeenCalled()
  })

  test('a second schedule after flush re-arms the scheduler for the next frame', () => {
    const flush = vi.fn()
    const frames: Array<() => void> = []
    const scheduler = createFlushScheduler({
      flush,
      requestAnimationFrame: cb => {
        frames.push(cb)
        return frames.length
      },
      cancelAnimationFrame: () => {},
    })

    scheduler.push(env(1), false)
    scheduler.schedule()
    frames[0]!()
    expect(flush).toHaveBeenCalledTimes(1)

    // Next frame: a fresh schedule arms a new rAF (not deduped against the prior).
    scheduler.push(env(2), false)
    scheduler.schedule()
    expect(frames).toHaveLength(2)
    frames[1]!()
    expect(flush).toHaveBeenCalledTimes(2)
    expect(flush.mock.calls[1]![0].map((b: { envelope: TimelineEnvelope }) => b.envelope.seq)).toEqual([2])
  })

  test('flush preserves the order envelopes were pushed in', () => {
    const flush = vi.fn()
    const frames: Array<() => void> = []
    const scheduler = createFlushScheduler({
      flush,
      requestAnimationFrame: cb => {
        frames.push(cb)
        return frames.length
      },
      cancelAnimationFrame: () => {},
    })

    scheduler.push(env(1), false)
    scheduler.push(env(2), true) // a mid-frame rotation is just a buffered flag
    scheduler.push(env(3), false)
    scheduler.schedule()
    frames[0]!()

    const batch = flush.mock.calls[0]![0]
    expect(batch.map((b: { envelope: TimelineEnvelope }) => b.envelope.seq)).toEqual([1, 2, 3])
    expect(batch.map((b: { rotated: boolean }) => b.rotated)).toEqual([false, true, false])
  })
})
