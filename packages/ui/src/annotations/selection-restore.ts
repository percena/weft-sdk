/**
 * selection-restore — stub for DOM selection restore utilities.
 */

export function clearDomSelection(): void {
  if (typeof window !== 'undefined' && window.getSelection) {
    const selection = window.getSelection()
    if (selection) {
      selection.removeAllRanges()
    }
  }
}