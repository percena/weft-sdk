import { describe, expect, test } from 'vitest'
import type { Options, PermissionResult, SDKMessage } from '@anthropic-ai/claude-agent-sdk'

import {
  createClaudeNativeSdkDriver,
  createClaudeProviderRuntime,
  createClaudeRuntimeCandidates,
  type ClaudeSdkQuery,
  type ClaudeSdkQueryRunner,
} from '@weft/providers/claude'
import type { RuntimePolicyHook } from '@weft/runtime-core'
import { createTimelineSequencer } from '@weft/timeline'
import type { TimelineItem, TimelineSequencer } from '@weft/timeline'

/**
 * Fake SDK `query()` runner: yields canned SDK messages and optionally captures
 * the Options the driver built, so we can assert what weft threaded through.
 */
function fakeQuery(
  messages: SDKMessage[],
  capture?: (opts: Options) => void,
): ClaudeSdkQueryRunner {
  return ({ options }) => {
    if (capture) capture(options ?? ({} as Options))
    async function* gen(): AsyncGenerator<SDKMessage> {
      for (const message of messages) yield message
    }
    return gen() as unknown as ClaudeSdkQuery
  }
}

/** Minimal SDK-shaped message, cast through unknown for projection tests. */
function msg(message: unknown): SDKMessage {
  return message as unknown as SDKMessage
}

const baseRuntimeOptions = {
  cwd: '/tmp/project',
  candidates: createClaudeRuntimeCandidates({
    nativeSdkAvailable: true,
    cliFallbackAvailable: false,
  }),
  auth: { mode: 'provider-owned' as const, configured: true, source: 'test' },
  now: () => 0,
}

describe('Claude native SDK driver — option threading', () => {
  test('threads sdkOptions (resume, skills, settingSources, agents, thinking, maxTurns, systemPrompt) to query', async () => {
    let captured: Options | undefined
    const runtime = createClaudeProviderRuntime({
      ...baseRuntimeOptions,
      query: fakeQuery([msg({ type: 'result', subtype: 'success' })], (o) => (captured = o)),
      sdkOptions: {
        resume: 'sess-abc',
        sessionId: 'sess-abc',
        forkSession: true,
        persistSession: false,
        skills: ['code-review'],
        settingSources: ['user', 'project'],
        agents: { 'reviewer': { description: 'd', prompt: 'p' } as never },
        thinking: { type: 'enabled', budgetTokens: 4096 } as never,
        maxTurns: 12,
        maxBudgetUsd: 1.5,
        systemPrompt: 'You are a test agent',
        additionalDirectories: ['/extra'],
      } as Options,
    })
    await runtime.preflight()
    await runtime.commands.sendMessage('hello')

    expect(captured?.resume).toBe('sess-abc')
    expect(captured?.forkSession).toBe(true)
    expect(captured?.persistSession).toBe(false)
    expect(captured?.skills).toEqual(['code-review'])
    expect(captured?.settingSources).toEqual(['user', 'project'])
    expect(captured?.maxTurns).toBe(12)
    expect(captured?.maxBudgetUsd).toBe(1.5)
    expect(captured?.systemPrompt).toBe('You are a test agent')
    expect(captured?.additionalDirectories).toEqual(['/extra'])
  })

  test('per-turn SendMessageOptions override model, effort, permissionMode, and outputSchema→outputFormat', async () => {
    let captured: Options | undefined
    const runtime = createClaudeProviderRuntime({
      ...baseRuntimeOptions,
      model: 'claude-default-model',
      query: fakeQuery([msg({ type: 'result', subtype: 'success' })], (o) => (captured = o)),
    })
    await runtime.preflight()
    await runtime.commands.sendMessage('hi', {
      model: 'claude-opus-4-8',
      reasoningEffort: 'xhigh',
      permissionMode: 'auto',
      outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
    } as never)

    expect(captured?.model).toBe('claude-opus-4-8')
    expect(captured?.effort).toBe('xhigh')
    expect(captured?.permissionMode).toBe('bypassPermissions')
    expect(captured?.allowDangerouslySkipPermissions).toBe(true)
    expect(captured?.outputFormat).toEqual({
      type: 'json_schema',
      schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
    })
  })

  test('permissionMode mapping: safe→plan, ask→default, allow-all→bypassPermissions', async () => {
    const captured: Options[] = []
    const run = async (mode: 'explore' | 'ask' | 'auto') => {
      const runtime = createClaudeProviderRuntime({
        ...baseRuntimeOptions,
        permissionMode: mode,
        query: fakeQuery([msg({ type: 'result', subtype: 'success' })], (o) => captured.push(o)),
      })
      await runtime.preflight()
      await runtime.commands.sendMessage('x')
    }
    await run('explore')
    await run('ask')
    await run('auto')

    expect(captured[0]?.permissionMode).toBe('plan')
    expect(captured[1]?.permissionMode).toBe('default')
    expect(captured[2]?.permissionMode).toBe('bypassPermissions')
    expect(captured[2]?.allowDangerouslySkipPermissions).toBe(true)
  })

  test('sdkOptions.permissionMode is preserved when no weft-level mode is set', async () => {
    let captured: Options | undefined
    const runtime = createClaudeProviderRuntime({
      ...baseRuntimeOptions,
      // No weft-level permissionMode — sdkOptions.permissionMode should survive.
      query: fakeQuery([msg({ type: 'result', subtype: 'success' })], (o) => (captured = o)),
      sdkOptions: { permissionMode: 'acceptEdits' } as Options,
    })
    await runtime.preflight()
    await runtime.commands.sendMessage('hi')

    expect(captured?.permissionMode).toBe('acceptEdits')
  })

  test('weft permissionMode overrides sdkOptions.permissionMode when explicitly set', async () => {
    let captured: Options | undefined
    const runtime = createClaudeProviderRuntime({
      ...baseRuntimeOptions,
      permissionMode: 'explore',
      query: fakeQuery([msg({ type: 'result', subtype: 'success' })], (o) => (captured = o)),
      sdkOptions: { permissionMode: 'acceptEdits' } as Options,
    })
    await runtime.preflight()
    await runtime.commands.sendMessage('hi')

    expect(captured?.permissionMode).toBe('plan')
  })

  test('driver-managed fields always win over stray sdkOptions entries', async () => {
    // A host that (erroneously) also sets cwd/model/env in sdkOptions must not
    // override the driver's own cwd/model (driver fields applied last).
    let captured: Options | undefined
    const runtime = createClaudeProviderRuntime({
      ...baseRuntimeOptions,
      cwd: '/tmp/project',
      model: 'claude-driver-model',
      query: fakeQuery([msg({ type: 'result', subtype: 'success' })], (o) => (captured = o)),
      sdkOptions: { cwd: '/wrong', model: 'wrong-model' } as Options,
    })
    await runtime.preflight()
    await runtime.commands.sendMessage('hi')

    expect(captured?.cwd).toBe('/tmp/project')
    expect(captured?.model).toBe('claude-driver-model')
  })
})

