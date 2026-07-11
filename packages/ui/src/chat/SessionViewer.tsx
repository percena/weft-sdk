import type { ReactNode } from 'react'
import { useMemo } from 'react'
import type { StoredSession } from '@weft/core'
import { cn } from '../lib/utils'
import { PlatformProvider, type PlatformActions } from '../context'
import { ChatTranscript } from './ChatTranscript'
import { storedToMessage } from './turn-utils'
import type { ActivityItem } from './turn-utils'

export type SessionViewerMode = 'interactive' | 'readonly'

export interface SessionViewerProps {
  session: StoredSession
  mode?: SessionViewerMode
  platformActions?: PlatformActions
  className?: string
  onTurnClick?: (turnId: string) => void
  onActivityClick?: (activity: ActivityItem) => void
  defaultExpanded?: boolean
  header?: ReactNode
  footer?: ReactNode
  sessionFolderPath?: string
}

export function SessionViewer({
  session,
  mode = 'readonly',
  platformActions = {},
  className,
  onTurnClick,
  onActivityClick,
  defaultExpanded = false,
  header,
  footer,
  sessionFolderPath,
}: SessionViewerProps) {
  const messages = useMemo(
    () => session.messages.map(storedToMessage),
    [session.messages]
  )

  return (
    <PlatformProvider actions={platformActions}>
      <div className={cn("flex flex-col h-full", className)}>
        {header && (
          <div className="shrink-0 border-b">
            {header}
          </div>
        )}

        <div
          className="flex-1 min-h-0"
          style={{
            maskImage: 'linear-gradient(to bottom, transparent 0%, black 32px, black calc(100% - 32px), transparent 100%)',
            WebkitMaskImage: 'linear-gradient(to bottom, transparent 0%, black 32px, black calc(100% - 32px), transparent 100%)'
          }}
        >
          <div className="h-full overflow-y-auto">
            <ChatTranscript
              messages={messages}
              platformActions={platformActions}
              onTurnClick={onTurnClick}
              onActivityClick={onActivityClick}
              defaultExpanded={defaultExpanded}
              sessionId={session.id}
              sessionFolderPath={sessionFolderPath}
              annotationInteractionMode={mode === 'readonly' ? 'tooltip-only' : 'interactive'}
            />
          </div>
        </div>

        {footer && (
          <div className="shrink-0 border-t">
            {footer}
          </div>
        )}
      </div>
    </PlatformProvider>
  )
}
