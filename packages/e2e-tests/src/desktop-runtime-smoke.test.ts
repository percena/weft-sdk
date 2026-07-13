import { describe, expect, test } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createHostAgentRuntime, detectRuntimeCandidates } from '@weft/providers/factory'
import type { TimelineEnvelope } from '@weft/timeline'

/**
 * Desktop demo smoke (Stack-B local path). Drives the same
 * `createHostAgentRuntime` + `runtime.events.connect` + `runtime.commands`
 * flow the chat-playground Electron main process uses, against real local
 * Claude / Codex. Gated like real-provider-smoke — skipped by default.
 *
 * Mirrors the demo's local Coding Agent story end-to-end (no server).
 */
const RUN_REAL_CLAUDE = process.env.WEFT_RUN_REAL_CLAUDE_E2E === '1'
const RUN_REAL_CODEX = process.env.WEFT_RUN_REAL_CODEX_TURN_E2E === '1'
const REAL_TURN_TIMEOUT_MS = 90_000

function makeTempCwd(): string {
  return mkdtempSync(join(tmpdir(), 'weft-desktop-smoke-'))
}

describe('Desktop demo local runtime smoke — opt-in only', () => {
  test.skipIf(!RUN_REAL_CLAUDE)('createHostAgentRuntime runs a real Claude turn through the timeline stream', { timeout: REAL_TURN_TIMEOUT_MS }, async () => {
    const cwd = makeTempCwd()
    const detected = await detectRuntimeCandidates({ provider: 'claude' })
    const { runtime } = createHostAgentRuntime({
      provider: 'claude',
      cwd,
      sessionId: 'desktop-claude-smoke',
      candidates: detected.candidates,
      auth: detected.auth,
      allowFallback: true,
      claude: { permissionMode: 'auto' },
    })

    const timeline: TimelineEnvelope[] = []
    runtime.events.connect(
      (envelope) => { timeline.push(envelope) },
      () => { /* error channel — surfaced by sendMessage rejection below */ },
    )

    try {
      await runtime.commands.sendMessage('Reply with exactly: WEFT_DESKTOP_CLAUDE_OK', {
        turnId: 'desktop-claude-turn',
        permissionMode: 'auto',
      })

      expect(timeline.some(item => item.item.type === 'user_message')).toBe(true)
      expect(timeline.some(item => item.item.type === 'turn_completed')).toBe(true)
      expect(JSON.stringify(timeline)).toContain('WEFT_DESKTOP_CLAUDE_OK')
    } finally {
      await runtime.commands.dispose()
    }
  })

  test.skipIf(!RUN_REAL_CODEX)('createHostAgentRuntime runs a real Codex turn through the timeline stream', { timeout: REAL_TURN_TIMEOUT_MS }, async () => {
    const cwd = makeTempCwd()
    const detected = await detectRuntimeCandidates({ provider: 'codex' })
    const { runtime } = createHostAgentRuntime({
      provider: 'codex',
      cwd,
      sessionId: 'desktop-codex-smoke',
      candidates: detected.candidates,
      auth: detected.auth,
      allowFallback: true,
      codex: { permissionMode: 'auto' },
    })

    const timeline: TimelineEnvelope[] = []
    runtime.events.connect((envelope) => { timeline.push(envelope) })

    try {
      await runtime.commands.sendMessage('Reply with exactly: WEFT_DESKTOP_CODEX_OK', {
        turnId: 'desktop-codex-turn',
        permissionMode: 'auto',
      })

      expect(timeline.some(item => item.item.type === 'user_message')).toBe(true)
      expect(timeline.some(item => item.item.type === 'turn_completed')).toBe(true)
      expect(JSON.stringify(timeline)).toContain('WEFT_DESKTOP_CODEX_OK')
    } finally {
      await runtime.commands.dispose()
    }
  })
})
