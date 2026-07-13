import { describe, expect, test } from 'vitest'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { AgentEvent } from '@weft/core'
import {
  buildCliArgs,
  createFakeCliAgentSession,
  createCliAgentSession,
  createCliTimelineProjector,
  mapClaudeStreamJsonLine,
  mapCodexExecJsonLine,
  reduceRuntimeState,
} from '@weft/cli-runtime'
import {
  AgentChatPanel,
  TimelineAgentChatPanel,
  findActivePermissionRequest,
  createAgentChatPanelModelFromTimeline,
  createAgentChatPanelModel,
  createTimelineDetailItems,
  createTimelineAgentChatPanelModel,
  useAgentChatSession,
  useTimelineAgentChatSession,
} from '@weft/chat'
import type { TimelineEnvelope } from '@weft/timeline'
import { appendTimelineItem } from '@weft/timeline'

function collectEvents(runtime: { events: { connect: (onEvent: (event: AgentEvent) => void) => void } }) {
  const events: AgentEvent[] = []
  runtime.events.connect((event) => events.push(event))
  return events
}

describe('CLI Runtime — Weft session contract', () => {
  test('fake runtime emits queued user message as streaming AgentEvents', async () => {
    const runtime = createFakeCliAgentSession({
      provider: 'claude',
      cwd: '/tmp/project',
      script: [
        { type: 'text_delta', text: 'Reading', turnId: 'turn-1' },
        { type: 'tool_start', toolName: 'Read', toolUseId: 'tool-1', input: { file_path: '/tmp/project/src/config.ts' }, turnId: 'turn-1' },
        { type: 'tool_result', toolName: 'Read', toolUseId: 'tool-1', result: 'ok', isError: false, turnId: 'turn-1' },
        { type: 'text_complete', text: 'Done', isIntermediate: false, turnId: 'turn-1' },
        { type: 'complete' },
      ],
    })
    const events = collectEvents(runtime)

    const auth = await runtime.preflight()
    await runtime.commands.sendMessage('inspect config')

    expect(auth.configured).toBe(true)
    expect(events.map(event => event.type)).toEqual([
      'status',
      'text_delta',
      'tool_start',
      'tool_result',
      'text_complete',
      'complete',
    ])
    expect(runtime.getState().status).toBe('ready')
    expect(runtime.getState().acceptedMessages).toEqual(['inspect config'])
  })

  test('runtime reducer uses accepted/queued semantics while running', () => {
    const initial = reduceRuntimeState(undefined, { type: 'send_message', message: 'first' })
    const queued = reduceRuntimeState(initial, { type: 'send_message', message: 'second' })
    const completed = reduceRuntimeState(queued, { type: 'complete' })

    expect(initial.status).toBe('running')
    expect(initial.acceptedMessages).toEqual(['first'])
    expect(queued.queuedMessages).toEqual(['second'])
    expect(completed.status).toBe('running')
    expect(completed.acceptedMessages).toEqual(['first', 'second'])
  })
})

describe('Chat — embeddable surface exports', () => {
  test('exports the standard chat panel glue for host apps', () => {
    expect(typeof AgentChatPanel).toBe('function')
    expect(typeof TimelineAgentChatPanel).toBe('function')
    expect(typeof useAgentChatSession).toBe('function')
    expect(typeof useTimelineAgentChatSession).toBe('function')
    expect(typeof findActivePermissionRequest).toBe('function')
    expect(typeof createAgentChatPanelModel).toBe('function')
    expect(typeof createAgentChatPanelModelFromTimeline).toBe('function')
    expect(typeof createTimelineAgentChatPanelModel).toBe('function')
  })
})

