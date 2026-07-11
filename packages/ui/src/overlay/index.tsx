/**
 * DocumentFormattedMarkdownOverlay — stub for overlay component.
 * Accepts all props used by TurnCard but renders nothing.
 */

import type * as React from 'react'
import type { AnnotationV1 } from '@weft/core'

export interface DocumentFormattedMarkdownOverlayProps {
  content: string
  className?: string
  isOpen?: boolean
  onClose?: () => void
  variant?: string
  onOpenUrl?: (url: string) => void
  onOpenFile?: (path: string) => void
  sessionId?: string
  messageId?: string
  annotations?: AnnotationV1[]
  onAddAnnotation?: (messageId: string, annotation: AnnotationV1) => void
  onRemoveAnnotation?: (messageId: string, annotationId: string) => void
  onUpdateAnnotation?: ((messageId: string, annotationId: string, note: string) => void) | ((messageId: string, annotationId: string, patch: Partial<AnnotationV1>) => void)
  sendMessageKey?: string
  openAnnotationRequest?: unknown
  isStreaming?: boolean
  onSaveAndSendFollowUp?: (messageId: string, annotationId: string, note: string) => void
  hasActiveFollowUpAnnotations?: boolean
  annotationInteractionMode?: string
}

export function DocumentFormattedMarkdownOverlay(_props: DocumentFormattedMarkdownOverlayProps): React.ReactNode {
  return null
}