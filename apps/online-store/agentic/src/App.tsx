import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { ShopPanel } from './ShopPanel'
import { ChatPane } from './ChatPane'
import { AuthProvider, useAuth } from './auth-context'
import { bootstrapChatSession, type ChatSessionBootstrap } from './chat-bootstrap'

const MAX_RETRIES = 5
const RETRY_DELAYS = [2000, 3000, 5000, 8000, 12000]

function MainLayout() {
  const { user, logout } = useAuth()
  const [boot, setBoot] = useState<ChatSessionBootstrap | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retrying, setRetrying] = useState(false)
  const retriesRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const abortRef = useRef<AbortController>(undefined)

  const attemptBootstrap = useCallback((auto = false) => {
    abortRef.current?.abort()
    const ac = new AbortController()
    abortRef.current = ac

    if (auto) setRetrying(true)
    else setError(null)

    bootstrapChatSession(ac.signal)
      .then((created) => {
        retriesRef.current = 0
        setRetrying(false)
        setError(null)
        setBoot(created)
      })
      .catch((err: Error) => {
        if (ac.signal.aborted) return
        setRetrying(false)
        setError(err.message)
        if (retriesRef.current < MAX_RETRIES) {
          const delay = RETRY_DELAYS[Math.min(retriesRef.current, RETRY_DELAYS.length - 1)]
          retriesRef.current++
          timerRef.current = setTimeout(() => attemptBootstrap(true), delay)
        }
      })
  }, [])

  useEffect(() => {
    attemptBootstrap()
    return () => {
      clearTimeout(timerRef.current)
      abortRef.current?.abort()
    }
  }, [attemptBootstrap])

  const manualRetry = () => {
    retriesRef.current = 0
    clearTimeout(timerRef.current)
    setRetrying(false)
    attemptBootstrap()
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b bg-white px-4 py-2 shadow-sm">
        <div className="flex items-center gap-2">
          <span className="text-lg">🧵</span>
          <h1 className="text-sm font-semibold">Online Store</h1>
          <span className="hidden text-xs opacity-50 sm:inline">Weft Chat × Visual Storefront</span>
        </div>
        <div className="flex items-center gap-3 text-xs">
          {boot && (
            <span className="hidden opacity-60 sm:inline">
              Session <span className="font-mono">{boot.session_id.slice(0, 8)}</span>
            </span>
          )}
          {user && (
            <div className="flex items-center gap-2">
              <span className="rounded-full bg-violet-100 px-2 py-0.5 font-medium text-violet-700">
                {user.username}
              </span>
              <button
                type="button"
                onClick={() => void logout()}
                className="rounded border px-2 py-0.5 opacity-70 hover:opacity-100"
              >
                Logout
              </button>
            </div>
          )}
        </div>
      </header>

      <main className="flex min-h-0 flex-1">
        <aside className="flex w-[440px] shrink-0 flex-col border-r bg-white">
          {error && (
            <div className="m-3 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
              Failed to create chat session: {error}
              <div className="mt-1.5 flex items-center gap-2 text-xs">
                {retrying ? (
                  <span className="opacity-70">
                    Retrying… ({retriesRef.current}/{MAX_RETRIES})
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={manualRetry}
                    className="rounded border border-red-300 bg-white px-2 py-0.5 text-red-600 hover:bg-red-50"
                  >
                    Reconnect
                  </button>
                )}
              </div>
            </div>
          )}
          {!boot && !error && (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm opacity-60">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-current border-t-transparent" />
              <span>Connecting to chat…</span>
            </div>
          )}
          {boot && <ChatPane boot={boot} />}
        </aside>
        <section className="min-w-0 flex-1 bg-gray-50">
          <ShopPanel />
        </section>
      </main>
    </div>
  )
}

function LoginPage() {
  const { login } = useAuth()
  const [username, setUsername] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    const name = username.trim()
    if (!name) return
    setSubmitting(true)
    setError(null)
    try {
      await login(name)
    } catch {
      setError('Login failed, please try again')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex h-full items-center justify-center bg-gradient-to-br from-violet-50 to-indigo-100">
      <div className="w-full max-w-sm rounded-2xl border bg-white p-8 shadow-lg">
        <div className="mb-6 text-center">
          <span className="text-4xl">🧵</span>
          <h1 className="mt-2 text-xl font-bold">Online Store</h1>
          <p className="mt-1 text-sm opacity-60">Weft Chat × Visual Storefront</p>
        </div>
        <form onSubmit={handleSubmit}>
          <label htmlFor="login-username" className="mb-1 block text-sm font-medium">
            Username
          </label>
          <input
            id="login-username"
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="Enter any username"
            className="w-full rounded-lg border px-3 py-2 text-sm focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500"
            disabled={submitting}
          />
          {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
          <button
            type="submit"
            disabled={submitting || !username.trim()}
            className="mt-4 w-full rounded-lg bg-violet-600 py-2.5 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-50"
          >
            {submitting ? 'Logging in…' : 'Login'}
          </button>
        </form>
        <p className="mt-4 text-center text-xs opacity-50">Enter any username to explore the full store + AI chat features</p>
      </div>
    </div>
  )
}

function AppContent() {
  const { user, loading } = useAuth()

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <span className="text-sm opacity-60">Checking login status…</span>
      </div>
    )
  }

  if (!user) return <LoginPage />

  return <MainLayout key={user.username} />
}

export default function App() {
  return (
    <AuthProvider>
      <AppContent />
    </AuthProvider>
  )
}
