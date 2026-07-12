/**
 * link-target — stub for markdown link target resolution.
 */

export type FileLinkTarget = { kind: 'file'; path: string }
export type UrlLinkTarget = { kind: 'url'; url: string }
// Target that must not be navigated to (dangerous scheme). Callers ignore it.
export type BlockedLinkTarget = { kind: 'blocked' }
export type LinkTarget = FileLinkTarget | UrlLinkTarget | BlockedLinkTarget

// Schemes that can execute script or exfiltrate when handed to a host's
// navigation handler. rehype-sanitize strips these from the rendered `href`,
// but the click handler also falls back to anchor *text* (which sanitize does
// not touch), so this function is the guard on that path.
const DANGEROUS_SCHEME = /^(?:javascript|data|vbscript|file):/i

export function resolveMarkdownLinkTarget(target: string): LinkTarget {
  if (target.startsWith('/') || target.startsWith('./') || target.startsWith('../')) {
    return { kind: 'file', path: target }
  }
  // Strip interleaved whitespace (tab/newline/CR an attacker can splice into
  // `java\tscript:`) before testing the scheme.
  const scheme = target.replace(/\s+/g, '')
  if (DANGEROUS_SCHEME.test(scheme)) {
    return { kind: 'blocked' }
  }
  return { kind: 'url', url: target }
}
