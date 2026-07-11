/**
 * link-target — stub for markdown link target resolution.
 */

export type FileLinkTarget = { kind: 'file'; path: string }
export type UrlLinkTarget = { kind: 'url'; url: string }
export type LinkTarget = FileLinkTarget | UrlLinkTarget

export function resolveMarkdownLinkTarget(target: string): LinkTarget {
  if (target.startsWith('/') || target.startsWith('./') || target.startsWith('../')) {
    return { kind: 'file', path: target }
  }
  return { kind: 'url', url: target }
}