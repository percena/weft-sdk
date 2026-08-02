import { describe, expect, test, vi } from 'vitest'

import type { WeftHttpClient } from '../client/index.ts'
import { createFlitroDriver } from '../runtime-driver.ts'

/**
 * tkt-45: the Flitro runtime-driver must forward `budget` through to
 * `WeftHttpClient.createRun` — both the session-level default
 * (`CreateFlitroDriverOptions.budget`) and the per-message override
 * (`ProviderRuntimeDriverInput.options.budget`). Before the fix, the
 * driver forwarded model/skillNames/mcpServerNames/permissionMode but
 * dropped `budget` entirely, so hosts had no client-side way to set a
 * run budget for long agentic flows.
 */

function mockClient() {
  return {
    createRun: vi.fn().mockResolvedValue({ run_id: 'run-1', session_id: 'sess-1', status: 'queued' }),
    cancelRun: vi.fn().mockResolvedValue(undefined),
  } as unknown as WeftHttpClient
}

// A no-op sequencer — sendMessage stores the active run id but doesn't use
// the sequencer for anything in this test.
const sequencer = {} as never

describe('createFlitroDriver — budget forwarding (tkt-45)', () => {
  test('forwards per-message budget to createRun', async () => {
    const client = mockClient()
    const driver = createFlitroDriver({ client, sessionId: 'sess-1' })

    await driver.sendMessage(
      { message: 'hi', options: { budget: { maxWallTimeSec: 600, maxSteps: 32 } } },
      sequencer,
    )

    expect(client.createRun).toHaveBeenCalledTimes(1)
    const [, , opts] = client.createRun.mock.calls[0] as [string, string, Record<string, unknown>]
    expect(opts.budget).toEqual({ maxSteps: 32, maxTokens: undefined, maxWallTimeSec: 600 })
  })

  test('forwards session-level budget when no per-message budget is set', async () => {
    const client = mockClient()
    const driver = createFlitroDriver({
      client,
      sessionId: 'sess-1',
      budget: { maxWallTimeSec: 600 },
    })

    await driver.sendMessage({ message: 'hi' }, sequencer)

    const [, , opts] = client.createRun.mock.calls[0] as [string, string, Record<string, unknown>]
    expect(opts.budget).toEqual({ maxSteps: undefined, maxTokens: undefined, maxWallTimeSec: 600 })
  })

  test('per-message budget wins over session-level default', async () => {
    const client = mockClient()
    const driver = createFlitroDriver({
      client,
      sessionId: 'sess-1',
      budget: { maxWallTimeSec: 300 },
    })

    await driver.sendMessage(
      { message: 'hi', options: { budget: { maxWallTimeSec: 900 } } },
      sequencer,
    )

    const [, , opts] = client.createRun.mock.calls[0] as [string, string, Record<string, unknown>]
    expect(opts.budget).toEqual({ maxSteps: undefined, maxTokens: undefined, maxWallTimeSec: 900 })
  })

  test('omits budget key entirely when neither session nor per-message budget is set', async () => {
    const client = mockClient()
    const driver = createFlitroDriver({ client, sessionId: 'sess-1' })

    await driver.sendMessage({ message: 'hi' }, sequencer)

    const [, , opts] = client.createRun.mock.calls[0] as [string, string, Record<string, unknown>]
    expect(opts.budget).toBeUndefined()
    // Other forwarding is unchanged
    expect(opts.model).toBeUndefined()
    expect(opts.permissionMode).toBeUndefined()
  })

  test('existing permissionMode forwarding is unchanged', async () => {
    const client = mockClient()
    const driver = createFlitroDriver({
      client,
      sessionId: 'sess-1',
      permissionMode: 'ask',
    })

    await driver.sendMessage(
      { message: 'hi', options: { permissionMode: 'auto' } },
      sequencer,
    )

    const [, , opts] = client.createRun.mock.calls[0] as [string, string, Record<string, unknown>]
    expect(opts.permissionMode).toBe('auto')
  })
})