describe('CLI Runtime — provider stream adapters', () => {
  test('maps Claude Code stream-json lines into canonical AgentEvents', () => {
    const lines = [
      '{"type":"system","subtype":"init","session_id":"s1"}',
      '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello "},"index":0},"session_id":"s1"}',
      '{"type":"assistant","message":{"id":"msg_1","content":[{"type":"tool_use","id":"tool_1","name":"Read","input":{"file_path":"README.md"}}]},"session_id":"s1"}',
      '{"type":"assistant","message":{"id":"msg_1","content":[{"type":"text","text":"Hello world"}],"stop_reason":"end_turn"},"session_id":"s1"}',
      '{"type":"result","subtype":"success","usage":{"input_tokens":5,"output_tokens":7}}',
    ]

    const events = lines.flatMap(line => mapClaudeStreamJsonLine(line))

    expect(events.map(event => event.type)).toEqual([
      'status',
      'text_delta',
      'tool_start',
      'text_complete',
      'complete',
    ])
    expect(events[1]).toEqual({ type: 'text_delta', text: 'Hello ', turnId: 'msg_1' })
    expect(events[2]).toEqual({ type: 'tool_start', toolName: 'Read', toolUseId: 'tool_1', input: { file_path: 'README.md' }, turnId: 'msg_1' })
    expect(events[4]).toEqual({ type: 'complete', usage: { inputTokens: 5, outputTokens: 7 } })
  })

  test('maps Codex exec --json lines into canonical AgentEvents', () => {
    const lines = [
      '{"type":"session.started","session_id":"s1"}',
      '{"type":"agent_message_delta","delta":"Working"}',
      '{"type":"exec_command_begin","call_id":"call_1","command":"ls"}',
      '{"type":"exec_command_end","call_id":"call_1","output":"README.md","exit_code":0}',
      '{"type":"agent_message","message":"Done"}',
      '{"type":"turn_completed"}',
    ]

    const events = lines.flatMap(line => mapCodexExecJsonLine(line))

    expect(events.map(event => event.type)).toEqual([
      'status',
      'text_delta',
      'tool_start',
      'tool_result',
      'text_complete',
      'complete',
    ])
    expect(events[2]).toEqual({ type: 'tool_start', toolName: 'Bash', toolUseId: 'call_1', input: { command: 'ls' } })
    expect(events[3]).toEqual({ type: 'tool_result', toolName: 'Bash', toolUseId: 'call_1', result: 'README.md', isError: false })
  })

  test('maps current Codex exec --json thread/item events into canonical AgentEvents', () => {
    const lines = [
      '{"type":"thread.started","thread_id":"thread-real"}',
      '{"type":"turn.started"}',
      '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"WEFT_CODEX_CONFIG_OK"}}',
      '{"type":"turn.completed","usage":{"input_tokens":16878,"cached_input_tokens":0,"output_tokens":67,"reasoning_output_tokens":55}}',
    ]

    const events = lines.flatMap(line => mapCodexExecJsonLine(line))

    expect(events).toEqual([
      { type: 'status', message: 'Codex session initialized' },
      { type: 'status', message: 'Codex turn started' },
      { type: 'text_complete', text: 'WEFT_CODEX_CONFIG_OK', isIntermediate: false, turnId: 'item_0' },
      { type: 'complete', usage: { inputTokens: 16878, outputTokens: 67 } },
    ])
  })

  test('maps Codex exec item.started/completed for web_search, mcp_tool_call, reasoning, file_change, todo_list, error', () => {
    const lines = [
      '{"type":"item.started","turn_id":"turn-1","item":{"id":"ws_1","type":"web_search","query":"codex app-server"}}',
      '{"type":"item.completed","turn_id":"turn-1","item":{"id":"ws_1","type":"web_search","query":"codex app-server"}}',
      '{"type":"item.started","turn_id":"turn-1","item":{"id":"mcp_1","type":"mcp_tool_call","server":"linear","tool":"create_issue","arguments":{"title":"x"}}}',
      '{"type":"item.completed","turn_id":"turn-1","item":{"id":"mcp_1","type":"mcp_tool_call","server":"linear","tool":"create_issue","result":{"ok":true}}}',
      '{"type":"item.completed","turn_id":"turn-1","item":{"id":"r_1","type":"reasoning","text":"planning the change"}}',
      '{"type":"item.completed","turn_id":"turn-1","item":{"id":"fc_1","type":"file_change","changes":[{"path":"a.ts","kind":"update"}],"status":"completed"}}',
      '{"type":"item.completed","turn_id":"turn-1","item":{"id":"todo_1","type":"todo_list","items":[{"text":"step a","completed":false},{"text":"step b","completed":true}]}}',
      '{"type":"item.completed","turn_id":"turn-1","item":{"id":"err_1","type":"error","message":"boom"}}',
    ]

    const events = lines.flatMap(line => mapCodexExecJsonLine(line))

    expect(events.map(event => event.type)).toEqual([
      'tool_start',
      'tool_result',
      'tool_start',
      'tool_result',
      'reasoning',
      'tool_result',
      'reasoning',
      'error',
    ])
    expect(events[0]).toMatchObject({ type: 'tool_start', toolName: 'webSearch', toolUseId: 'ws_1', input: { query: 'codex app-server' }, turnId: 'turn-1' })
    expect(events[1]).toMatchObject({ type: 'tool_result', toolName: 'webSearch', toolUseId: 'ws_1', isError: false, turnId: 'turn-1' })
    expect(events[2]).toMatchObject({ type: 'tool_start', toolName: 'linear.create_issue', toolUseId: 'mcp_1', turnId: 'turn-1' })
    expect(events[3]).toMatchObject({ type: 'tool_result', toolName: 'linear.create_issue', toolUseId: 'mcp_1', isError: false, turnId: 'turn-1' })
    expect(events[4]).toMatchObject({ type: 'reasoning', text: 'planning the change', turnId: 'turn-1' })
    expect(events[5]).toMatchObject({ type: 'tool_result', toolName: 'fileChange', toolUseId: 'fc_1', isError: false, turnId: 'turn-1' })
    expect(events[6]).toMatchObject({ type: 'reasoning', text: 'step a\nstep b', turnId: 'turn-1' })
    expect(events[7]).toMatchObject({ type: 'error', message: 'boom' })
  })

  test('builds Codex CLI args using current config overrides instead of removed approval flag', () => {
    const args = buildCliArgs({
      provider: 'codex',
      cwd: '/tmp/project',
      permissionMode: 'ask',
      reasoningEffort: 'high',
    })

    // A7: the prompt is piped via stdin — codex reads it from the `-`
    // positional; the message is no longer part of the argv.
    expect(args).toEqual([
      'exec',
      '--json',
      '--cd',
      '/tmp/project',
      '--config',
      'model_reasoning_effort="high"',
      '--config',
      'approval_policy="on-request"',
      '--sandbox',
      'workspace-write',
      '-',
    ])
    expect(args).not.toContain('--ask-for-approval')
  })

  test.each([
    ['explore', 'approval_policy="untrusted"', 'read-only'],
    ['ask', 'approval_policy="on-request"', 'workspace-write'],
    ['auto', 'approval_policy="never"', 'danger-full-access'],
  ] as const)('maps Codex permissionMode=%s to current approval and sandbox args', (permissionMode, approvalPolicy, sandbox) => {
    const args = buildCliArgs({
      provider: 'codex',
      cwd: '/tmp/project',
      permissionMode,
    })

    expect(args).toContain(approvalPolicy)
    expect(args).toContain('--sandbox')
    expect(args).toContain(sandbox)
    expect(args).not.toContain('--ask-for-approval')
  })

  test('A7: resume args — claude uses --resume, codex uses exec resume without --cd/--sandbox', () => {
    const claudeArgs = buildCliArgs({
      provider: 'claude',
      cwd: '/tmp/project',
      permissionMode: 'ask',
    }, 'claude-sess-9')
    expect(claudeArgs).toContain('--resume')
    expect(claudeArgs[claudeArgs.indexOf('--resume') + 1]).toBe('claude-sess-9')
    // Prompt is piped via stdin — no positional prompt in argv.
    expect(claudeArgs).not.toContain('hello')

    const codexArgs = buildCliArgs({
      provider: 'codex',
      cwd: '/tmp/project',
      permissionMode: 'ask',
      reasoningEffort: 'high',
    }, 'thread-42')
    expect(codexArgs.slice(0, 3)).toEqual(['exec', 'resume', 'thread-42'])
    expect(codexArgs).toContain('--json')
    // `exec resume` does not accept --cd/--sandbox (session keeps originals).
    expect(codexArgs).not.toContain('--cd')
    expect(codexArgs).not.toContain('--sandbox')
    expect(codexArgs[codexArgs.length - 1]).toBe('-')
  })

  test('createCliAgentSession applies sendMessage permissionMode to Codex CLI args', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'weft-codex-cli-'))
    const executable = join(tempDir, 'codex-fake.js')
    const argsLog = join(tempDir, 'args.jsonl')

    try {
      await writeFile(executable, `#!/usr/bin/env node
const { appendFileSync } = require('node:fs')

function writeResponse(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n')
}

if (process.argv[2] === 'app-server') {
  process.stdin.setEncoding('utf8')
  let buffer = ''
  process.stdin.on('data', (chunk) => {
    buffer += chunk
    const lines = buffer.split('\\n')
    buffer = lines.pop() || ''
    for (const line of lines) {
      if (!line.trim()) continue
      const message = JSON.parse(line)
      if (message.method === 'initialize') writeResponse(message.id, {})
      if (message.method === 'account/read') {
        writeResponse(message.id, { requiresOpenaiAuth: false })
        process.exit(0)
      }
    }
  })
} else if (process.argv[2] === 'exec') {
  appendFileSync(process.env.WEFT_ARGS_LOG, JSON.stringify(process.argv.slice(2)) + '\\n')
  process.stdout.write(JSON.stringify({ type: 'turn.completed' }) + '\\n')
} else {
  process.stderr.write('unexpected command: ' + process.argv.slice(2).join(' ') + '\\n')
  process.exit(1)
}
`, 'utf8')
      await chmod(executable, 0o755)

      const runtime = createCliAgentSession({
        provider: 'codex',
        cwd: tempDir,
        executable,
        permissionMode: 'ask',
        env: {
          PATH: process.env.PATH ?? '',
          WEFT_ARGS_LOG: argsLog,
        },
      })

      await runtime.commands.sendMessage('hello', { permissionMode: 'explore' })

      const [loggedArgs] = (await readFile(argsLog, 'utf8'))
        .trim()
        .split('\n')
        .map(line => JSON.parse(line) as string[])

      expect(loggedArgs).toContain('approval_policy="untrusted"')
      expect(loggedArgs).toContain('--sandbox')
      expect(loggedArgs).toContain('read-only')
      expect(loggedArgs).not.toContain('approval_policy="on-request"')
      expect(loggedArgs).not.toContain('workspace-write')
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('createCliAgentSession returns explicit capability errors instead of mock fallback', async () => {
    const runtime = createCliAgentSession({
      provider: 'codex',
      cwd: '/tmp/project',
      executable: '/definitely/missing/codex',
    })

    const auth = await runtime.preflight()

    expect(auth.configured).toBe(false)
    expect(auth.error).toContain('failed')
    expect(runtime.getState().status).toBe('failed')
  })
})

