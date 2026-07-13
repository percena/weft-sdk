import { describe, expect, test } from 'vitest'

import {
  createHostAgentRuntime,
} from '@weft/providers/factory'
import { createClaudeRuntimeCandidates, type ClaudeSdkQueryRunner } from '@weft/providers/claude'
import {
  createCodexRuntimeCandidates,
  type CodexAppServerClient,
  type CodexAppServerNotification,
  type CodexAppServerRequest,
} from '@weft/providers/codex'
import type {
  LoadedSource,
  SourceStateSnapshot,
} from '@weft/sources'

describe('Runtime factory — host composition', () => {
  test('builds Claude runtime from source registry state and provider-owned auth', async () => {
    const queryCalls: unknown[] = []
    const sourceStates: SourceStateSnapshot[] = [
      { sourceSlug: 'linear', enabled: true, authenticated: true, status: 'active' },
      { sourceSlug: 'slack', enabled: true, authenticated: false, status: 'needs_auth' },
    ]

    const result = createHostAgentRuntime({
      provider: 'claude',
      cwd: '/tmp/project',
      candidates: createClaudeRuntimeCandidates({
        nativeSdkAvailable: true,
        cliFallbackAvailable: false,
      }),
      auth: { mode: 'provider-owned', configured: true, source: 'test' },
      sourceRuntime: {
        requestedSourceSlugs: ['linear', 'slack'],
        sourceStates,
        sources: [
          loadedSource({
            slug: 'linear',
            type: 'mcp',
            mcp: {
              transport: 'stdio',
              command: 'linear-mcp',
              env: { PATH: '/usr/bin', LINEAR_API_KEY: 'secret-value' },
            },
          }),
        ],
        credentialRefs: {
          linear: { type: 'source_oauth', sourceSlug: 'linear', workspaceId: 'workspace-a' },
        },
        allowedStdioEnvKeys: ['PATH'],
      },
      claude: {
        query(params) {
          queryCalls.push(params)
          return sdkMessages([
            {
              type: 'result',
              subtype: 'success',
              uuid: 'factory-claude',
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
      },
    })

    await result.runtime.preflight()
    await result.runtime.commands.sendMessage('use @linear')

    expect(result.sourceRuntime?.capabilityDegradation.authRequiredSourceSlugs).toEqual(['slack'])
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
    expect(JSON.stringify(queryCalls[0])).not.toContain('secret-value')
  })

  test('builds Codex app-server runtime from source registry state and provider-owned auth', async () => {
    const client = createFakeCodexAppServerClient()
    const result = createHostAgentRuntime({
      provider: 'codex',
      cwd: '/tmp/project',
      candidates: createCodexRuntimeCandidates({
        appServerAvailable: true,
        nativeSdkAvailable: false,
        cliFallbackAvailable: false,
      }),
      auth: { mode: 'provider-owned', configured: true, source: 'test' },
      sourceRuntime: {
        requestedSourceSlugs: ['github'],
        sourceStates: [
          { sourceSlug: 'github', enabled: true, authenticated: true, status: 'active' },
        ],
        sources: [
          loadedSource({
            slug: 'github',
            type: 'api',
            api: {
              baseUrl: 'https://api.github.com',
              authType: 'bearer',
              defaultHeaders: {
                Accept: 'application/json',
                Authorization: 'Bearer secret-value',
              },
            },
          }),
        ],
        credentialRefs: {
          github: { type: 'source_bearer', sourceSlug: 'github', workspaceId: 'workspace-a' },
        },
      },
      codex: {
        appServerClient: client,
      },
    })

    await result.runtime.preflight()
    const send = result.runtime.commands.sendMessage('use @github')
    await waitFor(() => client.requests.some(request => request.method === 'turn/start'))
    client.emitNotification({
      method: 'turn/completed',
      params: { threadId: 'thread-1', turn: { id: 'turn-1' } },
    })
    await send

    expect(client.requests[0]).toMatchObject({
      method: 'thread/start',
    })
    // Source tools are accepted but not yet wired into the codex app-server
    // turn (config.weftSources is ignored by codex; dynamicTools registration
    // is future work). Ensure no descriptor or secret leaks into the request.
    expect(client.requests[0]?.params).not.toHaveProperty('config.weftSources')
    expect(JSON.stringify(client.requests[0])).not.toContain('secret-value')
    expect(JSON.stringify(client.requests[0])).not.toContain('Authorization')
  })

  test('bridges the integrator policy hook to the Claude driver — a deny hook blocks the tool, a missing hook auto-allows', async () => {
    // Regression: createHostAgentRuntime
    // accepts `policy` as a RuntimePolicyExtension struct { mode, hook? } and stores
    // it at extensions.policy (for capability reporting), but must ALSO bridge
    // `policy.hook` to the driver's top-level `policy` field (a RuntimePolicyHook
    // function). Without the bridge, native-sdk-driver.evaluatePolicy sees no policy
    // and returns { decision: 'allow' } for every tool → ask/explore is silently
    // defeated. This test fails if the bridge is removed.
    const denyHookCalls: { toolName: string; input: unknown }[] = []
    const denyResult = createHostAgentRuntime({
      provider: 'claude',
      cwd: '/tmp/project',
      candidates: createClaudeRuntimeCandidates({ nativeSdkAvailable: true, cliFallbackAvailable: false }),
      auth: { mode: 'provider-owned', configured: true, source: 'test' },
      policy: {
        mode: 'ask',
        hook: (req) => {
          denyHookCalls.push({ toolName: req.toolName, input: req.input })
          return { decision: 'deny', reason: 'blocked by policy hook' }
        },
      },
      claude: { query: fakeQueryThatInvokesCanUseTool('Bash', { command: 'rm -rf /' }, 'deny-1') },
    })
    await denyResult.runtime.preflight()
    await denyResult.runtime.commands.sendMessage('run rm -rf')
    await waitFor(() => denyHookCalls.length > 0)
    expect(denyHookCalls[0]?.toolName).toBe('Bash')

    // Sanity: a runtime built WITHOUT a policy still auto-allows (the documented
    // default) — this is the behavior the deny-hook test is contrasted against, and
    // it confirms the test is exercising the bridge, not a blanket deny.
    const noPolicyCanUseToolResults: { behavior: string }[] = []
    const noPolicyResult = createHostAgentRuntime({
      provider: 'claude',
      cwd: '/tmp/project',
      candidates: createClaudeRuntimeCandidates({ nativeSdkAvailable: true, cliFallbackAvailable: false }),
      auth: { mode: 'provider-owned', configured: true, source: 'test' },
      claude: {
        query: fakeQueryThatInvokesCanUseTool('Bash', { command: 'rm -rf /' }, 'allow-1', noPolicyCanUseToolResults),
      },
    })
    await noPolicyResult.runtime.preflight()
    await noPolicyResult.runtime.commands.sendMessage('run rm -rf')
    await waitFor(() => noPolicyCanUseToolResults.length > 0)
    expect(noPolicyCanUseToolResults[0]?.behavior).toBe('allow')
  })
})

function loadedSource(config: {
  slug: string
  type: 'api' | 'local' | 'mcp'
  api?: LoadedSource['config']['api']
  local?: LoadedSource['config']['local']
  mcp?: LoadedSource['config']['mcp']
}): LoadedSource {
  return {
    config: {
      id: config.slug,
      name: config.slug,
      slug: config.slug,
      enabled: true,
      provider: config.slug,
      type: config.type,
      api: config.api,
      local: config.local,
      mcp: config.mcp,
      isAuthenticated: true,
      connectionStatus: 'connected',
    },
    guide: null,
    folderPath: `/workspace/sources/${config.slug}`,
    workspaceRootPath: '/workspace',
    workspaceId: 'workspace-a',
  }
}

function sdkMessages(messages: unknown[]): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const message of messages) yield message
    },
  }
}

