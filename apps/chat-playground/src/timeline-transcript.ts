import type { TimelineEnvelope } from '@percena/weft'

export function isChatTranscriptTimelineEnvelope(envelope: TimelineEnvelope): boolean {
  switch (envelope.item.type) {
    case 'user_message':
    case 'assistant_message_delta':
    case 'assistant_message':
    case 'reasoning_delta':
    case 'reasoning':
    case 'tool_call':
    case 'tool_output_delta':
    case 'tool_result':
    case 'permission_requested':
    case 'turn_completed':
    case 'turn_failed':
      return true

    case 'runtime_capability_report':
    case 'runtime_fallback':
    case 'permission_resolved':
    case 'permission_policy_changed':
    case 'source_state_changed':
    case 'skill_activated':
    case 'automation_triggered':
    case 'automation_action_result':
    case 'host_state_changed':
    case 'turn_started':
    case 'session_status':
      return false
    default:
      return false
  }
}
