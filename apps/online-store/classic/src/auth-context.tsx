import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { guestId, setCustomerId } from './customer'

interface User {
  username: string
}

interface AuthCtx {
  user: User | null
  loading: boolean
  login: (username: string) => Promise<void>
  logout: () => Promise<void>
}

const AuthContext = createContext<AuthCtx>({
  user: null,
  loading: true,
  login: async () => {},
  logout: async () => {},
})

export function useAuth() {
  return useContext(AuthContext)
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/me')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.username) {
          setUser({ username: data.username })
          setCustomerId(data.username)
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const login = useCallback(async (username: string) => {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username }),
    })
    if (!res.ok) throw new Error('login failed')
    const data = (await res.json()) as { username: string }
    setUser({ username: data.username })
    setCustomerId(data.username)
  }, [])

  const logout = useCallback(async () => {
    try {
      await fetch('/api/logout', { method: 'POST' })
    } catch {
      // Network down — still clear client state so the user isn't stuck.
    }
    setUser(null)
    setCustomerId(guestId)
  }, [])

  return <AuthContext.Provider value={{ user, loading, login, logout }}>{children}</AuthContext.Provider>
}