describe('Claude native SDK driver — message projection (P0/P1)', () => {
  test('result.structured_output lands on turn_completed', async () => {
    const out: TimelineItem[] = []
    const runtime = createClaudeProviderRuntime({
      ...baseRuntimeOptions,
      query: fakeQuery([msg({
        type: 'result',
        subtype: 'success',
        usage: { input_tokens: 10, output_tokens: 5 },
        structured_output: { ok: true, count: 3 },
      })]),
    })
    runtime.events.connect((e) => out.push(e.item as TimelineItem))
    await runtime.preflight()
    await runtime.commands.sendMessage('hi')

    const completed = out.find((i) => i.type === 'turn_completed')
    expect(completed).toBeDefined()
    expect(completed).toMatchObject({ structuredOutput: { ok: true, count: 3 } })
  })

  test('stream content_block_start tool_use emits tool_call(running) immediately', async () => {
    const out: TimelineItem[] = []
    const runtime = createClaudeProviderRuntime({
      ...baseRuntimeOptions,
      query: fakeQuery([
        msg({
          type: 'stream_event',
          event: {
            type: 'content_block_start',
            content_block: { type: 'tool_use', id: 'tu-1', name: 'Bash', input: { command: 'ls' } },
          },
        }),
        msg({ type: 'result', subtype: 'success' }),
      ]),
    })
    runtime.events.connect((e) => out.push(e.item as TimelineItem))
    await runtime.preflight()
    await runtime.commands.sendMessage('hi')

    const toolCall = out.find((i) => i.type === 'tool_call')
    expect(toolCall).toMatchObject({
      type: 'tool_call',
      callId: 'tu-1',
      name: 'Bash',
      status: 'running',
    })
  })

  test('tool_progress top-level message maps to a running tool_call', async () => {
    const out: TimelineItem[] = []
    const runtime = createClaudeProviderRuntime({
      ...baseRuntimeOptions,
      query: fakeQuery([
        msg({ type: 'tool_progress', tool_use_id: 'tu-1', tool_name: 'Bash', elapsed_time_seconds: 2.5 }),
        msg({ type: 'result', subtype: 'success' }),
      ]),
    })
    runtime.events.connect((e) => out.push(e.item as TimelineItem))
    await runtime.preflight()
    await runtime.commands.sendMessage('hi')

    const toolCall = out.find((i) => i.type === 'tool_call')
    expect(toolCall).toMatchObject({ type: 'tool_call', callId: 'tu-1', status: 'running' })
  })

  test('auth_status error surfaces as session_status, not dropped', async () => {
    const out: TimelineItem[] = []
    const runtime = createClaudeProviderRuntime({
      ...baseRuntimeOptions,
      query: fakeQuery([
        msg({ type: 'auth_status', error: 'token expired' }),
        msg({ type: 'result', subtype: 'success' }),
      ]),
    })
    runtime.events.connect((e) => out.push(e.item as TimelineItem))
    await runtime.preflight()
    await runtime.commands.sendMessage('hi')

    expect(out.some((i) => i.type === 'session_status' && 'status' in i && i.status === 'auth_error: token expired')).toBe(true)
  })

  test('auth_status without error is projected as session_status, not silently dropped', async () => {
    const out: TimelineItem[] = []
    const runtime = createClaudeProviderRuntime({
      ...baseRuntimeOptions,
      query: fakeQuery([
        msg({ type: 'auth_status', status: 'authenticated' }),
        msg({ type: 'result', subtype: 'success' }),
      ]),
    })
    runtime.events.connect((e) => out.push(e.item as TimelineItem))
    await runtime.preflight()
    await runtime.commands.sendMessage('hi')

    expect(out.some((i) => i.type === 'session_status' && 'status' in i && i.status === 'auth: authenticated')).toBe(true)
  })

  test('system compact_boundary maps to compaction_boundary item; hook_started to session_status', async () => {
    const out: TimelineItem[] = []
    const runtime = createClaudeProviderRuntime({
      ...baseRuntimeOptions,
      query: fakeQuery([
        msg({ type: 'system', subtype: 'compact_boundary' }),
        msg({ type: 'system', subtype: 'hook_started' }),
        msg({ type: 'result', subtype: 'success' }),
      ]),
    })
    runtime.events.connect((e) => out.push(e.item as TimelineItem))
    await runtime.preflight()
    await runtime.commands.sendMessage('hi')

    expect(out.some((i) => i.type === 'compaction_boundary')).toBe(true)
    const statuses = out.filter((i) => i.type === 'session_status').map((i) => (i as { status: string }).status)
    expect(statuses).toContain('hook:hook_started')
  })

  test('failed result subtype projects turn_failed with error detail', async () => {
    const out: TimelineItem[] = []
    const runtime = createClaudeProviderRuntime({
      ...baseRuntimeOptions,
      query: fakeQuery([
        msg({ type: 'result', subtype: 'error_max_budget_usd', errors: ['budget exceeded'], stop_reason: 'max_budget' }),
      ]),
    })
    runtime.events.connect((e) => out.push(e.item as TimelineItem))
    await runtime.preflight()
    await runtime.commands.sendMessage('hi')

    const failed = out.find((i) => i.type === 'turn_failed')
    expect(failed).toBeDefined()
    expect(failed).toMatchObject({
      type: 'turn_failed',
      error: { subtype: 'error_max_budget_usd', stopReason: 'max_budget' },
    })
  })
})

