/**
 * ShikiThemeContext — stub for Shiki syntax highlighting theme context.
 */

import { createContext, useContext } from 'react'

const ShikiThemeContext = createContext<string | null>(null)

export function useShikiTheme(): string | null {
  return useContext(ShikiThemeContext)
}

export function ShikiThemeProvider({
  theme,
  children,
}: {
  theme: string
  children: React.ReactNode
}) {
  return (
    <ShikiThemeContext.Provider value={theme}>
      {children}
    </ShikiThemeContext.Provider>
  )
}