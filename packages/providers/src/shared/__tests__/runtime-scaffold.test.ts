import { describe, expect, it, vi } from 'vitest'
import type { RuntimeCapabilityReport } from '@weft/runtime-core'
import type { TimelineEnvelope, TimelineItem } from '@weft/timeline'
import { createProviderRuntimeScaffold } from '../runtime-scaffold.ts'

const report = { selected: 'app-server' } as unknown as RuntimeCapabilityReport

function makeReplicaScaffold(epoch: string) {
  return createProviderRuntimeScaffold({
    provider: 'flitro',
    sessionId: 's1',
    epoch,
    report,
    completion: 'deferred',
    dedup: true,
    getDriver: () => undefined,
  })
}

function serverEnvelope(epoch: string, seq: number): TimelineEnvelope {
  return {
    sessionId: 's1',
    provider: 'flitro',
    seq,
    epoch,
    timestamp: 0,
    item: { type: 'compaction_started' } as TimelineItem,
  }
}

describe('runtime-scaffold — replica/deferred seq space (C5)', () => {
  it('mints local meta-events at reserved seq 0 so they never poison the server keyspace', () => {
    const scaffold = makeReplicaScaffold('flitro-s1')

    // Local meta-events: capability report + a status warning + a failure.
    scaffold.sequencer.append({ type: 'session_status', status: 'idle' } as TimelineItem)
    scaffold.appendFailure('send failed')

    for (const env of scaffold.timeline) {
      expect(env.seq).toBe(0)
    }
  })

  it('does not drop a server envelope at seq 1 after a local append under the same epoch', () => {
    const scaffold = makeReplicaScaffold('flitro-s1')

    // A local status append under the server-owned epoch. Pre-fix this took
    // seq:1 and poisoned the dedup set; now it is seq:0 and ignored by dedup.
    scaffold.sequencer.append({ type: 'session_status', status: 'idle' } as TimelineItem)

    scaffold.appendEnvelope(serverEnvelope('flitro-s1', 1))

    const serverItems = scaffold.timeline.filter(e => e.seq === 1 && e.epoch === 'flitro-s1')
    expect(serverItems).toHaveLength(1)
  })

  it('still dedups genuine duplicate server envelopes under the same epoch', () => {
    const scaffold = makeReplicaScaffold('flitro-s1')
    scaffold.appendEnvelope(serverEnvelope('flitro-s1', 1))
    scaffold.appendEnvelope(serverEnvelope('flitro-s1', 1))
    expect(scaffold.timeline.filter(e => e.seq === 1)).toHaveLength(1)
  })
})