describe('Claude native SDK driver — dynamic control (P1-1)', () => {
  /** A query that yields one message then blocks on an external resolve, so the
   * turn stays "in flight" while we exercise mid-conversation control. */
  function openQuery(control: Record<string, (...args: unknown[]) => Promise<void>>): {
    query: ClaudeSdkQueryRunner
    resolve: () => void
  } {
    let resolve!: () => void
    const promise = new Promise<void>((r) => { resolve = r })
    const query: ClaudeSdkQueryRunner = () => {
      async function* gen(): AsyncGenerator<SDKMessage> {
        yield msg({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } })
        await promise
      }
      return Object.assign(gen(), control) as unknown as ClaudeSdkQuery
    }
    return { query, resolve }
  }

  function sequencer(): TimelineSequencer {
    return createTimelineSequencer({ sessionId: 's', provider: 'claude', epoch: 'e', now: () => 0 })
  }

  test('control methods delegate to the active SDK Query handle mid-turn', async () => {
    const calls: Array<[string, unknown[]]> = []
    const control = {
      setModel: async (...a: unknown[]) => calls.push(['setModel', a]),
      setPermissionMode: async (...a: unknown[]) => calls.push(['setPermissionMode', a]),
      rewindFiles: async (...a: unknown[]) => calls.push(['rewindFiles', a]),
      stopTask: async (...a: unknown[]) => calls.push(['stopTask', a]),
      reconnectMcpServer: async (...a: unknown[]) => calls.push(['reconnectMcpServer', a]),
      toggleMcpServer: async (...a: unknown[]) => calls.push(['toggleMcpServer', a]),
    }
    const { query, resolve } = openQuery(control)
    const driver = createClaudeNativeSdkDriver({ cwd: '/tmp/x', query })

    const send = driver.sendMessage({ message: 'hi' }, sequencer())
    // Let the generator yield + reach the blocking await (activeQuery now set).
    await new Promise((r) => setTimeout(r, 0))

    await driver.setModel('claude-opus-4-8')
    await driver.setPermissionMode('plan')
    await driver.rewindFiles('user-msg-1')
    await driver.stopTask('task-1')
    await driver.reconnectMcpServer('my-mcp')
    await driver.toggleMcpServer('my-mcp', false)

    resolve()
    await send

    expect(calls).toEqual([
      ['setModel', ['claude-opus-4-8']],
      ['setPermissionMode', ['plan']],
      ['rewindFiles', ['user-msg-1']],
      ['stopTask', ['task-1']],
      ['reconnectMcpServer', ['my-mcp']],
      ['toggleMcpServer', ['my-mcp', false]],
    ])
  })

  test('control query accessors return undefined with no turn in flight; mutators no-op', async () => {
    const driver = createClaudeNativeSdkDriver({ cwd: '/tmp/x', query: fakeQuery([]) })
    expect(driver.mcpServerStatus()).toBeUndefined()
    expect(driver.getContextUsage()).toBeUndefined()
    // No active query — must not throw.
    await expect(driver.setModel('x')).resolves.toBeUndefined()
    await expect(driver.stopTask('t')).resolves.toBeUndefined()
  })
})

describe('Claude native SDK driver — MCP source tool mapping', () => {
  test('maps mcp-server stdio/http/sse and skips in-process', async () => {
    let captured: Options | undefined
    const runtime = createClaudeProviderRuntime({
      ...baseRuntimeOptions,
      query: fakeQuery([msg({ type: 'result', subtype: 'success' })], (o) => (captured = o)),
      sourceTools: [
        { kind: 'mcp-server', sourceSlug: 'fs', transport: 'stdio', command: 'npx', args: ['srv'], env: { NODE_ENV: 'test' } },
        { kind: 'mcp-server', sourceSlug: 'api', transport: 'http', url: 'http://localhost:3000', headers: { 'X-Key': 'abc' } },
        { kind: 'mcp-server', sourceSlug: 'stream', transport: 'sse', url: 'http://localhost:3001/sse' },
        { kind: 'in-process', sourceSlug: 'internal', server: { name: 'internal', version: '1.0', tools: [] } },
        { kind: 'api-source', sourceSlug: 'rest-api', baseUrl: 'http://api.example.com', authType: 'bearer' },
        { kind: 'local-source', sourceSlug: 'docs', path: '/tmp/docs' },
      ],
    })
    await runtime.commands.sendMessage('hi')

    expect(captured!.mcpServers).toEqual({
      fs: { type: 'stdio', command: 'npx', args: ['srv'], env: { NODE_ENV: 'test' } },
      api: { type: 'http', url: 'http://localhost:3000', headers: { 'X-Key': 'abc' } },
      stream: { type: 'sse', url: 'http://localhost:3001/sse' },
    })
  })

  test('no sourceTools produces no mcpServers', async () => {
    let captured: Options | undefined
    const runtime = createClaudeProviderRuntime({
      ...baseRuntimeOptions,
      query: fakeQuery([msg({ type: 'result', subtype: 'success' })], (o) => (captured = o)),
    })
    await runtime.commands.sendMessage('hi')

    expect(captured!.mcpServers).toBeUndefined()
  })
})

