import { describe, expect, test } from 'vitest'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createClaudeNativeSdkDriver,
  createClaudeProviderRuntime,
  createClaudeRuntimeCapabilityReport,
  createClaudeRuntimeCandidates,
} from '@weft/providers/claude'
import {
  createCodexAppServerDriver,
  createCodexAppServerJsonRpcClient,
  createCodexAppServerSubprocessClient,
  createCodexProviderRuntime,
  createCodexRuntimeCapabilityReport,
  createCodexRuntimeCandidates,
  type CodexAppServerClient,
} from '@weft/providers/codex'
import type { AgentEvent } from '@weft/core'
import type { AgentSessionRuntime } from '@weft/cli-runtime'
import { readCodexAuth } from '@weft/adapter'
import type { SendMessageOptions } from '@weft/runtime-core'
import type { TimelineSequencer } from '@weft/timeline'
import { createTimelineSequencer, type TimelineEnvelope } from '@weft/timeline'

describe('Provider Runtime — SDK-first capability probes', () => {
  test('normal Claude provider entry isolates optional SDK value imports in an explicit sdk subpath', async () => {
    const claudeEntry = await readFile(join(process.cwd(), 'packages/providers/src/claude/index.ts'), 'utf8')
    const sdkEntry = join(process.cwd(), 'packages/providers/src/claude/sdk.ts')
    const desktopFacade = await readFile(join(process.cwd(), 'publish/desktop/package.json'), 'utf8')

    expect(claudeEntry).not.toContain("from '@anthropic-ai/claude-agent-sdk'")
    await expect(readFile(sdkEntry, 'utf8')).resolves.toContain("from '@anthropic-ai/claude-agent-sdk'")
    expect(JSON.parse(desktopFacade).exports['./providers/claude/sdk']).toBeDefined()
  })

  test('Claude provider prefers native SDK and marks CLI fallback policy as degraded', () => {
    const candidates = createClaudeRuntimeCandidates({
      nativeSdkAvailable: false,
      cliFallbackAvailable: true,
      nativeSdkReason: 'Claude Agent SDK is not installed',
    })

    const report = createClaudeRuntimeCapabilityReport({
      candidates,
      allowFallback: true,
      auth: {
        mode: 'provider-owned',
        configured: true,
        source: 'test',
      },
    })

    expect(report.provider).toBe('claude')
    expect(report.preferredRuntime).toBe('native-sdk')
    expect(report.selected).toBe('cli-fallback')
    expect(report.fallback).toBe(true)
    expect(report.policyCapabilities.degraded).toBe(true)
    expect(report.policyCapabilities.reason).toContain('CLI fallback')
  })

  test('Codex provider prefers app-server before native SDK and CLI fallback', () => {
    const candidates = createCodexRuntimeCandidates({
      appServerAvailable: true,
      nativeSdkAvailable: true,
      cliFallbackAvailable: true,
    })

    const report = createCodexRuntimeCapabilityReport({
      candidates,
      allowFallback: false,
      auth: {
        mode: 'provider-owned',
        configured: true,
        source: 'test',
      },
    })

    expect(report.provider).toBe('codex')
    expect(report.preferredRuntime).toBe('app-server')
    expect(report.selected).toBe('app-server')
    expect(report.fallback).toBe(false)
    expect(report.automationCapabilities.eventBus).toBe(true)
  })

  test('Claude provider runtime streams driver output into canonical timeline', async () => {
    const runtime = createClaudeProviderRuntime({
      cwd: '/tmp/project',
      sessionId: 'claude-session',
      epoch: 'epoch-a',
      now: () => 1_000,
      candidates: createClaudeRuntimeCandidates({
        nativeSdkAvailable: true,
        cliFallbackAvailable: true,
      }),
      auth: { mode: 'provider-owned', configured: true, source: 'test' },
      driver: {
        async sendMessage(input: { message: string }, sequencer: TimelineSequencer) {
          sequencer.append({ type: 'turn_started', turnId: 'turn-1' })
          sequencer.append({
            type: 'assistant_message_delta',
            text: `Echo: ${input.message}`,
            messageId: 'message-1',
            turnId: 'turn-1',
          })
          sequencer.append({
            type: 'assistant_message',
            text: `Echo: ${input.message}`,
            messageId: 'message-1',
            turnId: 'turn-1',
          })
          sequencer.append({ type: 'turn_completed', turnId: 'turn-1' })
        },
      },
    })

    const streamed: string[] = []
    runtime.events.connect((event) => streamed.push(event.item.type))

    const report = await runtime.preflight()
    await runtime.commands.sendMessage('hello')
    const replay = await runtime.fetchTimeline({})

    expect(report.selected).toBe('native-sdk')
    expect(streamed).toEqual([
      'runtime_capability_report',
      'turn_started',
      'assistant_message_delta',
      'assistant_message',
      'turn_completed',
    ])
    const replayTypes: string[] = replay.items.map(item => item.item.type)
    expect(replayTypes).toEqual(streamed)
  })

  test('provider runtimes apply extension command origin when send options omit one', async () => {
    const capturedOrigins: unknown[] = []
    const claudeRuntime = createClaudeProviderRuntime({
      cwd: '/tmp/project',
      candidates: createClaudeRuntimeCandidates({
        nativeSdkAvailable: true,
        cliFallbackAvailable: false,
      }),
      auth: { mode: 'provider-owned', configured: true, source: 'test' },
      extensions: {
        commandOrigin: { type: 'automation', id: 'daily-review' },
      },
      driver: {
        async sendMessage(input, sequencer) {
          capturedOrigins.push(input.origin)
          sequencer.append({ type: 'turn_completed', turnId: 'turn-1' })
        },
      },
    })
    const codexRuntime = createCodexProviderRuntime({
      cwd: '/tmp/project',
      candidates: createCodexRuntimeCandidates({
        appServerAvailable: true,
        nativeSdkAvailable: false,
        cliFallbackAvailable: false,
      }),
      auth: { mode: 'provider-owned', configured: true, source: 'test' },
      extensions: {
        commandOrigin: { type: 'host', id: 'session-tool' },
      },
      driver: {
        async sendMessage(input, sequencer) {
          capturedOrigins.push(input.origin)
          sequencer.append({ type: 'turn_completed', turnId: 'turn-2' })
        },
      },
    })

    await claudeRuntime.commands.sendMessage('review')
    await codexRuntime.commands.sendMessage('host follow-up')

    expect(capturedOrigins).toEqual([
      { type: 'automation', id: 'daily-review' },
      { type: 'host', id: 'session-tool' },
    ])
  })

  test('provider timeline streams support multiple concurrent subscribers', async () => {
    const runtime = createClaudeProviderRuntime({
      cwd: '/tmp/project',
      candidates: createClaudeRuntimeCandidates({
        nativeSdkAvailable: true,
        cliFallbackAvailable: false,
      }),
      auth: { mode: 'provider-owned', configured: true, source: 'test' },
      driver: {
        async sendMessage(_input, sequencer) {
          sequencer.append({ type: 'turn_started', turnId: 'turn-multi' })
        },
      },
    })
    const first: string[] = []
    const second: string[] = []

    runtime.events.connect(event => first.push(event.item.type))
    runtime.events.connect(event => second.push(event.item.type))
    await runtime.commands.sendMessage('hello')

    expect(first).toEqual(['turn_started'])
    expect(second).toEqual(['turn_started'])
  })

  test('provider runtime preflight advertises attached host service callbacks', async () => {
    const hostServices = {
      sessionTools: {
        async submitPlan(request: { planRef: string }) {
          return { accepted: true, planRef: request.planRef }
        },
        async runBrowserAction() {
          return { ok: true }
        },
        async updateSessionMetadata(request: { labels?: string[] }) {
          return { labels: request.labels ?? [] }
        },
      },
    }
    const claudeRuntime = createClaudeProviderRuntime({
      cwd: '/tmp/project',
      candidates: createClaudeRuntimeCandidates({
        nativeSdkAvailable: true,
        cliFallbackAvailable: false,
      }),
      auth: { mode: 'provider-owned', configured: true, source: 'test' },
      extensions: { hostServices },
      driver: {
        async sendMessage(_input, sequencer) {
          sequencer.append({ type: 'turn_completed', turnId: 'turn-1' })
        },
      },
    })
    const codexRuntime = createCodexProviderRuntime({
      cwd: '/tmp/project',
      candidates: createCodexRuntimeCandidates({
        appServerAvailable: true,
        nativeSdkAvailable: false,
        cliFallbackAvailable: false,
      }),
      auth: { mode: 'provider-owned', configured: true, source: 'test' },
      extensions: { hostServices },
      driver: {
        async sendMessage(_input, sequencer) {
          sequencer.append({ type: 'turn_completed', turnId: 'turn-2' })
        },
      },
    })

    const claudeReport = await claudeRuntime.preflight()
    const codexReport = await codexRuntime.preflight()

    for (const report of [claudeReport, codexReport]) {
      expect(report.hostToolCapabilities).toMatchObject({
        supported: true,
        sessionTools: true,
        workflowTransitions: true,
        browserActions: true,
        metadataWrites: true,
      })
    }
  })

  test('Claude provider runtime creates native SDK driver with source tools when no driver is injected', async () => {
    const queryCalls: unknown[] = []
    const runtime = createClaudeProviderRuntime({
      cwd: '/tmp/project',
      candidates: createClaudeRuntimeCandidates({
        nativeSdkAvailable: true,
        cliFallbackAvailable: false,
      }),
      auth: { mode: 'provider-owned', configured: true, source: 'test' },
      sourceTools: [
        {
          kind: 'mcp-server',
          sourceSlug: 'linear',
          transport: 'stdio',
          command: 'linear-mcp',
          env: { PATH: '/usr/bin' },
          credentialRef: { type: 'source_oauth', sourceSlug: 'linear', workspaceId: 'workspace-a' },
        },
      ],
      query(params) {
        queryCalls.push(params)
        return sdkMessages([
          {
            type: 'result',
            subtype: 'success',
            uuid: 'runtime-default-driver',
            session_id: 'sdk-session',
            duration_ms: 10,
            duration_api_ms: 5,
            is_error: false,
            num_turns: 1,
            result: 'done',
            stop_reason: 'end_turn',
            total_cost_usd: 0,
            usage: { input_tokens: 1, output_tokens: 1 },
            modelUsage: {},
            permission_denials: [],
          },
        ])
      },
    })

    await runtime.preflight()
    await runtime.commands.sendMessage('use @linear')

    expect(queryCalls[0]).toMatchObject({
      options: {
        mcpServers: {
          linear: {
            type: 'stdio',
            command: 'linear-mcp',
            env: { PATH: '/usr/bin' },
          },
        },
      },
    })
  })

  test('Codex provider runtime creates an app-server driver when source tools are provided', async () => {
    const client = createFakeCodexAppServerClient({ turnId: 'turn-1' })
    const runtime = createCodexProviderRuntime({
      cwd: '/tmp/project',
      candidates: createCodexRuntimeCandidates({
        appServerAvailable: true,
        nativeSdkAvailable: false,
        cliFallbackAvailable: false,
      }),
      auth: { mode: 'provider-owned', configured: true, source: 'test' },
      appServerClient: client,
      sourceTools: [
        {
          kind: 'api-source',
          sourceSlug: 'github',
          baseUrl: 'https://api.github.com',
          authType: 'bearer',
          defaultHeaders: { Accept: 'application/json' },
          credentialRef: { type: 'source_bearer', sourceSlug: 'github', workspaceId: 'workspace-a' },
          credentialSecret: 'secret-value',
        },
      ],
    })

    await runtime.preflight()
    expect(runtime.runtimeKind).toBe('app-server')
    const send = runtime.commands.sendMessage('use @github')
    await waitFor(() => client.requests.some(request => request.method === 'turn/start'))
    client.emitNotification({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'turn-1' } },
    })
    await send

    // Source tools are accepted but not yet wired into the app-server turn:
    // codex ignores config.weftSources, and dynamicTools registration is
    // future work. Ensure neither the descriptors nor any secret leak into
    // the request.
    const threadStart = client.requests.find(request => request.method === 'thread/start')
    expect(threadStart?.params).not.toHaveProperty('config.weftSources')
    expect(JSON.stringify(threadStart?.params ?? {})).not.toContain('secret-value')
    expect(JSON.stringify(threadStart?.params ?? {})).not.toContain('credentialSecret')
  })

  test('Codex provider never selects native-sdk even when marked available', () => {
    const candidates = createCodexRuntimeCandidates({
      appServerAvailable: false,
      nativeSdkAvailable: true,
      cliFallbackAvailable: false,
    })
    const report = createCodexRuntimeCapabilityReport({
      candidates,
      allowFallback: true,
      auth: { mode: 'provider-owned', configured: true, source: 'test' },
    })

    // native-sdk is reported-but-unselectable for codex (no in-process runtime
    // exists), so even with nativeSdkAvailable:true and app-server down it must
    // not be picked — selection falls through with no selectable runtime.
    const nativeCandidate = candidates.find(candidate => candidate.kind === 'native-sdk')
    expect(nativeCandidate?.available).toBe(false)
    expect(report.selected).not.toBe('native-sdk')
  })

  test('provider runtime state follows permission_requested and permission_resolved timeline items', async () => {
    const permissionReleased = deferred<void>()
    const runtime = createClaudeProviderRuntime({
      cwd: '/tmp/project',
      sessionId: 'permission-state-session',
      epoch: 'permission-state-epoch',
      now: () => 1_000,
      candidates: createClaudeRuntimeCandidates({
        nativeSdkAvailable: true,
        cliFallbackAvailable: false,
      }),
      auth: { mode: 'provider-owned', configured: true, source: 'test' },
      driver: {
        async sendMessage(_input, sequencer) {
          sequencer.append({ type: 'turn_started', turnId: 'turn-permission' })
          sequencer.append({
            type: 'permission_requested',
            request: {
              requestId: 'perm-runtime-state',
              toolName: 'Bash',
              reason: 'approval required',
              scope: { type: 'tool-call', callId: 'call-1' },
            },
          })
          await permissionReleased.promise
          sequencer.append({
            type: 'permission_resolved',
            requestId: 'perm-runtime-state',
            resolution: { allowed: true, remember: true },
          })
          sequencer.append({ type: 'turn_completed', turnId: 'turn-permission' })
        },
        async respondToPermission() {
          permissionReleased.resolve()
        },
      },
    })

    await runtime.preflight()
    const send = runtime.commands.sendMessage('run command')
    await waitFor(() => runtime.getState().status === 'waiting_for_permission')

    expect(runtime.getState()).toMatchObject({
      status: 'waiting_for_permission',
      waitingPermissionRequestId: 'perm-runtime-state',
    })

    await runtime.commands.respondToPermission('perm-runtime-state', true, true)
    await send
    expect(runtime.getState().status).toBe('ready')
    expect(runtime.getState().waitingPermissionRequestId).toBeUndefined()
  })

  test('provider respondToPermission clears waiting state even when fallback driver emits no resolution event', async () => {
    const continueTurn = deferred<void>()
    const runtime = createClaudeProviderRuntime({
      cwd: '/tmp/project',
      sessionId: 'permission-fallback-state-session',
      epoch: 'permission-fallback-state-epoch',
      now: () => 1_000,
      candidates: createClaudeRuntimeCandidates({
        nativeSdkAvailable: true,
        cliFallbackAvailable: false,
      }),
      auth: { mode: 'provider-owned', configured: true, source: 'test' },
      driver: {
        async sendMessage(_input, sequencer) {
          sequencer.append({
            type: 'permission_requested',
            request: {
              requestId: 'perm-no-resolution-event',
              toolName: 'Write',
              reason: 'approval required',
            },
          })
          await continueTurn.promise
          sequencer.append({ type: 'turn_completed', turnId: 'turn-no-resolution-event' })
        },
        async respondToPermission() {},
      },
    })

    await runtime.preflight()
    const send = runtime.commands.sendMessage('edit file')
    await waitFor(() => runtime.getState().status === 'waiting_for_permission')

    await runtime.commands.respondToPermission('perm-no-resolution-event', true, false)
    expect(runtime.getState().status).toBe('running')
    expect(runtime.getState().waitingPermissionRequestId).toBeUndefined()

    continueTurn.resolve()
    await send
  })

  test('Claude provider cli-fallback delegates to local CLI fallback runtime', async () => {
    const local = createFakeLocalAgentSession('claude')
    const runtime = createClaudeProviderRuntime({
      cwd: '/tmp/project',
      candidates: createClaudeRuntimeCandidates({
        nativeSdkAvailable: false,
        cliFallbackAvailable: true,
      }),
      allowFallback: true,
      auth: { mode: 'provider-owned', configured: true, source: 'test' },
      createCliFallbackSession: () => local,
    })

    await runtime.preflight()
    await runtime.commands.sendMessage('hello fallback', {
      turnId: 'turn-fallback',
      permissionMode: 'explore',
    })
    const replay = await runtime.fetchTimeline({})

    expect(runtime.runtimeKind).toBe('cli-fallback')
    expect(local.sentMessages).toEqual(['hello fallback'])
    expect(local.sentOptions).toEqual([{
      turnId: 'turn-fallback',
      permissionMode: 'explore',
    }])
    expect(replay.items.map(item => item.item.type)).toEqual([
      'runtime_capability_report',
      'user_message',
      'assistant_message_delta',
      'assistant_message',
      'turn_completed',
      'session_status',
    ])
  })

  test('Codex provider cli-fallback delegates to local CLI fallback runtime', async () => {
    const local = createFakeLocalAgentSession('codex')
    const runtime = createCodexProviderRuntime({
      cwd: '/tmp/project',
      candidates: createCodexRuntimeCandidates({
        appServerAvailable: false,
        nativeSdkAvailable: false,
        cliFallbackAvailable: true,
      }),
      allowFallback: true,
      auth: { mode: 'provider-owned', configured: true, source: 'test' },
      createCliFallbackSession: () => local,
    })

    await runtime.preflight()
    await runtime.commands.sendMessage('hello fallback', { turnId: 'turn-fallback' })
    const replay = await runtime.fetchTimeline({})

    expect(runtime.runtimeKind).toBe('cli-fallback')
    expect(local.sentMessages).toEqual(['hello fallback'])
    expect(replay.items.map(item => item.item.type)).toEqual([
      'runtime_capability_report',
      'user_message',
      'assistant_message_delta',
      'assistant_message',
      'turn_completed',
      'session_status',
    ])
  })

  test('Codex provider cli-fallback applies session permissionMode to real local CLI args', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'weft-provider-codex-cli-'))
    const executable = join(tempDir, 'codex-fake.js')
    const argsLog = join(tempDir, 'args.jsonl')

    try {
      await writeFakeCodexExecutable(executable)
      const runtime = createCodexProviderRuntime({
        cwd: tempDir,
        candidates: createCodexRuntimeCandidates({
          appServerAvailable: false,
          nativeSdkAvailable: false,
          cliFallbackAvailable: true,
        }),
        allowFallback: true,
        auth: { mode: 'provider-owned', configured: true, source: 'test' },
        executable,
        env: {
          PATH: process.env.PATH ?? '',
          WEFT_ARGS_LOG: argsLog,
        },
        permissionMode: 'explore',
      })

      await runtime.preflight()
      await runtime.commands.sendMessage('hello fallback')

      const [loggedArgs] = (await readFile(argsLog, 'utf8'))
        .trim()
        .split('\n')
        .map(line => JSON.parse(line) as string[])

      expect(runtime.runtimeKind).toBe('cli-fallback')
      expect(loggedArgs).toContain('approval_policy="untrusted"')
      expect(loggedArgs).toContain('--sandbox')
      expect(loggedArgs).toContain('read-only')
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('Claude native SDK driver maps SDK messages into canonical timeline', async () => {
    const queryCalls: unknown[] = []
    const driver = createClaudeNativeSdkDriver({
      cwd: '/tmp/project',
      model: 'claude-sonnet-4.5',
      reasoningEffort: 'high',
      query(params) {
        queryCalls.push(params)
        return sdkMessages([
          {
            type: 'stream_event',
            uuid: 'partial-1',
            session_id: 'sdk-session',
            parent_tool_use_id: null,
            event: {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: 'Hel' },
            },
          },
          {
            type: 'assistant',
            uuid: 'assistant-1',
            session_id: 'sdk-session',
            parent_tool_use_id: null,
            message: {
              id: 'message-1',
              type: 'message',
              role: 'assistant',
              model: 'claude-test',
              content: [
                { type: 'text', text: 'Hello' },
                { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } },
              ],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 1, output_tokens: 2 },
            },
          },
          {
            type: 'user',
            uuid: 'user-tool-result-1',
            session_id: 'sdk-session',
            parent_tool_use_id: null,
            message: {
              role: 'user',
              content: [
                { type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok', is_error: false },
              ],
            },
          },
          {
            type: 'result',
            subtype: 'success',
            uuid: 'result-1',
            session_id: 'sdk-session',
            duration_ms: 10,
            duration_api_ms: 5,
            is_error: false,
            num_turns: 1,
            result: 'Hello',
            stop_reason: 'end_turn',
            total_cost_usd: 0,
            usage: { input_tokens: 1, output_tokens: 2 },
            modelUsage: {},
            permission_denials: [],
          },
        ])
      },
    })

    const timeline = createCollectingSequencer()
    await driver.sendMessage({ message: 'hello', options: { turnId: 'turn-1' } }, timeline)

    expect(queryCalls).toHaveLength(1)
    expect(queryCalls[0]).toMatchObject({
      prompt: 'hello',
      options: {
        cwd: '/tmp/project',
        model: 'claude-sonnet-4.5',
        effort: 'high',
        includePartialMessages: true,
      },
    })
    expect(timeline.items.map(item => item.item.type)).toEqual([
      'turn_started',
      'user_message',
      'assistant_message_delta',
      'assistant_message',
      'tool_call',
      'tool_result',
      'turn_completed',
    ])
    expect(timeline.items[2]?.item).toMatchObject({
      type: 'assistant_message_delta',
      text: 'Hel',
      messageId: 'partial-1',
      turnId: 'turn-1',
    })
    expect(timeline.items[4]?.item).toMatchObject({
      type: 'tool_call',
      callId: 'toolu_1',
      name: 'Bash',
      status: 'running',
      turnId: 'turn-1',
    })
    expect(timeline.items[5]?.item).toMatchObject({
      type: 'tool_result',
      callId: 'toolu_1',
      result: 'ok',
      isError: false,
      turnId: 'turn-1',
    })
  })

  test('Claude native SDK driver bridges canUseTool ask decisions through permission timeline', async () => {
    const permissionStarted = deferred<void>()
    let permissionResult: unknown
    const policyRequests: unknown[] = []
    const driver = createClaudeNativeSdkDriver({
      cwd: '/tmp/project',
      policy: async (request) => {
        policyRequests.push(request)
        return { decision: 'ask', reason: 'workspace policy requires approval' }
      },
      query(params) {
        return sdkMessagesFromAsync(async function* () {
          if (!params.options?.canUseTool) throw new Error('missing canUseTool')
          const permission = params.options.canUseTool('Bash', { command: 'rm -rf tmp' }, {
            signal: new AbortController().signal,
            toolUseID: 'toolu_2',
            decisionReason: 'dangerous command',
            title: 'Run shell command',
            displayName: 'Bash',
            description: 'rm command',
          })
          permissionStarted.resolve()
          permissionResult = await permission
          yield {
            type: 'result',
            subtype: 'success',
            uuid: 'result-2',
            session_id: 'sdk-session',
            duration_ms: 10,
            duration_api_ms: 5,
            is_error: false,
            num_turns: 1,
            result: 'done',
            stop_reason: 'end_turn',
            total_cost_usd: 0,
            usage: { input_tokens: 1, output_tokens: 2 },
            modelUsage: {},
            permission_denials: [],
          }
        })
      },
    })

    const timeline = createCollectingSequencer()
    const send = driver.sendMessage({ message: 'delete temp', options: { turnId: 'turn-2' } }, timeline)
    await permissionStarted.promise
    await waitFor(() => timeline.items.some(item => item.item.type === 'permission_requested'))

    expect(timeline.items.map(item => item.item.type)).toEqual([
      'turn_started',
      'user_message',
      'permission_requested',
    ])
    expect(timeline.items[2]?.item).toMatchObject({
      type: 'permission_requested',
      request: {
        requestId: 'toolu_2',
        toolName: 'Bash',
        reason: 'workspace policy requires approval',
      },
    })
    expect(policyRequests[0]).toMatchObject({
      toolName: 'Bash',
      toolIntent: {
        kind: 'bash',
        command: 'rm -rf tmp',
        baseCommand: 'rm',
      },
      scope: { type: 'tool-call', callId: 'toolu_2' },
    })

    await driver.respondToPermission?.('toolu_2', true, true)
    await send

    expect(permissionResult).toMatchObject({
      behavior: 'allow',
      toolUseID: 'toolu_2',
    })
    expect(timeline.items.map(item => item.item.type)).toEqual([
      'turn_started',
      'user_message',
      'permission_requested',
      'permission_resolved',
      'turn_completed',
    ])
  })

  test('Claude native SDK driver maps source MCP descriptors into SDK mcpServers without leaking secrets', async () => {
    const queryCalls: unknown[] = []
    const driver = createClaudeNativeSdkDriver({
      cwd: '/tmp/project',
      sourceTools: [
        {
          kind: 'mcp-server',
          sourceSlug: 'linear',
          transport: 'stdio',
          command: 'linear-mcp',
          args: ['--stdio'],
          env: { PATH: '/usr/bin' },
          credentialRef: { type: 'source_bearer', sourceSlug: 'linear', workspaceId: 'workspace-a' },
          credentialSecret: 'secret-value',
        },
        {
          kind: 'api-source',
          sourceSlug: 'github',
          baseUrl: 'https://api.github.com',
          authType: 'bearer',
          credentialRef: { type: 'source_bearer', sourceSlug: 'github', workspaceId: 'workspace-a' },
          credentialSecret: 'secret-value',
        },
      ],
      query(params) {
        queryCalls.push(params)
        return sdkMessages([
          {
            type: 'result',
            subtype: 'success',
            uuid: 'result-source-tools',
            session_id: 'sdk-session',
            duration_ms: 10,
            duration_api_ms: 5,
            is_error: false,
            num_turns: 1,
            result: 'done',
            stop_reason: 'end_turn',
            total_cost_usd: 0,
            usage: { input_tokens: 1, output_tokens: 2 },
            modelUsage: {},
            permission_denials: [],
          },
        ])
      },
    })

    await driver.sendMessage({ message: 'use linear', options: { turnId: 'turn-source-tools' } }, createCollectingSequencer())

    expect(queryCalls).toHaveLength(1)
    expect(queryCalls[0]).toMatchObject({
      options: {
        mcpServers: {
          linear: {
            type: 'stdio',
            command: 'linear-mcp',
            args: ['--stdio'],
            env: { PATH: '/usr/bin' },
          },
        },
      },
    })
    const serialized = JSON.stringify(queryCalls[0])
    expect(serialized).not.toContain('credentialRef')
    expect(serialized).not.toContain('secret-value')
    expect(serialized).not.toContain('github')
  })

  test('Codex app-server driver starts a thread and maps notifications into canonical timeline', async () => {
    const client = createFakeCodexAppServerClient({ turnId: 'server-turn-1' })
    const driver = createCodexAppServerDriver({
      cwd: '/tmp/project',
      client,
      model: 'gpt-5.5',
      reasoningEffort: 'xhigh',
    })
    const timeline = createCollectingSequencer('codex')

    const send = driver.sendMessage({ message: 'hello', options: { turnId: 'turn-1' } }, timeline)
    await waitFor(() => client.requests.some(request => request.method === 'turn/start'))

    client.emitNotification({
      method: 'turn/started',
      params: { threadId: 'thread-1', turn: { id: 'server-turn-1' } },
    })
    client.emitNotification({
      method: 'item/agentMessage/delta',
      params: { threadId: 'thread-1', turnId: 'server-turn-1', itemId: 'message-1', delta: 'Hel' },
    })
    client.emitNotification({
      method: 'item/started',
      params: {
        threadId: 'thread-1',
        turnId: 'server-turn-1',
        item: {
          type: 'commandExecution',
          id: 'cmd-1',
          command: 'ls',
          cwd: '/tmp/project',
          status: 'running',
        },
      },
    })
    client.emitNotification({
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'server-turn-1',
        item: {
          type: 'commandExecution',
          id: 'cmd-1',
          command: 'ls',
          cwd: '/tmp/project',
          status: 'completed',
          aggregatedOutput: 'ok',
          exitCode: 0,
        },
      },
    })
    client.emitNotification({
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'server-turn-1',
        item: {
          type: 'agentMessage',
          id: 'message-1',
          text: 'Hello',
          phase: null,
        },
      },
    })
    client.emitNotification({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'server-turn-1' } },
    })
    await send

    expect(client.requests.map(request => request.method)).toEqual([
      'thread/start',
      'turn/start',
    ])
    expect(client.requests[0]?.params).toMatchObject({
      cwd: '/tmp/project',
      config: {
        model: 'gpt-5.5',
        model_reasoning_effort: 'xhigh',
      },
    })
    expect(client.requests[1]?.params).toMatchObject({
      threadId: 'thread-1',
      cwd: '/tmp/project',
      input: [{ type: 'text', text: 'hello', text_elements: [] }],
    })
    expect(timeline.items.map(item => item.item.type)).toEqual([
      'turn_started',
      'assistant_message_delta',
      'tool_call',
      'tool_result',
      'assistant_message',
      'turn_completed',
    ])
    // A5: the provider thread id is surfaced once the thread initializes, so
    // hosts can persist it for cross-process thread/resume.
    expect(timeline.providerSessionItems.map(envelope =>
      (envelope.item as { state?: { providerThreadId?: string } }).state?.providerThreadId,
    )).toEqual(['thread-1'])
    expect(timeline.items[2]?.item).toMatchObject({
      type: 'tool_call',
      callId: 'cmd-1',
      name: 'commandExecution',
      status: 'running',
      detail: { command: 'ls', cwd: '/tmp/project' },
      turnId: 'turn-1',
    })
    expect(timeline.items[3]?.item).toMatchObject({
      type: 'tool_result',
      callId: 'cmd-1',
      result: 'ok',
      isError: false,
      turnId: 'turn-1',
    })
  })

  test('Codex app-server driver passes current approval and sandbox params to thread start', async () => {
    const client = createFakeCodexAppServerClient({ turnId: 'server-turn-permissions' })
    const driver = createCodexAppServerDriver({
      cwd: '/tmp/project',
      client,
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      sandbox: 'workspace-write',
    })
    const timeline = createCollectingSequencer('codex')

    const send = driver.sendMessage({ message: 'hello', options: { turnId: 'turn-permissions' } }, timeline)
    await waitFor(() => client.requests.some(request => request.method === 'turn/start'))
    client.emitNotification({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'server-turn-permissions' } },
    })
    await send

    expect(client.requests[0]).toMatchObject({
      method: 'thread/start',
      params: {
        cwd: '/tmp/project',
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
        sandbox: 'workspace-write',
      },
    })
  })

  test('Codex app-server driver passes message permissionMode to turn start', async () => {
    const client = createFakeCodexAppServerClient({ turnId: 'server-turn-per-message-permissions' })
    const driver = createCodexAppServerDriver({
      cwd: '/tmp/project',
      client,
    })
    const timeline = createCollectingSequencer('codex')

    const send = driver.sendMessage({
      message: 'hello',
      options: {
        turnId: 'turn-per-message-permissions',
        permissionMode: 'auto',
      },
    }, timeline)
    await waitFor(() => client.requests.some(request => request.method === 'turn/start'))
    client.emitNotification({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'server-turn-per-message-permissions' } },
    })
    await send

    expect(client.requests.find(request => request.method === 'turn/start')).toMatchObject({
      method: 'turn/start',
      params: {
        approvalPolicy: 'never',
        approvalsReviewer: 'user',
        sandboxPolicy: { type: 'dangerFullAccess' },
      },
    })
  })

  test('Codex app-server driver streams command output deltas before completion', async () => {
    const client = createFakeCodexAppServerClient({ turnId: 'server-turn-stream' })
    const driver = createCodexAppServerDriver({
      cwd: '/tmp/project',
      client,
    })
    const timeline = createCollectingSequencer('codex')

    const send = driver.sendMessage({ message: 'inspect files', options: { turnId: 'turn-stream' } }, timeline)
    await waitFor(() => client.requests.some(request => request.method === 'turn/start'))

    client.emitNotification({
      method: 'item/started',
      params: {
        threadId: 'thread-1',
        turnId: 'server-turn-stream',
        item: {
          type: 'commandExecution',
          id: 'cmd-stream',
          command: "rg -n \"RuntimeClient\" apps/chat-playground/src",
          cwd: '/tmp/project',
          status: 'running',
          commandActions: [{ type: 'search', query: 'RuntimeClient', path: 'apps/chat-playground/src' }],
        },
      },
    })
    client.emitNotification({
      method: 'item/commandExecution/outputDelta',
      params: {
        threadId: 'thread-1',
        turnId: 'server-turn-stream',
        itemId: 'cmd-stream',
        stream: 'stdout',
        delta: 'apps/chat-playground/src/runtime-client.ts:1\n',
      },
    })
    client.emitNotification({
      method: 'item/commandExecution/outputDelta',
      params: {
        threadId: 'thread-1',
        turnId: 'server-turn-stream',
        itemId: 'cmd-stream',
        stream: 'stdout',
        delta: 'apps/chat-playground/src/App.tsx:14\n',
      },
    })
    client.emitNotification({
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'server-turn-stream',
        item: {
          type: 'commandExecution',
          id: 'cmd-stream',
          command: "rg -n \"RuntimeClient\" apps/chat-playground/src",
          cwd: '/tmp/project',
          status: 'completed',
          aggregatedOutput: 'apps/chat-playground/src/runtime-client.ts:1\napps/chat-playground/src/App.tsx:14\n',
          exitCode: 0,
        },
      },
    })
    client.emitNotification({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'server-turn-stream' } },
    })
    await send

    expect(timeline.items.map(item => item.item.type)).toEqual([
      'tool_call',
      'tool_output_delta',
      'tool_output_delta',
      'tool_result',
      'turn_completed',
    ])
    expect(timeline.items[0]?.item).toMatchObject({
      type: 'tool_call',
      callId: 'cmd-stream',
      detail: {
        command: "rg -n \"RuntimeClient\" apps/chat-playground/src",
        commandActions: [{ type: 'search', query: 'RuntimeClient', path: 'apps/chat-playground/src' }],
      },
    })
    expect(timeline.items[1]?.item).toMatchObject({
      type: 'tool_output_delta',
      callId: 'cmd-stream',
      text: 'apps/chat-playground/src/runtime-client.ts:1\n',
      stream: 'stdout',
      turnId: 'turn-stream',
    })
  })

  test('Codex app-server driver bridges approval requests through permission timeline', async () => {
    const client = createFakeCodexAppServerClient()
    const policyRequests: unknown[] = []
    const driver = createCodexAppServerDriver({
      cwd: '/tmp/project',
      client,
      policy: async (request) => {
        policyRequests.push(request)
        return { decision: 'ask', reason: 'approval required' }
      },
    })
    const timeline = createCollectingSequencer('codex')

    const send = driver.sendMessage({ message: 'delete tmp', options: { turnId: 'turn-1' } }, timeline)
    await waitFor(() => client.requests.some(request => request.method === 'turn/start'))

    const approval = client.emitRequest({
      id: 7,
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'cmd-2',
        approvalId: 'approval-2',
        command: 'rm -rf tmp',
        cwd: '/tmp/project',
        startedAtMs: 1_000,
      },
    })
    await waitFor(() => timeline.items.some(item => item.item.type === 'permission_requested'))

    expect(timeline.items[0]?.item).toMatchObject({
      type: 'permission_requested',
      request: {
        requestId: 'approval-2',
        toolName: 'Bash',
        input: { command: 'rm -rf tmp', cwd: '/tmp/project' },
        reason: 'approval required',
      },
    })
    expect(policyRequests[0]).toMatchObject({
      toolName: 'Bash',
      toolIntent: {
        kind: 'bash',
        command: 'rm -rf tmp',
        baseCommand: 'rm',
      },
      scope: { type: 'tool-call', callId: 'cmd-2' },
    })

    await driver.respondToPermission?.('approval-2', true, true)
    await expect(approval).resolves.toEqual({ decision: 'acceptForSession' })
    client.emitNotification({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'turn-1' } },
    })
    await send
    expect(timeline.items.map(item => item.item.type)).toEqual([
      'permission_requested',
      'permission_resolved',
      'turn_completed',
    ])
  })

  test('Codex app-server driver returns current approval decisions for allow and deny policy results', async () => {
    const client = createFakeCodexAppServerClient()
    const driver = createCodexAppServerDriver({
      cwd: '/tmp/project',
      client,
      policy: async (request) => {
        if (request.input?.command === 'pwd') return { decision: 'allow' }
        return { decision: 'deny', reason: 'blocked by policy' }
      },
    })
    const timeline = createCollectingSequencer('codex')

    const send = driver.sendMessage({ message: 'run commands', options: { turnId: 'turn-approval-policy' } }, timeline)
    await waitFor(() => client.requests.some(request => request.method === 'turn/start'))

    await expect(client.emitRequest({
      id: 8,
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-approval-policy',
        itemId: 'cmd-allow',
        approvalId: 'approval-allow',
        command: 'pwd',
        cwd: '/tmp/project',
      },
    })).resolves.toEqual({ decision: 'accept' })

    await expect(client.emitRequest({
      id: 9,
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-approval-policy',
        itemId: 'cmd-deny',
        approvalId: 'approval-deny',
        command: 'rm -rf tmp',
        cwd: '/tmp/project',
      },
    })).resolves.toEqual({ decision: 'decline' })

    client.emitNotification({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'turn-1' } },
    })
    await send
  })

  test('Codex app-server driver grants the requested permission subset when policy allows', async () => {
    const client = createFakeCodexAppServerClient({ turnId: 'turn-perm-allow' })
    const driver = createCodexAppServerDriver({
      cwd: '/tmp/project',
      client,
      policy: async () => ({ decision: 'allow' }),
    })
    const timeline = createCollectingSequencer('codex')

    const send = driver.sendMessage({ message: 'request permission', options: { turnId: 'turn-perm-allow' } }, timeline)
    await waitFor(() => client.requests.some(request => request.method === 'turn/start'))

    const requestedPermissions = { file_system: { entries: [] }, network: { enabled: true } }
    await expect(client.emitRequest({
      id: 10,
      method: 'item/permissions/requestApproval',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-perm-allow',
        itemId: 'permission-item-allow',
        cwd: '/tmp/project',
        permissions: requestedPermissions,
        startedAtMs: 1_000,
      },
    })).resolves.toEqual({ permissions: requestedPermissions, scope: 'turn' })

    client.emitNotification({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-perm-allow' } } })
    await send
  })

  test('Codex app-server driver denies all permissions when policy denies', async () => {
    const client = createFakeCodexAppServerClient({ turnId: 'turn-perm-deny' })
    const driver = createCodexAppServerDriver({
      cwd: '/tmp/project',
      client,
      policy: async () => ({ decision: 'deny', reason: 'network not permitted' }),
    })
    const timeline = createCollectingSequencer('codex')

    const send = driver.sendMessage({ message: 'request permission', options: { turnId: 'turn-perm-deny' } }, timeline)
    await waitFor(() => client.requests.some(request => request.method === 'turn/start'))

    await expect(client.emitRequest({
      id: 11,
      method: 'item/permissions/requestApproval',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-perm-deny',
        itemId: 'permission-item-deny',
        cwd: '/tmp/project',
        permissions: { network: { enabled: true } },
        startedAtMs: 1_000,
      },
    })).resolves.toEqual({ permissions: {}, scope: 'turn' })

    expect(timeline.items.some(item => item.item.type === 'permission_resolved')).toBe(true)
    expect(timeline.items.at(-1)?.item).toMatchObject({
      type: 'permission_resolved',
      requestId: 'permission-item-deny',
      resolution: { allowed: false, reason: 'network not permitted' },
    })

    client.emitNotification({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-perm-deny' } } })
    await send
  })

  test('Codex app-server driver surfaces permission requests to the host and honors respondToPermission', async () => {
    const client = createFakeCodexAppServerClient({ turnId: 'turn-perm-ask' })
    const driver = createCodexAppServerDriver({
      cwd: '/tmp/project',
      client,
      policy: async () => ({ decision: 'ask', reason: 'approval required' }),
    })
    const timeline = createCollectingSequencer('codex')

    const send = driver.sendMessage({ message: 'request permission', options: { turnId: 'turn-perm-ask' } }, timeline)
    await waitFor(() => client.requests.some(request => request.method === 'turn/start'))

    const requestedPermissions = { network: { enabled: true } }
    const approval = client.emitRequest({
      id: 12,
      method: 'item/permissions/requestApproval',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-perm-ask',
        itemId: 'permission-item-ask',
        cwd: '/tmp/project',
        permissions: requestedPermissions,
        startedAtMs: 1_000,
      },
    })
    await waitFor(() => timeline.items.some(item => item.item.type === 'permission_requested'))

    expect(timeline.items.at(-1)?.item).toMatchObject({
      type: 'permission_requested',
      request: { requestId: 'permission-item-ask', toolName: 'network' },
    })

    await driver.respondToPermission?.('permission-item-ask', true, false)
    await expect(approval).resolves.toEqual({ permissions: requestedPermissions, scope: 'turn' })

    expect(timeline.items.map(item => item.item.type)).toContain('permission_resolved')

    client.emitNotification({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-perm-ask' } } })
    await send
  })

  test('Codex app-server driver interrupts the in-flight turn on abort', async () => {
    const client = createFakeCodexAppServerClient({ turnId: 'server-turn-abort' })
    const driver = createCodexAppServerDriver({ cwd: '/tmp/project', client })
    const timeline = createCollectingSequencer('codex')

    const send = driver.sendMessage({ message: 'long task', options: { turnId: 'turn-abort' } }, timeline)
    await waitFor(() => client.requests.some(request => request.method === 'turn/start'))

    await driver.abort?.()
    await send

    const interrupt = client.requests.find(request => request.method === 'turn/interrupt')
    expect(interrupt).toBeDefined()
    expect(interrupt?.params).toMatchObject({ threadId: 'thread-1', turnId: 'server-turn-abort' })
  })

  test('Codex app-server driver surfaces a failed turn as turn_failed and fails the runtime state', async () => {
    const client = createFakeCodexAppServerClient({ turnId: 'server-turn-failed' })
    const runtime = createCodexProviderRuntime({
      cwd: '/tmp/project',
      sessionId: 'codex-failed',
      epoch: 'epoch-failed',
      now: () => 1_000,
      candidates: createCodexRuntimeCandidates({ appServerAvailable: true, nativeSdkAvailable: false, cliFallbackAvailable: false }),
      auth: { mode: 'provider-owned', configured: true, source: 'test' },
      appServerClient: client,
    })

    await runtime.preflight()
    const send = runtime.commands.sendMessage('do work')
    await waitFor(() => client.requests.some(request => request.method === 'turn/start'))

    client.emitNotification({
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: {
          id: 'server-turn-failed',
          status: 'failed',
          error: { message: 'context window exceeded', codexErrorInfo: 'contextWindowExceeded' },
        },
      },
    })
    // A failed turn now rejects sendMessage (CodexTurnFailureError) while still
    // appending a structured turn_failed carrying codexErrorInfo.
    await expect(send).rejects.toThrow('context window exceeded')

    expect(runtime.getState().status).toBe('failed')
    const replay = await runtime.fetchTimeline({})
    const failed = replay.items.filter(item => item.item.type === 'turn_failed')
    expect(failed).toHaveLength(1)
    expect(failed[0]?.item).toMatchObject({
      type: 'turn_failed',
      turnId: 'server-turn-failed',
      error: { message: 'context window exceeded', codexErrorInfo: 'contextWindowExceeded' },
    })
  })

  test('Codex app-server driver stashes a terminal mid-turn error and surfaces it on failed completion', async () => {
    const client = createFakeCodexAppServerClient({ turnId: 'server-turn-error' })
    const driver = createCodexAppServerDriver({ cwd: '/tmp/project', client })
    const timeline = createCollectingSequencer('codex')

    const send = driver.sendMessage({ message: 'do work', options: { turnId: 'turn-error' } }, timeline)
    await waitFor(() => client.requests.some(request => request.method === 'turn/start'))

    client.emitNotification({
      method: 'error',
      params: {
        threadId: 'thread-1',
        turnId: 'server-turn-error',
        willRetry: false,
        error: { message: 'upstream 500', codexErrorInfo: 'internalServerError' },
      },
    })
    // The turn hasn't terminated yet — no turn_failed until turn/completed.
    expect(timeline.items.some(item => item.item.type === 'turn_failed')).toBe(false)

    client.emitNotification({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'server-turn-error', status: 'failed' } },
    })
    await expect(send).rejects.toThrow('upstream 500')

    const failed = timeline.items.find(item => item.item.type === 'turn_failed')
    expect(failed?.item).toMatchObject({
      type: 'turn_failed',
      turnId: 'turn-error',
      error: { message: 'upstream 500', codexErrorInfo: 'internalServerError' },
    })
  })

  test('Codex app-server driver ignores transient error notifications that will retry', async () => {
    const client = createFakeCodexAppServerClient({ turnId: 'server-turn-retry' })
    const driver = createCodexAppServerDriver({ cwd: '/tmp/project', client })
    const timeline = createCollectingSequencer('codex')

    const send = driver.sendMessage({ message: 'do work', options: { turnId: 'turn-retry' } }, timeline)
    await waitFor(() => client.requests.some(request => request.method === 'turn/start'))

    client.emitNotification({
      method: 'error',
      params: { threadId: 'thread-1', turnId: 'server-turn-retry', willRetry: true, error: { message: 'transient' } },
    })
    expect(timeline.items.some(item => item.item.type === 'turn_failed')).toBe(false)

    client.emitNotification({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'server-turn-retry' } } })
    await send

    expect(timeline.items.map(item => item.item.type)).toContain('turn_completed')
    expect(timeline.items.some(item => item.item.type === 'turn_failed')).toBe(false)
  })

  test('Codex app-server driver returns protocol-valid safe defaults for unsupported server requests', async () => {
    const client = createFakeCodexAppServerClient({ turnId: 'server-turn-requests' })
    const driver = createCodexAppServerDriver({ cwd: '/tmp/project', client })
    const timeline = createCollectingSequencer('codex')

    const send = driver.sendMessage({ message: 'use tools', options: { turnId: 'turn-requests' } }, timeline)
    await waitFor(() => client.requests.some(request => request.method === 'turn/start'))

    await expect(client.emitRequest({
      id: 20,
      method: 'item/tool/requestUserInput',
      params: { threadId: 'thread-1', turnId: 'turn-requests', itemId: 'ui-1', questions: [] },
    })).resolves.toEqual({ answers: {} })

    await expect(client.emitRequest({
      id: 21,
      method: 'mcpServer/elicitation/request',
      params: { threadId: 'thread-1', turnId: 'turn-requests', serverName: 'mcp-x', mode: 'form', message: 'Authorize?', requestedSchema: { type: 'object' } },
    })).resolves.toEqual({ action: 'decline' })

    await expect(client.emitRequest({
      id: 22,
      method: 'item/tool/call',
      params: { threadId: 'thread-1', turnId: 'turn-requests', callId: 'dyn-1', tool: 'myTool', arguments: {} },
    })).resolves.toEqual({ contentItems: [], success: false })

    client.emitNotification({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'server-turn-requests' } } })
    await send
  })

  test('Codex app-server driver forwards per-turn model, effort, and outputSchema to turn start', async () => {
    const client = createFakeCodexAppServerClient({ turnId: 'server-turn-overrides' })
    const driver = createCodexAppServerDriver({ cwd: '/tmp/project', client })
    const timeline = createCollectingSequencer('codex')

    const outputSchema = {
      type: 'object',
      properties: { summary: { type: 'string' } },
      required: ['summary'],
    }
    const send = driver.sendMessage({
      message: 'summarize',
      options: { turnId: 'turn-overrides', model: 'gpt-5.5', reasoningEffort: 'xhigh', outputSchema },
    }, timeline)
    await waitFor(() => client.requests.some(request => request.method === 'turn/start'))

    expect(client.requests.find(request => request.method === 'turn/start')?.params).toMatchObject({
      model: 'gpt-5.5',
      effort: 'xhigh',
      outputSchema,
    })

    client.emitNotification({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'server-turn-overrides' } } })
    await send
  })

  test('Codex app-server driver maps webSearch, contextCompaction, and plan items into the timeline', async () => {
    const client = createFakeCodexAppServerClient({ turnId: 'server-turn-items' })
    const driver = createCodexAppServerDriver({ cwd: '/tmp/project', client })
    const timeline = createCollectingSequencer('codex')

    const send = driver.sendMessage({ message: 'research', options: { turnId: 'turn-items' } }, timeline)
    await waitFor(() => client.requests.some(request => request.method === 'turn/start'))

    client.emitNotification({
      method: 'item/started',
      params: {
        threadId: 'thread-1', turnId: 'server-turn-items',
        item: { type: 'webSearch', id: 'search-1', query: 'codex app-server', action: { type: 'search', query: 'codex app-server' } },
      },
    })
    client.emitNotification({
      method: 'item/completed',
      params: {
        threadId: 'thread-1', turnId: 'server-turn-items',
        item: { type: 'webSearch', id: 'search-1', query: 'codex app-server', action: { type: 'search', query: 'codex app-server' } },
      },
    })
    client.emitNotification({
      method: 'item/started',
      params: { threadId: 'thread-1', turnId: 'server-turn-items', item: { type: 'contextCompaction', id: 'compact-1' } },
    })
    client.emitNotification({
      method: 'item/completed',
      params: { threadId: 'thread-1', turnId: 'server-turn-items', item: { type: 'contextCompaction', id: 'compact-1' } },
    })
    client.emitNotification({
      method: 'item/completed',
      params: { threadId: 'thread-1', turnId: 'server-turn-items', item: { type: 'plan', id: 'plan-1', text: '1. search\n2. summarize' } },
    })
    client.emitNotification({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'server-turn-items' } } })
    await send

    expect(timeline.items.map(item => item.item.type)).toEqual([
      'tool_call',
      'tool_result',
      'compaction_started',
      'compaction_boundary',
      'reasoning',
      'turn_completed',
    ])
    expect(timeline.items[0]?.item).toMatchObject({ type: 'tool_call', callId: 'search-1', name: 'webSearch' })
    expect(timeline.items[1]?.item).toMatchObject({ type: 'tool_result', callId: 'search-1', result: { query: 'codex app-server' } })
    expect(timeline.items[4]?.item).toMatchObject({ type: 'reasoning', messageId: 'plan-1', text: '1. search\n2. summarize' })
  })

  test('Codex app-server driver attaches token usage to turn_completed', async () => {
    const client = createFakeCodexAppServerClient({ turnId: 'server-turn-usage' })
    const driver = createCodexAppServerDriver({ cwd: '/tmp/project', client })
    const timeline = createCollectingSequencer('codex')

    const send = driver.sendMessage({ message: 'work', options: { turnId: 'turn-usage' } }, timeline)
    await waitFor(() => client.requests.some(request => request.method === 'turn/start'))

    client.emitNotification({
      method: 'thread/tokenUsage/updated',
      params: {
        threadId: 'thread-1',
        turnId: 'server-turn-usage',
        tokenUsage: {
          total: { totalTokens: 1200, inputTokens: 1000, cachedInputTokens: 200, outputTokens: 200, reasoningOutputTokens: 50 },
          last: { totalTokens: 1200, inputTokens: 1000, cachedInputTokens: 200, outputTokens: 200, reasoningOutputTokens: 50 },
          modelContextWindow: 200000,
        },
      },
    })
    client.emitNotification({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'server-turn-usage' } } })
    await send

    const completed = timeline.items.find(item => item.item.type === 'turn_completed')
    expect(completed?.item).toMatchObject({
      type: 'turn_completed',
      turnId: 'turn-usage',
      usage: { total: { totalTokens: 1200, outputTokens: 200, reasoningOutputTokens: 50 }, modelContextWindow: 200000 },
    })
  })

  test('Codex app-server driver fails the in-flight turn when the connection drops', async () => {
    const client = createFakeCodexAppServerClient({ turnId: 'server-turn-crash' })
    const runtime = createCodexProviderRuntime({
      cwd: '/tmp/project',
      sessionId: 'codex-crash',
      epoch: 'epoch-crash',
      now: () => 1_000,
      candidates: createCodexRuntimeCandidates({ appServerAvailable: true, nativeSdkAvailable: false, cliFallbackAvailable: false }),
      auth: { mode: 'provider-owned', configured: true, source: 'test' },
      appServerClient: client,
    })

    await runtime.preflight()
    const send = runtime.commands.sendMessage('long task')
    await waitFor(() => client.requests.some(request => request.method === 'turn/start'))

    // Codex crashes mid-turn; no turn/completed will ever arrive.
    client.emitClose()
    await expect(send).rejects.toThrow('connection closed unexpectedly')

    expect(runtime.getState().status).toBe('failed')
    const replay = await runtime.fetchTimeline({})
    expect(replay.items.some(item => item.item.type === 'turn_failed')).toBe(true)
    expect(replay.items.filter(item => item.item.type === 'turn_failed')).toHaveLength(1)
  })

  test('Codex app-server driver does not emit a spurious turn_failed when the connection drops after a turn already completed', async () => {
    const client = createFakeCodexAppServerClient({ turnId: 'server-turn-done' })
    const runtime = createCodexProviderRuntime({
      cwd: '/tmp/project',
      sessionId: 'codex-done',
      epoch: 'epoch-done',
      now: () => 1_000,
      candidates: createCodexRuntimeCandidates({ appServerAvailable: true, nativeSdkAvailable: false, cliFallbackAvailable: false }),
      auth: { mode: 'provider-owned', configured: true, source: 'test' },
      appServerClient: client,
    })

    await runtime.preflight()
    const send = runtime.commands.sendMessage('done')
    await waitFor(() => client.requests.some(request => request.method === 'turn/start'))

    // Turn completes normally, then the connection drops afterward.
    client.emitNotification({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'server-turn-done' } } })
    await send
    client.emitClose()

    const replay = await runtime.fetchTimeline({})
    expect(replay.items.some(item => item.item.type === 'turn_failed')).toBe(false)
    expect(replay.items.some(item => item.item.type === 'turn_completed')).toBe(true)
  })

  test('Codex app-server subprocess client rejects pending requests and fires onClose when the process exits', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'weft-codex-crash-'))
    const executable = join(tempDir, 'codex-crash.js')
    try {
      await writeFile(executable, `#!/usr/bin/env node
process.stdin.setEncoding('utf8')
let buffer = ''
process.stdin.on('data', (chunk) => {
  buffer += chunk
  const lines = buffer.split('\\n')
  buffer = lines.pop() || ''
  for (const line of lines) {
    if (!line.trim()) continue
    const message = JSON.parse(line)
    if (message.method === 'initialize') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }) + '\\n')
    } else if (message.method === 'account/read') {
      // Crash mid-request instead of responding.
      process.exit(0)
    }
  }
})
`, 'utf8')
      await chmod(executable, 0o755)

      const client = await createCodexAppServerSubprocessClient({ executable })
      let closed = false
      client.onClose(() => { closed = true })

      await expect(client.request('account/read', { refreshToken: false })).rejects.toThrow('closed unexpectedly')
      expect(closed).toBe(true)
      client.close()
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('Codex app-server driver streams reasoning deltas and maps userMessage items', async () => {
    const client = createFakeCodexAppServerClient({ turnId: 'server-turn-reasoning' })
    const driver = createCodexAppServerDriver({ cwd: '/tmp/project', client })
    const timeline = createCollectingSequencer('codex')

    const send = driver.sendMessage({ message: 'think it through', options: { turnId: 'turn-reasoning' } }, timeline)
    await waitFor(() => client.requests.some(request => request.method === 'turn/start'))

    client.emitNotification({
      method: 'item/reasoning/summaryTextDelta',
      params: { threadId: 'thread-1', turnId: 'server-turn-reasoning', itemId: 'reason-1', delta: 'Consid' },
    })
    client.emitNotification({
      method: 'item/reasoning/summaryTextDelta',
      params: { threadId: 'thread-1', turnId: 'server-turn-reasoning', itemId: 'reason-1', delta: 'ering options' },
    })
    client.emitNotification({
      method: 'item/completed',
      params: {
        threadId: 'thread-1', turnId: 'server-turn-reasoning',
        item: { type: 'userMessage', id: 'user-msg-1', content: [{ type: 'text', text: 'think it through', text_elements: [] }] },
      },
    })
    client.emitNotification({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'server-turn-reasoning' } } })
    await send

    expect(timeline.items.map(item => item.item.type)).toEqual([
      'reasoning_delta',
      'reasoning_delta',
      'user_message',
      'turn_completed',
    ])
    expect(timeline.items[0]?.item).toMatchObject({ type: 'reasoning_delta', text: 'Consid', messageId: 'reason-1', turnId: 'turn-reasoning' })
    expect(timeline.items[2]?.item).toMatchObject({ type: 'user_message', text: 'think it through', messageId: 'user-msg-1', turnId: 'turn-reasoning' })
  })

  test('Codex app-server JSON-RPC client initializes and routes server messages', async () => {
    const transport = createFakeCodexJsonRpcTransport()
    const client = createCodexAppServerJsonRpcClient({
      transport,
      requestTimeoutMs: 1_000,
    })
    const notifications: Array<{ method: string; params?: unknown }> = []
    client.onNotification(notification => notifications.push(notification))
    client.onRequest(async request => {
      expect(request.method).toBe('item/commandExecution/requestApproval')
      return { decision: 'accept' }
    })

    const initialize = client.initialize()
    await waitFor(() => transport.writes.length === 1)
    expect(JSON.parse(transport.writes[0] ?? '{}')).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
    })
    transport.emit({ jsonrpc: '2.0', id: 1, result: { ok: true } })
    await initialize
    expect(JSON.parse(transport.writes[1] ?? '{}')).toMatchObject({
      jsonrpc: '2.0',
      method: 'initialized',
    })

    const account = client.request('account/read', { refreshToken: false })
    await waitFor(() => transport.writes.length === 3)
    expect(JSON.parse(transport.writes[2] ?? '{}')).toMatchObject({
      jsonrpc: '2.0',
      id: 2,
      method: 'account/read',
      params: { refreshToken: false },
    })
    transport.emit({ jsonrpc: '2.0', id: 2, result: { account: { email: 'me@example.com' } } })
    await expect(account).resolves.toEqual({ account: { email: 'me@example.com' } })

    transport.emit({ jsonrpc: '2.0', method: 'turn/started', params: { turn: { id: 'turn-1' } } })
    expect(notifications).toEqual([
      { method: 'turn/started', params: { turn: { id: 'turn-1' } } },
    ])

    transport.emit({
      jsonrpc: '2.0',
      id: 3,
      method: 'item/commandExecution/requestApproval',
      params: { itemId: 'cmd-1' },
    })
    await waitFor(() => transport.writes.length === 4)
    expect(JSON.parse(transport.writes[3] ?? '{}')).toEqual({
      jsonrpc: '2.0',
      id: 3,
      result: { decision: 'accept' },
    })
  })

  test('Codex app-server JSON-RPC client registers a pending request before a synchronous response', async () => {
    const handlers = new Set<(message: unknown) => void>()
    const client = createCodexAppServerJsonRpcClient({
      requestTimeoutMs: 50,
      transport: {
        write(message) {
          const request = JSON.parse(message) as { id?: number }
          if (request.id !== undefined) {
            for (const handler of handlers) handler({ jsonrpc: '2.0', id: request.id, result: { ok: true } })
          }
        },
        onMessage(handler) {
          handlers.add(handler)
          return () => handlers.delete(handler)
        },
      },
    })

    await expect(client.request('account/read')).resolves.toEqual({ ok: true })
  })

  test('Codex auth detection ignores notifications while awaiting matching JSON-RPC responses', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'weft-codex-auth-notification-'))
    const executable = join(tempDir, 'codex-notification.js')
    await writeFile(executable, `#!/usr/bin/env node
let buffer = ''
process.stdin.on('data', chunk => {
  buffer += chunk
  for (;;) {
    const newline = buffer.indexOf('\\n')
    if (newline < 0) return
    const line = buffer.slice(0, newline)
    buffer = buffer.slice(newline + 1)
    if (!line.trim()) continue
    const request = JSON.parse(line)
    if (request.method === 'initialize') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'account/updated', params: { authMode: 'chatgpt' } }) + '\\n')
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} }) + '\\n')
    }
    if (request.method === 'account/read') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'account/updated', params: { authMode: 'chatgpt' } }) + '\\n')
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { account: { id: 'account-1' } } }) + '\\n')
    }
  }
})
`)
    await chmod(executable, 0o755)

    try {
      await expect(readCodexAuth(executable, process.env as Record<string, string>, 1_000)).resolves.toMatchObject({
        configured: true,
        accountPresent: true,
      })
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('Codex app-server driver filters trailing item/* notifications after abort', async () => {
    const client = createFakeCodexAppServerClient({ turnId: 'server-turn-abort-filter' })
    const driver = createCodexAppServerDriver({ cwd: '/tmp/project', client })
    const timeline = createCollectingSequencer('codex')

    const send = driver.sendMessage({ message: 'long task', options: { turnId: 'turn-abort-filter' } }, timeline)
    await waitFor(() => client.requests.some(request => request.method === 'turn/start'))

    await driver.abort?.()
    // codex keeps emitting trailing item/* and a terminal turn/completed for
    // the interrupted turn after abort — these must not pollute the timeline.
    client.emitNotification({
      method: 'item/started',
      params: {
        threadId: 'thread-1',
        turnId: 'server-turn-abort-filter',
        item: { type: 'commandExecution', id: 'cmd-late', command: 'ls', cwd: '/tmp/project', status: 'running' },
      },
    })
    client.emitNotification({
      method: 'item/completed',
      params: { threadId: 'thread-1', turnId: 'server-turn-abort-filter', item: { type: 'agentMessage', id: 'msg-late', text: 'late' } },
    })
    client.emitNotification({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'server-turn-abort-filter', status: 'interrupted' } },
    })
    await send

    expect(timeline.items.map(item => item.item.type)).not.toContain('tool_call')
    expect(timeline.items.map(item => item.item.type)).not.toContain('assistant_message')
    expect(timeline.items.map(item => item.item.type)).not.toContain('turn_interrupted')
    expect(timeline.items.map(item => item.item.type)).not.toContain('turn_completed')
    expect(timeline.items.map(item => item.item.type)).not.toContain('turn_failed')
  })

  test('Codex app-server driver surfaces a server-initiated interrupted turn as turn_interrupted', async () => {
    const client = createFakeCodexAppServerClient({ turnId: 'server-turn-interrupted' })
    const driver = createCodexAppServerDriver({ cwd: '/tmp/project', client })
    const timeline = createCollectingSequencer('codex')

    const send = driver.sendMessage({ message: 'work', options: { turnId: 'turn-interrupted' } }, timeline)
    await waitFor(() => client.requests.some(request => request.method === 'turn/start'))
    client.emitNotification({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'server-turn-interrupted', status: 'interrupted' } },
    })
    // An interrupted (non-aborted) turn resolves — it is not a failure — and
    // emits a distinct turn_interrupted marker rather than turn_completed.
    await send

    expect(timeline.items.at(-1)?.item).toMatchObject({ type: 'turn_interrupted', turnId: 'turn-interrupted' })
    expect(timeline.items.some(item => item.item.type === 'turn_failed')).toBe(false)
  })

  test('Codex app-server driver surfaces requestUserInput, elicitation, and dynamic tool call on the timeline', async () => {
    const client = createFakeCodexAppServerClient({ turnId: 'server-turn-requests-tl' })
    const driver = createCodexAppServerDriver({ cwd: '/tmp/project', client })
    const timeline = createCollectingSequencer('codex')

    const send = driver.sendMessage({ message: 'use tools', options: { turnId: 'turn-requests-tl' } }, timeline)
    await waitFor(() => client.requests.some(request => request.method === 'turn/start'))

    await client.emitRequest({
      id: 30,
      method: 'item/tool/requestUserInput',
      params: { threadId: 'thread-1', turnId: 'turn-requests-tl', itemId: 'ui-tl', questions: [{ id: 'q1', prompt: 'name?' }] },
    })
    await client.emitRequest({
      id: 31,
      method: 'mcpServer/elicitation/request',
      params: { threadId: 'thread-1', turnId: 'turn-requests-tl', serverName: 'mcp-x', mode: 'form', message: 'Authorize?', requestedSchema: { type: 'object' } },
    })
    await client.emitRequest({
      id: 32,
      method: 'item/tool/call',
      params: { threadId: 'thread-1', turnId: 'turn-requests-tl', callId: 'dyn-tl', tool: 'myTool', arguments: {} },
    })

    const states = timeline.items
      .filter(item => item.item.type === 'host_state_changed')
      .map(item => (item.item as { state: { kind: string } }).state.kind)
    expect(states).toEqual(['codex_user_input_requested', 'codex_elicitation_requested', 'codex_dynamic_tool_call'])

    client.emitNotification({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'server-turn-requests-tl' } } })
    await send
  })

  test('Codex app-server driver maps collabAgentToolCall and imageGeneration items', async () => {
    const client = createFakeCodexAppServerClient({ turnId: 'server-turn-items-extra' })
    const driver = createCodexAppServerDriver({ cwd: '/tmp/project', client })
    const timeline = createCollectingSequencer('codex')

    const send = driver.sendMessage({ message: 'spawn + image', options: { turnId: 'turn-items-extra' } }, timeline)
    await waitFor(() => client.requests.some(request => request.method === 'turn/start'))

    client.emitNotification({
      method: 'item/started',
      params: {
        threadId: 'thread-1', turnId: 'server-turn-items-extra',
        item: { type: 'collabAgentToolCall', id: 'collab-1', tool: 'spawnAgent', status: 'inProgress', senderThreadId: 'thread-1', receiverThreadIds: ['thread-2'], prompt: 'do X', model: null, reasoningEffort: null, agentsStates: {} },
      },
    })
    client.emitNotification({
      method: 'item/completed',
      params: {
        threadId: 'thread-1', turnId: 'server-turn-items-extra',
        item: { type: 'collabAgentToolCall', id: 'collab-1', tool: 'spawnAgent', status: 'completed', senderThreadId: 'thread-1', receiverThreadIds: ['thread-2'], prompt: 'do X', model: null, reasoningEffort: null, agentsStates: { 'thread-2': 'completed' } },
      },
    })
    client.emitNotification({
      method: 'item/started',
      params: {
        threadId: 'thread-1', turnId: 'server-turn-items-extra',
        item: { type: 'imageGeneration', id: 'img-1', status: 'completed', revisedPrompt: 'a cat', result: 'url', savedPath: '/tmp/cat.png' },
      },
    })
    client.emitNotification({
      method: 'item/completed',
      params: {
        threadId: 'thread-1', turnId: 'server-turn-items-extra',
        item: { type: 'imageGeneration', id: 'img-1', status: 'completed', revisedPrompt: 'a cat', result: 'url', savedPath: '/tmp/cat.png' },
      },
    })
    client.emitNotification({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'server-turn-items-extra' } } })
    await send

    expect(timeline.items.map(item => item.item.type)).toEqual([
      'tool_call',
      'tool_result',
      'tool_call',
      'tool_result',
      'turn_completed',
    ])
    expect(timeline.items[0]?.item).toMatchObject({ type: 'tool_call', callId: 'collab-1', name: 'collab.spawnAgent' })
    expect(timeline.items[1]?.item).toMatchObject({ type: 'tool_result', callId: 'collab-1', isError: false })
    expect(timeline.items[2]?.item).toMatchObject({ type: 'tool_call', callId: 'img-1', name: 'imageGeneration' })
    expect(timeline.items[3]?.item).toMatchObject({ type: 'tool_result', callId: 'img-1' })
  })

  test('Codex app-server driver streams plan deltas and maps thread status changes', async () => {
    const client = createFakeCodexAppServerClient({ turnId: 'server-turn-plan-stream' })
    const driver = createCodexAppServerDriver({ cwd: '/tmp/project', client })
    const timeline = createCollectingSequencer('codex')

    const send = driver.sendMessage({ message: 'plan', options: { turnId: 'turn-plan-stream' } }, timeline)
    await waitFor(() => client.requests.some(request => request.method === 'turn/start'))

    client.emitNotification({
      method: 'item/plan/delta',
      params: { threadId: 'thread-1', turnId: 'server-turn-plan-stream', itemId: 'plan-d', delta: 'step 1' },
    })
    client.emitNotification({
      method: 'thread/status/changed',
      params: { threadId: 'thread-1', status: 'busy' },
    })
    client.emitNotification({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'server-turn-plan-stream' } } })
    await send

    expect(timeline.items.map(item => item.item.type)).toEqual([
      'reasoning_delta',
      'session_status',
      'turn_completed',
    ])
    expect(timeline.items[0]?.item).toMatchObject({ type: 'reasoning_delta', text: 'step 1' })
    expect(timeline.items[1]?.item).toMatchObject({ type: 'session_status', status: 'busy' })
  })

  test('Codex app-server driver streams mcpToolCall/progress and fileChange patch deltas as tool_output_delta', async () => {
    const client = createFakeCodexAppServerClient({ turnId: 'server-turn-progress' })
    const driver = createCodexAppServerDriver({ cwd: '/tmp/project', client })
    const timeline = createCollectingSequencer('codex')

    const send = driver.sendMessage({ message: 'work', options: { turnId: 'turn-progress' } }, timeline)
    await waitFor(() => client.requests.some(request => request.method === 'turn/start'))

    // mcpToolCall/progress carries `message` (no `delta`); fileChange/patchUpdated carries `changes`.
    client.emitNotification({
      method: 'item/started',
      params: { threadId: 'thread-1', turnId: 'server-turn-progress', item: { type: 'mcpToolCall', id: 'mcp-p', server: 's', tool: 't', status: 'inProgress', arguments: {} } },
    })
    client.emitNotification({
      method: 'item/mcpToolCall/progress',
      params: { threadId: 'thread-1', turnId: 'server-turn-progress', itemId: 'mcp-p', message: 'downloading 50%' },
    })
    client.emitNotification({
      method: 'item/fileChange/patchUpdated',
      params: { threadId: 'thread-1', turnId: 'server-turn-progress', itemId: 'mcp-p', changes: [{ path: '/a' }] },
    })
    client.emitNotification({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'server-turn-progress' } } })
    await send

    const deltas = timeline.items.filter(item => item.item.type === 'tool_output_delta')
    expect(deltas).toHaveLength(2)
    expect(deltas[0]?.item).toMatchObject({ type: 'tool_output_delta', callId: 'mcp-p', text: 'downloading 50%' })
    const completedDelta = deltas[1]
    expect(completedDelta?.item).toMatchObject({ type: 'tool_output_delta', callId: 'mcp-p' })
    if (completedDelta?.item.type !== 'tool_output_delta') {
      throw new Error('Expected a completed tool output delta')
    }
    expect(String(completedDelta.item.text)).toContain('path')
  })

  test('Codex app-server driver stops tracking an aborted turn once its turn/completed arrives', async () => {
    const client = createFakeCodexAppServerClient({ turnId: 'server-turn-abort-bound' })
    const driver = createCodexAppServerDriver({ cwd: '/tmp/project', client })
    const timeline = createCollectingSequencer('codex')

    const send = driver.sendMessage({ message: 'long', options: { turnId: 'turn-abort-bound' } }, timeline)
    await waitFor(() => client.requests.some(request => request.method === 'turn/start'))
    await driver.abort?.()
    // The aborted turn's terminal turn/completed is dropped, and tracking stops.
    client.emitNotification({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'server-turn-abort-bound', status: 'interrupted' } } })
    await send
    expect(timeline.items.some(item => item.item.type === 'turn_interrupted')).toBe(false)

    // A subsequent turn reusing the same provider turn id is NOT filtered (the
    // aborted id was untracked on its terminal event), so its items surface.
    const send2 = driver.sendMessage({ message: 'again', options: { turnId: 'turn-abort-bound-2' } }, timeline)
    await waitFor(() => client.requests.some(request => request.method === 'turn/start'))
    client.emitNotification({
      method: 'item/completed',
      params: { threadId: 'thread-1', turnId: 'server-turn-abort-bound', item: { type: 'agentMessage', id: 'msg-2', text: 'hi' } },
    })
    client.emitNotification({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'server-turn-abort-bound' } } })
    await send2
    expect(timeline.items.some(item => item.item.type === 'assistant_message')).toBe(true)
  })

  test('Codex app-server driver forwards per-turn serviceTier, summary, and personality to turn start', async () => {
    const client = createFakeCodexAppServerClient({ turnId: 'server-turn-overrides-extra' })
    const driver = createCodexAppServerDriver({ cwd: '/tmp/project', client })
    const timeline = createCollectingSequencer('codex')

    const send = driver.sendMessage({
      message: 'go',
      options: { turnId: 'turn-overrides-extra', serviceTier: 'priority', summary: 'auto', personality: 'concise' },
    }, timeline)
    await waitFor(() => client.requests.some(request => request.method === 'turn/start'))

    expect(client.requests.find(request => request.method === 'turn/start')?.params).toMatchObject({
      serviceTier: 'priority',
      summary: 'auto',
      personality: 'concise',
    })

    client.emitNotification({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'server-turn-overrides-extra' } } })
    await send
  })

  test('Codex app-server driver forwards thread-level overrides to thread start', async () => {
    const client = createFakeCodexAppServerClient({ turnId: 'server-turn-thread-overrides' })
    const driver = createCodexAppServerDriver({
      cwd: '/tmp/project',
      client,
      modelProvider: 'openai',
      baseInstructions: 'be brief',
      developerInstructions: 'use tools',
      personality: 'helpful',
      serviceName: 'weft',
      threadSource: 'host',
    })
    const timeline = createCollectingSequencer('codex')

    const send = driver.sendMessage({ message: 'go', options: { turnId: 'turn-thread-overrides' } }, timeline)
    await waitFor(() => client.requests.some(request => request.method === 'turn/start'))

    expect(client.requests[0]?.params).toMatchObject({
      modelProvider: 'openai',
      baseInstructions: 'be brief',
      developerInstructions: 'use tools',
      personality: 'helpful',
      serviceName: 'weft',
      threadSource: 'host',
    })

    client.emitNotification({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'server-turn-thread-overrides' } } })
    await send
  })

  test('Codex capability report marks sources degraded when app-server is available', () => {
    const candidates = createCodexRuntimeCandidates({ appServerAvailable: true, nativeSdkAvailable: false, cliFallbackAvailable: false })
    const report = createCodexRuntimeCapabilityReport({
      candidates,
      auth: { mode: 'provider-owned', configured: true, source: 'test' },
    })
    // Sources look supported (app-server available) but are marked degraded:
    // dynamicTools execution bridge is deferred.
    expect(report.sourceCapabilities.supported).toBe(true)
    expect(report.sourceCapabilities.degraded).toBe(true)
    expect(report.sourceCapabilities.reason).toContain('dynamicTools')
  })

  test('Codex app-server driver returns currentTimeAt for currentTime/read requests', async () => {
    const client = createFakeCodexAppServerClient({ turnId: 'server-turn-time' })
    const driver = createCodexAppServerDriver({ cwd: '/tmp/project', client })
    const timeline = createCollectingSequencer('codex')

    const send = driver.sendMessage({ message: 'work', options: { turnId: 'turn-time' } }, timeline)
    await waitFor(() => client.requests.some(request => request.method === 'turn/start'))

    const before = Math.floor(Date.now() / 1000)
    const response = await client.emitRequest({
      id: 40,
      method: 'currentTime/read',
      params: { threadId: 'thread-1' },
    })
    const after = Math.floor(Date.now() / 1000)

    expect(response).toHaveProperty('currentTimeAt')
    const timeAt = (response as { currentTimeAt: number }).currentTimeAt
    expect(timeAt).toBeGreaterThanOrEqual(before)
    expect(timeAt).toBeLessThanOrEqual(after)

    client.emitNotification({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'server-turn-time' } } })
    await send
  })

  test('Codex app-server driver returns JSON-RPC errors for unsupported auth requests', async () => {
    const client = createFakeCodexAppServerClient({ turnId: 'server-turn-auth' })
    const driver = createCodexAppServerDriver({ cwd: '/tmp/project', client })
    const timeline = createCollectingSequencer('codex')

    const send = driver.sendMessage({ message: 'work', options: { turnId: 'turn-auth' } }, timeline)
    await waitFor(() => client.requests.some(request => request.method === 'turn/start'))

    await expect(client.emitRequest({
      id: 41,
      method: 'account/chatgptAuthTokens/refresh',
      params: {},
    })).rejects.toThrow('not supported')

    await expect(client.emitRequest({
      id: 42,
      method: 'attestation/generate',
      params: {},
    })).rejects.toThrow('not supported')

    client.emitNotification({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'server-turn-auth' } } })
    await send
  })

  test('Codex app-server driver surfaces model/rerouted notifications on the timeline', async () => {
    const client = createFakeCodexAppServerClient({ turnId: 'server-turn-reroute' })
    const driver = createCodexAppServerDriver({ cwd: '/tmp/project', client })
    const timeline = createCollectingSequencer('codex')

    const send = driver.sendMessage({ message: 'work', options: { turnId: 'turn-reroute' } }, timeline)
    await waitFor(() => client.requests.some(request => request.method === 'turn/start'))

    client.emitNotification({
      method: 'model/rerouted',
      params: { threadId: 'thread-1', turnId: 'server-turn-reroute', fromModel: 'o3-pro', toModel: 'o3', reason: 'quota_exceeded' },
    })
    client.emitNotification({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'server-turn-reroute' } } })
    await send

    const rerouted = timeline.items.find(item => item.item.type === 'host_state_changed')
    expect(rerouted).toBeDefined()
    expect((rerouted!.item as { state: { kind: string; fromModel: string; toModel: string; reason: string; turnId: string } }).state).toMatchObject({
      kind: 'codex_model_rerouted',
      fromModel: 'o3-pro',
      toModel: 'o3',
      reason: 'quota_exceeded',
      turnId: 'turn-reroute',
    })
  })

  test('Codex app-server driver surfaces warning notifications on the timeline', async () => {
    const client = createFakeCodexAppServerClient({ turnId: 'server-turn-warn' })
    const driver = createCodexAppServerDriver({ cwd: '/tmp/project', client })
    const timeline = createCollectingSequencer('codex')

    const send = driver.sendMessage({ message: 'work', options: { turnId: 'turn-warn' } }, timeline)
    await waitFor(() => client.requests.some(request => request.method === 'turn/start'))

    client.emitNotification({
      method: 'warning',
      params: { threadId: 'thread-1', message: 'Token limit approaching' },
    })
    client.emitNotification({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'server-turn-warn' } } })
    await send

    const warned = timeline.items.find(item => item.item.type === 'host_state_changed')
    expect(warned).toBeDefined()
    expect((warned!.item as { state: { kind: string; message: string } }).state).toMatchObject({
      kind: 'codex_warning',
      message: 'Token limit approaching',
    })
  })

  test('Codex app-server driver calls thread/resume when threadId is provided', async () => {
    const client = createFakeCodexAppServerClient({ turnId: 'server-turn-resume' })
    const driver = createCodexAppServerDriver({
      cwd: '/tmp/project',
      client,
      threadId: 'existing-thread-42',
      model: 'gpt-5.5',
    })
    const timeline = createCollectingSequencer('codex')

    const send = driver.sendMessage({ message: 'continue work', options: { turnId: 'turn-resume' } }, timeline)
    await waitFor(() => client.requests.some(request => request.method === 'turn/start'))

    client.emitNotification({ method: 'turn/completed', params: { threadId: 'existing-thread-42', turn: { id: 'server-turn-resume' } } })
    await send

    // Should call thread/resume (not thread/start) with the provided threadId
    expect(client.requests[0]).toMatchObject({
      method: 'thread/resume',
      params: { threadId: 'existing-thread-42', cwd: '/tmp/project' },
    })
    expect(client.requests.some(request => request.method === 'thread/start')).toBe(false)
    // Second message should not re-send thread/resume
    const send2 = driver.sendMessage({ message: 'more work', options: { turnId: 'turn-resume-2' } }, timeline)
    await waitFor(() => client.requests.filter(request => request.method === 'turn/start').length === 2)
    client.emitNotification({ method: 'turn/completed', params: { threadId: 'existing-thread-42', turn: { id: 'server-turn-resume' } } })
    await send2
    expect(client.requests.filter(request => request.method === 'thread/resume')).toHaveLength(1)
  })

  test('Codex app-server driver omits thread/start-only fields on thread/resume', async () => {
    const client = createFakeCodexAppServerClient({ turnId: 'server-turn-resume-fields' })
    const driver = createCodexAppServerDriver({
      cwd: '/tmp/project',
      client,
      threadId: 'existing-thread-77',
      // Common to both start and resume:
      modelProvider: 'openai',
      serviceTier: 'flex',
      baseInstructions: 'be brief',
      developerInstructions: 'use tools',
      personality: 'helpful',
      // ThreadStartParams-only (must NOT appear on thread/resume):
      serviceName: 'weft',
      threadSource: 'host',
      multiAgentMode: 'enabled',
    })
    const timeline = createCollectingSequencer('codex')

    const send = driver.sendMessage({ message: 'continue', options: { turnId: 'turn-resume-fields' } }, timeline)
    await waitFor(() => client.requests.some(request => request.method === 'turn/start'))
    client.emitNotification({ method: 'turn/completed', params: { threadId: 'existing-thread-77', turn: { id: 'server-turn-resume-fields' } } })
    await send

    const resume = client.requests.find(request => request.method === 'thread/resume')
    const params = resume?.params as Record<string, unknown>
    // Common fields are still forwarded on resume.
    expect(params).toMatchObject({
      threadId: 'existing-thread-77',
      modelProvider: 'openai',
      serviceTier: 'flex',
      baseInstructions: 'be brief',
      developerInstructions: 'use tools',
      personality: 'helpful',
    })
    // ThreadStartParams-only fields are not part of ThreadResumeParams.
    expect(params).not.toHaveProperty('serviceName')
    expect(params).not.toHaveProperty('threadSource')
    expect(params).not.toHaveProperty('multiAgentMode')
  })

  test('Codex app-server driver falls back to thread/start when thread/resume fails (PI-5)', async () => {
    let resumeCallCount = 0
    const baseClient = createFakeCodexAppServerClient({ turnId: 'server-turn-resume-fallback' })
    // Wrap the client so thread/resume returns an invalid response (no thread id),
    // simulating an expired/invalid thread. The driver's readThreadId() throws
    // inside the try/catch, causing a fallback to thread/start.
    const client: typeof baseClient = {
      ...baseClient,
      async request<T = unknown>(method: string, params?: unknown): Promise<T> {
        if (method === 'thread/resume') {
          resumeCallCount++
          // Return a response with no thread id — readThreadId() will throw
          // "Codex app-server did not return a thread id", caught by the driver.
          return { error: 'thread not found' } as T
        }
        return baseClient.request<T>(method, params)
      },
    }
    const driver = createCodexAppServerDriver({
      cwd: '/tmp/project',
      client,
      threadId: 'expired-thread-99',
    })
    const timeline = createCollectingSequencer('codex')

    const send = driver.sendMessage({ message: 'retry after resume fails', options: { turnId: 'turn-resume-fallback' } }, timeline)
    await waitFor(() => client.requests.some(request => request.method === 'turn/start'))

    client.emitNotification({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'server-turn-resume-fallback' } } })
    await send

    // thread/resume was attempted (returned invalid response, readThreadId threw).
    expect(resumeCallCount).toBe(1)
    // The driver fell through to thread/start (recorded by the base client).
    expect(client.requests[0]).toMatchObject({ method: 'thread/start' })
    expect(client.requests.some(request => request.method === 'thread/start')).toBe(true)
    // No thread/resume in requests (the wrapper intercepted it before the base
    // client could record it).
    expect(client.requests.some(request => request.method === 'thread/resume')).toBe(false)
    // The turn completed successfully via the fallback thread/start path.
    expect(timeline.items.some(item => item.item.type === 'turn_completed')).toBe(true)
  })

  test('Codex app-server driver returns cancel decision when permission is denied with interrupt (PI-6)', async () => {
    const client = createFakeCodexAppServerClient()
    const driver = createCodexAppServerDriver({
      cwd: '/tmp/project',
      client,
      policy: async () => ({ decision: 'ask', reason: 'approval required' }),
    })
    const timeline = createCollectingSequencer('codex')

    const send = driver.sendMessage({ message: 'do work', options: { turnId: 'turn-interrupt' } }, timeline)
    await waitFor(() => client.requests.some(request => request.method === 'turn/start'))

    // Approval kind (commandExecution) — interrupt should return cancel, not decline.
    const approval = client.emitRequest({
      id: 50,
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-interrupt',
        itemId: 'cmd-interrupt',
        approvalId: 'approval-interrupt',
        command: 'rm -rf tmp',
        cwd: '/tmp/project',
      },
    })
    await waitFor(() => timeline.items.some(item => item.item.type === 'permission_requested'))

    await driver.respondToPermission?.('approval-interrupt', false, false, { interrupt: true })
    await expect(approval).resolves.toEqual({ decision: 'cancel' })

    // Permission kind (permissions/requestApproval) — interrupt should also
    // return cancel, NOT { permissions: {}, scope: 'turn' }.
    const permApproval = client.emitRequest({
      id: 51,
      method: 'item/permissions/requestApproval',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-interrupt',
        itemId: 'perm-interrupt',
        cwd: '/tmp/project',
        permissions: { network: { enabled: true } },
        reason: 'needs network',
      },
    })
    await waitFor(() => timeline.items.filter(item => item.item.type === 'permission_requested').length === 2)

    await driver.respondToPermission?.('perm-interrupt', false, false, { interrupt: true })
    await expect(permApproval).resolves.toEqual({ decision: 'cancel' })

    // Verify the permission_resolved timeline entries record the interrupt reason.
    const resolved = timeline.items.filter(item => item.item.type === 'permission_resolved')
    expect(resolved).toHaveLength(2)
    for (const item of resolved) {
      expect(item.item).toMatchObject({
        type: 'permission_resolved',
        resolution: { allowed: false, reason: 'interrupt' },
      })
    }

    client.emitNotification({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1' } } })
    await send
  })

  test('Codex app-server driver still calls thread/start when no threadId is provided', async () => {
    const client = createFakeCodexAppServerClient({ turnId: 'server-turn-start' })
    const driver = createCodexAppServerDriver({ cwd: '/tmp/project', client })
    const timeline = createCollectingSequencer('codex')

    const send = driver.sendMessage({ message: 'new work', options: { turnId: 'turn-start' } }, timeline)
    await waitFor(() => client.requests.some(request => request.method === 'turn/start'))

    client.emitNotification({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'server-turn-start' } } })
    await send

    expect(client.requests[0]).toMatchObject({ method: 'thread/start' })
    expect(client.requests.some(request => request.method === 'thread/resume')).toBe(false)
  })

  test('Codex app-server driver forwards multiAgentMode, collaborationMode, and environments to turn/start', async () => {
    const client = createFakeCodexAppServerClient({ turnId: 'server-turn-multi' })
    const driver = createCodexAppServerDriver({
      cwd: '/tmp/project',
      client,
      multiAgentMode: 'orchestrator',
    })
    const timeline = createCollectingSequencer('codex')

    const send = driver.sendMessage({
      message: 'coordinate',
      options: {
        turnId: 'turn-multi',
        multiAgentMode: 'participant',
        collaborationMode: 'pair',
        environments: [{ type: 'remote', id: 'env-1' }],
      },
    }, timeline)
    await waitFor(() => client.requests.some(request => request.method === 'turn/start'))

    // thread/start should carry the thread-level multiAgentMode
    expect(client.requests[0]?.params).toMatchObject({
      multiAgentMode: 'orchestrator',
    })
    // turn/start should carry the per-turn overrides
    expect(client.requests.find(request => request.method === 'turn/start')?.params).toMatchObject({
      multiAgentMode: 'participant',
      collaborationMode: 'pair',
      environments: [{ type: 'remote', id: 'env-1' }],
    })

    client.emitNotification({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'server-turn-multi' } } })
    await send
  })
})