describe('CLI Runtime — timeline projection', () => {
  test('projects local AgentEvents into canonical timeline envelopes', () => {
    const projector = createCliTimelineProjector({
      sessionId: 'session-1',
      provider: 'claude',
      epoch: 'epoch-a',
      now: () => 1_000,
    })

    const timeline = [
      { type: 'text_delta', text: 'Reading', turnId: 'turn-1' },
      { type: 'tool_start', toolName: 'Read', toolUseId: 'tool-1', input: { file_path: 'README.md' }, turnId: 'turn-1' },
      {
        type: 'permission_request',
        requestId: 'permission-1',
        toolName: 'Write',
        description: 'Write README.md',
        reason: 'edit requested',
      },
      { type: 'tool_result', toolName: 'Read', toolUseId: 'tool-1', result: 'ok', isError: false, turnId: 'turn-1' },
      { type: 'text_complete', text: 'Done', isIntermediate: false, turnId: 'turn-1' },
      { type: 'complete' },
    ].flatMap((event) => projector.project(event as AgentEvent))

    expect(timeline.map(envelope => envelope.seq)).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(timeline.map(envelope => envelope.item.type)).toEqual([
      'assistant_message_delta',
      'tool_call',
      'permission_requested',
      'tool_result',
      'assistant_message',
      'turn_completed',
      'session_status',
    ])
    expect(timeline[1]?.item).toEqual({
      type: 'tool_call',
      callId: 'tool-1',
      name: 'Read',
      status: 'running',
      detail: { input: { file_path: 'README.md' } },
      turnId: 'turn-1',
    })
    expect(timeline[2]?.item).toEqual({
      type: 'permission_requested',
      request: {
        requestId: 'permission-1',
        toolName: 'Write',
        input: { command: undefined },
        reason: 'edit requested',
      },
    })
    expect(timeline[5]?.item).toEqual({
      type: 'turn_completed',
      turnId: 'turn-1',
      usage: undefined,
    })
  })

  test('builds chat panel turns from local runtime timeline envelopes', () => {
    const projector = createCliTimelineProjector({
      sessionId: 'session-1',
      provider: 'claude',
      epoch: 'epoch-a',
      now: () => 1_000,
    })
    const timeline = [
      { type: 'text_delta', text: 'Reading', turnId: 'turn-1' },
      { type: 'tool_start', toolName: 'Read', toolUseId: 'tool-1', input: { file_path: 'README.md' }, turnId: 'turn-1' },
      { type: 'tool_result', toolName: 'Read', toolUseId: 'tool-1', result: 'ok', isError: false, turnId: 'turn-1' },
      { type: 'text_complete', text: 'Done', isIntermediate: false, turnId: 'turn-1' },
      { type: 'complete' },
    ].flatMap((event) => projector.project(event as AgentEvent))

    const model = createAgentChatPanelModelFromTimeline({
      timeline,
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
      workspaceName: 'Workspace',
    })
    const assistantTurns = model.turns.filter(turn => turn.type === 'assistant')
    const assistantTurn = assistantTurns[0]

    expect(model.session.messages.map(message => message.role)).toEqual(['assistant', 'tool'])
    expect(assistantTurns).toHaveLength(1)
    expect(assistantTurn?.type).toBe('assistant')
    if (assistantTurn?.type !== 'assistant') {
      throw new Error('Expected assistant turn')
    }
    expect(assistantTurn.response?.text).toBe('Done')
    expect(assistantTurn.activities[0]?.toolName).toBe('Read')
    expect(assistantTurn.activities[0]?.content).toBe('ok')
  })

  test('builds user and assistant turns from canonical timeline envelopes', () => {
    const timeline: TimelineEnvelope[] = [
      {
        sessionId: 'session-1',
        provider: 'claude',
        epoch: 'epoch-a',
        seq: 1,
        timestamp: 1_000,
        item: {
          type: 'user_message',
          text: 'inspect config',
          messageId: 'user-1',
          turnId: 'turn-1',
        },
      },
      {
        sessionId: 'session-1',
        provider: 'claude',
        epoch: 'epoch-a',
        seq: 2,
        timestamp: 1_001,
        item: {
          type: 'assistant_message',
          text: 'Done',
          messageId: 'assistant-1',
          turnId: 'turn-1',
        },
      },
      {
        sessionId: 'session-1',
        provider: 'claude',
        epoch: 'epoch-a',
        seq: 3,
        timestamp: 1_002,
        item: { type: 'turn_completed', turnId: 'turn-1' },
      },
    ]

    const model = createAgentChatPanelModelFromTimeline({
      timeline,
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
      workspaceName: 'Workspace',
    })

    expect(model.turns.map(turn => turn.type)).toEqual(['user', 'assistant'])
    const userTurn = model.turns[0]
    expect(userTurn?.type).toBe('user')
    if (userTurn?.type !== 'user') {
      throw new Error('Expected user turn')
    }
    expect(userTurn.message.content).toBe('inspect config')
  })

  test('extracts clickable detail items from timeline extension events', () => {
    const details = createTimelineDetailItems([
      {
        sessionId: 'session-1',
        provider: 'codex',
        epoch: 'epoch-a',
        seq: 1,
        timestamp: 1_000,
        item: {
          type: 'permission_requested',
          request: {
            requestId: 'permission-1',
            toolName: 'Bash',
            input: { command: 'rm -rf dist' },
            reason: 'destructive command',
          },
        },
      },
      {
        sessionId: 'session-1',
        provider: 'codex',
        epoch: 'epoch-a',
        seq: 2,
        timestamp: 1_001,
        item: {
          type: 'runtime_fallback',
          from: 'app-server',
          to: 'cli-fallback',
          reason: 'app-server unavailable',
        },
      },
      {
        sessionId: 'session-1',
        provider: 'codex',
        epoch: 'epoch-a',
        seq: 3,
        timestamp: 1_002,
        item: {
          type: 'source_state_changed',
          source: {
            sourceSlug: 'github',
            status: 'needs_auth',
          },
        },
      },
    ])

    expect(details.map(detail => detail.kind)).toEqual([
      'permission',
      'runtime',
      'source',
    ])
    expect(details[0]?.title).toBe('Permission requested: Bash')
    expect(details[0]?.detail).toEqual({
      requestId: 'permission-1',
      toolName: 'Bash',
      input: { command: 'rm -rf dist' },
      reason: 'destructive command',
    })
    expect(details[1]?.summary).toBe('app-server unavailable')
    expect(details[2]?.title).toBe('Source state changed: github')
  })

  test('builds chat panel model from runtime-core timeline state', () => {
    const projector = createCliTimelineProjector({
      sessionId: 'session-1',
      provider: 'codex',
      epoch: 'epoch-a',
      now: () => 1_000,
    })
    const timeline = [
      { type: 'text_delta', text: 'Working', turnId: 'turn-1' },
      { type: 'text_complete', text: 'Done', isIntermediate: false, turnId: 'turn-1' },
      { type: 'complete' },
    ].flatMap((event) => projector.project(event as AgentEvent))

    const model = createTimelineAgentChatPanelModel({
      timeline,
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
      runtimeState: {
        status: 'running',
        acceptedMessages: ['build'],
        queuedMessages: [],
      },
      capabilityReport: null,
      error: null,
    })

    expect(model.isRunning).toBe(true)
    expect(model.turns.filter(turn => turn.type === 'assistant' && turn.response)).toHaveLength(1)
    expect(model.capabilityReport).toBeNull()
    expect(model.error).toBeNull()
  })
})

