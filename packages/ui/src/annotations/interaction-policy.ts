/**
 * interaction-policy — stub for annotation interaction policy.
 */

export function getAnnotationChipInteraction(_annotation: unknown): {
  clickable: boolean
  openMode: 'view' | 'edit'
} {
  return { clickable: true, openMode: 'view' }
}

export function shouldIgnoreSelectionMouseUpTarget(_target: EventTarget | null): boolean {
  return false
}