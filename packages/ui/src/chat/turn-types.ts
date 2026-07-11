import type { AnnotationV1, Message, ToolDisplayMeta } from '@weft/core'

export type ActivityStatus = 'pending' | 'running' | 'completed' | 'error' | 'backgrounded'
export type ActivityType = 'tool' | 'thinking' | 'intermediate' | 'status' | 'plan'
export type AnnotationInteractionMode = 'interactive' | 'tooltip-only'

export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'interrupted'

export interface TodoItem {
  /** Task content/description */
  content: string
  /** Current status */
  status: TodoStatus
  /** Present continuous form shown when in_progress (e.g., "Running tests") */
  activeForm?: string
}

export interface ActivityItem {
  id: string
  type: ActivityType
  status: ActivityStatus
  toolName?: string
  toolUseId?: string  // For matching parent-child relationships
  toolInput?: Record<string, unknown>
  content?: string
  intent?: string
  /** Optional backing message id (used by plan activities for branching/annotations) */
  messageId?: string
  /** Optional persisted annotations (used by plan activities) */
  annotations?: AnnotationV1[]
  displayName?: string  // LLM-generated human-friendly tool name (for MCP tools)
  toolDisplayMeta?: ToolDisplayMeta  // Embedded metadata with base64 icon (for viewer compatibility)
  timestamp: number
  error?: string
  // Parent-child nesting for Task subagents
  parentId?: string  // Parent activity's toolUseId
  depth?: number     // Nesting level (0 = root, 1 = child, etc.)
  // Status activities (e.g., compacting)
  statusType?: string  // e.g., 'compacting'
  // Background task fields
  taskId?: string         // For background Task tools
  shellId?: string        // For background Bash shells
  elapsedSeconds?: number // Live progress updates
  isBackground?: boolean  // Flag for UI differentiation
}

export interface ResponseContent {
  text: string
  isStreaming: boolean
  streamStartTime?: number
  /** Whether this response is a plan (renders with plan variant) */
  isPlan?: boolean
  /** ID of the underlying message (for branching + annotations) */
  messageId?: string
  /** Persisted annotations attached to the response message */
  annotations?: AnnotationV1[]
}

// ============================================================================
// Turn Types
// ============================================================================

/** Represents one complete assistant turn */
export interface AssistantTurn {
  type: 'assistant'
  turnId: string
  activities: ActivityItem[]
  response?: ResponseContent
  intent?: string
  isStreaming: boolean
  isComplete: boolean
  timestamp: number
  /** Extracted from TodoWrite tool - latest todo state in this turn */
  todos?: TodoItem[]
}

/** Represents a user message */
export interface UserTurn {
  type: 'user'
  message: Message
  timestamp: number
}

/** Represents a system/info/error message that stands alone */
export interface SystemTurn {
  type: 'system'
  message: Message
  timestamp: number
}

/** Represents an auth request (credential input, OAuth flow) */
export interface AuthRequestTurn {
  type: 'auth-request'
  message: Message
  timestamp: number
}

export type Turn = AssistantTurn | UserTurn | SystemTurn | AuthRequestTurn

export type OpenAnnotationRequest = {
  messageId: string
  annotationId: string
  mode: 'view' | 'edit'
  anchorX?: number
  anchorY?: number
  nonce: number
}