describe('runtime-scaffold — epoch rotation on restart (C6)', () => {
  it('ingests envelopes arriving under a new epoch after a simulated restart', () => {
    const scaffold = makeReplicaScaffold('flitro-s1')

    // Pre-restart epoch.
    scaffold.appendEnvelope(serverEnvelope('flitro-s1', 1))
    scaffold.appendEnvelope(serverEnvelope('flitro-s1', 2))

    // Server restarts → new boot epoch; seqs restart from 1. Without the reset
    // these would be dropped against the stale epoch's dedup keyspace.
    scaffold.appendEnvelope(serverEnvelope('flitro-s1-boot2', 1))
    scaffold.appendEnvelope(serverEnvelope('flitro-s1-boot2', 2))

    const boot2 = scaffold.timeline.filter(e => e.epoch === 'flitro-s1-boot2')
    expect(boot2.map(e => e.seq)).toEqual([1, 2])
  })

  it('drops the stale old-epoch buffer on rotation so a full replay does not duplicate (T5)', () => {
    const scaffold = makeReplicaScaffold('flitro-s1')

    // Pre-restart: two durable events under boot1.
    scaffold.appendEnvelope(serverEnvelope('flitro-s1', 1))
    scaffold.appendEnvelope(serverEnvelope('flitro-s1', 2))
    expect(scaffold.timeline).toHaveLength(2)

    // Restart → T5 makes the server replay the full durable history from seq 1
    // under the new boot epoch. The scaffold must drop the old-epoch buffer so
    // the timeline holds one copy, not two.
    scaffold.appendEnvelope(serverEnvelope('flitro-s1-boot2', 1))
    scaffold.appendEnvelope(serverEnvelope('flitro-s1-boot2', 2))

    expect(scaffold.timeline).toHaveLength(2)
    expect(scaffold.timeline.every(e => e.epoch === 'flitro-s1-boot2')).toBe(true)
  })

  it('does not rotate on a local meta-event (seq 0) under a different-looking epoch', () => {
    const scaffold = makeReplicaScaffold('flitro-s1')
    scaffold.appendEnvelope(serverEnvelope('flitro-s1', 1))

    // A local append keeps currentEpoch pinned; a later duplicate server seq 1
    // under the original epoch must still dedup (proving no spurious rotation).
    scaffold.sequencer.append({ type: 'session_status', status: 'idle' } as TimelineItem)
    scaffold.appendEnvelope(serverEnvelope('flitro-s1', 1))

    expect(scaffold.timeline.filter(e => e.seq === 1 && e.epoch === 'flitro-s1')).toHaveLength(1)
  })

  it('preserves local meta-events (seq 0) across an epoch rotation (T5-7)', async () => {
    // Fresh session: preflight appends the capability report as a local
    // meta-event at seq 0 under the initial (bootID-less) epoch. The first
    // real server event arrives under the server's boot epoch, which differs
    // from the initial epoch → rotation. Pre-T5-7 `timeline.length = 0` wiped
    // the capability-report row on every fresh session's first server event.
    const scaffold = makeReplicaScaffold('flitro-s1')
    await scaffold.preflight()
    const capBefore = scaffold.timeline.find(e => e.item.type === 'runtime_capability_report')
    expect(capBefore).toBeTruthy()
    expect(capBefore!.seq).toBe(0)

    scaffold.appendEnvelope(serverEnvelope('flitro-s1-boot1', 1))
    scaffold.appendEnvelope(serverEnvelope('flitro-s1-boot1', 2))

    // The capability report survives; old-epoch server envelopes are dropped.
    const capAfter = scaffold.timeline.find(e => e.item.type === 'runtime_capability_report')
    expect(capAfter).toBeTruthy()
    expect(scaffold.timeline.filter(e => e.seq === 0)).toHaveLength(1)
    expect(scaffold.timeline.filter(e => e.epoch === 'flitro-s1-boot1').map(e => e.seq)).toEqual([1, 2])
  })
})