function createCollectingSequencer(provider = 'claude'): TimelineSequencer & {
  items: TimelineEnvelope[]
  /** A5: `host_state_changed { kind: 'provider_session' }` meta items are
   * collected here instead of `items`, so the many exact-sequence assertions
   * below stay focused on conversation items. Tests that care about session-id
   * surfacing assert on this array explicitly. */
  providerSessionItems: TimelineEnvelope[]
} {
  const items: TimelineEnvelope[] = []
  const providerSessionItems: TimelineEnvelope[] = []
  const sequencer = createTimelineSequencer({
    sessionId: 'test-session',
    provider,
    epoch: 'test-epoch',
    now: () => 1_000,
  })
  return {
    items,
    providerSessionItems,
    append(item, rawRef) {
      const envelope = sequencer.append(item, rawRef)
      if (
        item.type === 'host_state_changed'
        && (item.state as { kind?: string } | undefined)?.kind === 'provider_session'
      ) {
        providerSessionItems.push(envelope)
      } else {
        items.push(envelope)
      }
      return envelope
    },
  }
}

async function* sdkMessages(messages: unknown[]): AsyncGenerator<unknown> {
  for (const message of messages) {
    yield message
  }
}

function sdkMessagesFromAsync(factory: () => AsyncGenerator<unknown>): AsyncGenerator<unknown> {
  return factory()
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: Error) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve
    reject = innerReject
  })
  return { promise, resolve, reject }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 0))
  }
}

