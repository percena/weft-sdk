import { describe, expect, it } from 'vitest'
import { createRuntimeCapabilityReport, type RuntimeAuthDetection } from '@weft/runtime-core'
import {
  createProviderRuntimeScaffold,
  type ProviderRuntimeDriver,
  type ProviderRuntimeDriverInput,
} from '../runtime-scaffold.ts'

const auth: RuntimeAuthDetection = { mode: 'provider-owned', configured: true, source: 'test' }

function createReport() {
  return createRuntimeCapabilityReport({
    provider: 'claude',
    candidates: [{ kind: 'native-sdk', available: true }],
    preferredRuntime: 'native-sdk',
    auth,
  })
}

/** A driver whose turns complete only when the test releases them, and which
 *  records how many turns ran concurrently (A2 regression guard). */
function createControlledDriver() {
  const started: Array<{ input: ProviderRuntimeDriverInput; release: () => void }> = []
  let active = 0
  let maxActive = 0
  const driver: ProviderRuntimeDriver = {
    async sendMessage(input, sequencer) {
      active += 1
      maxActive = Math.max(maxActive, active)
      const turnId = input.options?.turnId ?? `turn-${started.length + 1}`
      sequencer.append({ type: 'turn_started', turnId })
      await new Promise<void>((resolve) => {
        started.push({ input, release: resolve })
      })
      sequencer.append({ type: 'turn_completed', turnId })
      active -= 1
    },
  }
  return {
    driver,
    started,
    get maxActive() { return maxActive },
    releaseNext() { started[0]?.release() },
    release(index: number) { started[index].release() },
  }
}

async function flush(): Promise<void> {
  // Drain enqueued microtasks + the fire-and-forget drain chain.
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

describe('eager-mode send queueing (A2)', () => {
  it('queues a send while a turn is running instead of racing a second query loop', async () => {
    const controlled = createControlledDriver()
    const scaffold = createProviderRuntimeScaffold({
      provider: 'claude',
      sessionId: 'eager-queue-test',
      report: createReport(),
      getDriver: () => controlled.driver,
    })

    const first = scaffold.commands.sendMessage('m1')
    await flush()
    expect(controlled.started).toHaveLength(1)
    expect(scaffold.getState().status).toBe('running')

    // Second send while running: must queue, not start a concurrent turn.
    const second = scaffold.commands.sendMessage('m2')
    await second // resolves on accept (queued), not on turn completion
    await flush()
    expect(controlled.started).toHaveLength(1)
    expect(scaffold.getState().queuedMessages).toEqual(['m2'])
    expect(controlled.maxActive).toBe(1)

    // Completing turn 1 drains the queue and starts turn 2.
    controlled.release(0)
    await first
    await flush()
    expect(controlled.started).toHaveLength(2)
    expect(controlled.started[1].input.message).toBe('m2')
    expect(controlled.maxActive).toBe(1)
    expect(scaffold.getState().status).toBe('running')
    expect(scaffold.getState().queuedMessages).toEqual([])
    expect(scaffold.getState().acceptedMessages).toEqual(['m1', 'm2'])

    controlled.release(1)
    await flush()
    expect(scaffold.getState().status).toBe('ready')
  })

  it('abort clears queued eager sends', async () => {
    const controlled = createControlledDriver()
    const scaffold = createProviderRuntimeScaffold({
      provider: 'claude',
      sessionId: 'eager-abort-test',
      report: createReport(),
      getDriver: () => controlled.driver,
    })

    const first = scaffold.commands.sendMessage('m1')
    await flush()
    await scaffold.commands.sendMessage('m2')
    expect(scaffold.getState().queuedMessages).toEqual(['m2'])

    await scaffold.commands.abort('user cancel')
    expect(scaffold.getState().queuedMessages).toEqual([])

    // Completing the (aborted) first turn must not resurrect the queued send.
    controlled.release(0)
    await first.catch(() => {})
    await flush()
    expect(controlled.started).toHaveLength(1)
  })
})
