/**
 * AnnotationIslandMenu — stub for annotation island menu component.
 * Accepts all props used by TurnCard but renders nothing.
 */

import type * as React from 'react'
import type { IslandTransitionConfig } from '../ui'

export interface AnnotationIslandMenuProps {
  anchor?: { x: number; y: number } | null
  sourceKey?: string
  replayNonce?: number
  isVisible?: boolean
  activeView?: string | null
  mode?: string
  draft?: string
  onDraftChange?: (draft: string) => void
  onOpenFollowUp?: () => void
  onCancel?: () => void
  onRequestBack?: () => boolean
  onRequestEdit?: () => void
  onSubmit?: (note: string) => void
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onSubmitAndSend?: (...args: any[]) => void
  onDelete?: () => void
  sendMessageKey?: string
  transitionConfig?: Record<string, unknown> | IslandTransitionConfig
  onExitComplete?: () => void
  usePortal?: boolean
  className?: string
}

export function AnnotationIslandMenu(_props: AnnotationIslandMenuProps): React.ReactNode {
  return null
}