describe('Claude native SDK driver — message projection completion', () => {
  test('rate_limit_event top-level message projects to a rate_limit item', async () => {
    const out: TimelineItem[] = []
    const runtime = createClaudeProviderRuntime({
      ...baseRuntimeOptions,
      query: fakeQuery([
        msg({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', utilization: 0.82 } }),
        msg({ type: 'result', subtype: 'success' }),
      ]),
    })
    runtime.events.connect((e) => out.push(e.item as TimelineItem))
    await runtime.preflight()
    await runtime.commands.sendMessage('hi')

    const rl = out.find((i) => i.type === 'rate_limit')
    expect(rl).toBeDefined()
    expect((rl as { info: { status: string } }).info).toMatchObject({ status: 'allowed_warning' })
  })

  test('result message enriches turn_completed with cost / duration / numTurns / result / sessionId', async () => {
    const out: TimelineItem[] = []
    const runtime = createClaudeProviderRuntime({
      ...baseRuntimeOptions,
      query: fakeQuery([msg({
        type: 'result',
        subtype: 'success',
        total_cost_usd: 0.0123,
        duration_ms: 4200,
        duration_api_ms: 3900,
        num_turns: 3,
        result: 'done',
        session_id: 'sess-7',
        usage: { input_tokens: 10 },
        // JS SDK uses camelCase `modelUsage` (NOT model_usage) — guards against
        // a casing regression that would silently drop the per-model breakdown.
        modelUsage: { 'claude-sonnet-4-6': { input_tokens: 10 } },
      })]),
    })
    runtime.events.connect((e) => out.push(e.item as TimelineItem))
    await runtime.preflight()
    await runtime.commands.sendMessage('hi')

    const completed = out.find((i) => i.type === 'turn_completed') as Record<string, unknown> | undefined
    expect(completed).toBeDefined()
    expect(completed).toMatchObject({
      costUsd: 0.0123,
      durationMs: 4200,
      durationApiMs: 3900,
      numTurns: 3,
      result: 'done',
      sessionId: 'sess-7',
    })
    expect((completed as { modelUsage: Record<string, unknown> }).modelUsage).toMatchObject({
      'claude-sonnet-4-6': { input_tokens: 10 },
    })
  })

  test('result deferred_tool_use and api_error_status are surfaced, not dropped', async () => {
    const out: TimelineItem[] = []
    const runtime = createClaudeProviderRuntime({
      ...baseRuntimeOptions,
      query: fakeQuery([msg({
        type: 'result',
        subtype: 'success',
        deferred_tool_use: { id: 'tu-1', name: 'Bash', input: { command: 'ls' } },
        api_error_status: 429,
      })]),
    })
    runtime.events.connect((e) => out.push(e.item as TimelineItem))
    await runtime.preflight()
    await runtime.commands.sendMessage('hi')

    const completed = out.find((i) => i.type === 'turn_completed') as Record<string, unknown> | undefined
    expect(completed).toBeDefined()
    expect(completed).toMatchObject({ apiErrorStatus: 429 })
    expect((completed as { deferredToolUse: { id: string } }).deferredToolUse).toMatchObject({ id: 'tu-1' })
  })

  test('task_started/progress/updated/notification project to task_event, NOT turn_completed', async () => {
    const out: TimelineItem[] = []
    const runtime = createClaudeProviderRuntime({
      ...baseRuntimeOptions,
      query: fakeQuery([
        msg({ type: 'system', subtype: 'task_started', task_id: 't-1', description: 'build' }),
        msg({ type: 'system', subtype: 'task_progress', task_id: 't-1', description: 'building', usage: { tool_uses: 2 } }),
        msg({ type: 'system', subtype: 'task_updated', task_id: 't-1', patch: { status: 'running' } }),
        msg({ type: 'system', subtype: 'task_notification', task_id: 't-1', status: 'completed', summary: 'ok' }),
        msg({ type: 'result', subtype: 'success' }),
      ]),
    })
    runtime.events.connect((e) => out.push(e.item as TimelineItem))
    await runtime.preflight()
    await runtime.commands.sendMessage('hi')

    const events = out.filter((i) => i.type === 'task_event') as Array<Record<string, unknown>>
    expect(events.map((e) => e.phase)).toEqual(['started', 'progress', 'updated', 'notification'])
    // The terminal task_notification must NOT be projected as turn_completed
    // (only the real result message should).
    const turnCompleted = out.filter((i) => i.type === 'turn_completed')
    expect(turnCompleted).toHaveLength(1)
    expect((events[3]).status).toBe('completed')
    expect((events[2]).detail).toMatchObject({ status: 'running' })
  })

  test('server_tool_use and advisor_tool_result blocks project to tool_call / tool_result', async () => {
    const out: TimelineItem[] = []
    const runtime = createClaudeProviderRuntime({
      ...baseRuntimeOptions,
      query: fakeQuery([
        msg({
          type: 'assistant',
          message: {
            content: [
              { type: 'server_tool_use', id: 'su-1', name: 'web_search', input: { query: 'x' } },
              { type: 'advisor_tool_result', tool_use_id: 'su-1', content: { hits: 3 } },
            ],
          },
        }),
        msg({ type: 'result', subtype: 'success' }),
      ]),
    })
    runtime.events.connect((e) => out.push(e.item as TimelineItem))
    await runtime.preflight()
    await runtime.commands.sendMessage('hi')

    expect(out.find((i) => i.type === 'tool_call' && (i as { callId: string }).callId === 'su-1')).toBeDefined()
    expect(out.find((i) => i.type === 'tool_result' && (i as { callId: string }).callId === 'su-1')).toBeDefined()
  })

  test('UserMessageReplay projects like a user message (rewind_files support)', async () => {
    const out: TimelineItem[] = []
    const runtime = createClaudeProviderRuntime({
      ...baseRuntimeOptions,
      query: fakeQuery([
        msg({ type: 'user_message_replay', message: { content: [{ type: 'text', text: 'replayed' }] } }),
        msg({ type: 'result', subtype: 'success' }),
      ]),
    })
    runtime.events.connect((e) => out.push(e.item as TimelineItem))
    await runtime.preflight()
    await runtime.commands.sendMessage('hi')

    expect(out.some((i) => i.type === 'assistant_message')).toBe(false)
    // The replayed user message text is not on assistant; verify no crash and
    // at least the turn completed. (user_message items aren't produced by the
    // assistant path — replay only carries tool_result-style content here.)
    expect(out.some((i) => i.type === 'turn_completed')).toBe(true)
  })

  test('remaining system subtypes (memory_recall/notification/etc.) forward to session_status, not dropped', async () => {
    const out: TimelineItem[] = []
    const runtime = createClaudeProviderRuntime({
      ...baseRuntimeOptions,
      query: fakeQuery([
        msg({ type: 'system', subtype: 'memory_recall' }),
        msg({ type: 'system', subtype: 'notification' }),
        msg({ type: 'system', subtype: 'thinking_tokens' }),
        msg({ type: 'result', subtype: 'success' }),
      ]),
    })
    runtime.events.connect((e) => out.push(e.item as TimelineItem))
    await runtime.preflight()
    await runtime.commands.sendMessage('hi')

    const statuses = out.filter((i) => i.type === 'session_status').map((i) => (i as { status: string }).status)
    expect(statuses).toContain('memory_recall')
    expect(statuses).toContain('notification')
    expect(statuses).toContain('thinking_tokens')
  })
})

describe('Claude native SDK driver — policy → PreToolUse hook bridge', () => {
  function setup(policy: RuntimePolicyHook) {
    let captured: Options | undefined
    const out: TimelineItem[] = []
    const runtime = createClaudeProviderRuntime({
      ...baseRuntimeOptions,
      policy,
      query: fakeQuery([msg({ type: 'result', subtype: 'success' })], (o) => (captured = o)),
    })
    runtime.events.connect((e) => out.push(e.item as TimelineItem))
    return {
      runtime,
      out,
      options: () => captured!,
    }
  }

  async function runPreToolUseHook(options: Options, toolUseId: string, toolName: string, toolInput: Record<string, unknown>) {
    const callback = options.hooks?.PreToolUse?.at(-1)?.hooks?.[0]
    if (!callback) throw new Error('PreToolUse hook not registered')
    return callback(
      { hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: toolInput, tool_use_id: toolUseId } as never,
      toolUseId,
      { signal: new AbortController().signal } as never,
    )
  }

  test('policy allow → hook returns permissionDecision allow', async () => {
    const { runtime, options } = setup(async () => ({ decision: 'allow' }))
    await runtime.preflight()
    await runtime.commands.sendMessage('hi')
    const out = await runPreToolUseHook(options(), 'tu-1', 'Bash', { command: 'ls' })
    expect(out.hookSpecificOutput).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'allow' })
  })

  test('policy allow with updatedInput → hook forwards updatedInput', async () => {
    const { runtime, options } = setup(async () => ({ decision: 'allow', updatedInput: { command: 'ls -la' } }))
    await runtime.preflight()
    await runtime.commands.sendMessage('hi')
    const out = await runPreToolUseHook(options(), 'tu-1', 'Bash', { command: 'ls' })
    expect(out.hookSpecificOutput).toMatchObject({ permissionDecision: 'allow', updatedInput: { command: 'ls -la' } })
  })

  test('policy deny → hook returns deny with reason', async () => {
    const { runtime, options } = setup(async () => ({ decision: 'deny', reason: 'blocked by policy' }))
    await runtime.preflight()
    await runtime.commands.sendMessage('hi')
    const out = await runPreToolUseHook(options(), 'tu-1', 'Bash', { command: 'rm -rf /' })
    expect(out.hookSpecificOutput).toMatchObject({ permissionDecision: 'deny', permissionDecisionReason: 'blocked by policy' })
  })

  test('policy ask → hook returns defer with reason; canUseTool reuses cached decision', async () => {
    const { runtime, options, out } = setup(async () => ({ decision: 'ask', reason: 'needs review' }))
    await runtime.preflight()
    await runtime.commands.sendMessage('hi')
    const hookOut = await runPreToolUseHook(options(), 'tu-1', 'Bash', { command: 'rm -rf /' })
    expect(hookOut.hookSpecificOutput).toMatchObject({ permissionDecision: 'defer', permissionDecisionReason: 'needs review' })

    // SDK would now invoke canUseTool (defer → normal flow). It must reuse the
    // cached 'ask' decision and emit a permission_requested (don't re-evaluate).
    const pending = options().canUseTool!('Bash', { command: 'rm -rf /' }, { toolUseID: 'tu-1', signal: new AbortController().signal } as never)
    await new Promise((r) => setTimeout(r, 0))
    const req = out.find((i) => i.type === 'permission_requested') as { request: { reason: string } } | undefined
    expect(req).toBeDefined()
    expect(req!.request.reason).toBe('needs review')
    // Clean up the pending permission so the test doesn't hang.
    await runtime.commands.respondToPermission('tu-1', false)
    await pending.catch(() => undefined)
  })

  test('no policy → no PreToolUse hook registered; canUseTool allows by default', async () => {
    let captured: Options | undefined
    const runtime = createClaudeProviderRuntime({
      ...baseRuntimeOptions,
      query: fakeQuery([msg({ type: 'result', subtype: 'success' })], (o) => (captured = o)),
    })
    await runtime.preflight()
    await runtime.commands.sendMessage('hi')
    expect(captured!.hooks).toBeUndefined()
    const result = await captured!.canUseTool!('Bash', { command: 'ls' }, { toolUseID: 'tu-2', signal: new AbortController().signal } as never)
    expect(result).toMatchObject({ behavior: 'allow' })
  })

  test('policy bridge registers a PreToolUse hook with NO matcher (match-all convention)', async () => {
    // Guards against regressing to `matcher: '*'`, which the CLI would treat as a
    // literal tool name and silently never fire the policy hook for.
    let captured: Options | undefined
    const runtime = createClaudeProviderRuntime({
      ...baseRuntimeOptions,
      policy: async () => ({ decision: 'allow' }),
      query: fakeQuery([msg({ type: 'result', subtype: 'success' })], (o) => (captured = o)),
    })
    await runtime.preflight()
    await runtime.commands.sendMessage('hi')
    const policyMatcher = captured!.hooks?.PreToolUse?.at(-1)
    expect(policyMatcher).toBeDefined()
    expect((policyMatcher as { matcher?: string }).matcher).toBeUndefined()
  })
})

