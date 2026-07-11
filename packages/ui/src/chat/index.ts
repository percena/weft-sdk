/**
 * Chat component exports for @weft/ui
 */

// Turn utilities (pure functions, no React)
// All turn-types exports (ActivityStatus, ActivityType, etc.) flow through the turn-utils barrel
export * from './turn-utils'
export * from './follow-up-helpers'

// Components
export { TurnCard, type TurnCardProps } from './TurnCard'
export { ResponseCard, type ResponseCardProps } from './ResponseCard'
export { SIZE_CONFIG } from './turn-helpers'
export { ActivityStatusIcon } from './ActivityRow'
export { shouldShowStreamingContent } from './tool-display'
export { InlineExecution, mapToolEventToActivity, type InlineExecutionProps, type InlineExecutionStatus, type InlineActivityItem } from './InlineExecution'
export { TurnCardActionsMenu, type TurnCardActionsMenuProps } from './TurnCardActionsMenu'
export { ChatTranscript, type ChatTranscriptProps } from './ChatTranscript'
export { SessionViewer, type SessionViewerProps, type SessionViewerMode } from './SessionViewer'
export { PendingIndicator, type PendingIndicatorProps } from './PendingIndicator'
export { UserMessageBubble, type UserMessageBubbleProps } from './UserMessageBubble'
export { SystemMessage, type SystemMessageProps, type SystemMessageType } from './SystemMessage'
export { PermissionRequestCard, type PermissionRequestCardProps } from './PermissionRequestCard'
export { AssistantTurnCard } from './AssistantTurnCard'
export { ActivityInspector } from './ActivityInspector'
export { ActivityDetailsPanel } from './ActivityDetailsPanel'
export { PermissionModeMenu } from './PermissionModeMenu'

// Attachment helpers
export { FileTypeIcon, getFileTypeLabel, type FileTypeIconProps } from './attachment-helpers'

// Accept plan dropdown (for plan cards)
export { AcceptPlanDropdown } from './AcceptPlanDropdown'
