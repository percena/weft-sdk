/**
 * SimpleDropdown — minimal stub for UI package.
 *
 * Provides a basic dropdown menu with trigger and items.
 * When integrating with a full app, replace with Radix UI DropdownMenu.
 */

import * as React from 'react'
import { cn } from './cn'

export interface SimpleDropdownProps {
  align?: 'start' | 'end'
  onOpenChange?: (open: boolean) => void
  trigger: React.ReactNode
  children: React.ReactNode
}

export function SimpleDropdown({
  align = 'start',
  onOpenChange,
  trigger,
  children,
}: SimpleDropdownProps) {
  const [isOpen, setIsOpen] = React.useState(false)

  const handleToggle = () => {
    const next = !isOpen
    setIsOpen(next)
    onOpenChange?.(next)
  }

  const handleClose = () => {
    setIsOpen(false)
    onOpenChange?.(false)
  }

  return (
    <div className="relative inline-flex">
      <div onClick={handleToggle}>{trigger}</div>
      {isOpen && (
        <div
          className={cn(
            'absolute z-50 min-w-[160px] p-1',
            'bg-background rounded-[8px] shadow-strong border border-border/50',
            align === 'end' ? 'right-0' : 'left-0',
            'top-full mt-1',
          )}
          onClick={handleClose}
        >
          {children}
        </div>
      )}
    </div>
  )
}

export interface SimpleDropdownItemProps {
  onClick: (e: React.MouseEvent) => void
  icon?: React.ReactNode
  children: React.ReactNode
  className?: string
}

export function SimpleDropdownItem({
  onClick,
  icon,
  children,
  className,
}: SimpleDropdownItemProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex items-center gap-2 w-full px-2 py-1.5 text-left rounded-[6px]',
        'hover:bg-foreground/[0.05] focus:bg-foreground/[0.05]',
        'text-sm transition-colors',
        className,
      )}
    >
      {icon && <span className="shrink-0">{icon}</span>}
      <span>{children}</span>
    </button>
  )
}