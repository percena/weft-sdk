import { describe, expect, test } from 'vitest'

import {
  createAutomationSchedulerHost,
  createInMemoryAutomationHistoryStore,
  createAutomationTimelineBridge,
  createRuntimeAutomationBridge,
  createAutomationRuntimeGuard,
  executeAutomationPrompt,
  projectTimelineEnvelopeToAutomationInput,
  type PendingPrompt,
} from '@weft/automations'
import {
  createRuntimeCapabilityReport,
  type AgentRuntime,
  type SendMessageOptions,
} from '@weft/runtime-core'
import type { TimelineEnvelope } from '@weft/timeline'

function createRuntimeSpy() {
  const sends: Array<{ message: string; options?: SendMessageOptions }> = []
  const runtime: AgentRuntime = {
    sessionId: 'session-a',
    provider: 'codex',
    runtimeKind: 'app-server',
    events: {
      connect() {},
      disconnect() {},
      isConnected() {
        return false
      },
    },
    commands: {
      async sendMessage(message, options) {
        sends.push({ message, options })
      },
      async abort() {},
      async respondToPermission() {},
      async dispose() {},
    },
    async preflight() {
      return createRuntimeCapabilityReport({
        provider: 'codex',
        candidates: [{ kind: 'app-server', available: true }],
        auth: { mode: 'provider-owned', configured: true, source: 'test' },
      })
    },
    async fetchTimeline() {
      return {
        items: [],
        nextCursor: { epoch: 'epoch-a', afterSeq: 0 },
        hasGap: false,
      }
    },
    getState() {
      return {
        status: 'ready',
        acceptedMessages: [],
        queuedMessages: [],
      }
    },
  }

  return { runtime, sends }
}

const prompt: PendingPrompt = {
  sessionId: 'session-a',
  matcherId: 'daily-review',
  automationName: 'Daily Review',
  prompt: 'Summarize the workspace state',
  mentions: ['github'],
  labels: ['automation'],
  permissionMode: 'ask',
}