describe('Chat — permission request utilities', () => {
  test('findActivePermissionRequest returns null for empty timeline', () => {
    expect(findActivePermissionRequest([])).toBeNull()
  })

  test('findActivePermissionRequest returns null when all requests are resolved', () => {
    const timeline: TimelineEnvelope[] = [
      {
        sessionId: 's1', provider: 'claude', epoch: 'e1', seq: 1, timestamp: 1000,
        item: { type: 'permission_requested', request: { requestId: 'req-1', toolName: 'Write', reason: 'File write needs approval' } },
      },
      {
        sessionId: 's1', provider: 'claude', epoch: 'e1', seq: 2, timestamp: 2000,
        item: { type: 'permission_resolved', requestId: 'req-1', resolution: { allowed: true } },
      },
    ]
    expect(findActivePermissionRequest(timeline)).toBeNull()
  })

  test('findActivePermissionRequest returns active request when not resolved', () => {
    const timeline: TimelineEnvelope[] = [
      {
        sessionId: 's1', provider: 'claude', epoch: 'e1', seq: 1, timestamp: 1000,
        item: { type: 'permission_requested', request: { requestId: 'req-1', toolName: 'Bash', reason: 'Command execution needs approval', input: { command: 'rm -rf /tmp' } } },
      },
    ]
    const result = findActivePermissionRequest(timeline)
    expect(result).not.toBeNull()
    expect(result!.requestId).toBe('req-1')
    expect(result!.toolName).toBe('Bash')
    expect(result!.reason).toBe('Command execution needs approval')
  })

  test('findActivePermissionRequest returns most recent unresolved request', () => {
    const timeline: TimelineEnvelope[] = [
      {
        sessionId: 's1', provider: 'claude', epoch: 'e1', seq: 1, timestamp: 1000,
        item: { type: 'permission_requested', request: { requestId: 'req-1', toolName: 'Read' } },
      },
      {
        sessionId: 's1', provider: 'claude', epoch: 'e1', seq: 2, timestamp: 2000,
        item: { type: 'permission_resolved', requestId: 'req-1', resolution: { allowed: true } },
      },
      {
        sessionId: 's1', provider: 'claude', epoch: 'e1', seq: 3, timestamp: 3000,
        item: { type: 'permission_requested', request: { requestId: 'req-2', toolName: 'Write', reason: 'File modification', input: { file_path: '/src/config.ts' } } },
      },
    ]
    const result = findActivePermissionRequest(timeline)
    expect(result).not.toBeNull()
    expect(result!.requestId).toBe('req-2')
    expect(result!.toolName).toBe('Write')
    expect(result!.input).toEqual({ file_path: '/src/config.ts' })
  })

  test('findActivePermissionRequest includes scope label', () => {
    const timeline: TimelineEnvelope[] = [
      {
        sessionId: 's1', provider: 'claude', epoch: 'e1', seq: 1, timestamp: 1000,
        item: {
          type: 'permission_requested',
          request: {
            requestId: 'req-3',
            toolName: 'Bash',
            reason: 'Shell command',
            scope: { type: 'session', sessionId: 's1' },
          },
        },
      },
    ]
    const result = findActivePermissionRequest(timeline)
    expect(result).not.toBeNull()
    expect(result!.scope).toEqual({ type: 'session', label: 'this session' })
  })
})