describe('Claude native SDK driver — permission enrichment', () => {
  test('permission_requested surfaces SDK context (suggestions/agentId/blockedPath)', async () => {
    const out: TimelineItem[] = []
    let captured: Options | undefined
    const runtime = createClaudeProviderRuntime({
      ...baseRuntimeOptions,
      // policy ask forces canUseTool to emit permission_requested.
      policy: async () => ({ decision: 'ask', reason: 'review' }),
      query: fakeQuery([msg({ type: 'result', subtype: 'success' })], (o) => (captured = o)),
    })
    runtime.events.connect((e) => out.push(e.item as TimelineItem))
    await runtime.preflight()
    const send = runtime.commands.sendMessage('hi')
    await new Promise((r) => setTimeout(r, 0))

    // Simulate the SDK calling canUseTool with a rich permission context.
    const pending = captured!.canUseTool!(
      'Bash', { command: 'ls /etc' },
      {
        toolUseID: 'tu-ctx', signal: new AbortController().signal,
        suggestions: [{ type: 'addRules' }], agentID: 'sub-1', blockedPath: '/etc/shadow',
        title: 'Claude wants to run ls', displayName: 'Run Bash', description: 'list /etc',
        decisionReason: 'outside cwd',
      } as never,
    )
    await new Promise((r) => setTimeout(r, 0))
    const req = out.find((i) => i.type === 'permission_requested') as { request: Record<string, unknown> } | undefined
    expect(req).toBeDefined()
    expect(req!.request).toMatchObject({
      toolName: 'Bash', title: 'Claude wants to run ls',
      agentId: 'sub-1', blockedPath: '/etc/shadow',
    })
    expect(req!.request.suggestions).toEqual([{ type: 'addRules' }])

    await runtime.commands.respondToPermission('tu-ctx', false)
    await pending.catch(() => undefined)
    await send
  })

  test('respondToPermission allow carries updatedInput/updatedPermissions; deny carries interrupt', async () => {
    // An `ask` policy makes canUseTool block on a pending permission, so
    // respondToPermission actually resolves it (the no-policy path returns
    // allow immediately and never reaches the pending map).
    let captured: Options | undefined
    const runtime = createClaudeProviderRuntime({
      ...baseRuntimeOptions,
      policy: async () => ({ decision: 'ask', reason: 'review' }),
      query: fakeQuery([msg({ type: 'result', subtype: 'success' })], (o) => (captured = o)),
    })
    await runtime.preflight()
    const send = runtime.commands.sendMessage('hi')
    await new Promise((r) => setTimeout(r, 0))

    // allow with updatedInput + updatedPermissions
    const allowPromise = captured!.canUseTool!('Bash', { command: 'ls' }, { toolUseID: 'tu-a', signal: new AbortController().signal } as never) as Promise<PermissionResult>
    await new Promise((r) => setTimeout(r, 0))
    await runtime.commands.respondToPermission('tu-a', true, false, {
      updatedInput: { command: 'ls -la' },
      updatedPermissions: [{ type: 'addRules' }],
    })
    const allowResult = await allowPromise
    expect(allowResult).toMatchObject({ behavior: 'allow', updatedInput: { command: 'ls -la' } })
    expect((allowResult as { updatedPermissions: unknown[] }).updatedPermissions).toBeDefined()

    // deny with interrupt
    const denyPromise = captured!.canUseTool!('Bash', { command: 'rm -rf /' }, { toolUseID: 'tu-d', signal: new AbortController().signal } as never) as Promise<PermissionResult>
    await new Promise((r) => setTimeout(r, 0))
    await runtime.commands.respondToPermission('tu-d', false, false, { interrupt: true })
    const denyResult = await denyPromise
    expect(denyResult).toMatchObject({ behavior: 'deny', interrupt: true })

    await send
  })
})

