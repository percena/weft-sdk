/**
 * Shared runtime + timeline type re-exports.
 * Centralized to avoid repeating the same block across entry points.
 */
export type {
  AgentRuntime,
  AgentCommandSink,
  AgentEventStream,
  AgentTimelineStream,
  AgentRuntimeState,
  AgentRuntimeStatus,
  AgentRuntimeKind,
  SendMessageOptions,
} from '@weft/runtime-core'

export type { PermissionMode } from '@weft/core'

export type {
  TimelineEnvelope,
  TimelineItem,
  TimelineCursor,
  TimelineFetchRequest,
  TimelineFetchResult,
  TimelinePermissionRequest,
  TimelinePermissionResolution,
  TurnFailedErrorInfo,
} from '@weft/timeline'

// The supported way to consume `turn_failed.error` (which stays `unknown` on
// the wire): yields {message, code?, status?} with weftd's stable code when
// the failure carried one.
export { readTurnFailedError } from '@weft/timeline'
