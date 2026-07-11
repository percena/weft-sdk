/**
 * StyledDropdown — minimal stub for UI package.
 *
 * Provides styled dropdown menu components matching the existing UI patterns.
 * When integrating with a full app, replace with Radix UI DropdownMenu.
 */

import type * as React from 'react'
import { cn } from './cn'

export function DropdownMenu({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}

export function DropdownMenuTrigger({ children }: { children: React.ReactNode; asChild?: boolean }) {
  return <>{children}</>
}

export function StyledDropdownMenuContent({
  children,
  align = 'end',
  minWidth,
  sideOffset,
  className,
}: {
  children: React.ReactNode
  align?: 'start' | 'end'
  minWidth?: string
  sideOffset?: number
  className?: string
}) {
  return (
    <div className={cn(
      'min-w-[180px] p-1 bg-background rounded-[8px] shadow-strong border border-border/50',
      align === 'end' ? 'ml-auto' : '',
      className,
    )}>
      {children}
    </div>
  )
}

export function StyledDropdownMenuItem({
  onClick,
  children,
  className,
}: {
  onClick?: (e: React.MouseEvent) => void
  children: React.ReactNode
  className?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex items-center gap-2 w-full px-2 py-1.5 text-left rounded-[6px]',
        'hover:bg-foreground/[0.05] text-sm',
        className,
      )}
    >
      {children}
    </button>
  )
}