function createFakeCodexAppServerClient(options: { turnId?: string } = {}): CodexAppServerClient & {
  requests: Array<{ method: string; params: unknown }>
  emitNotification: (notification: { method: string; params?: unknown }) => void
  emitRequest: (request: { id: unknown; method: string; params?: unknown }) => Promise<unknown>
  emitClose: () => void
} {
  const requests: Array<{ method: string; params: unknown }> = []
  const notificationHandlers = new Set<(notification: { method: string; params?: unknown }) => void>()
  const requestHandlers = new Set<(request: { id: unknown; method: string; params?: unknown }) => Promise<unknown>>()
  const closeHandlers = new Set<() => void>()

  return {
    requests,
    async request<T = unknown>(method: string, params?: unknown): Promise<T> {
      requests.push({ method, params })
      if (method === 'thread/start') {
        return { thread: { id: 'thread-1' } } as T
      }
      if (method === 'thread/resume') {
        return { thread: { id: (params as Record<string, unknown>)?.threadId ?? 'thread-1' } } as T
      }
      if (method === 'turn/start') {
        return { turn: { id: options.turnId ?? 'turn-1' } } as T
      }
      return {} as T
    },
    onNotification(handler) {
      notificationHandlers.add(handler)
      return () => notificationHandlers.delete(handler)
    },
    onRequest(handler) {
      requestHandlers.add(handler)
      return () => requestHandlers.delete(handler)
    },
    onClose(handler) {
      closeHandlers.add(handler)
      return () => closeHandlers.delete(handler)
    },
    emitNotification(notification) {
      for (const handler of notificationHandlers) handler(notification)
    },
    async emitRequest(request) {
      const [handler] = requestHandlers
      if (!handler) throw new Error('missing request handler')
      return handler(request)
    },
    emitClose() {
      for (const handler of closeHandlers) handler()
    },
  }
}

