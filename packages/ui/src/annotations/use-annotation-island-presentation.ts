/**
 * use-annotation-island-presentation — stub for annotation island presentation hook.
 */

import * as React from 'react'

export interface AnnotationIslandPresentationResult {
  islandRef: React.RefObject<HTMLElement | null>
  islandPosition: { x: number; y: number }
  islandStyle: Record<string, string | number>
  shouldRenderInPortal: boolean
  renderAnchor: { x: number; y: number } | null
  renderSourceKey: string
  isVisible: boolean
  openedAtRef: React.RefObject<number | null>
  handleExitComplete: () => void
  resetPresentation: () => void
}

export function useAnnotationIslandPresentation(_opts?: {
  anchor?: { x: number; y: number } | null
  sourceKey?: string
}): AnnotationIslandPresentationResult {
  return {
    islandRef: React.createRef<HTMLElement>(),
    islandPosition: { x: 0, y: 0 },
    islandStyle: {},
    shouldRenderInPortal: true,
    renderAnchor: null,
    renderSourceKey: '',
    isVisible: false,
    openedAtRef: React.createRef<number>(),
    handleExitComplete: () => {},
    resetPresentation: () => {},
  }
}