import { useState, type FormEvent } from 'react'
import { api, ApiError, API_BASE, setToken, type User } from '../lib/api'
import { Logo } from '../components/ui'

/**
 * One form for both signing in and signing up, because at this size a second
 * screen is a second thing to keep consistent for no benefit. The monitor is
 * the only validator: it owns the password rules, so repeating them here would
 * mean two rules that drift apart.
 */
export default function SignInView({ onSignedIn }: { onSignedIn: (user: User) => void }) {
  const [mode, setMode] = useState<'login' | 'signup'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const session = mode === 'login'
        ? await api.login(email, password)
        : await api.signup(email, password)
      setToken(session.token)
      onSignedIn(session.user)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong')
    } finally {
      setBusy(false)
    }
  }

  const other = mode === 'login' ? 'signup' : 'login'

  return (
    <div className="flex min-h-screen items-center justify-center bg-ink px-6">
      <div className="w-full max-w-[380px]">
        <div className="mb-8 flex justify-center">
          <Logo size={30} />
        </div>

        <div className="panel p-6">
          <h1 className="text-lg font-bold tracking-[-0.02em]">
            {mode === 'login' ? 'Sign in' : 'Create an account'}
          </h1>
          <p className="mt-1.5 text-sm leading-relaxed text-muted">
            This is a ClassPik account, not your school login. We never ask for that.
          </p>

          <form onSubmit={submit} className="mt-5 space-y-3">
            <label className="block">
              <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">
                Email
              </span>
              <input
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full rounded-xl border border-line bg-white/3 px-3.5 py-2.5 text-sm outline-none transition-colors placeholder:text-muted focus:border-open/40"
                placeholder="you@school.edu"
              />
            </label>

            <label className="block">
              <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">
                Password
              </span>
              <input
                type="password"
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-xl border border-line bg-white/3 px-3.5 py-2.5 text-sm outline-none transition-colors placeholder:text-muted focus:border-open/40"
                placeholder={mode === 'login' ? '' : 'at least 10 characters'}
              />
            </label>

            {error && (
              <p className="rounded-xl border border-full/25 bg-full/8 px-3.5 py-2.5 text-sm text-full">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={busy}
              className="w-full rounded-xl bg-open px-4 py-2.5 text-sm font-semibold text-ink transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {busy ? 'Working…' : mode === 'login' ? 'Sign in' : 'Create account'}
            </button>
          </form>

          <button
            type="button"
            onClick={() => { setMode(other); setError(null) }}
            className="mt-4 w-full text-center text-xs text-muted transition-colors hover:text-bright"
          >
            {mode === 'login' ? 'No account yet? Create one' : 'Already have an account? Sign in'}
          </button>
        </div>

        <p className="num mt-5 text-center text-[11px] text-muted">
          {API_BASE.replace(/^https?:\/\//, '')}
        </p>
      </div>
    </div>
  )
}
