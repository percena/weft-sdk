/**
 * PermissionRequestCard - Inline permission prompt for agent tool approval
 *
 * Renders when the agent is paused awaiting user approval for a tool
 * invocation (e.g. bash command, file write, MCP mutation). Displays
 * the tool name, input preview, and reason, with Allow/Deny/Remember
 * action buttons.
 *
 * Styling follows the Weft design system:
 * - Rounded-[8px] card with shadow-minimal
 * - Accent-coloured header strip for tool identity
 * - Truncated input preview in a subtle code block
 * - Two or three action buttons (Allow, Deny, Remember)
 */

import { cn } from '../lib/utils'
import { Markdown } from '../markdown'

export interface PermissionRequestCardProps {
  /** Unique request ID matching the runtime permission request */
  requestId: string
  /** Tool name requesting approval (e.g. "Bash", "Write", "Edit") */
  toolName: string
  /** Optional scope descriptor (session, workspace, source, skill, tool-call) */
  scope?: {
    type: string
    label?: string
  }
  /** Optional input preview (command, file path, MCP payload) */
  input?: Record<string, unknown>
  /** Optional reason text explaining why permission is needed */
  reason?: string
  /** Whether this request is currently active (not yet resolved) */
  isActive?: boolean
  /** Previous resolution if re-shown for context (allowed/denied) */
  previousResolution?: {
    allowed: boolean
    remember?: boolean
    reason?: string
  }
  /** Callback when user approves the request */
  onAllow?: (requestId: string, remember?: boolean) => void
  /** Callback when user denies the request */
  onDeny?: (requestId: string) => void
  /** Additional className */
  className?: string
}

/** Truncate a string for display, keeping the most informative part */
function truncateForPreview(value: string, maxLength: number = 120): string {
  if (value.length <= maxLength) return value
  // Keep the end for commands (most informative), keep the start for paths
  const isCommand = value.includes(' ') && !value.startsWith('/')
  if (isCommand) {
    return `…${value.slice(value.length - maxLength + 1)}`
  }
  return `${value.slice(0, maxLength - 1)}…`
}

/** Format input record as a readable preview string */
function formatInputPreview(input: Record<string, unknown>): string {
  const entries = Object.entries(input)
  if (entries.length === 0) return ''

  // Single command field — show it directly
  if (entries.length === 1 && (entries[0][0] === 'command' || entries[0][0] === 'cmd')) {
    return String(entries[0][1])
  }

  // Single file_path field — show it directly
  if (entries.length === 1 && entries[0][0] === 'file_path') {
    return String(entries[0][1])
  }

  // Multiple fields — show as key=value pairs. Objects (e.g. an elicitation's
  // schema/options) must be JSON-stringified — String() would render "[object Object]".
  return entries
    .map(([key, value]) => {
      const valStr = typeof value === 'string' ? value : JSON.stringify(value)
      return `${key}: ${truncateForPreview(valStr, 60)}`
    })
    .join('\n')
}

/** Map scope type to a short human label */
function scopeLabel(scope: { type: string; label?: string }): string {
  if (scope.label) return scope.label
  switch (scope.type) {
    case 'session': return 'this session'
    case 'workspace': return 'this workspace'
    case 'source': return 'source'
    case 'skill': return 'skill'
    case 'automation': return 'automation'
    case 'tool-call': return 'tool call'
    default: return scope.type
  }
}

export function PermissionRequestCard({
  requestId,
  toolName,
  scope,
  input,
  reason,
  isActive = true,
  previousResolution,
  onAllow,
  onDeny,
  className,
}: PermissionRequestCardProps) {
  const inputPreview = input ? formatInputPreview(input) : undefined
  const resolvedAs = previousResolution
    ? previousResolution.allowed
      ? 'allowed'
      : 'denied'
    : undefined

  return (
    <div
      className={cn(
        "rounded-[8px] shadow-minimal overflow-hidden",
        isActive ? 'bg-background' : 'bg-background/80',
        className,
      )}
      data-request-id={requestId}
    >
      {/* Header: tool name + scope */}
      <div className="border-b border-border bg-accent/[0.08] px-4 py-2.5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-medium text-foreground">
              {toolName}
            </span>
            {scope && (
              <span className="text-[12px] text-muted-foreground">
                · {scopeLabel(scope)}
              </span>
            )}
          </div>
          {!isActive && resolvedAs && (
            <span
              className={cn(
                "text-[12px] font-medium px-2 py-0.5 rounded-[5px]",
                resolvedAs === 'allowed'
                  ? 'bg-green-500/[0.12] text-green-600'
                  : 'bg-red-500/[0.12] text-red-600',
              )}
            >
              {resolvedAs === 'allowed' ? 'Allowed' : 'Denied'}
            </span>
          )}
        </div>
        {reason && (
          <div className="mt-1.5 text-[12px] text-muted-foreground">
            <Markdown mode="minimal" className="[&_p]:m-0 [&_p]:text-[12px]">
              {reason}
            </Markdown>
          </div>
        )}
      </div>

      {/* Input preview */}
      {inputPreview && (
        <div className="px-4 py-3">
          <pre
            className="max-h-[80px] overflow-auto whitespace-pre-wrap rounded-[6px] bg-foreground/[0.04] px-3 py-2 text-[12px] leading-relaxed text-foreground font-mono"
          >
            {truncateForPreview(inputPreview, 200)}
          </pre>
        </div>
      )}

      {/* Action buttons */}
      {isActive && (
        <div className="flex items-center gap-2 px-4 py-3 border-t border-border">
          <button
            type="button"
            onClick={() => onAllow?.(requestId, false)}
            className="rounded-[7px] bg-accent px-3 py-2 text-[13px] font-medium text-background shadow-minimal transition hover:opacity-90"
          >
            Allow
          </button>
          <button
            type="button"
            onClick={() => onAllow?.(requestId, true)}
            className="rounded-[7px] bg-foreground/[0.06] px-3 py-2 text-[13px] text-foreground transition hover:bg-foreground/[0.1]"
          >
            Allow & Remember
          </button>
          <button
            type="button"
            onClick={() => onDeny?.(requestId)}
            className="rounded-[7px] bg-foreground/[0.06] px-3 py-2 text-[13px] text-foreground transition hover:bg-foreground/[0.1]"
          >
            Deny
          </button>
        </div>
      )}

      {/* Resolution context for previously resolved requests */}
      {!isActive && previousResolution?.reason && (
        <div className="px-4 py-2 text-[12px] text-muted-foreground border-t border-border">
          {previousResolution.reason}
        </div>
      )}
    </div>
  )
}