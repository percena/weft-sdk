/**
 * MarkdownMermaidBlock — stub for Mermaid diagram rendering.
 */

import { cn } from '../lib/utils'

export function MarkdownMermaidBlock({ code, className, showExpandButton = true }: { code: string; className?: string; showExpandButton?: boolean }) {
  return (
    <pre className={cn('font-mono text-sm whitespace-pre-wrap my-2', className)}>
      <code>{code}</code>
    </pre>
  )
}