describe('Claude native SDK driver — extended dynamic control', () => {
  test('new control methods delegate to the active SDK Query handle mid-turn', async () => {
    const calls: Array<[string, unknown[]]> = []
    const control = {
      readFile: async (...a: unknown[]) => calls.push(['readFile', a]),
      reloadPlugins: async (...a: unknown[]) => calls.push(['reloadPlugins', a]),
      accountInfo: async (...a: unknown[]) => calls.push(['accountInfo', a]),
      seedReadState: async (...a: unknown[]) => calls.push(['seedReadState', a]),
      backgroundTasks: async (...a: unknown[]) => calls.push(['backgroundTasks', a]),
      setMcpServers: async (...a: unknown[]) => calls.push(['setMcpServers', a]),
      supportedCommands: async (...a: unknown[]) => calls.push(['supportedCommands', a]),
      supportedModels: async (...a: unknown[]) => calls.push(['supportedModels', a]),
      supportedAgents: async (...a: unknown[]) => calls.push(['supportedAgents', a]),
    }
    let resolve!: () => void
    const gate = new Promise<void>((r) => { resolve = r })
    const query: ClaudeSdkQueryRunner = () => {
      async function* gen(): AsyncGenerator<SDKMessage> {
        yield msg({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } })
        await gate // block until control methods have been exercised
      }
      return Object.assign(gen(), control) as unknown as ClaudeSdkQuery
    }
    const driver = createClaudeNativeSdkDriver({ cwd: '/tmp/x', query })
    const send = driver.sendMessage({ message: 'hi' }, createTimelineSequencer({ sessionId: 's', provider: 'claude', epoch: 'e', now: () => 0 }))
    await new Promise((r) => setTimeout(r, 0))

    await driver.setMcpServers({ srv: { type: 'stdio', command: 'x' } })
    await driver.readFile('/a/b')
    await driver.reloadPlugins()
    await driver.accountInfo()
    await driver.seedReadState('/a/b', 123)
    await driver.backgroundTasks('tu-1')
    await driver.supportedCommands()
    await driver.supportedModels()
    await driver.supportedAgents()

    expect(calls.map((c) => c[0])).toEqual([
      'setMcpServers', 'readFile', 'reloadPlugins', 'accountInfo',
      'seedReadState', 'backgroundTasks', 'supportedCommands', 'supportedModels', 'supportedAgents',
    ])

    resolve()
    await send
  })

  test('extended control accessors return undefined with no turn in flight', async () => {
    const driver = createClaudeNativeSdkDriver({ cwd: '/tmp/x', query: fakeQuery([]) })
    expect(driver.readFile('/a')).toBeUndefined()
    expect(driver.reloadPlugins()).toBeUndefined()
    expect(driver.accountInfo()).toBeUndefined()
    expect(driver.seedReadState('/a', 1)).toBeUndefined()
    expect(driver.backgroundTasks()).toBeUndefined()
    expect(driver.supportedCommands()).toBeUndefined()
    expect(driver.supportedModels()).toBeUndefined()
    expect(driver.supportedAgents()).toBeUndefined()
    expect(driver.streamInput(async function*() {}())).toBeUndefined()
  })

  test('readFile forwards options to active query', async () => {
    const calls: Array<[string, ...unknown[]]> = []
    let resolve!: () => void
    const gate = new Promise<void>((r) => { resolve = r })
    const control: Record<string, (...args: unknown[]) => unknown> = {
      readFile: (...args: unknown[]) => { calls.push(['readFile', ...args]); return Promise.resolve('data') },
    }
    const query: ClaudeSdkQueryRunner = () => {
      async function* gen(): AsyncGenerator<SDKMessage> {
        yield msg({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } })
        await gate
      }
      return Object.assign(gen(), control) as unknown as ClaudeSdkQuery
    }
    const driver = createClaudeNativeSdkDriver({ cwd: '/tmp/x', query })
    const send = driver.sendMessage({ message: 'hi' }, createTimelineSequencer({ sessionId: 's', provider: 'claude', epoch: 'e', now: () => 0 }))
    await new Promise((r) => setTimeout(r, 0))

    await driver.readFile('/a/b', { maxBytes: 1024, encoding: 'utf-8' })
    expect(calls).toEqual([['readFile', '/a/b', { maxBytes: 1024, encoding: 'utf-8' }]])

    resolve()
    await send
  })

  test('streamInput delegates to active query', async () => {
    const calls: Array<[string, ...unknown[]]> = []
    let resolve!: () => void
    const gate = new Promise<void>((r) => { resolve = r })
    const control: Record<string, (...args: unknown[]) => unknown> = {
      streamInput: (...args: unknown[]) => { calls.push(['streamInput', ...args]); return Promise.resolve() },
    }
    const query: ClaudeSdkQueryRunner = () => {
      async function* gen(): AsyncGenerator<SDKMessage> {
        yield msg({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } })
        await gate
      }
      return Object.assign(gen(), control) as unknown as ClaudeSdkQuery
    }
    const driver = createClaudeNativeSdkDriver({ cwd: '/tmp/x', query })
    const send = driver.sendMessage({ message: 'hi' }, createTimelineSequencer({ sessionId: 's', provider: 'claude', epoch: 'e', now: () => 0 }))
    await new Promise((r) => setTimeout(r, 0))

    const fakeStream = (async function*() { yield { type: 'user' } })()
    await driver.streamInput(fakeStream)
    expect(calls[0]![0]).toBe('streamInput')

    resolve()
    await send
  })

  test('closeQuery delegates to active query close', async () => {
    let closeCalled = false
    let resolve!: () => void
    const gate = new Promise<void>((r) => { resolve = r })
    const control = {
      close: () => { closeCalled = true },
    }
    const query: ClaudeSdkQueryRunner = () => {
      async function* gen(): AsyncGenerator<SDKMessage> {
        yield msg({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } })
        await gate
      }
      return Object.assign(gen(), control) as unknown as ClaudeSdkQuery
    }
    const driver = createClaudeNativeSdkDriver({ cwd: '/tmp/x', query })
    const send = driver.sendMessage({ message: 'hi' }, createTimelineSequencer({ sessionId: 's', provider: 'claude', epoch: 'e', now: () => 0 }))
    await new Promise((r) => setTimeout(r, 0))

    driver.closeQuery()
    expect(closeCalled).toBe(true)

    resolve()
    await send
  })
})

