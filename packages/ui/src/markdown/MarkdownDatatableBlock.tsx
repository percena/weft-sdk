/**
 * MarkdownDatatableBlock — stub for datatable rendering in markdown.
 */

import { cn } from '../lib/utils'

export function MarkdownDatatableBlock({ code, className }: { code: string; className?: string }) {
  return (
    <pre className={cn('font-mono text-sm whitespace-pre-wrap', className)}>
      <code>{code}</code>
    </pre>
  )
}