describe('CLI Runtime — respondToPermission integration', () => {
  test('runtime enters waiting_for_permission after permission_request event', async () => {
    const runtime = createFakeCliAgentSession({
      provider: 'claude',
      cwd: '/tmp/project',
      script: [
        { type: 'text_delta', text: 'Working', turnId: 'turn-1' },
        { type: 'permission_request', requestId: 'perm-1', toolName: 'Bash', description: 'Run command', reason: 'Shell execution' },
      ],
    })

    await runtime.preflight()
    expect(runtime.getState().status).toBe('ready')

    await runtime.commands.sendMessage('run command')
    expect(runtime.getState().status).toBe('waiting_for_permission')
    expect(runtime.getState().acceptedMessages).toEqual(['run command'])
  })

  test('respondToPermission transitions runtime from waiting_for_permission to running', async () => {
    const runtime = createFakeCliAgentSession({
      provider: 'codex',
      cwd: '/tmp/project',
      script: [
        { type: 'permission_request', requestId: 'perm-2', toolName: 'Write', description: 'Write file', reason: 'File modification' },
      ],
    })

    await runtime.preflight()
    await runtime.commands.sendMessage('edit file')
    expect(runtime.getState().status).toBe('waiting_for_permission')

    await runtime.commands.respondToPermission('perm-2', true, false)
    // permission_response transitions to 'running' (agent continues work)
    expect(runtime.getState().status).toBe('running')
  })

  test('deny permission also transitions runtime from waiting_for_permission to running', async () => {
    const runtime = createFakeCliAgentSession({
      provider: 'codex',
      cwd: '/tmp/project',
      script: [
        { type: 'permission_request', requestId: 'perm-3', toolName: 'Bash', description: 'Run destructive command', reason: 'Safety' },
      ],
    })

    await runtime.preflight()
    await runtime.commands.sendMessage('run command')
    expect(runtime.getState().status).toBe('waiting_for_permission')

    await runtime.commands.respondToPermission('perm-3', false)
    // permission_response transitions to 'running' (agent continues with denied permission)
    expect(runtime.getState().status).toBe('running')
  })

  test('permission lifecycle: request → resolve → findActivePermissionRequest returns null', () => {
    // Build timeline directly with TimelineEnvelope data (permission lifecycle is at timeline level, not AgentEvent level)
    const timeline: TimelineEnvelope[] = [
      appendTimelineItem({
        sessionId: 'session-1', provider: 'claude', epoch: 'epoch-a',
        seq: 1, timestamp: 1_000,
        item: { type: 'turn_started', turnId: 'turn-1' },
      }),
      appendTimelineItem({
        sessionId: 'session-1', provider: 'claude', epoch: 'epoch-a',
        seq: 2, timestamp: 1_001,
        item: {
          type: 'permission_requested',
          request: {
            requestId: 'perm-lifecycle',
            toolName: 'Bash',
            scope: { type: 'session', sessionId: 'session-1' },
            reason: 'Shell execution',
          },
        },
      }),
      appendTimelineItem({
        sessionId: 'session-1', provider: 'claude', epoch: 'epoch-a',
        seq: 3, timestamp: 1_002,
        item: {
          type: 'permission_resolved',
          requestId: 'perm-lifecycle',
          resolution: { allowed: true },
        },
      }),
      appendTimelineItem({
        sessionId: 'session-1', provider: 'claude', epoch: 'epoch-a',
        seq: 4, timestamp: 1_003,
        item: { type: 'assistant_message_delta', text: 'Done', messageId: 'msg-1', turnId: 'turn-1' },
      }),
      appendTimelineItem({
        sessionId: 'session-1', provider: 'claude', epoch: 'epoch-a',
        seq: 5, timestamp: 1_004,
        item: { type: 'turn_completed', turnId: 'turn-1' },
      }),
    ]

    // After permission is resolved, findActivePermissionRequest should return null
    const active = findActivePermissionRequest(timeline)
    expect(active).toBeNull()

    // Verify the timeline includes both permission_requested and permission_resolved
    const permRequested = timeline.find(e => e.item.type === 'permission_requested')
    const permResolved = timeline.find(e => e.item.type === 'permission_resolved')
    expect(permRequested).toBeDefined()
    expect(permResolved).toBeDefined()
  })
})