describe('Claude native SDK driver — result projection enrichment', () => {
  test('projects ttft_ms, terminal_reason, fast_mode_state, origin from result message', async () => {
    const items: TimelineItem[] = []
    const runtime = createClaudeProviderRuntime({
      ...baseRuntimeOptions,
      query: fakeQuery([
        msg({
          type: 'result',
          subtype: 'success',
          total_cost_usd: 0.01,
          ttft_ms: 245,
          terminal_reason: 'end_turn',
          fast_mode_state: 'enabled',
          origin: { type: 'api', region: 'us-east-1' },
        }),
      ]),
    })
    await runtime.preflight()
    runtime.events.connect((env) => items.push(env.item))
    await runtime.commands.sendMessage('hello')

    const completed = items.find((i): i is Extract<TimelineItem, { type: 'turn_completed' }> => i.type === 'turn_completed')
    expect(completed).toBeDefined()
    expect(completed!.ttftMs).toBe(245)
    expect(completed!.terminalReason).toBe('end_turn')
    expect(completed!.fastModeState).toBe('enabled')
    expect(completed!.origin).toEqual({ type: 'api', region: 'us-east-1' })
  })

  test('omits new result fields when absent from SDK message', async () => {
    const items: TimelineItem[] = []
    const runtime = createClaudeProviderRuntime({
      ...baseRuntimeOptions,
      query: fakeQuery([
        msg({ type: 'result', subtype: 'success', total_cost_usd: 0.5 }),
      ]),
    })
    await runtime.preflight()
    runtime.events.connect((env) => items.push(env.item))
    await runtime.commands.sendMessage('hello')

    const completed = items.find((i): i is Extract<TimelineItem, { type: 'turn_completed' }> => i.type === 'turn_completed')
    expect(completed).toBeDefined()
    expect(completed!.costUsd).toBe(0.5)
    expect('ttftMs' in completed!).toBe(false)
    expect('terminalReason' in completed!).toBe(false)
    expect('fastModeState' in completed!).toBe(false)
    expect('origin' in completed!).toBe(false)
  })
})

describe('Claude native SDK driver — per-turn option overrides', () => {
  test('per-turn thinking override takes precedence over sdkOptions.thinking', async () => {
    let captured: Options | undefined
    const runtime = createClaudeProviderRuntime({
      ...baseRuntimeOptions,
      query: fakeQuery([msg({ type: 'result', subtype: 'success' })], (o) => (captured = o)),
      sdkOptions: {
        thinking: { type: 'enabled', budgetTokens: 4096 },
      } as Options,
    })
    await runtime.preflight()
    await runtime.commands.sendMessage('test', {
      thinking: { type: 'disabled' },
    })

    expect(captured?.thinking).toEqual({ type: 'disabled' })
  })

  test('per-turn maxTurns overrides sdkOptions.maxTurns', async () => {
    let captured: Options | undefined
    const runtime = createClaudeProviderRuntime({
      ...baseRuntimeOptions,
      query: fakeQuery([msg({ type: 'result', subtype: 'success' })], (o) => (captured = o)),
      sdkOptions: { maxTurns: 10 } as Options,
    })
    await runtime.preflight()
    await runtime.commands.sendMessage('test', { maxTurns: 3 })

    expect(captured?.maxTurns).toBe(3)
  })

  test('per-turn maxBudgetUsd overrides sdkOptions.maxBudgetUsd', async () => {
    let captured: Options | undefined
    const runtime = createClaudeProviderRuntime({
      ...baseRuntimeOptions,
      query: fakeQuery([msg({ type: 'result', subtype: 'success' })], (o) => (captured = o)),
      sdkOptions: { maxBudgetUsd: 5.0 } as Options,
    })
    await runtime.preflight()
    await runtime.commands.sendMessage('test', { maxBudgetUsd: 0.5 })

    expect(captured?.maxBudgetUsd).toBe(0.5)
  })

  test('per-turn overrides are absent when not specified (sdkOptions fall through)', async () => {
    let captured: Options | undefined
    const runtime = createClaudeProviderRuntime({
      ...baseRuntimeOptions,
      query: fakeQuery([msg({ type: 'result', subtype: 'success' })], (o) => (captured = o)),
      sdkOptions: {
        thinking: { type: 'enabled', budgetTokens: 8192 },
        maxTurns: 20,
        maxBudgetUsd: 2.0,
      } as Options,
    })
    await runtime.preflight()
    await runtime.commands.sendMessage('test')

    expect(captured?.thinking).toEqual({ type: 'enabled', budgetTokens: 8192 })
    expect(captured?.maxTurns).toBe(20)
    expect(captured?.maxBudgetUsd).toBe(2.0)
  })
})

