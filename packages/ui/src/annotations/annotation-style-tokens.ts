/**
 * annotation-style-tokens — stub for annotation visual style tokens.
 */

export function getAnnotationRectVisual(_rect: { color: string }): { className: string; style: Record<string, string> } {
  return { className: 'absolute pointer-events-none', style: {} }
}

export function getAnnotationChipVisual(_chip: unknown): { className: string; style: Record<string, string> } {
  return { className: 'absolute pointer-events-auto', style: {} }
}

export function annotationColorToCss(_color: string | undefined): string {
  return 'yellow'
}