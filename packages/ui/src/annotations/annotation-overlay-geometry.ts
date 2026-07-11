/**
 * annotation-overlay-geometry — stub for annotation overlay geometry computation.
 */

import type { AnnotationV1 } from '@weft/core'
import type { AnnotationOverlayRect, AnnotationOverlayChip } from './annotation-core'

export interface AnnotationOverlayGeometryResult {
  rects: AnnotationOverlayRect[]
  chips: AnnotationOverlayChip[]
  unresolved: Array<{ annotation: AnnotationV1; reason: string }>
}

export function computeAnnotationOverlayGeometry(
  _containerOrOpts: HTMLElement | { root: HTMLElement; renderedAnnotations: AnnotationV1[]; persistedAnnotations?: AnnotationV1[] },
  _annotations?: AnnotationV1[],
  _content?: string,
): AnnotationOverlayGeometryResult {
  return { rects: [], chips: [], unresolved: [] }
}