/**
 * A fake Claude SDK `query` runner that immediately invokes the driver-built
 * `options.canUseTool(toolName, input, { toolUseID})` (the F1 contract surface:
 * canUseTool consults the bridged policy hook). Records the PermissionResult
 * `behavior` if `results` is provided. Returns a minimal success result stream.
 */
function fakeQueryThatInvokesCanUseTool(
  toolName: string,
  input: Record<string, unknown>,
  toolUseID: string,
  results?: { behavior: string }[],
): ClaudeSdkQueryRunner {
  return (params) => {
    const canUseTool = (params.options as {
      canUseTool?: (n: string, i: Record<string, unknown>, c: { toolUseID?: string }) => Promise<{ behavior: string }>
    }).canUseTool
    void canUseTool?.(toolName, input, { toolUseID }).then((r) => {
      if (results) results.push(r)
    })
    return sdkMessages([
      {
        type: 'result',
        subtype: 'success',
        uuid: 'factory-f1',
        session_id: 'sdk-session',
        duration_ms: 1,
        duration_api_ms: 1,
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
  }
}

function createFakeCodexAppServerClient(): CodexAppServerClient & {
  requests: Array<{ method: string; params?: unknown }>
  emitNotification(notification: CodexAppServerNotification): void
} {
  const notificationHandlers = new Set<(notification: CodexAppServerNotification) => void>()
  const requestHandlers = new Set<(request: CodexAppServerRequest) => Promise<unknown>>()
  const requests: Array<{ method: string; params?: unknown }> = []

  return {
    requests,
    async request<T>(method: string, params?: unknown): Promise<T> {
      requests.push({ method, params })
      if (method === 'thread/start') return { thread: { id: 'thread-1' } } as T
      if (method === 'turn/start') return { id: 'turn-1' } as T
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
    emitNotification(notification) {
      for (const handler of notificationHandlers) handler(notification)
    },
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > 1_000) {
      throw new Error('Timed out waiting for condition')
    }
    await new Promise(resolve => setTimeout(resolve, 1))
  }
}


describe('B5 — detectRuntimeCandidates', () => {
  test('assembles claude candidates from SDK probe + auth probe (missing binary path)', async () => {
    const { detectRuntimeCandidates } = await import('@weft/providers/factory')
    const detected = await detectRuntimeCandidates({
      provider: 'claude',
      executable: '/definitely/missing/claude-binary',
      probeClaudeSdk: async () => true,
    })

    const native = detected.candidates.find(c => c.kind === 'native-sdk')
    const cli = detected.candidates.find(c => c.kind === 'cli-fallback')
    expect(native?.available).toBe(true)
    expect(cli?.available).toBe(false)
    expect(detected.auth.mode).toBe('provider-owned')
    expect(detected.auth.configured).toBe(false)
  })

  test('assembles codex candidates from the app-server probe (missing binary path)', async () => {
    const { detectRuntimeCandidates } = await import('@weft/providers/factory')
    const detected = await detectRuntimeCandidates({
      provider: 'codex',
      executable: '/definitely/missing/codex-binary',
      requestTimeoutMs: 2000,
    })

    const appServer = detected.candidates.find(c => c.kind === 'app-server')
    const native = detected.candidates.find(c => c.kind === 'native-sdk')
    expect(appServer?.available).toBe(false)
    expect(native?.available).toBe(false)
    expect(detected.auth.configured).toBe(false)
  })
})