describe('Claude native SDK driver — warmQuery support', () => {
  test('first sendMessage uses warmQuery handle, subsequent calls use normal query', async () => {
    const warmCalls: string[] = []
    const normalCalls: string[] = []

    const warmQuery = {
      query(prompt: string | AsyncIterable<unknown>) {
        warmCalls.push(typeof prompt === 'string' ? prompt : 'stream')
        async function* gen(): AsyncGenerator<SDKMessage> {
          yield msg({ type: 'result', subtype: 'success' })
        }
        return gen() as unknown as ClaudeSdkQuery
      },
      close() {},
    }
    const normalQuery: ClaudeSdkQueryRunner = ({ prompt }) => {
      normalCalls.push(typeof prompt === 'string' ? prompt : 'stream')
      async function* gen(): AsyncGenerator<SDKMessage> {
        yield msg({ type: 'result', subtype: 'success' })
      }
      return gen() as unknown as ClaudeSdkQuery
    }
    const driver = createClaudeNativeSdkDriver({ cwd: '/tmp/x', query: normalQuery, warmQuery })
    const seq = createTimelineSequencer({ sessionId: 's', provider: 'claude', epoch: 'e', now: () => 0 })

    await driver.sendMessage({ message: 'first' }, seq)
    expect(warmCalls).toEqual(['first'])
    expect(normalCalls).toEqual([])

    await driver.sendMessage({ message: 'second' }, seq)
    expect(warmCalls).toEqual(['first'])
    expect(normalCalls).toEqual(['second'])
  })

  test('dispose closes unconsumed warmQuery handle', async () => {
    let closeCalled = false
    const warmQuery = {
      query() { return (async function*() {})() as unknown as ClaudeSdkQuery },
      close() { closeCalled = true },
    }
    const driver = createClaudeNativeSdkDriver({ cwd: '/tmp/x', query: fakeQuery([]), warmQuery })

    await driver.dispose()
    expect(closeCalled).toBe(true)
  })

  test('dispose does not double-close a consumed warmQuery handle', async () => {
    let closeCount = 0
    const warmQuery = {
      query() {
        async function* gen(): AsyncGenerator<SDKMessage> {
          yield msg({ type: 'result', subtype: 'success' })
        }
        return gen() as unknown as ClaudeSdkQuery
      },
      close() { closeCount++ },
    }
    const driver = createClaudeNativeSdkDriver({ cwd: '/tmp/x', query: fakeQuery([]), warmQuery })
    const seq = createTimelineSequencer({ sessionId: 's', provider: 'claude', epoch: 'e', now: () => 0 })

    await driver.sendMessage({ message: 'consume' }, seq)
    await driver.dispose()
    expect(closeCount).toBe(0)
  })
})

describe('Claude native SDK driver — session continuity (A1/A5) + user_message (A4)', () => {
  test('captures session_id from init and auto-resumes it on the next turn', async () => {
    const capturedOptions: Options[] = []
    const runtime = createClaudeProviderRuntime({
      ...baseRuntimeOptions,
      query: fakeQuery([
        msg({ type: 'system', subtype: 'init', session_id: 'claude-sess-1' }),
        msg({ type: 'result', subtype: 'success', session_id: 'claude-sess-1' }),
      ], (o) => capturedOptions.push(o)),
    })
    await runtime.preflight()

    await runtime.commands.sendMessage('turn one')
    expect(capturedOptions[0]?.resume).toBeUndefined()

    await runtime.commands.sendMessage('turn two')
    expect(capturedOptions[1]?.resume).toBe('claude-sess-1')
  })

  test('host-managed sessions (sdkOptions.resume/continue/forkSession) suppress auto-resume', async () => {
    const capturedOptions: Options[] = []
    const runtime = createClaudeProviderRuntime({
      ...baseRuntimeOptions,
      query: fakeQuery([
        msg({ type: 'system', subtype: 'init', session_id: 'auto-captured' }),
        msg({ type: 'result', subtype: 'success' }),
      ], (o) => capturedOptions.push(o)),
      sdkOptions: { continue: true } as Options,
    })
    await runtime.preflight()

    await runtime.commands.sendMessage('turn one')
    await runtime.commands.sendMessage('turn two')
    // The host's `continue: true` wins; the captured id must not override it.
    expect(capturedOptions[1]?.resume).toBeUndefined()
    expect(capturedOptions[1]?.continue).toBe(true)
  })

  test('emits provider_session host_state_changed and user_message timeline items', async () => {
    const driver = createClaudeNativeSdkDriver({
      cwd: '/tmp/x',
      query: fakeQuery([
        msg({ type: 'system', subtype: 'init', session_id: 'sess-42' }),
        msg({ type: 'result', subtype: 'success', session_id: 'sess-42' }),
      ]),
    })
    const items: TimelineItem[] = []
    const seq = createTimelineSequencer({ sessionId: 's', provider: 'claude', epoch: 'e', now: () => 0 })
    const recording: TimelineSequencer = {
      append(item, rawRef) {
        items.push(item)
        return seq.append(item, rawRef)
      },
    }

    await driver.sendMessage({ message: 'hello there' }, recording)

    const userMessage = items.find(item => item.type === 'user_message')
    expect(userMessage).toBeDefined()
    expect(userMessage && 'text' in userMessage ? userMessage.text : undefined).toBe('hello there')

    const providerSession = items.find(item =>
      item.type === 'host_state_changed'
      && (item.state as { kind?: string }).kind === 'provider_session')
    expect(providerSession).toBeDefined()
    expect((providerSession as { state: { providerSessionId?: string } }).state.providerSessionId).toBe('sess-42')
    expect(driver.getProviderSessionId()).toBe('sess-42')
  })
})
