/**
 * use-annotation-island-events — stub for annotation island events hook.
 */

import type * as React from 'react'

export function useAnnotationIslandEvents(_opts?: {
  enabled?: boolean
  openedAtRef?: React.RefObject<number | null>
  isCompactView?: boolean
  isTargetInsideAnnotationIsland?: (target: Node | null) => boolean
  onBack?: () => boolean
  onClose?: () => void
}): {
  handleAnnotationSubmit: () => void
  handleAnnotationDelete: () => void
  handleAnnotationEdit: () => void
  handleAnnotationCancel: () => void
} {
  return {
    handleAnnotationSubmit: () => {},
    handleAnnotationDelete: () => {},
    handleAnnotationEdit: () => {},
    handleAnnotationCancel: () => {},
  }
}