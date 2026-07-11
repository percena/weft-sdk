import type { TimelineEnvelope } from '@weft/timeline'

/**
 * Find the active (unresolved) permission request from timeline envelopes.
 *
 * Walks the timeline backwards to find the most recent permission_requested
 * envelope that has not been resolved by a matching permission_resolved.
 */
export function findActivePermissionRequest(timeline: TimelineEnvelope[]): {
  requestId: string
  toolName: string
  input?: Record<string, unknown>
  reason?: string
  scope?: { type: string; label?: string }
} | null {
  const resolvedIds = new Set<string>()
  for (let i = timeline.length - 1; i >= 0; i--) {
    const { item } = timeline[i]
    if (item.type === 'permission_resolved') {
      resolvedIds.add(item.requestId)
    }
  }

  for (let i = timeline.length - 1; i >= 0; i--) {
    const { item } = timeline[i]
    if (item.type === 'permission_requested' && !resolvedIds.has(item.request.requestId)) {
      const scope = item.request.scope
      return {
        requestId: item.request.requestId,
        toolName: item.request.toolName,
        input: item.request.input,
        reason: item.request.reason,
        scope: scope
          ? { type: scope.type, label: formatScopeLabel(scope) }
          : undefined,
      }
    }
  }

  return null
}

function formatScopeLabel(scope: { type: string; sessionId?: string; workspaceId?: string; sourceSlug?: string; skillSlug?: string }): string {
  switch (scope.type) {
    case 'session': return 'this session'
    case 'workspace': return 'this workspace'
    case 'source': return scope.sourceSlug ?? 'source'
    case 'skill': return scope.skillSlug ?? 'skill'
    case 'automation': return 'automation'
    case 'tool-call': return 'tool call'
    default: return scope.type
  }
}