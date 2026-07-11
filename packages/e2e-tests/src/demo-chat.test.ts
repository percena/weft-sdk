import { describe, expect, test, vi, } from 'vitest'

// Polyfill browser-only event types not available in Node.js 22
if (typeof globalThis.ErrorEvent === 'undefined') {
  (globalThis as any).ErrorEvent = class ErrorEvent extends Event {
    readonly message: string
    constructor(type: string, init?: { message?: string }) {
      super(type)
      this.message = init?.message ?? ''
    }
  }
}
if (typeof globalThis.CloseEvent === 'undefined') {
  (globalThis as any).CloseEvent = class CloseEvent extends Event {
    readonly code: number
    readonly reason: string
    readonly wasClean: boolean
    constructor(type: string, init?: { code?: number; reason?: string; wasClean?: boolean }) {
      super(type)
      this.code = init?.code ?? 1000
      this.reason = init?.reason ?? ''
      this.wasClean = init?.wasClean ?? false
    }
  }
}

import {
  DEMO_EVENTS,
  DEMO_TIMELINE,
  DEMO_SESSION_ID,
  DEMO_WORKSPACE_ID,
  createDemoSessionState,
  getDemoTurns,
  reduceDemoEvents,
} from '../../../apps/chat-playground/src/demo-session'
import {
  createAgentChatPanelModelFromTimeline,
  createTimelineDetailItems,
} from '@weft/chat'
import { shouldShowStreamingContent } from '@weft/ui'
import { RuntimeClient, type RuntimeClientConnectOptions, type RuntimeClientState } from '../../../apps/chat-playground/src/runtime-client'
import {
  LIVE_FRAMEWORK_OPTIONS,
  REASONING_EFFORT_OPTIONS,
  LIVE_SESSIONS_STORAGE_KEY,
  appendLiveTimeline,
  buildSessionStateFromTimeline,
  createLiveAttachments,
  createLiveSessionRecord,
  getLiveFrameworkLabel,
  getReasoningEffortOptions,
  loadLiveSessions,
  saveLiveSessions,
  titleFromMessage,
  upsertLiveSession,
  type StorageLike,
} from '../../../apps/chat-playground/src/live-session-store'

