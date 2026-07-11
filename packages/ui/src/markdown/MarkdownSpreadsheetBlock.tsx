/**
 * MarkdownSpreadsheetBlock — stub for spreadsheet rendering in markdown.
 */

import { cn } from '../lib/utils'

export function MarkdownSpreadsheetBlock({ code, className }: { code: string; className?: string }) {
  return (
    <pre className={cn('font-mono text-sm whitespace-pre-wrap', className)}>
      <code>{code}</code>
    </pre>
  )
}