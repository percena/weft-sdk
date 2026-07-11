import { useState, type FormEvent } from 'react'
import { ShopPanel } from './ShopPanel'
import { AuthProvider, useAuth } from './auth-context'

function MainLayout() {
  const { user, logout } = useAuth()
  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b bg-white px-4 py-2 shadow-sm">
        <div className="flex items-center gap-2">
          <span className="text-lg">🧵</span>
          <h1 className="text-sm font-semibold">Online Store</h1>
          <span className="hidden text-xs opacity-50 sm:inline">Visual Storefront</span>
        </div>
        {user && (
          <div className="flex items-center gap-2 text-xs">
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
      </header>
      <main className="min-h-0 flex-1 bg-gray-50">
        <ShopPanel />
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
          <p className="mt-1 text-sm opacity-60">Visual Storefront</p>
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
        <p className="mt-4 text-center text-xs opacity-50">Enter any username to explore the store</p>
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