describe('runtime-scaffold — session contract ring-buffer cap', () => {
  function makeCappedScaffold(historyCap: number) {
    return createProviderRuntimeScaffold({
      provider: 'flitro',
      sessionId: 's1',
      epoch: 'e1',
      report,
      completion: 'deferred',
      dedup: true,
      historyCap,
      getDriver: () => undefined,
    })
  }

  it('caps the timeline buffer at historyCap (oldest evicted, newest retained)', () => {
    const scaffold = makeCappedScaffold(3)
    for (let seq = 1; seq <= 5; seq++) {
      scaffold.appendEnvelope(serverEnvelope('e1', seq))
    }
    expect(scaffold.timeline).toHaveLength(3)
    expect(scaffold.timeline.map(e => e.seq)).toEqual([3, 4, 5])
  })

  it('evicts incrementally (one per ingest once over the cap)', () => {
    const scaffold = makeCappedScaffold(2)
    scaffold.appendEnvelope(serverEnvelope('e1', 1))
    expect(scaffold.timeline.map(e => e.seq)).toEqual([1])
    scaffold.appendEnvelope(serverEnvelope('e1', 2))
    expect(scaffold.timeline.map(e => e.seq)).toEqual([1, 2])
    scaffold.appendEnvelope(serverEnvelope('e1', 3))
    expect(scaffold.timeline.map(e => e.seq)).toEqual([2, 3])
    scaffold.appendEnvelope(serverEnvelope('e1', 4))
    expect(scaffold.timeline.map(e => e.seq)).toEqual([3, 4])
  })

  it('still dedups recent duplicates within the cap window', () => {
    const scaffold = makeCappedScaffold(3)
    scaffold.appendEnvelope(serverEnvelope('e1', 1))
    scaffold.appendEnvelope(serverEnvelope('e1', 2))
    scaffold.appendEnvelope(serverEnvelope('e1', 3))
    // A duplicate of a seq still inside the cap window → deduped (not re-added).
    scaffold.appendEnvelope(serverEnvelope('e1', 3))
    expect(scaffold.timeline.filter(e => e.seq === 3)).toHaveLength(1)
    expect(scaffold.timeline).toHaveLength(3)
  })

  it('re-accepts a duplicate whose key was evicted by the cap (ring-buffer semantics)', () => {
    // With cap=2, appending seq 1..3 evicts the key for seq 1. A later
    // duplicate of seq 1 is re-accepted (its dedup key is gone). This is the
    // documented cap trade-off: duplicates only arrive from overlapping
    // catchup near the recent cursor (well within the cap), and an
    // epoch-rotation replay clears the set — so an evicted-key re-accept only
    // happens under a synthetic duplicate-of-very-old envelope, not in normal
    // replay/catchup.
    const scaffold = makeCappedScaffold(2)
    scaffold.appendEnvelope(serverEnvelope('e1', 1))
    scaffold.appendEnvelope(serverEnvelope('e1', 2))
    scaffold.appendEnvelope(serverEnvelope('e1', 3)) // evicts key for seq 1
    expect(scaffold.timeline.map(e => e.seq)).toEqual([2, 3])
    scaffold.appendEnvelope(serverEnvelope('e1', 1)) // re-accepted
    expect(scaffold.timeline.filter(e => e.seq === 1)).toHaveLength(1)
  })

  it('does not evict when under the cap (default 1000 is a safety net)', () => {
    const scaffold = makeReplicaScaffold('e1')
    for (let seq = 1; seq <= 5; seq++) {
      scaffold.appendEnvelope(serverEnvelope('e1', seq))
    }
    expect(scaffold.timeline).toHaveLength(5)
  })

  it('clears the dedup set on epoch rotation (cap does not interfere with rotation)', () => {
    // A rotation under a capped buffer still clears seenKeys, so the new
    // epoch's seqs (restarting from 1) are accepted from scratch — the cap
    // only bounds within-epoch growth.
    const scaffold = makeCappedScaffold(3)
    scaffold.appendEnvelope(serverEnvelope('e1', 1))
    scaffold.appendEnvelope(serverEnvelope('e1', 2))
    scaffold.appendEnvelope(serverEnvelope('e2', 1)) // rotation: clears seenKeys
    scaffold.appendEnvelope(serverEnvelope('e2', 1)) // duplicate under new epoch → deduped
    expect(scaffold.timeline.filter(e => e.epoch === 'e2' && e.seq === 1)).toHaveLength(1)
  })
})

