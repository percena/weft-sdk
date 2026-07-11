/**
 * Characterization tests for groupMessagesByTurn (P2-07-02 residual).
 *
 * These LOCK the current turn-grouping output on a representative streaming
 * sequence BEFORE the per-frame memoization refactor, so the refactor (useMemo
 * dep change + any future incremental tail-fold) is gated by a concrete
 * equivalence check. If the function's output ever drifts, these fail.
 *
 * The assertions capture the structural shape that downstream TurnCard rendering
 * depends on: turn count/types, which turn holds the response, activity counts,
 * and streaming/complete flags. Not a full deep-equal (brittle against
 * incidental field churn) — but enough to catch a grouping regression.
 */
import type { Message } from '@weft/core'
import { describe, expect, it } from 'vitest'
import { groupMessagesByTurn } from './turn-grouping'

let seq = 0
function msg(partial: Partial<Message> & { role: Message['role'] }): Message {
  seq += 1
  return {
    id: `m${seq}`,
    content: '',
    timestamp: seq * 10,
    ...partial,
  } as Message
}

describe('groupMessagesByTurn — characterization (current behavior locked)', () => {
  it('user + final assistant → two turns, response on the assistant turn', () => {
    const messages: Message[] = [
      msg({ role: 'user', content: 'hello', timestamp: 10 }),
      msg({ role: 'assistant', content: 'hi there', isStreaming: false, turnId: 't1', timestamp: 20 }),
    ]
    const turns = groupMessagesByTurn(messages)
    expect(turns).toHaveLength(2)
    expect(turns[0]?.type).toBe('user')
    expect(turns[1]?.type).toBe('assistant')
    const a = turns[1]
    expect(a?.type).toBe('assistant')
    if (a?.type === 'assistant') {
      expect(a.response?.text).toBe('hi there')
      expect(a.isStreaming).toBe(false)
      expect(a.isComplete).toBe(true)
    }
  })

  it('streaming assistant (isPending) keeps the turn open; final flushes it', () => {
    const messages: Message[] = [
      msg({ role: 'user', content: 'q', timestamp: 10 }),
      msg({ role: 'assistant', content: 'par', isPending: true, isStreaming: true, turnId: 't1', timestamp: 20 }),
      msg({ role: 'assistant', content: 'partial', isPending: true, isStreaming: true, turnId: 't1', timestamp: 30 }),
      msg({ role: 'assistant', content: 'partial final', isStreaming: false, isIntermediate: false, turnId: 't1', timestamp: 40 }),
    ]
    const turns = groupMessagesByTurn(messages)
    expect(turns).toHaveLength(2)
    const a = turns[1]
    expect(a?.type).toBe('assistant')
    if (a?.type === 'assistant') {
      // The final (non-intermediate, non-streaming) message is the response.
      expect(a.response?.text).toBe('partial final')
      expect(a.isComplete).toBe(true)
    }
  })

  it('tool call + result + final assistant → one assistant turn with activities + response', () => {
    const messages: Message[] = [
      msg({ role: 'user', content: 'run it', timestamp: 10 }),
      msg({ role: 'tool', toolName: 'Bash', toolUseId: 'tu1', toolStatus: 'executing', turnId: 't1', content: '', timestamp: 20 }),
      msg({ role: 'tool', toolName: 'Bash', toolUseId: 'tu1', toolStatus: 'completed', toolResult: 'ok', turnId: 't1', content: '', timestamp: 30 }),
      msg({ role: 'assistant', content: 'done', isStreaming: false, turnId: 't1', timestamp: 40 }),
    ]
    const turns = groupMessagesByTurn(messages)
    expect(turns).toHaveLength(2)
    const a = turns[1]
    expect(a?.type).toBe('assistant')
    if (a?.type === 'assistant') {
      expect(a.activities).toHaveLength(2)
      expect(a.activities[0]?.toolName).toBe('Bash')
      expect(a.response?.text).toBe('done')
    }
  })

  it('intermediate assistant commentary (isIntermediate) becomes an activity, not the response', () => {
    const messages: Message[] = [
      msg({ role: 'user', content: 'go', timestamp: 10 }),
      msg({ role: 'assistant', content: 'thinking...', isIntermediate: true, turnId: 't1', timestamp: 20 }),
      msg({ role: 'assistant', content: 'final answer', isStreaming: false, turnId: 't1', timestamp: 30 }),
    ]
    const turns = groupMessagesByTurn(messages)
    expect(turns).toHaveLength(2)
    const a = turns[1]
    if (a?.type === 'assistant') {
      // Intermediate commentary is an activity; the final message is the response.
      expect(a.activities.some(act => act.type === 'intermediate' && act.content === 'thinking...')).toBe(true)
      expect(a.response?.text).toBe('final answer')
    }
  })

  it('two user/assistant pairs → four turns (no cross-pair merge)', () => {
    const messages: Message[] = [
      msg({ role: 'user', content: 'a', timestamp: 10 }),
      msg({ role: 'assistant', content: 'A', isStreaming: false, turnId: 't1', timestamp: 20 }),
      msg({ role: 'user', content: 'b', timestamp: 30 }),
      msg({ role: 'assistant', content: 'B', isStreaming: false, turnId: 't2', timestamp: 40 }),
    ]
    const turns = groupMessagesByTurn(messages)
    expect(turns.map(t => t.type)).toEqual(['user', 'assistant', 'user', 'assistant'])
  })

  // R-M2 regression: the later-tool-before-boundary check was rewritten from a
  // per-message forward scan (O(n²)) to a single reverse-pass precomputation.
  // These tests lock the boundary semantics the old scan implemented.
  describe('commentary detection (hasLaterToolBeforeBoundary semantics)', () => {
    it('final assistant followed by a tool (same turn) renders as commentary, not response', () => {
      const messages: Message[] = [
        msg({ role: 'user', content: 'go', timestamp: 10 }),
        msg({ role: 'assistant', content: 'let me check', isStreaming: false, turnId: 't1', timestamp: 20 }),
        msg({ role: 'tool', toolName: 'Bash', toolUseId: 'tu1', toolStatus: 'completed', toolResult: 'ok', turnId: 't1', timestamp: 30 }),
        msg({ role: 'assistant', content: 'done', isStreaming: false, turnId: 't1', timestamp: 40 }),
      ]
      const turns = groupMessagesByTurn(messages)
      expect(turns).toHaveLength(2)
      const a = turns[1]
      expect(a?.type).toBe('assistant')
      if (a?.type === 'assistant') {
        expect(a.activities.some(act => act.type === 'intermediate' && act.content === 'let me check')).toBe(true)
        expect(a.activities.some(act => act.type === 'tool')).toBe(true)
        expect(a.response?.text).toBe('done')
      }
    })

    it('a final assistant with a DIFFERENT turnId acts as a boundary (first stays the response)', () => {
      const messages: Message[] = [
        msg({ role: 'user', content: 'go', timestamp: 10 }),
        msg({ role: 'assistant', content: 'first', isStreaming: false, turnId: 't1', timestamp: 20 }),
        msg({ role: 'assistant', content: 'second', isStreaming: false, turnId: 't2', timestamp: 30 }),
        msg({ role: 'tool', toolName: 'Bash', toolUseId: 'tu1', toolStatus: 'completed', toolResult: 'ok', turnId: 't2', timestamp: 40 }),
        msg({ role: 'assistant', content: 'done', isStreaming: false, turnId: 't2', timestamp: 50 }),
      ]
      const turns = groupMessagesByTurn(messages)
      expect(turns.map(t => t.type)).toEqual(['user', 'assistant', 'assistant'])
      const first = turns[1]
      const second = turns[2]
      if (first?.type === 'assistant') {
        // 'first' must NOT be demoted to commentary: the t2 final in between is a boundary
        expect(first.response?.text).toBe('first')
        expect(first.activities).toHaveLength(0)
      }
      if (second?.type === 'assistant') {
        // 'second' IS commentary: a tool of its own turn follows directly
        expect(second.activities.some(act => act.type === 'intermediate' && act.content === 'second')).toBe(true)
        expect(second.response?.text).toBe('done')
      }
    })

    it('finals with two distinct turnIds before a tool block commentary for both', () => {
      const messages: Message[] = [
        msg({ role: 'user', content: 'go', timestamp: 10 }),
        msg({ role: 'assistant', content: 'A', isStreaming: false, turnId: 't1', timestamp: 20 }),
        msg({ role: 'assistant', content: 'B', isStreaming: false, turnId: 't2', timestamp: 30 }),
        msg({ role: 'assistant', content: 'C', isStreaming: false, turnId: 't1', timestamp: 40 }),
        msg({ role: 'tool', toolName: 'Bash', toolUseId: 'tu1', toolStatus: 'completed', toolResult: 'ok', turnId: 't1', timestamp: 50 }),
        msg({ role: 'assistant', content: 'done', isStreaming: false, turnId: 't1', timestamp: 60 }),
      ]
      const turns = groupMessagesByTurn(messages)
      // A sees B (t2 ≠ t1) → boundary → A is a response. B sees C (t1 ≠ t2) →
      // boundary → B is a response. C sees the tool directly → commentary.
      expect(turns.map(t => t.type)).toEqual(['user', 'assistant', 'assistant', 'assistant'])
      const [, tA, tB, tC] = turns
      if (tA?.type === 'assistant') expect(tA.response?.text).toBe('A')
      if (tB?.type === 'assistant') expect(tB.response?.text).toBe('B')
      if (tC?.type === 'assistant') {
        expect(tC.activities.some(act => act.type === 'intermediate' && act.content === 'C')).toBe(true)
        expect(tC.response?.text).toBe('done')
      }
    })

    it('user message between final assistant and tool is a hard boundary', () => {
      const messages: Message[] = [
        msg({ role: 'user', content: 'q1', timestamp: 10 }),
        msg({ role: 'assistant', content: 'answer', isStreaming: false, turnId: 't1', timestamp: 20 }),
        msg({ role: 'user', content: 'q2', timestamp: 30 }),
        msg({ role: 'tool', toolName: 'Bash', toolUseId: 'tu1', toolStatus: 'completed', toolResult: 'ok', turnId: 't2', timestamp: 40 }),
        msg({ role: 'assistant', content: 'done', isStreaming: false, turnId: 't2', timestamp: 50 }),
      ]
      const turns = groupMessagesByTurn(messages)
      expect(turns.map(t => t.type)).toEqual(['user', 'assistant', 'user', 'assistant'])
      const a = turns[1]
      if (a?.type === 'assistant') expect(a.response?.text).toBe('answer')
    })

    it('status messages are transparent to the commentary scan', () => {
      const messages: Message[] = [
        msg({ role: 'user', content: 'go', timestamp: 10 }),
        msg({ role: 'assistant', content: 'note', isStreaming: false, turnId: 't1', timestamp: 20 }),
        msg({ role: 'status', content: 'compacting…', statusType: 'compacting', timestamp: 30 }),
        msg({ role: 'tool', toolName: 'Bash', toolUseId: 'tu1', toolStatus: 'completed', toolResult: 'ok', turnId: 't1', timestamp: 40 }),
        msg({ role: 'assistant', content: 'done', isStreaming: false, turnId: 't1', timestamp: 50 }),
      ]
      const turns = groupMessagesByTurn(messages)
      expect(turns).toHaveLength(2)
      const a = turns[1]
      if (a?.type === 'assistant') {
        // 'note' is commentary because the scan passes through the status message
        expect(a.activities.some(act => act.type === 'intermediate' && act.content === 'note')).toBe(true)
        expect(a.response?.text).toBe('done')
      }
    })
  })

  it('is deterministic: same input twice → same output (memoization-safe)', () => {
    const messages: Message[] = [
      msg({ role: 'user', content: 'x', timestamp: 10 }),
      msg({ role: 'tool', toolName: 'Bash', toolUseId: 'tu1', toolStatus: 'completed', toolResult: 'r', turnId: 't1', timestamp: 20 }),
      msg({ role: 'assistant', content: 'y', isStreaming: false, turnId: 't1', timestamp: 30 }),
    ]
    const a = groupMessagesByTurn(messages)
    const b = groupMessagesByTurn([...messages])
    expect(b).toEqual(a)
  })
})
