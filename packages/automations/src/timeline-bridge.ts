import type { TimelineEnvelope } from '@weft/timeline'

export type AutomationInputEventSource =
  | 'timeline'
  | 'host'
  | 'policy'
  | 'source'
  | 'skill'

export interface AutomationInputEvent {
  event: string
  source: AutomationInputEventSource
  sessionId: string
  matchValue?: string
  payload: unknown
  timestamp: number
}

export interface AutomationTimelineBridge {
  handleTimelineEnvelope(envelope: TimelineEnvelope): void
}

export interface CreateAutomationTimelineBridgeOptions {
  publish(event: AutomationInputEvent): void
}

export function createAutomationTimelineBridge(
  options: CreateAutomationTimelineBridgeOptions,
): AutomationTimelineBridge {
  return {
    handleTimelineEnvelope(envelope) {
      for (const event of projectTimelineEnvelopeToAutomationInput(envelope)) {
        options.publish(event)
      }
    },
  }
}

export function projectTimelineEnvelopeToAutomationInput(
  envelope: TimelineEnvelope,
): AutomationInputEvent[] {
  const { item, sessionId, timestamp } = envelope

  switch (item.type) {
    case 'permission_requested':
      return [{
        event: 'PermissionRequest',
        source: 'timeline',
        sessionId,
        matchValue: item.request.toolName,
        payload: compactRecord({
          requestId: item.request.requestId,
          toolName: item.request.toolName,
          reason: item.request.reason,
          input: item.request.input,
          scope: item.request.scope,
        }),
        timestamp,
      }]

    case 'permission_resolved':
      return [{
        event: 'PermissionResolved',
        source: 'policy',
        sessionId,
        matchValue: item.resolution.allowed ? 'allowed' : 'denied',
        payload: {
          requestId: item.requestId,
          resolution: item.resolution,
        },
        timestamp,
      }]

    case 'source_state_changed': {
      const source = asRecord(item.source)
      const sourceSlug = stringValue(source.sourceSlug) ?? stringValue(source.slug) ?? stringValue(source.id)
      return [{
        event: 'SourceStateChange',
        source: 'source',
        sessionId,
        matchValue: sourceSlug,
        payload: item.source,
        timestamp,
      }]
    }

    case 'skill_activated': {
      const skill = asRecord(item.skill)
      const skillSlug = stringValue(skill.skillSlug) ?? stringValue(skill.slug) ?? stringValue(skill.id)
      return [{
        event: 'SkillActivated',
        source: 'skill',
        sessionId,
        matchValue: skillSlug,
        payload: item.skill,
        timestamp,
      }]
    }

    case 'host_state_changed':
      return hostStateEvents(item.state, sessionId, timestamp)

    case 'turn_started':
      return [{
        event: 'SessionStart',
        source: 'timeline',
        sessionId,
        matchValue: item.turnId,
        payload: item,
        timestamp,
      }]

    case 'turn_completed':
    case 'turn_interrupted':
      return [{
        event: 'SessionEnd',
        source: 'timeline',
        sessionId,
        matchValue: item.turnId,
        payload: item,
        timestamp,
      }]

    default:
      return []
  }
}

function hostStateEvents(
  state: unknown,
  fallbackSessionId: string,
  timestamp: number,
): AutomationInputEvent[] {
  const record = asRecord(state)
  const sessionId = stringValue(record.sessionId) ?? fallbackSessionId
  const events: AutomationInputEvent[] = []

  if (typeof record.status === 'string') {
    events.push({
      event: 'SessionStatusChange',
      source: 'host',
      sessionId,
      matchValue: record.status,
      payload: state,
      timestamp,
    })
  }

  if (typeof record.flagged === 'boolean') {
    events.push({
      event: 'FlagChange',
      source: 'host',
      sessionId,
      matchValue: String(record.flagged),
      payload: state,
      timestamp,
    })
  }

  if (Array.isArray(record.labels)) {
    for (const label of record.labels) {
      if (typeof label !== 'string') continue
      events.push({
        event: 'LabelAdd',
        source: 'host',
        sessionId,
        matchValue: label,
        payload: state,
        timestamp,
      })
    }
  }

  return events
}

function compactRecord(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined))
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}
