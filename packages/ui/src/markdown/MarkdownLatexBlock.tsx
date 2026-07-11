/**
 * MarkdownLatexBlock — stub for LaTeX rendering in markdown.
 */

import { cn } from '../lib/utils'

export function MarkdownLatexBlock({ code, className }: { code: string; className?: string }) {
  return (
    <pre className={cn('font-mono text-sm whitespace-pre-wrap', className)}>
      <code>{code}</code>
    </pre>
  )
}