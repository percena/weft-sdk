/**
 * use-annotation-cancel-restore — stub for annotation cancel/restore hook.
 * Returns a callable function for cancel/restore operations.
 */

export function useAnnotationCancelRestore(_opts?: {
  contentRootRef?: React.RefObject<HTMLElement | null>
  cancelFollowUp?: () => void
}): () => void {
  return () => {}
}