/**
 * @weft/ui — React streaming chat panel
 *
 * Main entry point. Re-exports from sub-modules:
 * - chat: TurnCard, SessionViewer, StreamingMarkdown, etc.
 * - markdown: Markdown, MemoizedMarkdown, CodeBlock
 * - annotations: annotation overlay system
 * - ui: styled primitives (IslandTransitionConfig, StyledDropdown)
 * - processor: SessionEvent → Message[] pipeline, EventSource, useEventProcessor hook
 */

// Chat components
export {
  TurnCard,
  ResponseCard,
  SIZE_CONFIG,
  shouldShowStreamingContent,
  type TurnCardProps,
  type ResponseCardProps,
  type ActivityItem,
  type ActivityStatus,
  type ResponseContent,
  type TodoItem,
} from './chat'

export {
  ChatTranscript,
  type ChatTranscriptProps,
} from './chat'

export {
  SessionViewer,
  type SessionViewerProps,
  type SessionViewerMode,
} from './chat'

export {
  PendingIndicator,
  type PendingIndicatorProps,
} from './chat'

export {
  groupMessagesByTurn,
  getAssistantTurnUiKey,
  storedToMessage,
  type Turn,
  type AssistantTurn,
  type UserTurn,
  type SystemTurn,
  type AuthRequestTurn,
} from './chat'

export {
  InlineExecution,
  type InlineExecutionProps,
  type InlineExecutionStatus,
  type InlineActivityItem,
} from './chat'

export {
  UserMessageBubble,
  type UserMessageBubbleProps,
} from './chat'

export {
  SystemMessage,
  type SystemMessageProps,
  type SystemMessageType,
} from './chat'

export {
  PermissionRequestCard,
  type PermissionRequestCardProps,
} from './chat'

export {
  AssistantTurnCard,
  ActivityInspector,
  ActivityDetailsPanel,
  PermissionModeMenu,
} from './chat'

// Markdown
export {
  Markdown,
  MemoizedMarkdown,
  CollapsibleMarkdownProvider,
  CodeBlock,
  InlineCode,
  type MarkdownProps,
  type RenderMode,
} from './markdown'

// Annotations
export {
  type AnnotationOverlayRect,
  type AnnotationOverlayChip,
  type TextSegment,
  hasExistingTextRangeAnnotation,
  createSelectionPreviewAnnotation,
  createTextSelectionAnnotation,
  collectTextSegments,
  getCanonicalText,
  resolveNodeOffset,
} from './annotations/annotation-core'

export {
  computeAnnotationOverlayGeometry,
  type AnnotationOverlayGeometryResult,
} from './annotations/annotation-overlay-geometry'

export {
  AnnotationOverlayLayer,
  type AnnotationOverlayLayerProps,
} from './annotations/AnnotationOverlayLayer'

export {
  type AnnotationIslandMenuProps,
  AnnotationIslandMenu,
} from './annotations/AnnotationIslandMenu'

export {
  type PointerSnapshot,
  buildAnnotationChipEntryTransition,
  buildSelectionEntryTransition,
} from './annotations/island-motion'

// UI primitives
export type {
  IslandTransitionConfig,
} from './ui'

// Context
export {
  PlatformProvider,
  type PlatformActions,
} from './context'

// Event processor — SessionEvent → Message[] pipeline
export * from './processor/index.ts'