describe('Automations — runtime command bridge', () => {
  test('executes prompt actions through runtime command sink with automation origin metadata', async () => {
    const { runtime, sends } = createRuntimeSpy()

    const result = await executeAutomationPrompt({ runtime, prompt })

    expect(sends).toEqual([
      {
        message: 'Summarize the workspace state',
        options: {
          commandOrigin: { type: 'automation', id: 'daily-review' },
          permissionMode: 'ask',
        },
      },
    ])
    expect(result.timelineItems).toEqual([
      {
        type: 'automation_triggered',
        automation: {
          automationId: 'daily-review',
          origin: { type: 'automation', id: 'daily-review' },
          detail: {
            name: 'Daily Review',
            mentions: ['github'],
            labels: ['automation'],
            permissionMode: 'ask',
          },
        },
      },
      {
        type: 'automation_action_result',
        result: {
          type: 'prompt',
          automationId: 'daily-review',
          success: true,
          sessionId: 'session-a',
        },
      },
    ])
  })

  test('loop guard blocks duplicate prompt dispatch for the same runtime session and matcher', async () => {
    const { runtime, sends } = createRuntimeSpy()
    const guard = createAutomationRuntimeGuard()

    const first = await executeAutomationPrompt({ runtime, prompt, guard })
    const second = await executeAutomationPrompt({ runtime, prompt, guard })

    expect(first.skipped).toBe(false)
    expect(second.skipped).toBe(true)
    expect(sends).toHaveLength(1)
    expect(second.timelineItems.at(-1)).toEqual({
      type: 'automation_action_result',
      result: {
        type: 'prompt',
        automationId: 'daily-review',
        success: false,
        sessionId: 'session-a',
        skipped: true,
        reason: 'automation loop guard blocked duplicate prompt dispatch',
      },
    })
  })

  test('projects canonical timeline items into automation input events', () => {
    const permission = projectTimelineEnvelopeToAutomationInput(envelope({
      type: 'permission_requested',
      request: {
        requestId: 'permission-1',
        toolName: 'Bash',
        reason: 'ask first',
      },
    }))
    const host = projectTimelineEnvelopeToAutomationInput(envelope({
      type: 'host_state_changed',
      state: {
        kind: 'session_metadata',
        sessionId: 'session-a',
        status: 'needs-review',
        labels: ['scheduled'],
      },
    }))
    const source = projectTimelineEnvelopeToAutomationInput(envelope({
      type: 'source_state_changed',
      source: { sourceSlug: 'github', state: 'needs_auth' },
    }))
    const skill = projectTimelineEnvelopeToAutomationInput(envelope({
      type: 'skill_activated',
      skill: { skillSlug: 'review' },
    }))

    expect(permission).toEqual([{
      event: 'PermissionRequest',
      source: 'timeline',
      sessionId: 'session-a',
      matchValue: 'Bash',
      payload: {
        requestId: 'permission-1',
        toolName: 'Bash',
        reason: 'ask first',
      },
      timestamp: 1_000,
    }])
    expect(host).toEqual([
      {
        event: 'SessionStatusChange',
        source: 'host',
        sessionId: 'session-a',
        matchValue: 'needs-review',
        payload: {
          kind: 'session_metadata',
          sessionId: 'session-a',
          status: 'needs-review',
          labels: ['scheduled'],
        },
        timestamp: 1_000,
      },
      {
        event: 'LabelAdd',
        source: 'host',
        sessionId: 'session-a',
        matchValue: 'scheduled',
        payload: {
          kind: 'session_metadata',
          sessionId: 'session-a',
          status: 'needs-review',
          labels: ['scheduled'],
        },
        timestamp: 1_000,
      },
    ])
    expect(source[0]).toMatchObject({
      event: 'SourceStateChange',
      source: 'source',
      sessionId: 'session-a',
      matchValue: 'github',
    })
    expect(skill[0]).toMatchObject({
      event: 'SkillActivated',
      source: 'skill',
      sessionId: 'session-a',
      matchValue: 'review',
    })
  })

  test('automation timeline bridge publishes projected events', () => {
    const published: unknown[] = []
    const bridge = createAutomationTimelineBridge({
      publish(event) {
        published.push(event)
      },
    })

    bridge.handleTimelineEnvelope(envelope({
      type: 'permission_requested',
      request: {
        requestId: 'permission-2',
        toolName: 'Write',
      },
    }))

    expect(published).toEqual([{
      event: 'PermissionRequest',
      source: 'timeline',
      sessionId: 'session-a',
      matchValue: 'Write',
      payload: {
        requestId: 'permission-2',
        toolName: 'Write',
      },
      timestamp: 1_000,
    }])
  })

  test('runtime automation bridge subscribes to timeline events and dispatches pending prompts', async () => {
    const { runtime, sends } = createRuntimeSpy()
    let onRuntimeEvent: ((event: TimelineEnvelope) => void) | undefined
    runtime.events.connect = (onEvent) => {
      onRuntimeEvent = onEvent
    }
    const published: unknown[] = []
    const emittedTimelineItems: unknown[] = []

    const bridge = createRuntimeAutomationBridge({
      runtime,
      publish(event) {
        published.push(event)
      },
      emitTimelineItem(item) {
        emittedTimelineItems.push(item)
      },
    })

    expect(runtime.events.isConnected()).toBe(false)
    onRuntimeEvent?.(envelope({
      type: 'permission_requested',
      request: {
        requestId: 'permission-3',
        toolName: 'Bash',
      },
    }))
    await bridge.handlePromptsReady([prompt])

    expect(published).toEqual([{
      event: 'PermissionRequest',
      source: 'timeline',
      sessionId: 'session-a',
      matchValue: 'Bash',
      payload: {
        requestId: 'permission-3',
        toolName: 'Bash',
      },
      timestamp: 1_000,
    }])
    expect(sends).toEqual([{
      message: 'Summarize the workspace state',
      options: {
        commandOrigin: { type: 'automation', id: 'daily-review' },
        permissionMode: 'ask',
      },
    }])
    expect(emittedTimelineItems).toHaveLength(2)
    expect(emittedTimelineItems[0]).toMatchObject({
      type: 'automation_triggered',
      automation: {
        automationId: 'daily-review',
      },
    })

    bridge.dispose()
  })

  test('runtime automation bridge records matcher output into automation history store', async () => {
    const { runtime } = createRuntimeSpy()
    const history = createInMemoryAutomationHistoryStore({ now: () => 8_000 })

    const bridge = createRuntimeAutomationBridge({
      runtime,
      publish() {},
      historyStore: history,
    })

    await bridge.handlePromptsReady([prompt])

    expect(await history.list({ matcherId: 'daily-review' })).toEqual([
      {
        recordId: 'automation-history:1',
        matcherId: 'daily-review',
        automationName: 'Daily Review',
        sessionId: 'session-a',
        actionType: 'prompt',
        status: 'success',
        skipped: false,
        attempt: 1,
        timestamp: 8_000,
        promptPreview: 'Summarize the workspace state',
        timelineItemCount: 2,
      },
    ])
    expect(await history.getLastExecuted('daily-review')).toMatchObject({
      matcherId: 'daily-review',
      timestamp: 8_000,
    })

    bridge.dispose()
  })

  test('automation scheduler host exposes explicit lifecycle receipts and scheduler tick events', async () => {
    const published: unknown[] = []
    const scheduler = createAutomationSchedulerHost({
      now: () => 9_000,
      publish(event) {
        published.push(event)
      },
    })

    expect(scheduler.start({
      schedulerId: 'scheduler-daily',
      workspaceId: 'workspace-a',
      cron: '0 9 * * *',
      timezone: 'Asia/Shanghai',
    })).toEqual({
      schedulerId: 'scheduler-daily',
      workspaceId: 'workspace-a',
      state: 'started',
      cron: '0 9 * * *',
      timezone: 'Asia/Shanghai',
      timestamp: 9_000,
    })

    scheduler.tick('scheduler-daily', { reason: 'manual-test' })
    expect(published).toEqual([
      {
        event: 'SchedulerTick',
        source: 'host',
        sessionId: 'workspace-a',
        matchValue: 'scheduler-daily',
        payload: {
          schedulerId: 'scheduler-daily',
          workspaceId: 'workspace-a',
          cron: '0 9 * * *',
          timezone: 'Asia/Shanghai',
          reason: 'manual-test',
        },
        timestamp: 9_000,
      },
    ])
    expect(scheduler.stop('scheduler-daily')).toMatchObject({
      schedulerId: 'scheduler-daily',
      state: 'stopped',
      timestamp: 9_000,
    })
    expect(scheduler.getSnapshot().schedules).toHaveLength(0)
  })
})

function envelope(item: TimelineEnvelope['item']): TimelineEnvelope {
  return {
    sessionId: 'session-a',
    provider: 'codex',
    epoch: 'epoch-a',
    seq: 1,
    timestamp: 1_000,
    item,
  }
}
