import { Markdown } from '../markdown'
import type { ActivityItem } from './turn-types'

/**
 * Renders a single activity's input / output / error for inspection. Shared by
 * the web app's side panel and the embeddable chat panel's detail popup so the
 * step-detail view stays identical across hosts.
 */
export function ActivityInspector({
  activity,
  onClose,
}: {
  activity: ActivityItem | null
  onClose?: () => void
}) {
  if (!activity) {
    return (
      <div className="rounded-[8px] bg-background shadow-minimal p-4 text-[13px] text-muted-foreground">
        Select an activity from the turn card to inspect its input and output.
      </div>
    )
  }

  return (
    <div className="flex flex-col overflow-hidden">
      <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <div className="truncate text-[13px] font-medium text-foreground">{activity.displayName ?? activity.toolName ?? 'Activity'}</div>
          <div className="mt-1 text-[12px] text-muted-foreground">{activity.intent ?? activity.status ?? 'unknown'}</div>
        </div>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-[6px] text-[16px] leading-none text-muted-foreground transition hover:bg-foreground/[0.06] hover:text-foreground"
            aria-label="Close activity details"
          >
            ✕
          </button>
        )}
      </div>
      <div className="overflow-y-auto space-y-4 p-4">
        {activity.toolInput && (
          <div>
            <div className="mb-2 text-[12px] font-medium text-muted-foreground">Input</div>
            <pre className="max-h-[280px] overflow-auto rounded-[6px] bg-foreground/[0.04] p-3 text-[12px] leading-relaxed text-foreground">
              {JSON.stringify(activity.toolInput, null, 2)}
            </pre>
          </div>
        )}
        {activity.error && (
          <div>
            <div className="mb-2 text-[12px] font-medium text-muted-foreground">Error</div>
            <pre className="max-h-[320px] overflow-auto whitespace-pre-wrap rounded-[6px] bg-foreground/[0.04] p-3 text-[12px] leading-relaxed text-foreground">
              {activity.error}
            </pre>
          </div>
        )}
        {activity.content && !activity.error && (
          <div>
            <div className="mb-2 text-[12px] font-medium text-muted-foreground">Output</div>
            <div className="max-h-[320px] overflow-y-auto rounded-[6px] bg-foreground/[0.04] px-3 py-2 text-[12px] text-foreground">
              <Markdown mode="minimal" className="text-[12px] leading-relaxed">
                {activity.content}
              </Markdown>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
