/**
 * interaction-selectors — stub for annotation interaction selector utilities.
 */

import type { AnnotationV1 } from '@weft/core'
import type { AnnotationInteractionState } from './interaction-state-machine'

export function getAnnotationInteractionAnchor(
  _annotation: AnnotationV1 | AnnotationInteractionState,
): { x: number; y: number } {
  return { x: 0, y: 0 }
}

export function getAnnotationInteractionSourceKey(
  _annotation: AnnotationV1 | AnnotationInteractionState,
  _scope?: string,
): string {
  return ''
}

export function hasAnnotationInteraction(
  _annotation: AnnotationV1 | AnnotationInteractionState,
): boolean {
  return false
}