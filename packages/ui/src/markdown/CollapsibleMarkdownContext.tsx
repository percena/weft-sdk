/**
 * CollapsibleMarkdownContext — stub for collapsible markdown context.
 */

import { createContext, useContext } from 'react'

interface CollapsibleContext {
  collapsedSections: Set<string>
  toggleSection: (id: string) => void
}

const CollapsibleMarkdownContext = createContext<CollapsibleContext | null>(null)

export function useCollapsibleMarkdown(): CollapsibleContext | null {
  return useContext(CollapsibleMarkdownContext)
}

export function CollapsibleMarkdownProvider({
  children,
}: {
  children: React.ReactNode
}) {
  const collapsedSections = new Set<string>()
  const toggleSection = (_id: string) => {}
  return (
    <CollapsibleMarkdownContext.Provider value={{ collapsedSections, toggleSection }}>
      {children}
    </CollapsibleMarkdownContext.Provider>
  )
}