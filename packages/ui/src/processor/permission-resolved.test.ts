import { describe, expect, it } from 'vitest'
import { processEvent } from './processor.ts'
import { createEmptySession } from './helpers.ts'
import type { SessionState, PermissionRequestEvent, PermissionResolvedEvent } from './types.ts'
import type { PermissionRequest } from '@weft/core'

function initialState(): SessionState {
  return {
    session: createEmptySession('sess-1', 'ws-1', 'WS'),
    streaming: null,
  }
}

function permissionRequestEvent(requestId: string): PermissionRequestEvent {
  const request: PermissionRequest = {
    requestId,
    toolName: 'Bash',
    description: 'run a command',
    command: 'ls -la',
  }
  return { type: 'permission_request', sessionId: 'sess-1', request }
}

function permissionResolvedEvent(requestId: string, allowed = true, reason?: string): PermissionResolvedEvent {
  const outcome = allowed ? 'granted' : 'denied'
  return {
    type: 'permission_resolved',
    sessionId: 'sess-1',
    requestId,
    allowed,
    reason,
    message: reason ? `Permission ${outcome}: ${reason}` : `Permission ${outcome}`,
    timestamp: 1000,
  }
}

describe('processEvent — X-E(b) permission_resolved reducer', () => {
  it('permission_request mirrors the pending request into state AND emits the effect', () => {
    const state = initialState()
    const result = processEvent(state, permissionRequestEvent('r1'))
    // Effect still emitted (onPermissionAllow callback flow unchanged).
    expect(result.effects).toEqual([
      { type: 'permission_request', request: expect.objectContaining({ requestId: 'r1' }) },
    ])
    // State now mirrors the pending request.
    expect(result.state.pendingPermissionRequests).toHaveLength(1)
    expect(result.state.pendingPermissionRequests?.[0]?.requestId).toBe('r1')
  })

  it('permission_resolved clears the matching pending request', () => {
    const afterRequest = processEvent(initialState(), permissionRequestEvent('r1')).state
    expect(afterRequest.pendingPermissionRequests).toHaveLength(1)

    const afterResolved = processEvent(afterRequest, permissionResolvedEvent('r1', true, 'ok')).state
    expect(afterResolved.pendingPermissionRequests).toEqual([])
  })

  it('permission_resolved leaves non-matching pending requests intact', () => {
    // Two pending requests; resolve only one.
    let state = processEvent(initialState(), permissionRequestEvent('r1')).state
    state = processEvent(state, permissionRequestEvent('r2')).state
    expect(state.pendingPermissionRequests).toHaveLength(2)

    const afterResolved = processEvent(state, permissionResolvedEvent('r1')).state
    expect(afterResolved.pendingPermissionRequests).toHaveLength(1)
    expect(afterResolved.pendingPermissionRequests?.[0]?.requestId).toBe('r2')
  })

  it('permission_resolved surfaces the outcome as an info message (UX continuity)', () => {
    const afterRequest = processEvent(initialState(), permissionRequestEvent('r1')).state
    const afterResolved = processEvent(afterRequest, permissionResolvedEvent('r1', true, 'admin approved'))

    const infoMessages = afterResolved.state.session.messages.filter(m => m.role === 'info')
    expect(infoMessages).toHaveLength(1)
    expect(infoMessages[0]?.content).toBe('Permission granted: admin approved')
    expect(infoMessages[0]?.timestamp).toBe(1000)
  })

  it('permission_resolved is a safe no-op when no pending request matches (e.g. pre-window replay)', () => {
    const state = initialState()
    // No prior permission_request — pendingPermissionRequests is undefined.
    const result = processEvent(state, permissionResolvedEvent('r-orphan', false, 'gone'))
    expect(result.state.pendingPermissionRequests).toEqual([])
    // The outcome info line still surfaces.
    const infoMessages = result.state.session.messages.filter(m => m.role === 'info')
    expect(infoMessages).toHaveLength(1)
    expect(infoMessages[0]?.content).toBe('Permission denied: gone')
  })

  it('permission_resolved preserves the existing session messages + streaming state', () => {
    const afterRequest = processEvent(initialState(), permissionRequestEvent('r1')).state
    const withStreaming: SessionState = {
      ...afterRequest,
      streaming: { content: 'partial', turnId: 't1' },
    }
    const afterResolved = processEvent(withStreaming, permissionResolvedEvent('r1'))
    // Streaming is untouched (permission resolution does not end the stream).
    expect(afterResolved.state.streaming).toEqual({ content: 'partial', turnId: 't1' })
    // Original messages preserved (the info line is appended, not a replacement).
    expect(afterResolved.state.session.messages.length).toBeGreaterThanOrEqual(1)
  })
})