function createFakeCodexJsonRpcTransport(): {
  writes: string[]
  write: (message: string) => void
  onMessage: (handler: (message: unknown) => void) => () => void
  close: () => void
  emit: (message: unknown) => void
} {
  const writes: string[] = []
  const handlers = new Set<(message: unknown) => void>()
  return {
    writes,
    write(message) {
      writes.push(message)
    },
    onMessage(handler) {
      handlers.add(handler)
      return () => handlers.delete(handler)
    },
    close() {
      handlers.clear()
    },
    emit(message) {
      for (const handler of handlers) handler(message)
    },
  }
}

function createFakeLocalAgentSession(provider: 'claude' | 'codex'): AgentSessionRuntime & {
  sentMessages: string[]
  sentOptions: Array<SendMessageOptions | undefined>
} {
  const handlers = new Set<(event: AgentEvent) => void>()
  const sentMessages: string[] = []
  const sentOptions: Array<SendMessageOptions | undefined> = []

  return {
    sessionId: `local-${provider}-fallback`,
    provider,
    sentMessages,
    sentOptions,
    events: {
      connect(onEvent) {
        handlers.add(onEvent)
      },
      disconnect() {
        handlers.clear()
      },
      isConnected() {
        return handlers.size > 0
      },
    },
    async preflight() {
      return {
        mode: 'provider-owned',
        configured: true,
        source: 'test-local-cli',
      }
    },
    getState() {
      return {
        status: 'ready',
        acceptedMessages: sentMessages,
        queuedMessages: [],
      }
    },
    commands: {
      async sendMessage(message, options) {
        sentMessages.push(message)
        sentOptions.push(options)
        for (const handler of handlers) {
          handler({ type: 'text_delta', text: 'Hel', turnId: 'turn-fallback' })
          handler({ type: 'text_complete', text: 'Hello fallback', isIntermediate: false, turnId: 'turn-fallback' })
          handler({ type: 'complete' })
        }
      },
      async abort() {},
      async respondToPermission() {},
      async dispose() {},
    },
  }
}

async function writeFakeCodexExecutable(executable: string): Promise<void> {
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
}