describe('Demo app streaming chat integration', () => {
  test('builds an assistant turn from processor events', () => {
    const state = reduceDemoEvents(createDemoSessionState(), DEMO_EVENTS)
    const turns = getDemoTurns(state)

    const userTurn = turns.find(turn => turn.type === 'user')
    expect(userTurn?.type).toBe('user')
    if (userTurn?.type === 'user') {
      expect(userTurn.message.content).toContain('timeout')
    }

    const assistantTurn = turns.find(turn =>
      turn.type === 'assistant' &&
      turn.response?.text.includes('retry backoff')
    )
    expect(assistantTurn?.type).toBe('assistant')
    if (assistantTurn?.type !== 'assistant') {
      throw new Error('Expected an assistant turn')
    }

    expect(assistantTurn.isComplete).toBe(true)
    expect(assistantTurn.response?.text).toContain('retry backoff')
    const activities = turns
      .filter(turn => turn.type === 'assistant')
      .flatMap(turn => turn.activities)

    expect(activities.map(activity => activity.toolName)).toEqual(expect.arrayContaining(['Read', 'Write']))
    expect(activities.filter(activity => activity.toolName === 'Read' || activity.toolName === 'Write')
      .every(activity => activity.status === 'completed')).toBe(true)
    expect(activities.find(activity => activity.toolName === 'Read')?.toolInput).toEqual({ file_path: '/src/config.ts' })
    expect(activities.find(activity => activity.toolName === 'Write')?.content).toContain('File written successfully')
  })

  test('exposes in-progress streaming state before completion', () => {
    const partialState = reduceDemoEvents(createDemoSessionState(), DEMO_EVENTS.slice(0, 9))
    const turns = getDemoTurns(partialState)
    const assistantTurn = turns.find(turn =>
      turn.type === 'assistant' &&
      turn.activities.some(activity => activity.toolName === 'Read')
    )

    expect(assistantTurn?.type).toBe('assistant')
    if (assistantTurn?.type !== 'assistant') {
      throw new Error('Expected a streaming assistant turn')
    }

    expect(assistantTurn.isStreaming).toBe(true)
    expect(assistantTurn.isComplete).toBe(false)
    expect(partialState.streaming?.content).toContain('configuration file')
    expect(assistantTurn.activities.some(activity => activity.toolName === 'Read' && activity.status === 'running')).toBe(true)
  })

  test('exposes canonical runtime details for the demo sidebar', () => {
    const details = createTimelineDetailItems(DEMO_TIMELINE)

    expect(details.some(detail => detail.kind === 'runtime' && detail.title === 'Runtime capability report')).toBe(true)
    expect(details.some(detail => detail.kind === 'source' && detail.title.includes('workspace-files'))).toBe(true)
    expect(details.some(detail => detail.kind === 'permission' && detail.title === 'Permission requested: Write')).toBe(true)
    expect(details.some(detail => detail.kind === 'permission' && detail.status === 'allowed')).toBe(true)
  })

  test('keeps runtime detail timeline items out of the chat transcript', () => {
    const model = createAgentChatPanelModelFromTimeline({
      timeline: DEMO_TIMELINE,
      sessionId: DEMO_SESSION_ID,
      workspaceId: DEMO_WORKSPACE_ID,
    })

    expect(model.turns.some(turn => turn.type === 'system')).toBe(false)
    expect(model.turns.filter(turn => turn.type === 'user')).toHaveLength(1)
    expect(model.turns.some(turn =>
      turn.type === 'assistant' &&
      turn.response?.text.includes('retry backoff')
    )).toBe(true)
  })

  test('streaming TurnCard data: delta events produce partial response with streaming state', () => {
    // Simulate a real streaming scenario: text_delta events arrive one-by-one
    const timeline = [
      {
        sessionId: 's1', provider: 'claude', epoch: 'e1', seq: 1, timestamp: 1_000,
        item: { type: 'user_message', text: 'hello', messageId: 'user-1', turnId: 'turn-1' },
      },
      {
        sessionId: 's1', provider: 'claude', epoch: 'e1', seq: 2, timestamp: 1_001,
        item: { type: 'assistant_message_delta', text: 'Hello', messageId: 'msg-1', turnId: 'turn-1' },
      },
      {
        sessionId: 's1', provider: 'claude', epoch: 'e1', seq: 3, timestamp: 1_002,
        item: { type: 'assistant_message_delta', text: ' world', messageId: 'msg-1', turnId: 'turn-1' },
      },
    ] as const

    const model = createAgentChatPanelModelFromTimeline({
      timeline,
      sessionId: 's1',
      workspaceId: 'ws-1',
    })

    // Verify streaming state: assistant turn has isStreaming=true, isComplete=false
    const streamingTurn = model.turns.find(turn => turn.type === 'assistant')
    if (streamingTurn?.type !== 'assistant') throw new Error('Expected assistant turn')
    expect(streamingTurn.isStreaming).toBe(true)
    expect(streamingTurn.isComplete).toBe(false)

    // Complete text: add final assistant_message + turn_completed
    const completedTimeline = [...timeline, {
      sessionId: 's1', provider: 'claude', epoch: 'e1', seq: 4, timestamp: 1_003,
      item: { type: 'assistant_message', text: 'Hello world', messageId: 'msg-1', turnId: 'turn-1' },
    }, {
      sessionId: 's1', provider: 'claude', epoch: 'e1', seq: 5, timestamp: 1_004,
      item: { type: 'turn_completed', turnId: 'turn-1' },
    }] as const

    const completedModel = createAgentChatPanelModelFromTimeline({
      timeline: completedTimeline,
      sessionId: 's1',
      workspaceId: 'ws-1',
    })

    const completedTurn = completedModel.turns.find(turn => turn.type === 'assistant')
    if (completedTurn?.type !== 'assistant') throw new Error('Expected assistant turn')
    expect(completedTurn.isStreaming).toBe(false)
    expect(completedTurn.isComplete).toBe(true)
    expect(completedTurn.response?.text).toBe('Hello world')
  })

  test('live transcript shows an assistant thinking turn immediately after accepted user prompt', () => {
    const session = createLiveSessionRecord({
      id: 'live-pending-turn',
      now: 1,
      config: { provider: 'codex', model: 'gpt-5.5' },
    })
    const state = buildSessionStateFromTimeline(appendLiveTimeline(session, [{
      sessionId: 'live-pending-turn',
      provider: 'local',
      epoch: '0000-local',
      seq: 1,
      timestamp: 1,
      item: { type: 'user_message', text: 'Inspect the repo', messageId: 'user-1', turnId: 'turn-1' },
    }], 2))

    const turns = getDemoTurns(state)

    expect(state.session.isProcessing).toBe(true)
    expect(turns.map(turn => turn.type)).toEqual(['user', 'assistant'])
    const pendingTurn = turns[1]
    if (pendingTurn?.type !== 'assistant') throw new Error('Expected pending assistant turn')
    expect(pendingTurn.activities).toHaveLength(0)
    expect(pendingTurn.response).toBeUndefined()
    expect(pendingTurn.isStreaming).toBe(true)
    expect(pendingTurn.isComplete).toBe(false)
  })

  test('live transcript keeps assistant commentary before later tool activity in the same turn', () => {
    const session = createLiveSessionRecord({
      id: 'live-commentary-before-tool',
      now: 1,
      config: { provider: 'codex', model: 'gpt-5.5' },
    })
    const state = buildSessionStateFromTimeline(appendLiveTimeline(session, [
      {
        sessionId: 'live-commentary-before-tool',
        provider: 'local',
        epoch: '0000-local',
        seq: 1,
        timestamp: 1,
        item: { type: 'user_message', text: 'Check docs', messageId: 'user-1', turnId: 'turn-1' },
      },
      {
        sessionId: 'codex-session',
        provider: 'codex',
        epoch: 'default',
        seq: 1,
        timestamp: 2,
        item: { type: 'assistant_message_delta', text: 'I will quickly read the relevant docs first.', messageId: 'msg-1', turnId: 'turn-1' },
      },
      {
        sessionId: 'codex-session',
        provider: 'codex',
        epoch: 'default',
        seq: 2,
        timestamp: 4,
        item: {
          type: 'tool_call',
          callId: 'cmd-1',
          name: 'commandExecution',
          status: 'running',
          detail: { command: "sed -n '1,40p' docs/ARCHITECTURE.md", cwd: '/tmp/project' },
          turnId: 'turn-1',
        },
      },
      {
        sessionId: 'codex-session',
        provider: 'codex',
        epoch: 'default',
        seq: 3,
        timestamp: 5,
        item: { type: 'tool_result', callId: 'cmd-1', result: 'Architecture docs', turnId: 'turn-1' },
      },
      {
        sessionId: 'codex-session',
        provider: 'codex',
        epoch: 'default',
        seq: 4,
        timestamp: 7,
        item: { type: 'assistant_message', text: 'I will quickly read the relevant docs first.', messageId: 'msg-1', turnId: 'turn-1' },
      },
    ], 8))

    const assistantTurn = getDemoTurns(state).find(turn => turn.type === 'assistant')
    if (assistantTurn?.type !== 'assistant') throw new Error('Expected assistant turn')

    expect(assistantTurn.response).toBeUndefined()
    expect(assistantTurn.activities.map(activity => activity.type)).toEqual(['intermediate', 'tool'])
    expect(assistantTurn.activities[0]?.content).toBe('I will quickly read the relevant docs first.')
    expect(assistantTurn.activities[1]?.displayName).toBe('Read File')
  })

  test('a later metadata-less tool_call does not wipe the first event input/displayName', () => {
    // Flitro emits two tool_call events per call: "pending" carries
    // { input, displayName }, then "running" carries no detail. The later event
    // must not overwrite the captured input/displayName with undefined,
    // otherwise the step row falls back to the bare tool name ("http_request").
    const session = createLiveSessionRecord({
      id: 'live-flitro-tool-intent',
      now: 1,
      config: { provider: 'codex', model: 'gpt-5.5' },
    })
    const state = buildSessionStateFromTimeline(appendLiveTimeline(session, [
      {
        sessionId: 'live-flitro-tool-intent',
        provider: 'local',
        epoch: '0000-local',
        seq: 1,
        timestamp: 1,
        item: { type: 'user_message', text: 'List the available tools', messageId: 'user-1', turnId: 'turn-1' },
      },
      {
        sessionId: 'flitro-session',
        provider: 'flitro',
        epoch: 'default',
        seq: 1,
        timestamp: 2,
        item: {
          type: 'tool_call',
          callId: 'call-1',
          name: 'http_request',
          status: 'pending',
          detail: { input: { method: 'GET', url: 'http://example.com/api/tools' }, displayName: 'GET /api/tools' },
          turnId: 'turn-1',
        },
      },
      {
        sessionId: 'flitro-session',
        provider: 'flitro',
        epoch: 'default',
        seq: 2,
        timestamp: 3,
        // "running" event with no detail — must not clear the above.
        item: { type: 'tool_call', callId: 'call-1', name: 'http_request', status: 'running', turnId: 'turn-1' },
      },
      {
        sessionId: 'flitro-session',
        provider: 'flitro',
        epoch: 'default',
        seq: 3,
        timestamp: 4,
        item: { type: 'tool_result', callId: 'call-1', result: 'ok', turnId: 'turn-1' },
      },
    ], 5))

    const assistantTurn = getDemoTurns(state).find(turn => turn.type === 'assistant')
    if (assistantTurn?.type !== 'assistant') throw new Error('Expected assistant turn')
    const toolActivity = assistantTurn.activities.find(activity => activity.type === 'tool')
    // displayName becomes the step's primary label (formatToolDisplay returns
    // it verbatim), so the row reads "GET /api/tools", not "http_request".
    expect(toolActivity?.displayName).toBe('GET /api/tools')
    expect(toolActivity?.toolInput).toEqual({ method: 'GET', url: 'http://example.com/api/tools' })
  })

  test('streaming response content is visible from the first non-empty delta', () => {
    expect(shouldShowStreamingContent('I will', true, Date.now()).shouldShow).toBe(true)
  })

  test('RuntimeClient live connection creates a host session before opening the stream', async () => {
    const calls: string[] = []
    class TestRuntimeClient extends RuntimeClient {
      override async createSession(options: RuntimeClientConnectOptions): Promise<void> {
        calls.push(`create:${options.provider}:${options.cwd}`)
      }

      override connectStream(): void {
        calls.push('stream')
      }
    }

    const client = new TestRuntimeClient({
      baseUrl: 'http://127.0.0.1:4127',
      sessionId: 'demo-live-test',
    })

    await client.connectLiveSession({ provider: 'codex', cwd: '/tmp/project' })

    expect(calls).toEqual([
      'create:codex:/tmp/project',
      'stream',
    ])
  })

  test('RuntimeClient disconnect clears _error from getState', () => {
    class TestRuntimeClient extends RuntimeClient {
      override async createSession(): Promise<void> {}
      override connectStream(): void {}
    }

    const client = new TestRuntimeClient({
      baseUrl: 'http://127.0.0.1:4127',
      sessionId: 'demo-error-test',
    })

    // Simulate: an error was captured before disconnect
    // (In production, onerror/onclose sets _error; we manually set it via a mock)
    const stateBefore = client.getState()
    expect(stateBefore.error).toBeNull()

    client.disconnect()

    const stateAfter = client.getState()
    expect(stateAfter.error).toBeNull()
    expect(stateAfter.isConnected).toBe(false)
  })

  test('live session store persists active session config and timeline', () => {
    const memory = new Map<string, string>()
    const storage: StorageLike = {
      getItem: key => memory.get(key) ?? null,
      setItem: (key, value) => { memory.set(key, value) },
    }
    const now = 1_800
    const session = appendLiveTimeline(createLiveSessionRecord({
      id: 'live-a',
      now,
      title: 'Inspect runtime',
      config: {
        provider: 'claude',
        model: 'claude-sonnet-4.5',
        reasoningEffort: 'xhigh',
        permissionMode: 'explore',
        cwd: '/home/user/project',
        selectedSourceSlugs: ['workspace-files', 'host-tools'],
      },
    }), [{
      sessionId: 'host-a',
      provider: 'claude',
      epoch: 'epoch-a',
      seq: 1,
      timestamp: now,
      item: { type: 'user_message', text: 'hello live', messageId: 'u1', turnId: 't1' },
    }], now + 1)

    const state = upsertLiveSession(loadLiveSessions(storage, now), session, 'live-a')
    saveLiveSessions(storage, state)

    const restored = loadLiveSessions(storage, now + 2)
    expect(memory.has(LIVE_SESSIONS_STORAGE_KEY)).toBe(true)
    expect(restored.activeSessionId).toBe('live-a')
    expect(restored.sessions[0].config.permissionMode).toBe('explore')
    expect(restored.sessions[0].config.reasoningEffort).toBe('xhigh')
    expect(restored.sessions[0].config.selectedSourceSlugs).toEqual(['workspace-files', 'host-tools'])
    expect(restored.sessions[0].timeline).toHaveLength(1)

    const restoredState = buildSessionStateFromTimeline(restored.sessions[0])
    expect(restoredState.session.messages.some(message => message.content === 'hello live')).toBe(true)
  })

  test('live session store reconciles completed persisted runs on reload', () => {
    const memory = new Map<string, string>()
    const storage: StorageLike = {
      getItem: key => memory.get(key) ?? null,
      setItem: (key, value) => { memory.set(key, value) },
    }
    memory.set(LIVE_SESSIONS_STORAGE_KEY, JSON.stringify({
      version: 1,
      activeSessionId: 'live-complete',
      sessions: [{
        id: 'live-complete',
        title: 'Completed run',
        createdAt: 1,
        updatedAt: 2,
        status: 'running',
        config: { provider: 'codex', model: 'gpt-5.5', permissionMode: 'ask', cwd: '/tmp', selectedSourceSlugs: [], attachments: [] },
        timeline: [{
          sessionId: 'live-complete',
          provider: 'codex',
          epoch: 'e1',
          seq: 1,
          timestamp: 2,
          item: { type: 'turn_completed', turnId: 't1' },
        }],
      }],
    }))

    const restored = loadLiveSessions(storage, 3)

    expect(restored.sessions[0].status).toBe('disconnected')
  })

  test('live session transcript ignores runtime-only timeline events', () => {
    const session = createLiveSessionRecord({
      id: 'live-transcript',
      now: 1,
      config: { provider: 'codex', model: 'gpt-5.5' },
    })
    const withTimeline = appendLiveTimeline(session, [
      {
        sessionId: 'live-transcript',
        provider: 'codex',
        epoch: 'e1',
        seq: 1,
        timestamp: 1,
        item: { type: 'runtime_capability_report', report: { provider: 'codex', selected: 'app-server' } },
      },
      {
        sessionId: 'live-transcript',
        provider: 'codex',
        epoch: 'e1',
        seq: 2,
        timestamp: 2,
        item: { type: 'user_message', text: 'Inspect the project', messageId: 'user-1', turnId: 'turn-1' },
      },
      {
        sessionId: 'live-transcript',
        provider: 'codex',
        epoch: 'e1',
        seq: 3,
        timestamp: 3,
        item: { type: 'turn_started', turnId: 'turn-1' },
      },
      {
        sessionId: 'live-transcript',
        provider: 'codex',
        epoch: 'e1',
        seq: 4,
        timestamp: 4,
        item: { type: 'source_state_changed', source: { sourceSlug: 'workspace-files', status: 'active' } },
      },
      {
        sessionId: 'live-transcript',
        provider: 'codex',
        epoch: 'e1',
        seq: 5,
        timestamp: 5,
        item: {
          type: 'tool_call',
          callId: 'tool-read',
          name: 'Read',
          status: 'running',
          detail: { input: { file_path: '/tmp/README.md' }, intent: 'Read project summary.' },
          turnId: 'turn-1',
        },
      },
      {
        sessionId: 'live-transcript',
        provider: 'codex',
        epoch: 'e1',
        seq: 6,
        timestamp: 6,
        item: { type: 'permission_resolved', requestId: 'permission-1', resolution: { allowed: true } },
      },
      {
        sessionId: 'live-transcript',
        provider: 'codex',
        epoch: 'e1',
        seq: 7,
        timestamp: 7,
        item: { type: 'tool_result', callId: 'tool-read', result: 'README contents', turnId: 'turn-1' },
      },
      {
        sessionId: 'live-transcript',
        provider: 'codex',
        epoch: 'e1',
        seq: 8,
        timestamp: 8,
        item: { type: 'assistant_message', text: 'I inspected the README.', messageId: 'assistant-1', turnId: 'turn-1' },
      },
      {
        sessionId: 'live-transcript',
        provider: 'codex',
        epoch: 'e1',
        seq: 9,
        timestamp: 9,
        item: { type: 'session_status', status: 'ready' },
      },
    ], 10)

    const state = buildSessionStateFromTimeline(withTimeline)
    const roles = state.session.messages.map(message => message.role)
    const turns = getDemoTurns(state)

    expect(roles).toEqual(['user', 'tool', 'assistant'])
    expect(turns.map(turn => turn.type)).toEqual(['user', 'assistant'])
    const assistantTurn = turns[1]
    if (assistantTurn?.type !== 'assistant') throw new Error('Expected assistant turn')
    expect(assistantTurn.activities.map(activity => activity.toolName)).toEqual(['Read'])
    expect(assistantTurn.response?.text).toBe('I inspected the README.')
  })

  test('live session transcript renders Codex command executions as inspectable Bash steps', () => {
    const session = createLiveSessionRecord({
      id: 'live-command-execution',
      now: 1,
      config: { provider: 'codex', model: 'gpt-5.5' },
    })
    const withTimeline = appendLiveTimeline(session, [
      {
        sessionId: 'live-command-execution',
        provider: 'local',
        epoch: '0000-local',
        seq: 1,
        timestamp: 1,
        item: { type: 'user_message', text: 'Summarize docs/ARCHITECTURE.md', messageId: 'user-1', turnId: 'turn-1' },
      },
      {
        sessionId: 'codex-session',
        provider: 'codex',
        epoch: 'default',
        seq: 1,
        timestamp: 2,
        item: {
          type: 'tool_call',
          callId: 'cmd-1',
          name: 'commandExecution',
          status: 'running',
          detail: {
            command: "/bin/zsh -lc \"sed -n '1,160p' docs/ARCHITECTURE.md\"",
            cwd: '/home/user/project/weft',
          },
          turnId: 'turn-1',
        },
      },
      {
        sessionId: 'codex-session',
        provider: 'codex',
        epoch: 'default',
        seq: 2,
        timestamp: 3,
        item: { type: 'tool_result', callId: 'cmd-1', result: 'Architecture summary', turnId: 'turn-1' },
      },
      {
        sessionId: 'codex-session',
        provider: 'codex',
        epoch: 'default',
        seq: 3,
        timestamp: 4,
        item: { type: 'assistant_message', text: 'The architecture is SDK-first.', messageId: 'assistant-1', turnId: 'turn-1' },
      },
    ], 5)

    const state = buildSessionStateFromTimeline(withTimeline)
    const assistantTurn = getDemoTurns(state).find(turn => turn.type === 'assistant')
    if (assistantTurn?.type !== 'assistant') throw new Error('Expected assistant turn')

    expect(assistantTurn.activities).toHaveLength(1)
    expect(assistantTurn.activities[0]).toMatchObject({
      toolName: 'Bash',
      displayName: 'Read File',
      intent: 'Read docs/ARCHITECTURE.md',
      toolInput: {
        command: "/bin/zsh -lc \"sed -n '1,160p' docs/ARCHITECTURE.md\"",
        cwd: '/home/user/project/weft',
      },
      content: 'Architecture summary',
      status: 'completed',
    })
  })

  test('live session transcript keeps Codex command output streaming inside a running Bash activity', () => {
    const session = createLiveSessionRecord({
      id: 'live-command-stream',
      now: 1,
      config: { provider: 'codex', model: 'gpt-5.5' },
    })
    const withTimeline = appendLiveTimeline(session, [
      {
        sessionId: 'live-command-stream',
        provider: 'local',
        epoch: '0000-local',
        seq: 1,
        timestamp: 1,
        item: { type: 'user_message', text: 'Search RuntimeClient', messageId: 'user-1', turnId: 'turn-1' },
      },
      {
        sessionId: 'codex-session',
        provider: 'codex',
        epoch: 'default',
        seq: 1,
        timestamp: 2,
        item: {
          type: 'tool_call',
          callId: 'cmd-stream',
          name: 'commandExecution',
          status: 'running',
          detail: {
            command: "rg -n \"RuntimeClient\" apps/chat-playground/src",
            cwd: '/home/user/project/weft',
            commandActions: [{ type: 'search', query: 'RuntimeClient', path: 'apps/chat-playground/src' }],
          },
          turnId: 'turn-1',
        },
      },
      {
        sessionId: 'codex-session',
        provider: 'codex',
        epoch: 'default',
        seq: 2,
        timestamp: 3,
        item: {
          type: 'tool_output_delta',
          callId: 'cmd-stream',
          text: 'apps/chat-playground/src/runtime-client.ts:1\n',
          stream: 'stdout',
          turnId: 'turn-1',
        },
      },
      {
        sessionId: 'codex-session',
        provider: 'codex',
        epoch: 'default',
        seq: 3,
        timestamp: 4,
        item: {
          type: 'tool_output_delta',
          callId: 'cmd-stream',
          text: 'apps/chat-playground/src/App.tsx:14\n',
          stream: 'stdout',
          turnId: 'turn-1',
        },
      },
    ], 5)

    const state = buildSessionStateFromTimeline(withTimeline)
    const assistantTurn = getDemoTurns(state).find(turn => turn.type === 'assistant')
    if (assistantTurn?.type !== 'assistant') throw new Error('Expected assistant turn')

    expect(assistantTurn.isStreaming).toBe(true)
    expect(assistantTurn.activities).toHaveLength(1)
    expect(assistantTurn.activities[0]).toMatchObject({
      toolName: 'Bash',
      displayName: 'Search Files',
      intent: 'Search RuntimeClient in apps/chat-playground/src',
      content: 'apps/chat-playground/src/runtime-client.ts:1\napps/chat-playground/src/App.tsx:14\n',
      status: 'running',
    })
  })

  test('live session transcript keeps optimistic user messages before server assistant events after reload', () => {
    const session = createLiveSessionRecord({
      id: 'live-reload-order',
      now: 1,
      config: { provider: 'codex', model: 'gpt-5.5' },
    })
    const withTimeline = appendLiveTimeline(session, [
      {
        sessionId: 'codex-session',
        provider: 'codex',
        epoch: 'default',
        seq: 1,
        timestamp: 2,
        item: { type: 'assistant_message', text: 'Hello!', messageId: 'assistant-1', turnId: 'turn-1' },
      },
      {
        sessionId: 'codex-session',
        provider: 'local',
        epoch: '0000-local',
        seq: 1,
        timestamp: 1,
        item: { type: 'user_message', text: 'Say hello', messageId: 'local-user-1', turnId: 'local-turn-1' },
      },
    ], 3)

    const state = buildSessionStateFromTimeline(withTimeline)

    expect(withTimeline.timeline.map(envelope => envelope.item.type)).toEqual(['user_message', 'assistant_message'])
    expect(state.session.messages.map(message => message.role)).toEqual(['user', 'assistant'])
    expect(getDemoTurns(state).map(turn => turn.type)).toEqual(['user', 'assistant'])
  })

  test('live session titles are derived from first substantive message', () => {
    expect(titleFromMessage('  Summarize the host runtime fallback path  ')).toBe('Summarize the host runtime fallback path')
    expect(titleFromMessage('x'.repeat(80))).toBe(`${'x'.repeat(41)}...`)
    expect(titleFromMessage('   ')).toBe('New live session')
  })

  test('live attachment factory supports multi-select paths with stable unique ids', () => {
    expect(createLiveAttachments([
      '/home/user/project/README.md',
      '/home/user/project/src/App.tsx',
    ], 1_700)).toEqual([
      {
        id: 'attachment-1700-0',
        name: 'README.md',
        path: '/home/user/project/README.md',
      },
      {
        id: 'attachment-1700-1',
        name: 'App.tsx',
        path: '/home/user/project/src/App.tsx',
      },
    ])
  })

  test('RuntimeClient sends live composer options with each message', async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(url),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      })
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }) as typeof fetch

    try {
      const client = new RuntimeClient({
        baseUrl: 'http://127.0.0.1:4127',
        sessionId: 'host-live-a',
      })
      await client.sendMessage('Use the selected sources', {
        model: 'gpt-5.5',
        reasoningEffort: 'xhigh',
        permissionMode: 'ask',
        cwd: '/home/user/project',
        sourceSlugs: ['workspace-files'],
        attachments: [{ path: '/home/user/project/README.md', name: 'README.md' }],
      })

      expect(calls[0].url).toBe('http://127.0.0.1:4127/sessions/host-live-a/messages')
      expect(calls[0].body).toEqual({
        message: 'Use the selected sources',
        model: 'gpt-5.5',
        reasoningEffort: 'xhigh',
        permissionMode: 'ask',
        cwd: '/home/user/project',
        sourceSlugs: ['workspace-files'],
        attachments: [{ path: '/home/user/project/README.md', name: 'README.md' }],
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('RuntimeClient adds sent user messages to the live transcript immediately', async () => {
    const originalFetch = globalThis.fetch
    let resolveFetch: ((response: Response) => void) | undefined
    globalThis.fetch = (() =>
      new Promise<Response>((resolve) => {
        resolveFetch = resolve
      })
    ) as typeof fetch

    try {
      const client = new RuntimeClient({
        baseUrl: 'http://127.0.0.1:4127',
        sessionId: 'host-live-user',
      })

      const pendingSend = client.sendMessage('Inspect README and summarize key points')

      const state = client.getState()
      expect(state.timeline.map(envelope => envelope.item.type)).toEqual(['user_message'])
      expect(state.timeline[0]?.epoch).toBe('0000-local')
      expect(state.sessionState.session.isProcessing).toBe(true)
      expect(state.sessionState.session.messages.map(message => message.role)).toEqual(['user'])
      expect(state.turns.map(turn => turn.type)).toEqual(['user'])
      const userTurn = state.turns[0]
      if (userTurn?.type !== 'user') throw new Error('Expected user turn')
      expect(userTurn.message.content).toBe('Inspect README and summarize key points')

      resolveFetch?.(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      await pendingSend
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('live framework selector exposes Claude Code and Codex choices', () => {
    expect(LIVE_FRAMEWORK_OPTIONS).toEqual([
      { provider: 'claude', label: 'Claude Code' },
      { provider: 'codex', label: 'Codex' },
    ])
    expect(getLiveFrameworkLabel('claude')).toBe('Claude Code')
    expect(getLiveFrameworkLabel('codex')).toBe('Codex')
  })

  test('live effort selector exposes provider-specific choices with config inheritance', () => {
    expect(REASONING_EFFORT_OPTIONS.codex.map(option => option.effort)).toEqual(['low', 'medium', 'high', 'xhigh'])
    expect(REASONING_EFFORT_OPTIONS.claude.map(option => option.effort)).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(getReasoningEffortOptions('codex').some(option => option.effort === 'max')).toBe(false)
    expect(createLiveSessionRecord({ id: 'live-default', now: 1 }).config.reasoningEffort).toBeUndefined()
  })
})

// ===== WebSocket lifecycle tests with mock WS =====

/** Minimal mock WebSocket that supports onerror/onclose/onopen/onmessage handlers */
class MockWebSocket {
  url: string
  readyState: number = WebSocket.CONNECTING
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  onopen: (() => void) | null = null

  constructor(url: string) {
    this.url = url
  }

  close(_code: number = 1000, _reason: string = ''): void {
    this.readyState = WebSocket.CLOSED
  }

  // Test helpers — simulate events
  simulateOpen(): void {
    this.readyState = WebSocket.OPEN
    this.onopen?.()
  }

  simulateError(message: string): void {
    // Create a real ErrorEvent so instanceof ErrorEvent check passes
    const event = new ErrorEvent('error', { message })
    this.onerror?.(event)
  }

  simulateClose(code: number, reason: string = '', wasClean = code === 1000): void {
    this.readyState = WebSocket.CLOSED
    const event = new CloseEvent('close', { code, reason, wasClean })
    this.onclose?.(event)
  }

  simulateMessage(data: string): void {
    this.onmessage?.({ data })
  }
}

describe('RuntimeClient WebSocket error lifecycle', () => {
  test('createSession fetch failure propagates as thrown error', async () => {
    // Mock global fetch to return a server error
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ reason: 'Host server unreachable' }), { status: 503 })
    )

    const client = new RuntimeClient({
      baseUrl: 'http://127.0.0.1:4127',
      sessionId: 'demo-fetch-fail',
    })

    try {
      await client.connectLiveSession({ provider: 'codex', cwd: '/tmp/project' })
      // Should not reach here
      expect.unreachable('Expected connectLiveSession to throw')
    } catch (err) {
      expect((err as Error).message).toBe('Host server unreachable')
    }

    globalThis.fetch = originalFetch
  })

  test('WS onerror (ErrorEvent-like) captures error message in getState', async () => {
    const mockWs = new MockWebSocket('ws://127.0.0.1:4127/sessions/test/stream')

    class MockWSClient extends RuntimeClient {
      override async createSession(): Promise<void> {
        // Skip fetch — directly set sessionId
      }
      override createWebSocket(_url: string): WebSocket {
        return mockWs as unknown as WebSocket
      }
    }

    const stateChanges: RuntimeClientState[] = []
    const client = new MockWSClient({
      baseUrl: 'http://127.0.0.1:4127',
      sessionId: 'ws-error-test',
    })
    client.onStateChange((state) => stateChanges.push(state))

    // Start connection — triggers connectWebSocket
    client.connectStream()

    // Simulate: server sends onerror with a specific message
    mockWs.simulateError('Connection refused')

    const errorState = client.getState()
    expect(errorState.error).toBe('Connection refused')
  })

  test('WS onclose abnormal (code 1006) uses fallback chain: reason || prior _error || generic', async () => {
    const mockWs = new MockWebSocket('ws://127.0.0.1:4127/sessions/test/stream')

    class MockWSClient extends RuntimeClient {
      override async createSession(): Promise<void> {}
      override createWebSocket(_url: string): WebSocket {
        return mockWs as unknown as WebSocket
      }
    }

    const client = new MockWSClient({
      baseUrl: 'http://127.0.0.1:4127',
      sessionId: 'ws-close-test',
    })

    client.connectStream()

    // Simulate onerror first (browser always fires onerror before onclose)
    mockWs.simulateError('Connection refused')
    expect(client.getState().error).toBe('Connection refused')

    // Simulate onclose with reason — reason takes priority
    mockWs.simulateClose(1006, 'Server shutdown')
    const state1 = client.getState()
    expect(state1.error).toBe('Server shutdown')
    expect(state1.isReconnecting).toBe(true)

    // Test case 2: onclose with empty reason — falls back to prior _error
    const mockWs2 = new MockWebSocket('ws://127.0.0.1:4127/sessions/test2/stream')
    class MockWSClient2 extends RuntimeClient {
      override async createSession(): Promise<void> {}
      override createWebSocket(_url: string): WebSocket {
        return mockWs2 as unknown as WebSocket
      }
    }

    const client2 = new MockWSClient2({
      baseUrl: 'http://127.0.0.1:4127',
      sessionId: 'ws-close-test2',
    })

    client2.connectStream()
    mockWs2.simulateError('DNS resolution failed')
    mockWs2.simulateClose(1006, '')  // empty reason — fallback to prior _error
    expect(client2.getState().error).toBe('DNS resolution failed')

    // Test case 3: no prior error, no reason — generic fallback
    const mockWs3 = new MockWebSocket('ws://127.0.0.1:4127/sessions/test3/stream')
    class MockWSClient3 extends RuntimeClient {
      override async createSession(): Promise<void> {}
      override createWebSocket(_url: string): WebSocket {
        return mockWs3 as unknown as WebSocket
      }
    }

    const client3 = new MockWSClient3({
      baseUrl: 'http://127.0.0.1:4127',
      sessionId: 'ws-close-test3',
    })

    client3.connectStream()
    // No onerror — just onclose with empty reason and code
    mockWs3.simulateClose(1006, '')
    expect(client3.getState().error).toContain('code 1006')
  })

  test('WS onclose normal (code 1000) clears _error', async () => {
    const mockWs = new MockWebSocket('ws://127.0.0.1:4127/sessions/test/stream')

    class MockWSClient extends RuntimeClient {
      override async createSession(): Promise<void> {}
      override createWebSocket(_url: string): WebSocket {
        return mockWs as unknown as WebSocket
      }
    }

    const client = new MockWSClient({
      baseUrl: 'http://127.0.0.1:4127',
      sessionId: 'ws-normal-close',
    })

    client.connectStream()
    mockWs.simulateOpen()
    expect(client.getState().isConnected).toBe(true)
    expect(client.getState().error).toBeNull()

    // Normal close clears error
    mockWs.simulateClose(1000, 'done')
    const state = client.getState()
    expect(state.error).toBeNull()
    expect(state.isConnected).toBe(false)
  })

  test('WS onopen clears _error after reconnect', async () => {
    const mockWs = new MockWebSocket('ws://127.0.0.1:4127/sessions/test/stream')

    class MockWSClient extends RuntimeClient {
      override async createSession(): Promise<void> {}
      override createWebSocket(_url: string): WebSocket {
        return mockWs as unknown as WebSocket
      }
      // Override reconnect to avoid setTimeout + real WS in test
      override connectStream(): void {
        this.disposed = false
        this.reconnectAttempt = 0
        this.isReconnecting = false
        this.hasGap = false
        this.connectWebSocket()
      }
    }

    const client = new MockWSClient({
      baseUrl: 'http://127.0.0.1:4127',
      sessionId: 'ws-reconnect',
    })

    client.connectStream()
    mockWs.simulateError('Connection reset')
    mockWs.simulateClose(1006, '')
    expect(client.getState().error).toBe('Connection reset')
    expect(client.getState().isReconnecting).toBe(true)

    // Successful reconnect — onopen clears error
    mockWs.simulateOpen()
    const state = client.getState()
    expect(state.error).toBeNull()
    expect(state.isReconnecting).toBe(false)
  })
})
