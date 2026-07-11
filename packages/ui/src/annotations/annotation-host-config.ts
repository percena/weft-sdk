/**
 * annotation-host-config — stub for annotation host configuration.
 */

export function canAnnotateMessage(
  _opts: { hasAddAnnotationHandler: boolean; hasMessageId: boolean; isStreaming: boolean } | string,
): boolean {
  if (typeof _opts === 'string') return true
  return _opts.hasAddAnnotationHandler && _opts.hasMessageId && !_opts.isStreaming
}

export function shouldRenderAnnotationIslandInPortal(_context?: string): boolean {
  return true
}