/**
 * Platform context — provides platform-specific actions to UI components.
 *
 * In Electron, this wraps window.electronAPI.
 * In web viewer, this provides read-only actions.
 * For testing, this provides mock actions.
 */

import type React from 'react'
import { createContext, useContext } from 'react'

/**
 * Platform-specific actions for UI components.
 * Consumers provide these via PlatformProvider.
 */
export interface PlatformActions {
  /** Open a file in the system editor/Finder */
  onOpenFile?: (path: string) => void
  /** Open a URL in the system browser */
  onOpenUrl?: (url: string) => void
  /** Open a markdown preview popover */
  onOpenMarkdownPreview?: (sessionId: string, markdown: string) => void
  /** Open turn details in a new window/panel */
  onOpenTurnDetails?: (sessionId: string, turnId: string) => void
  /** Open activity details */
  onOpenActivityDetails?: (sessionId: string, activityId: string) => void
  /** Open multi-file diff view for a turn */
  onOpenMultiFileDiff?: (sessionId: string, turnId: string) => void
  /** Respond to a permission or auth request */
  onPermissionAllow?: (requestId: string, allowed: boolean, remember?: boolean) => void
}

const PlatformContext = createContext<PlatformActions>({})

/**
 * Provider that injects platform-specific actions into the component tree.
 */
export function PlatformProvider({
  actions,
  children,
}: {
  actions: PlatformActions
  children: React.ReactNode
}) {
  return (
    <PlatformContext.Provider value={actions}>
      {children}
    </PlatformContext.Provider>
  )
}

/**
 * Hook to access platform actions from context.
 */
export function usePlatform(): PlatformActions {
  return useContext(PlatformContext)
}