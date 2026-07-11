import { useEffect } from 'react'
import { ActivityInspector } from './ActivityInspector'
import type { ActivityItem } from './turn-types'

/**
 * Modal popup wrapping ActivityInspector: centered, dismissable via backdrop
 * click or Escape. Open it from a TurnCard's onOpenActivityDetails callback.
 */
export function ActivityDetailsPanel({
  activity,
  onClose,
}: {
  activity: ActivityItem | null
  onClose: () => void
}) {
  useEffect(() => {
    if (!activity) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [activity, onClose])

  if (!activity) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-[640px] max-h-[80vh] overflow-hidden rounded-[12px] border border-border bg-background shadow-strong mx-4"
        onClick={e => e.stopPropagation()}
      >
        <ActivityInspector activity={activity} onClose={onClose} />
      </div>
    </div>
  )
}
