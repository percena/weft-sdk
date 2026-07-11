import { describe, expect, test } from 'vitest'

import {
  RUNTIME_KINDS,
  createRuntimeExtensionContext,
  createRuntimeCapabilityReport,
  initialRuntimeState,
  invokeSessionTool,
  reduceRuntimeState,
  sanitizeProviderSourceTools,
  selectRuntimeCandidate,
  type AgentTimelineStream,
  type AgentRuntime,
  type RuntimeCandidate,
  type SessionToolBridge,
  type ToolPolicyRequest,
} from '@weft/runtime-core'
import type { TimelineEnvelope } from '@weft/timeline'

describe('Runtime Core — capability selection', () => {
  test('exports stable runtime kind ordering', () => {
    expect(RUNTIME_KINDS).toEqual(['native-sdk', 'app-server', 'compatible-sdk', 'cli-fallback'])
  })

  test('selects native SDK first when no preference is provided', () => {
    const candidates: RuntimeCandidate[] = [
      { kind: 'cli-fallback', available: true },
      { kind: 'native-sdk', available: true },
    ]

    const selected = selectRuntimeCandidate({ candidates })

    expect(selected.selected).toBe('native-sdk')
    expect(selected.fallback).toBe(false)
  })

  test('selects app-server first for Codex when fallbackKindOrder is provided', () => {
    const candidates: RuntimeCandidate[] = [
      { kind: 'cli-fallback', available: true },
      { kind: 'native-sdk', available: true },
      { kind: 'app-server', available: true },
    ]

    const selected = selectRuntimeCandidate({
      provider: 'codex',
      candidates,
      fallbackKindOrder: ['app-server', 'native-sdk', 'compatible-sdk', 'cli-fallback'],
    })

    expect(selected.selected).toBe('app-server')
    expect(selected.fallback).toBe(false)
  })

  test('requires explicit fallback permission when preferred runtime is unavailable', () => {
    const report = createRuntimeCapabilityReport({
      provider: 'claude',
      candidates: [
        { kind: 'native-sdk', available: false, reason: 'Claude SDK not installed' },
        { kind: 'cli-fallback', available: true },
      ],
      preferredRuntime: 'native-sdk',
      allowFallback: false,
      auth: {
        mode: 'provider-owned',
        configured: true,
        source: 'test',
      },
    })

    expect(report.selected).toBeUndefined()
    expect(report.fallback).toBe(false)
    expect(report.error).toContain('Claude SDK not installed')
  })

  test('marks fallback explicitly when preferred runtime is unavailable but fallback is allowed', () => {
    const report = createRuntimeCapabilityReport({
      provider: 'codex',
      candidates: [
        { kind: 'native-sdk', available: false, reason: 'Codex app-server streaming unavailable' },
        { kind: 'cli-fallback', available: true },
      ],
      preferredRuntime: 'native-sdk',
      allowFallback: true,
      auth: {
        mode: 'provider-owned',
        configured: true,
        source: 'test',
      },
    })

    expect(report.selected).toBe('cli-fallback')
    expect(report.fallback).toBe(true)
    expect(report.fallbackReason).toContain('Codex app-server streaming unavailable')
  })

  test('reports extension capability degradation explicitly', () => {
    const report = createRuntimeCapabilityReport({
      provider: 'claude',
      candidates: [
        { kind: 'cli-fallback', available: true },
      ],
      preferredRuntime: 'native-sdk',
      allowFallback: true,
      auth: {
        mode: 'provider-owned',
        configured: true,
        source: 'test',
      },
      extensionCapabilities: {
        policy: {
          supported: true,
          degraded: true,
          modes: ['explore', 'ask'],
          approvals: false,
          toolPolicy: true,
          reason: 'CLI fallback cannot complete provider-native permission callbacks',
        },
        sources: {
          supported: false,
          reason: 'Source registry is not attached',
        },
        skills: {
          supported: false,
          reason: 'Skill registry is not attached',
        },
        automations: {
          supported: true,
          degraded: true,
          eventBus: true,
          schedulerHost: false,
          promptAction: true,
          webhookAction: false,
          reason: 'Scheduler host is unavailable in browser-safe runtime',
        },
        hostTools: {
          supported: true,
          degraded: true,
          sessionTools: true,
          workflowTransitions: true,
          browserActions: false,
          metadataWrites: true,
          reason: 'Browser actions require a desktop or VPS host service',
        },
      },
    })

    expect(report.policyCapabilities).toEqual({
      supported: true,
      degraded: true,
      modes: ['explore', 'ask'],
      approvals: false,
      toolPolicy: true,
      reason: 'CLI fallback cannot complete provider-native permission callbacks',
    })
    expect(report.sourceCapabilities.supported).toBe(false)
    expect(report.skillCapabilities.supported).toBe(false)
    expect(report.automationCapabilities).toEqual({
      supported: true,
      degraded: true,
      eventBus: true,
      schedulerHost: false,
      promptAction: true,
      webhookAction: false,
      reason: 'Scheduler host is unavailable in browser-safe runtime',
    })
    expect(report.hostToolCapabilities).toEqual({
      supported: true,
      degraded: true,
      sessionTools: true,
      workflowTransitions: true,
      browserActions: false,
      metadataWrites: true,
      reason: 'Browser actions require a desktop or VPS host service',
    })
  })

  test('normalizes provider-neutral extension context for policy, sources, skills, and command origin', () => {
    const context = createRuntimeExtensionContext({
      policy: { mode: 'explore' },
      sources: { enabledSourceSlugs: ['github', 'linear', 'github'] },
      skills: { activeSkillSlugs: ['review', 'review'] },
      commandOrigin: {
        type: 'automation',
        id: 'daily-review',
      },
    })

    expect(context).toEqual({
      policy: { mode: 'explore' },
      sources: { enabledSourceSlugs: ['github', 'linear'] },
      skills: { activeSkillSlugs: ['review'] },
      commandOrigin: {
        type: 'automation',
        id: 'daily-review',
      },
    })
  })

  test('preserves host-services session tool bridge and expanded command origins', () => {
    const sessionTools: SessionToolBridge = {
      async submitPlan(request) {
        return { accepted: true, planRef: request.planRef }
      },
      async updateSessionMetadata(request) {
        return { sessionId: request.sessionId, labels: request.labels ?? [] }
      },
    }

    const context = createRuntimeExtensionContext({
      hostServices: { sessionTools },
      commandOrigin: {
        type: 'scheduler',
        id: 'daily-review',
      },
    })

    expect(context.hostServices?.sessionTools).toBe(sessionTools)
    expect(context.commandOrigin).toEqual({
      type: 'scheduler',
      id: 'daily-review',
    })
  })

  test('invokes session tool bridge callbacks through policy and host timeline receipts', async () => {
    const timeline: TimelineEnvelope[] = []
    const sessionTools: SessionToolBridge = {
      async submitPlan(request) {
        return { accepted: true, planRef: request.planRef }
      },
    }
    const policyRequests: ToolPolicyRequest[] = []

    const receipt = await invokeSessionTool({
      sessionId: 'session-a',
      toolName: 'submitPlan',
      request: {
        sessionId: 'session-a',
        planRef: 'plans/plan.md',
        origin: { type: 'user', id: 'accept-plan' },
      },
      bridge: sessionTools,
      policy: async (request) => {
        policyRequests.push(request)
        return { decision: 'allow' }
      },
      appendTimeline(item) {
        const envelope: TimelineEnvelope = {
          sessionId: 'session-a',
          provider: 'host',
          epoch: 'epoch-a',
          seq: timeline.length + 1,
          timestamp: 1_000 + timeline.length,
          item,
        }
        timeline.push(envelope)
        return envelope
      },
    })

    expect(policyRequests).toEqual([
      {
        toolName: 'host.submitPlan',
        input: {
          sessionId: 'session-a',
          planRef: 'plans/plan.md',
          origin: { type: 'user', id: 'accept-plan' },
        },
        toolIntent: { kind: 'unknown', toolName: 'host.submitPlan' },
        scope: { type: 'session', sessionId: 'session-a' },
      },
    ])
    expect(receipt).toMatchObject({
      ok: true,
      toolName: 'submitPlan',
      origin: { type: 'user', id: 'accept-plan' },
      policyDecision: { decision: 'allow' },
      result: { accepted: true, planRef: 'plans/plan.md' },
    })
    expect(receipt.timelineRefs).toEqual([
      { epoch: 'epoch-a', seq: 1 },
      { epoch: 'epoch-a', seq: 2 },
    ])
    expect(timeline.map(item => item.item)).toEqual([
      {
        type: 'host_state_changed',
        state: {
          kind: 'host_tool_invoked',
          requestId: receipt.requestId,
          toolName: 'submitPlan',
          origin: { type: 'user', id: 'accept-plan' },
        },
      },
      {
        type: 'host_state_changed',
        state: {
          kind: 'host_tool_result',
          requestId: receipt.requestId,
          toolName: 'submitPlan',
          ok: true,
        },
      },
    ])
  })

  test('does not invoke denied session tool bridge callbacks', async () => {
    let called = false
    const timeline: TimelineEnvelope[] = []
    const receipt = await invokeSessionTool({
      sessionId: 'session-a',
      toolName: 'runBrowserAction',
      request: { sessionId: 'session-a', action: 'open', input: { url: 'https://example.com' } },
      bridge: {
        async runBrowserAction() {
          called = true
          return { ok: true }
        },
      },
      policy: async () => ({ decision: 'deny', reason: 'browser disabled' }),
      appendTimeline(item) {
        const envelope: TimelineEnvelope = {
          sessionId: 'session-a',
          provider: 'host',
          epoch: 'epoch-a',
          seq: timeline.length + 1,
          timestamp: 1_000,
          item,
        }
        timeline.push(envelope)
        return envelope
      },
    })

    expect(called).toBe(false)
    expect(receipt).toMatchObject({
      ok: false,
      toolName: 'runBrowserAction',
      policyDecision: { decision: 'deny', reason: 'browser disabled' },
      reason: 'browser disabled',
    })
    expect(timeline.map(item => item.item)).toEqual([
      {
        type: 'host_state_changed',
        state: {
          kind: 'host_tool_denied',
          requestId: receipt.requestId,
          toolName: 'runBrowserAction',
          reason: 'browser disabled',
        },
      },
    ])
  })

  test('policy hook requests carry structured permission scopes', () => {
    const request: ToolPolicyRequest = {
      toolName: 'Write',
      input: { file_path: 'CHANGELOG.md' },
      scope: { type: 'session', sessionId: 'session-a' },
    }

    expect(request.scope).toEqual({ type: 'session', sessionId: 'session-a' })
  })

  test('sanitizes credential-bearing source headers before provider runtimes receive descriptors', () => {
    const sanitized = sanitizeProviderSourceTools([
      {
        kind: 'api-source',
        sourceSlug: 'github',
        baseUrl: 'https://api.github.com',
        authType: 'bearer',
        defaultHeaders: {
          Authorization: 'Bearer secret-value',
          'X-Api-Key': 'secret-value',
          Accept: 'application/json',
        },
      },
      {
        kind: 'mcp-server',
        sourceSlug: 'linear',
        transport: 'http',
        url: 'https://mcp.example.com',
        headers: {
          Cookie: 'session=secret-value',
          'X-Trace': 'trace-1',
        },
      },
    ])

    expect(sanitized).toEqual([
      {
        kind: 'api-source',
        sourceSlug: 'github',
        baseUrl: 'https://api.github.com',
        authType: 'bearer',
        defaultHeaders: {
          Accept: 'application/json',
        },
      },
      {
        kind: 'mcp-server',
        sourceSlug: 'linear',
        transport: 'http',
        url: 'https://mcp.example.com',
        headers: {
          'X-Trace': 'trace-1',
        },
      },
    ])
    expect(JSON.stringify(sanitized)).not.toContain('secret-value')
  })

  test('runtime event stream and replay API are canonical timeline based', async () => {
    const envelope: TimelineEnvelope = {
      sessionId: 'session-a',
      provider: 'codex',
      epoch: 'epoch-a',
      seq: 1,
      timestamp: 1_000,
      item: { type: 'turn_started', turnId: 'turn-a' },
    }
    const received: TimelineEnvelope[] = []
    const stream: AgentTimelineStream = {
      connect(onEvent) {
        onEvent(envelope)
      },
      disconnect() {},
      isConnected() {
        return true
      },
    }
    const runtime: AgentRuntime = {
      sessionId: 'session-a',
      provider: 'codex',
      runtimeKind: 'app-server',
      events: stream,
      commands: {
        async sendMessage() {},
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
          items: [envelope],
          nextCursor: { epoch: 'epoch-a', afterSeq: 1 },
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

    runtime.events.connect(item => received.push(item))

    expect(received[0]?.item.type).toBe('turn_started')
    expect((await runtime.fetchTimeline({})).items).toEqual([envelope])
  })
})

describe('Runtime Core — state machine reducer', () => {
  test('initial state is idle with empty message queues', () => {
    expect(initialRuntimeState).toEqual({
      status: 'idle',
      acceptedMessages: [],
      queuedMessages: [],
    })
  })

  test('preflight transitions: idle → preflighting → ready', () => {
    const preflighting = reduceRuntimeState(initialRuntimeState, { type: 'preflight_start' })
    expect(preflighting.status).toBe('preflighting')
    expect(preflighting.lastError).toBeUndefined()

    const ready = reduceRuntimeState(preflighting, { type: 'preflight_ok' })
    expect(ready.status).toBe('ready')
    expect(ready.lastError).toBeUndefined()
  })

  test('preflight error transitions: idle → preflighting → failed', () => {
    const preflighting = reduceRuntimeState(initialRuntimeState, { type: 'preflight_start' })
    const failed = reduceRuntimeState(preflighting, { type: 'preflight_error', error: 'auth not configured' })
    expect(failed.status).toBe('failed')
    expect(failed.lastError).toBe('auth not configured')
  })

  test('send_message from ready transitions to running and accepts the message', () => {
    const running = reduceRuntimeState(initialRuntimeState, { type: 'send_message', message: 'inspect config' })
    expect(running.status).toBe('running')
    expect(running.acceptedMessages).toEqual(['inspect config'])
    expect(running.queuedMessages).toEqual([])
  })

  test('send_message while running enqueues rather than accepts', () => {
    const running = reduceRuntimeState(undefined, { type: 'send_message', message: 'first' })
    const queued = reduceRuntimeState(running, { type: 'send_message', message: 'second' })
    expect(running.status).toBe('running')
    expect(running.acceptedMessages).toEqual(['first'])
    expect(queued.queuedMessages).toEqual(['second'])
  })

  test('complete with empty queue transitions running → ready', () => {
    const running = reduceRuntimeState(undefined, { type: 'send_message', message: 'build' })
    const ready = reduceRuntimeState(running, { type: 'complete' })
    expect(ready.status).toBe('ready')
  })

  test('complete with queued messages drains queue and stays running', () => {
    const running = reduceRuntimeState(undefined, { type: 'send_message', message: 'first' })
    const queued = reduceRuntimeState(running, { type: 'send_message', message: 'second' })
    const drained = reduceRuntimeState(queued, { type: 'complete' })
    expect(drained.status).toBe('running')
    expect(drained.acceptedMessages).toEqual(['first', 'second'])
    expect(drained.queuedMessages).toEqual([])
  })

  test('permission request transitions running → waiting_for_permission', () => {
    const running = reduceRuntimeState(undefined, { type: 'send_message', message: 'write file' })
    const waiting = reduceRuntimeState(running, { type: 'permission_request', requestId: 'perm-1' })
    expect(waiting.status).toBe('waiting_for_permission')
    expect(waiting.waitingPermissionRequestId).toBe('perm-1')
  })

  test('permission response transitions waiting_for_permission → running', () => {
    const running = reduceRuntimeState(undefined, { type: 'send_message', message: 'write file' })
    const waiting = reduceRuntimeState(running, { type: 'permission_request', requestId: 'perm-1' })
    const resumed = reduceRuntimeState(waiting, { type: 'permission_response' })
    expect(resumed.status).toBe('running')
    expect(resumed.waitingPermissionRequestId).toBeUndefined()
  })

  test('abort clears queue and permission state, transitions to ready', () => {
    const running = reduceRuntimeState(undefined, { type: 'send_message', message: 'first' })
    const queued = reduceRuntimeState(running, { type: 'send_message', message: 'second' })
    const waiting = reduceRuntimeState(queued, { type: 'permission_request', requestId: 'perm-1' })
    const aborted = reduceRuntimeState(waiting, { type: 'abort', reason: 'user cancelled' })
    expect(aborted.status).toBe('ready')
    expect(aborted.queuedMessages).toEqual([])
    expect(aborted.waitingPermissionRequestId).toBeUndefined()
    expect(aborted.lastError).toBe('user cancelled')
  })

  test('error transitions any state to failed', () => {
    const running = reduceRuntimeState(undefined, { type: 'send_message', message: 'test' })
    const failed = reduceRuntimeState(running, { type: 'error', error: 'crashed' })
    expect(failed.status).toBe('failed')
    expect(failed.lastError).toBe('crashed')
  })

  test('dispose transitions any state to disposed and clears queue', () => {
    const running = reduceRuntimeState(undefined, { type: 'send_message', message: 'test' })
    const queued = reduceRuntimeState(running, { type: 'send_message', message: 'queued' })
    const disposed = reduceRuntimeState(queued, { type: 'dispose' })
    expect(disposed.status).toBe('disposed')
    expect(disposed.queuedMessages).toEqual([])
  })

  test('starting transitions ready → starting', () => {
    const ready = reduceRuntimeState(undefined, { type: 'preflight_ok' })
    const starting = reduceRuntimeState(ready, { type: 'starting' })
    expect(starting.status).toBe('starting')
  })

  test('turn_completed transitions running → turn_completed', () => {
    const running = reduceRuntimeState(undefined, { type: 'send_message', message: 'build' })
    const turnCompleted = reduceRuntimeState(running, { type: 'turn_completed' })
    expect(turnCompleted.status).toBe('turn_completed')
  })

  test('complete from turn_completed with empty queue transitions to ready', () => {
    const running = reduceRuntimeState(undefined, { type: 'send_message', message: 'build' })
    const turnCompleted = reduceRuntimeState(running, { type: 'turn_completed' })
    const ready = reduceRuntimeState(turnCompleted, { type: 'complete' })
    expect(ready.status).toBe('ready')
  })

  test('complete from turn_completed with queued messages drains and stays running', () => {
    const running = reduceRuntimeState(undefined, { type: 'send_message', message: 'first' })
    const queued = reduceRuntimeState(running, { type: 'send_message', message: 'second' })
    const turnCompleted = reduceRuntimeState(queued, { type: 'turn_completed' })
    const drained = reduceRuntimeState(turnCompleted, { type: 'complete' })
    expect(drained.status).toBe('running')
    expect(drained.acceptedMessages).toEqual(['first', 'second'])
    expect(drained.queuedMessages).toEqual([])
  })

  // session contract: send_message must not silently resurrect a terminal state.
  test('send_message from failed is a no-op (session contract: no resurrection)', () => {
    const failed = reduceRuntimeState(undefined, { type: 'error', error: 'crashed' })
    expect(failed.status).toBe('failed')
    const result = reduceRuntimeState(failed, { type: 'send_message', message: 'retry' })
    // Terminal state is preserved; the message is dropped (not accepted). The
    // live send path (scaffold.sendMessage) dispatches `abort` first when it
    // detects `failed`, so this no-op only fires if a caller bypasses it.
    expect(result.status).toBe('failed')
    expect(result.acceptedMessages).toEqual([])
    expect(result.lastError).toBe('crashed')
  })

  test('send_message from disposed is a no-op (session contract: no resurrection)', () => {
    const disposed = reduceRuntimeState(undefined, { type: 'dispose' })
    expect(disposed.status).toBe('disposed')
    const result = reduceRuntimeState(disposed, { type: 'send_message', message: 'retry' })
    expect(result.status).toBe('disposed')
    expect(result.acceptedMessages).toEqual([])
  })

  test('send_message from failed does not enqueue (the message is dropped, not queued)', () => {
    const failed = reduceRuntimeState(undefined, { type: 'error', error: 'crashed' })
    const result = reduceRuntimeState(failed, { type: 'send_message', message: 'retry' })
    expect(result.queuedMessages).toEqual([])
  })

  test('replay_reconcile still sets status unconditionally (session contract does not regress X-C)', () => {
    // The replay_reconcile action (session contract) is separate from send_message and
    // must continue to set status unconditionally — including from failed.
    const failed = reduceRuntimeState(undefined, { type: 'error', error: 'crashed' })
    const reconciled = reduceRuntimeState(failed, {
      type: 'replay_reconcile',
      status: 'ready',
    })
    expect(reconciled.status).toBe('ready')
    expect(reconciled.waitingPermissionRequestId).toBeUndefined()
  })

  test('replay_reconcile to waiting_for_permission carries requestId (X-C preserved)', () => {
    const failed = reduceRuntimeState(undefined, { type: 'error', error: 'crashed' })
    const reconciled = reduceRuntimeState(failed, {
      type: 'replay_reconcile',
      status: 'waiting_for_permission',
      requestId: 'perm-1',
    })
    expect(reconciled.status).toBe('waiting_for_permission')
    expect(reconciled.waitingPermissionRequestId).toBe('perm-1')
  })

  // SDK-R-4: replay_reconcile clears the reducer-visible queue and carries an
  // optional error for the failed arm.
  test('replay_reconcile to failed carries the error message (SDK-R-4)', () => {
    const failed = reduceRuntimeState(undefined, { type: 'error', error: 'old' })
    const reconciled = reduceRuntimeState(failed, {
      type: 'replay_reconcile',
      status: 'failed',
      error: 'replayed turn_failed',
    })
    expect(reconciled.status).toBe('failed')
    expect(reconciled.lastError).toBe('replayed turn_failed')
  })

  test('replay_reconcile clears queuedMessages (SDK-R-4)', () => {
    // A queued message from the pre-rotation turn is invalidated by the
    // rotation; the reducer-visible queue must not disagree with the scaffold's
    // pendingQueue after a reconcile.
    const running = reduceRuntimeState(undefined, { type: 'send_message', message: 'first' })
    const queued = reduceRuntimeState(running, { type: 'send_message', message: 'second' })
    expect(queued.queuedMessages).toEqual(['second'])
    const reconciled = reduceRuntimeState(queued, {
      type: 'replay_reconcile',
      status: 'ready',
    })
    expect(reconciled.queuedMessages).toEqual([])
    expect(reconciled.status).toBe('ready')
  })

  test('replay_reconcile to failed without an error leaves lastError untouched (SDK-R-4 backward-compat)', () => {
    // No `error` on the action → don't synthesize one; preserve prior lastError
    // so callers that don't carry the error see the existing message (if any).
    const failed = reduceRuntimeState(undefined, { type: 'error', error: 'prior' })
    const reconciled = reduceRuntimeState(failed, {
      type: 'replay_reconcile',
      status: 'failed',
    })
    expect(reconciled.lastError).toBe('prior')
  })

  // SDK-R-5: an unrecognized action returns state unchanged instead of
  // `undefined` (which would crash every subsequent getState().status read).
  test('an unknown action returns state unchanged (SDK-R-5 default arm)', () => {
    const running = reduceRuntimeState(undefined, { type: 'send_message', message: 'first' })
    // Simulate a future/external action the reducer doesn't know about.
    const result = reduceRuntimeState(running, {
      type: 'some_future_action',
    } as unknown as Parameters<typeof reduceRuntimeState>[1])
    expect(result).toBe(running)
    expect(result.status).toBe('running')
  })
})