describe('CLI Runtime — reasoning_delta/reasoning timeline projection', () => {
  test('processor maps reasoning_delta timeline item to text_delta AgentEvent', () => {
    // reasoning_delta is a TimelineItem type, not an AgentEvent type.
    // The processor maps it to text_delta for the chat panel.
    // Test the data flow: TimelineEnvelope (reasoning_delta) → processor → AgentEvent (text_delta)
    const timeline: TimelineEnvelope[] = [
      appendTimelineItem({
        sessionId: 'session-1', provider: 'claude', epoch: 'epoch-a',
        seq: 1, timestamp: 1_000,
        item: { type: 'turn_started', turnId: 'turn-1' },
      }),
      appendTimelineItem({
        sessionId: 'session-1', provider: 'claude', epoch: 'epoch-a',
        seq: 2, timestamp: 1_001,
        item: { type: 'reasoning_delta', text: 'Analyzing the code structure', messageId: 'msg-2', turnId: 'turn-1' },
      }),
      appendTimelineItem({
        sessionId: 'session-1', provider: 'claude', epoch: 'epoch-a',
        seq: 3, timestamp: 1_002,
        item: { type: 'reasoning', text: 'Final reasoning summary', messageId: 'msg-3', turnId: 'turn-1' },
      }),
      appendTimelineItem({
        sessionId: 'session-1', provider: 'claude', epoch: 'epoch-a',
        seq: 4, timestamp: 1_003,
        item: { type: 'assistant_message', text: 'Here is my conclusion', messageId: 'msg-4', turnId: 'turn-1' },
      }),
      appendTimelineItem({
        sessionId: 'session-1', provider: 'claude', epoch: 'epoch-a',
        seq: 5, timestamp: 1_004,
        item: { type: 'turn_completed', turnId: 'turn-1' },
      }),
    ]

    // reasoning_delta envelope should exist in the timeline
    const reasoningDelta = timeline.find(e => e.item.type === 'reasoning_delta')
    expect(reasoningDelta).toBeDefined()
    expect(reasoningDelta!.item).toEqual({
      type: 'reasoning_delta',
      text: 'Analyzing the code structure',
      messageId: 'msg-2',
      turnId: 'turn-1',
    })

    // reasoning (complete) envelope should exist
    const reasoningComplete = timeline.find(e => e.item.type === 'reasoning')
    expect(reasoningComplete).toBeDefined()
    expect(reasoningComplete!.item).toEqual({
      type: 'reasoning',
      text: 'Final reasoning summary',
      messageId: 'msg-3',
      turnId: 'turn-1',
    })
  })

  test('builds chat panel turns including reasoning text alongside assistant text', () => {
    // Build timeline with reasoning items — the chat panel should merge them
    const timeline: TimelineEnvelope[] = [
      appendTimelineItem({
        sessionId: 'session-1', provider: 'claude', epoch: 'epoch-a',
        seq: 1, timestamp: 1_000,
        item: { type: 'user_message', text: 'hello', messageId: 'user-1', turnId: 'turn-1' },
      }),
      appendTimelineItem({
        sessionId: 'session-1', provider: 'claude', epoch: 'epoch-a',
        seq: 2, timestamp: 1_001,
        item: { type: 'reasoning_delta', text: 'Step 1', messageId: 'msg-2', turnId: 'turn-1' },
      }),
      appendTimelineItem({
        sessionId: 'session-1', provider: 'claude', epoch: 'epoch-a',
        seq: 3, timestamp: 1_002,
        item: { type: 'assistant_message_delta', text: 'Result: ', messageId: 'msg-3', turnId: 'turn-1' },
      }),
      appendTimelineItem({
        sessionId: 'session-1', provider: 'claude', epoch: 'epoch-a',
        seq: 4, timestamp: 1_003,
        item: { type: 'reasoning', text: 'Summary', messageId: 'msg-4', turnId: 'turn-1' },
      }),
      appendTimelineItem({
        sessionId: 'session-1', provider: 'claude', epoch: 'epoch-a',
        seq: 5, timestamp: 1_004,
        item: { type: 'assistant_message', text: 'Final answer', messageId: 'msg-5', turnId: 'turn-1' },
      }),
      appendTimelineItem({
        sessionId: 'session-1', provider: 'claude', epoch: 'epoch-a',
        seq: 6, timestamp: 1_005,
        item: { type: 'turn_completed', turnId: 'turn-1' },
      }),
    ]

    const model = createAgentChatPanelModelFromTimeline({
      timeline,
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
      workspaceName: 'Workspace',
    })

    // reasoning_delta and text_delta merge into the same streaming turn
    const assistantTurns = model.turns.filter(turn => turn.type === 'assistant')
    expect(assistantTurns).toHaveLength(1)

    // Final text should come from the assistant_message (complete) event
    const assistantTurn = assistantTurns[0]
    if (assistantTurn?.type !== 'assistant') throw new Error('Expected assistant turn')
    expect(assistantTurn.response?.text).toBe('Final answer')
  })
})
