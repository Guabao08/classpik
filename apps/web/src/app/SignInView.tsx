import { useState, type FormEvent } from 'react'
import { api, ApiError, setToken, type User } from '../lib/api'
import { AuthCard, authField } from './AuthCard'

/**
 * Signing in, and nothing else.
 *
 * This used to toggle between sign in and sign up in place, which was fine
 * while both were one form. Signup now asks four more questions, and the two
 * live at their own paths, so a mode flag here would be a second way to reach a
 * screen that the URL already names.
 *
 * The monitor is the only validator: it owns the password rules, so repeating
 * them here would mean two rules that drift apart.
 */
export default function SignInView({
  onSignedIn,
  offline,
}: {
  onSignedIn: (user: User) => void
  /**
   * Set when the stored session could not be checked because the monitor was
   * unreachable. Worth saying up front: submitting this form will fail for the
   * same reason, and a form that fails with no explanation reads as a rejected
   * password.
   */
  offline?: string | null
}) {
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
      const session = await api.login(email, password)
      setToken(session.token)
      onSignedIn(session.user)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong')
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthCard>
      <h1 className="text-lg font-bold tracking-[-0.02em]">Sign in</h1>
      <p className="mt-1.5 text-sm leading-relaxed text-muted">
        This is a ClassPik account, not your school login. We never ask for that.
      </p>

      {offline && !error && (
        <p className="mt-4 rounded-xl border border-wait/25 bg-wait/8 px-3.5 py-2.5 text-xs leading-relaxed text-muted">
          {offline}. Signing in will not work until it is running.
        </p>
      )}

      <form onSubmit={submit} className="mt-5 space-y-3">
        <label className="block">
          <span className={authField.label}>Email</span>
          <input
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={authField.input}
            placeholder="you@school.edu"
          />
        </label>

        <label className="block">
          <span className={authField.label}>Password</span>
          <input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={authField.input}
          />
        </label>

        {error && (
          <p className="rounded-xl border border-full/25 bg-full/8 px-3.5 py-2.5 text-sm text-full">
            {error}
          </p>
        )}

        <button type="submit" disabled={busy} className={authField.submit}>
          {busy ? 'Working…' : 'Sign in'}
        </button>
      </form>

      <a
        href="/signup"
        className="mt-4 block text-center text-xs text-muted transition-colors hover:text-bright"
      >
        No account yet? Create one
      </a>
    </AuthCard>
  )
}
