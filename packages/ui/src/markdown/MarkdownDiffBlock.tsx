/**
 * MarkdownDiffBlock - Renders diff code blocks without pulling in the full
 * Shiki diff renderer bundle.
 *
 * When the markdown viewer encounters a ```diff code block, this component
 * uses lightweight line styling for additions, deletions, hunk headers, and
 * file headers.
 */

import * as React from 'react'
import { cn } from '../lib/utils'

// ── Main component ────────────────────────────────────────────────────────

export interface MarkdownDiffBlockProps {
  /** Raw diff text from the markdown code block */
  code: string
  className?: string
}

type DiffLineKind = 'add' | 'remove' | 'hunk' | 'file' | 'context'

function getDiffLineKind(line: string): DiffLineKind {
  if (line.startsWith('@@')) return 'hunk'
  if (line.startsWith('+++') || line.startsWith('---')) return 'file'
  if (line.startsWith('+')) return 'add'
  if (line.startsWith('-')) return 'remove'
  return 'context'
}

function getLineClass(kind: DiffLineKind): string {
  switch (kind) {
    case 'add':
      return 'bg-success/[0.08] text-success'
    case 'remove':
      return 'bg-destructive/[0.08] text-destructive'
    case 'hunk':
      return 'bg-accent/[0.08] text-accent'
    case 'file':
      return 'bg-muted/60 text-muted-foreground'
    default:
      return 'text-foreground/80'
  }
}

export function MarkdownDiffBlock({ code, className }: MarkdownDiffBlockProps) {
  const lines = React.useMemo(() => code.split(/\r?\n/), [code])
  return (
    <pre
      className={cn(
        'relative rounded-[8px] overflow-x-auto border bg-muted/30 py-2 text-[13px] leading-relaxed',
        className,
      )}
      style={{ fontFamily: '"JetBrains Mono", monospace' }}
    >
      <code>
        {lines.map((line, index) => {
          const kind = getDiffLineKind(line)
          const sign = line[0] === '+' || line[0] === '-' ? line[0] : ' '
          return (
            <span
              key={`${index}:${line}`}
              className={cn('block min-w-max px-3 whitespace-pre', getLineClass(kind))}
            >
              <span className="mr-3 inline-block w-3 select-none text-center opacity-70">
                {sign}
              </span>
              {line || ' '}
            </span>
          )
        })}
      </code>
    </pre>
  )
}
