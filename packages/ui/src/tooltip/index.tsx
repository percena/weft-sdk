/**
 * Tooltip components — minimal stubs for UI package.
 *
 * These are placeholder components that render content without tooltip behavior.
 * When integrating with a full app (Electron or web), replace these with
 * proper tooltip implementations (e.g., Radix UI Tooltip).
 */

import type * as React from 'react'
import { cn } from '../ui/cn'

/**
 * TooltipProvider - Wraps children to enable tooltip behavior.
 * Stub: just renders children.
 */
export function TooltipProvider({ children }: { children: React.ReactNode; delayDuration?: number }) {
  return <>{children}</>
}

/**
 * Tooltip - Container for a tooltip trigger + content pair.
 * Stub: just renders children.
 */
export function Tooltip({ children }: { children: React.ReactNode; open?: boolean; onOpenChange?: (open: boolean) => void }) {
  return <>{children}</>
}

/**
 * TooltipTrigger - Element that triggers the tooltip on hover/focus.
 * Stub: renders child element as-is.
 */
export function TooltipTrigger({
  children,
  asChild = false,
}: {
  children: React.ReactNode
  asChild?: boolean
}) {
  return <>{children}</>
}

/**
 * TooltipContent - The floating content shown when triggered.
 * Stub: renders content inline with a subtle background for visibility.
 */
export function TooltipContent({
  children,
  side = 'top',
  className,
}: {
  children: React.ReactNode
  side?: 'top' | 'bottom' | 'left' | 'right'
  className?: string
  sideOffset?: number
}) {
  return (
    <div className={cn(
      'px-2 py-1 text-xs rounded bg-foreground text-background',
      'max-w-xs whitespace-normal',
      className,
    )}>
      {children}
    </div>
  )
}