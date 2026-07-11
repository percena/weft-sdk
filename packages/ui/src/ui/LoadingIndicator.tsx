/**
 * LoadingIndicator / Spinner — minimal stubs for UI package.
 */

import { cn } from './cn'

/**
 * Spinner - Animated loading spinner
 */
export function Spinner({ className }: { className?: string; animated?: boolean }) {
  return (
    <svg
      className={cn('animate-spin h-4 w-4 text-muted-foreground', className)}
      viewBox="0 0 24 24"
      fill="none"
      role="img"
      aria-label="Loading"
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
      />
    </svg>
  )
}

/**
 * LoadingIndicator - Shows a spinner with optional elapsed time
 */
export function LoadingIndicator({
  className,
  animated = true,
  showElapsed = false,
}: {
  className?: string
  animated?: boolean
  showElapsed?: boolean
}) {
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <Spinner animated={animated} />
      {showElapsed && <span className="text-xs text-muted-foreground">...</span>}
    </div>
  )
}