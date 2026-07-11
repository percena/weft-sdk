import { describe, expect, test } from 'vitest'

import { createClaudeNativeSdkDriver } from '@weft/providers/claude'
import {
  createCodexAppServerDriver,
  createCodexAppServerSubprocessClient,
} from '@weft/providers/codex'
import { createCliAgentSession } from '@weft/cli-runtime'
import { createTimelineSequencer, type TimelineEnvelope } from '@weft/timeline'

const RUN_REAL_AGENT_E2E = process.env.WEFT_RUN_REAL_AGENT_E2E === '1'
const RUN_REAL_CODEX_TURN_E2E = process.env.WEFT_RUN_REAL_CODEX_TURN_E2E === '1'
const RUN_REAL_CODEX_CLI_E2E = process.env.WEFT_RUN_REAL_CODEX_CLI_E2E === '1'
const RUN_REAL_CLAUDE_E2E = process.env.WEFT_RUN_REAL_CLAUDE_E2E === '1'
const REAL_ACCOUNT_TIMEOUT_MS = 10_000
const REAL_TURN_TIMEOUT_MS = 60_000

describe('Real provider smoke tests — opt-in only', () => {
  test.skipIf(!RUN_REAL_AGENT_E2E)('Codex app-server account/read uses provider-owned auth state', { timeout: REAL_ACCOUNT_TIMEOUT_MS }, async () => {
    const client = await createCodexAppServerSubprocessClient({
      executable: process.env.WEFT_CODEX_EXECUTABLE,
      requestTimeoutMs: REAL_ACCOUNT_TIMEOUT_MS,
    })
    try {
      const account = await client.request<Record<string, unknown>>('account/read', {
        refreshToken: false,
      })

      expect(account).toBeTruthy()
      expect(typeof account).toBe('object')
      expect(JSON.stringify(account)).not.toContain('access_token')
      expect(JSON.stringify(account)).not.toContain('refresh_token')
    } finally {
      client.close()
    }
  })

  test.skipIf(!RUN_REAL_CODEX_TURN_E2E)('Codex app-server can run a real turn into canonical timeline', { timeout: REAL_TURN_TIMEOUT_MS }, async () => {
    const client = await createCodexAppServerSubprocessClient({
      executable: process.env.WEFT_CODEX_EXECUTABLE,
      requestTimeoutMs: REAL_TURN_TIMEOUT_MS,
    })
    const timeline: TimelineEnvelope[] = []
    const sequencer = createTimelineSequencer({
      sessionId: 'real-codex-smoke',
      provider: 'codex',
      epoch: 'real-smoke',
    })
    const driver = createCodexAppServerDriver({
      cwd: process.cwd(),
      client,
      policy: () => ({ decision: 'deny', reason: 'real smoke denies tool execution' }),
    })

    try {
      await driver.sendMessage({
        message: 'Reply with exactly: WEFT_REAL_CODEX_OK',
        options: { turnId: 'real-codex-turn', permissionMode: 'ask' },
      }, {
        append(item, rawRef) {
          const envelope = sequencer.append(item, rawRef)
          timeline.push(envelope)
          return envelope
        },
      })

      expect(timeline.some(item => item.item.type === 'turn_started')).toBe(true)
      expect(timeline.some(item => item.item.type === 'turn_completed')).toBe(true)
      expect(JSON.stringify(timeline)).toContain('WEFT_REAL_CODEX_OK')
    } finally {
      await driver.dispose?.()
      client.close()
    }
  })

  test.skipIf(!RUN_REAL_CODEX_CLI_E2E)('Codex CLI fallback maps real exec JSONL into AgentEvents', { timeout: REAL_TURN_TIMEOUT_MS }, async () => {
    const runtime = createCliAgentSession({
      provider: 'codex',
      cwd: process.cwd(),
      executable: process.env.WEFT_CODEX_EXECUTABLE,
      permissionMode: 'ask',
      requestTimeoutMs: REAL_ACCOUNT_TIMEOUT_MS,
    })
    const events: unknown[] = []
    runtime.events.connect(event => events.push(event))

    const auth = await runtime.preflight()
    expect(auth.configured).toBe(true)

    await runtime.commands.sendMessage('Do not run commands. Reply exactly: WEFT_REAL_CODEX_CLI_OK')

    expect(JSON.stringify(events)).toContain('WEFT_REAL_CODEX_CLI_OK')
    expect(events).toContainEqual(expect.objectContaining({ type: 'complete' }))
  })

  test.skipIf(!RUN_REAL_CLAUDE_E2E)('Claude Agent SDK can run a real turn into canonical timeline', { timeout: REAL_TURN_TIMEOUT_MS }, async () => {
    const timeline: TimelineEnvelope[] = []
    const sequencer = createTimelineSequencer({
      sessionId: 'real-claude-smoke',
      provider: 'claude',
      epoch: 'real-smoke',
    })
    const driver = createClaudeNativeSdkDriver({
      cwd: process.cwd(),
      permissionMode: 'explore',
      policy: () => ({ decision: 'deny', reason: 'real smoke denies tool execution' }),
    })

    await driver.sendMessage({
      message: 'Reply with exactly: WEFT_REAL_CLAUDE_OK',
      options: { turnId: 'real-claude-turn' },
    }, {
      append(item, rawRef) {
        const envelope = sequencer.append(item, rawRef)
        timeline.push(envelope)
        return envelope
      },
    })

    expect(timeline.some(item => item.item.type === 'turn_started')).toBe(true)
    expect(timeline.some(item => item.item.type === 'turn_completed')).toBe(true)
    expect(JSON.stringify(timeline)).toContain('WEFT_REAL_CLAUDE_OK')
  })

  test.skipIf(!RUN_REAL_CLAUDE_E2E)('Claude Agent SDK can resume a session and continue the conversation', { timeout: REAL_TURN_TIMEOUT_MS }, async () => {
    // First turn establishes a Claude-side session (persistSession default true).
    const timeline1: TimelineEnvelope[] = []
    const seq1 = createTimelineSequencer({ sessionId: 'real-claude-resume', provider: 'claude', epoch: 'real-smoke' })
    let sessionId: string | undefined
    const driver1 = createClaudeNativeSdkDriver({
      cwd: process.cwd(),
      permissionMode: 'explore',
      policy: () => ({ decision: 'deny', reason: 'real smoke denies tool execution' }),
    })

    await driver1.sendMessage({
      message: 'Remember the secret word "WEFT_RESUME_SECRET". Reply with only: STORED',
    }, {
      append(item, rawRef) {
        const env = seq1.append(item, rawRef)
        timeline1.push(env)
        const result = item.type === 'turn_completed' ? item : null
        void result
        return env
      },
    })

    // Extract the session id from the result message's usage/turn_completed if
    // surfaced; otherwise rely on the driver's per-turn sessionId metadata.
    const completed1 = timeline1.find(e => e.item.type === 'turn_completed')?.item as { sessionId?: string } | undefined
    sessionId = completed1?.sessionId
    expect(timeline1.some(e => e.item.type === 'turn_completed')).toBe(true)

    // Second driver resumes that session and recalls the secret word.
    const timeline2: TimelineEnvelope[] = []
    const seq2 = createTimelineSequencer({ sessionId: 'real-claude-resume', provider: 'claude', epoch: 'real-smoke' })
    const driver2 = createClaudeNativeSdkDriver({
      cwd: process.cwd(),
      permissionMode: 'explore',
      policy: () => ({ decision: 'deny', reason: 'real smoke denies tool execution' }),
      sdkOptions: sessionId ? { resume: sessionId } : undefined,
    })

    await driver2.sendMessage({
      message: 'What was the secret word I asked you to remember? Reply with only that word.',
    }, {
      append(item, rawRef) {
        const env = seq2.append(item, rawRef)
        timeline2.push(env)
        return env
      },
    })

    expect(timeline2.some(e => e.item.type === 'turn_completed')).toBe(true)
    expect(JSON.stringify(timeline2)).toContain('WEFT_RESUME_SECRET')
  })

  test.skipIf(!RUN_REAL_CLAUDE_E2E)('Claude Agent SDK produces structured output from a JSON schema', { timeout: REAL_TURN_TIMEOUT_MS }, async () => {
    const timeline: TimelineEnvelope[] = []
    const sequencer = createTimelineSequencer({ sessionId: 'real-claude-struct', provider: 'claude', epoch: 'real-smoke' })
    const driver = createClaudeNativeSdkDriver({
      cwd: process.cwd(),
      permissionMode: 'explore',
      policy: () => ({ decision: 'deny', reason: 'real smoke denies tool execution' }),
    })

    await driver.sendMessage({
      message: 'Extract: name is "Ada", age is 36.',
      options: {
        turnId: 'real-claude-struct-turn',
        outputSchema: {
          type: 'object',
          properties: { name: { type: 'string' }, age: { type: 'number' } },
          required: ['name', 'age'],
        },
      } as never,
    }, {
      append(item, rawRef) {
        const env = sequencer.append(item, rawRef)
        timeline.push(env)
        return env
      },
    })

    const completed = timeline.find(e => e.item.type === 'turn_completed')?.item as { structuredOutput?: { name?: string; age?: number } } | undefined
    expect(completed).toBeDefined()
    expect(completed!.structuredOutput).toMatchObject({ name: 'Ada', age: 36 })
  })
})
