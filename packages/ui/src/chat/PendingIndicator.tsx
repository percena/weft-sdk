export interface PendingIndicatorProps {
  isReconnecting?: boolean
}

export function PendingIndicator({
  isReconnecting = false,
}: PendingIndicatorProps) {
  if (isReconnecting) {
    return (
      <div className="flex items-center gap-2 rounded-[8px] bg-background shadow-minimal px-4 py-3 text-[13px] text-muted-foreground">
        <span className="h-2 w-2 animate-pulse rounded-full bg-yellow-400/70" />
        <span>Reconnecting...</span>
      </div>
    )
  }

  return (
    <div className="rounded-[8px] bg-background shadow-minimal px-4 py-3">
      <div className="flex items-center gap-1">
        {([0, 160, 320] as const).map((delay) => (
          <span
            key={delay}
            className="h-2 w-2 animate-bounce rounded-full bg-muted-foreground/50"
            style={{ animationDelay: `${delay}ms` }}
          />
        ))}
      </div>
    </div>
  )
}
