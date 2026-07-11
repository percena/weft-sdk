/**
 * MarkdownHtmlBlock — renders an `html-preview` code fence's HTML SOURCE as
 * plain text inside a <pre><code>. The source is displayed for inspection,
 * NOT executed or sandboxed. Raw HTML in agent markdown is additionally
 * stripped by `rehype-sanitize` before it reaches the React tree, so this
 * block only ever shows the verbatim text content of the fenced code block.
 */

import { cn } from '../lib/utils'

export function MarkdownHtmlBlock({ code, className }: { code: string; className?: string }) {
  return (
    <pre className={cn('font-mono text-sm whitespace-pre-wrap', className)}>
      <code>{code}</code>
    </pre>
  )
}