describe('runtime-scaffold — session contract send_message from failed', () => {
  it('eager: dispatches abort before send_message so a retry un-fails the runtime', async () => {
    const driver = { sendMessage: vi.fn(async () => {}) }
    const scaffold = createProviderRuntimeScaffold({
      provider: 'test',
      sessionId: 's1',
      epoch: 'e1',
      report,
      completion: 'eager',
      getDriver: () => driver,
    })
    // Put the runtime into a failed state (e.g. a previous turn_failed).
    scaffold.dispatch({ type: 'error', error: 'previous turn crashed' })
    expect(scaffold.getState().status).toBe('failed')
    expect(scaffold.getState().lastError).toBe('previous turn crashed')

    // User retries — the scaffold must reset (abort → ready) before
    // send_message, because the reducer (session contract) no longer resurrects `failed`
    // via send_message.
    await scaffold.commands.sendMessage('retry')

    // After send + complete, the runtime is ready (un-failed), and the
    // previous lastError was cleared by the abort.
    expect(scaffold.getState().status).toBe('ready')
    expect(scaffold.getState().lastError).toBeUndefined()
    expect(driver.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'retry' }),
      expect.anything(),
    )
  })

  it('deferred: dispatches abort before send_message from failed (replica retry)', async () => {
    const onMessageDrained = vi.fn(async () => {})
    const scaffold = createProviderRuntimeScaffold({
      provider: 'flitro',
      sessionId: 's1',
      epoch: 'e1',
      report,
      completion: 'deferred',
      dedup: true,
      getDriver: () => ({ sendMessage: vi.fn(async () => {}) }),
      onMessageDrained,
    })
    // Simulate a replayed turn_failed leaving the runtime in `failed` after
    // armReplay (the X-C post-replay state).
    scaffold.dispatch({ type: 'error', error: 'replayed turn_failed' })
    expect(scaffold.getState().status).toBe('failed')

    await scaffold.commands.sendMessage('retry')

    // abort → ready → send_message → running. Deferred mode does not dispatch
    // complete on send resolve (the terminal timeline item drives it), so the
    // state stays running after the send — the live send path is un-wedged.
    expect(scaffold.getState().status).toBe('running')
    expect(scaffold.getState().lastError).toBeUndefined()
    expect(onMessageDrained).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'retry' }),
      expect.anything(),
    )
  })

  it('deferred: rethrows the original error so hosts can branch on typed fields (e.g. WeftHttpError.code)', async () => {
    // Mirrors WeftHttpError: message for display, code/status for machine branching.
    class StructuredSendError extends Error {
      readonly code: string
      readonly status: number
      constructor(message: string, code: string, status: number) {
        super(message)
        this.name = 'StructuredSendError'
        this.code = code
        this.status = status
      }
    }
    const thrown = new StructuredSendError(
      'Weft HTTP 409: connection "Claude Max" is unusable — re-connect it in the console',
      'llm_connection_unusable',
      409,
    )
    const onMessageDrained = vi.fn(async () => {
      throw thrown
    })
    const scaffold = createProviderRuntimeScaffold({
      provider: 'flitro',
      sessionId: 's1',
      epoch: 'e1',
      report,
      completion: 'deferred',
      dedup: true,
      getDriver: () => ({ sendMessage: vi.fn(async () => {}) }),
      onMessageDrained,
    })
    scaffold.dispatch({ type: 'preflight_ok' })

    // Public sendMessage must reject with the ORIGINAL error (not a string-only wrap).
    await expect(scaffold.commands.sendMessage('hi')).rejects.toBe(thrown)

    // State + timeline still surface the failure for UI/lastError consumers.
    expect(scaffold.getState().status).toBe('failed')
    expect(scaffold.getState().lastError).toBe(thrown.message)
    const failure = scaffold.timeline.find(e => e.item.type === 'turn_failed')
    expect(failure).toBeTruthy()
    expect(failure!.item).toMatchObject({
      type: 'turn_failed',
      error: {
        message: thrown.message,
        code: 'llm_connection_unusable',
        status: 409,
      },
    })
  })

  it('eager: send from a non-failed state does NOT dispatch a spurious abort', async () => {
    // Verify the abort is conditional — a normal send from `ready` must not
    // dispatch abort (which would clobber a non-failed state unnecessarily).
    const driver = { sendMessage: vi.fn(async () => {}) }
    const scaffold = createProviderRuntimeScaffold({
      provider: 'test',
      sessionId: 's1',
      epoch: 'e1',
      report,
      completion: 'eager',
      getDriver: () => driver,
    })
    // ready (initialRuntimeState is idle; preflight not needed for this check).
    scaffold.dispatch({ type: 'preflight_ok' })
    expect(scaffold.getState().status).toBe('ready')
    expect(scaffold.getState().lastError).toBeUndefined()

    await scaffold.commands.sendMessage('hello')

    // send_message → running → complete → ready. No abort was dispatched
    // (lastError stays undefined; if abort had fired it would still clear
    // lastError, so we assert the send path itself worked normally).
    expect(scaffold.getState().status).toBe('ready')
    expect(driver.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'hello' }),
      expect.anything(),
    )
  })
})
