/**
 * island-motion — stub for annotation island motion/animation utilities.
 */

export interface PointerSnapshot {
  x: number
  y: number
  timestamp: number
}

export function buildAnnotationChipEntryTransition(_snapshot: PointerSnapshot | null = null): Record<string, unknown> {
  return {}
}

export function buildSelectionEntryTransition(
  _primary: PointerSnapshot | null = null,
  _secondary?: PointerSnapshot | null,
): Record<string, unknown> {
  return {}
}