import { useState, type FormEvent } from 'react'
import { api, ApiError } from '../lib/api'
import { AuthCard, authField } from './AuthCard'

/**
 * Where a reset link lands, and only that.
 *
 * The token is required by the type rather than checked here: the router sends
 * a tokenless /reset to /forgot, so there is exactly one screen behind this path
 * and it always has the credential it needs. Asking for an address lives at
 * /forgot for the same reason.
 *
 * Deliberately reachable signed out, and it does not wait on the session check.
 * The mail is read wherever the mail is read, which is routinely a phone that
 * has never signed in, and the whole premise of this screen is somebody who
 * cannot sign in.
 *
 * The monitor owns the password rules, so nothing here repeats them: two copies
 * of a minimum length are two numbers that drift apart.
 */
export default function ResetView({ token }: { token: string }) {
  const [password, setPassword] = useState('')
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await api.resetPassword(token, password)
      setDone(true)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong')
    } finally {
      setBusy(false)
    }
  }

  if (done) {
    return (
      <AuthCard>
        <h1 className="text-lg font-bold tracking-[-0.02em]">Password changed</h1>
        <p className="mt-1.5 text-sm leading-relaxed text-muted">
          Every device that was signed in has been signed out, including any you did not know
          about. Your watches are untouched and still running.
        </p>
        {/* No session came back from the reset, and that is the point: signing
            in with the password just chosen is the step that proves it took. */}
        <a
          href="/login"
          className="mt-5 block rounded-xl bg-open px-4 py-2.5 text-center text-sm font-semibold text-ink transition-opacity hover:opacity-90"
        >
          Sign in
        </a>
      </AuthCard>
    )
  }

  return (
    <AuthCard>
      <h1 className="text-lg font-bold tracking-[-0.02em]">Choose a new password</h1>
      <p className="mt-1.5 text-sm leading-relaxed text-muted">
        This signs out every device currently using the old one.
      </p>

      <form onSubmit={submit} className="mt-5 space-y-3">
        <label className="block">
          <span className={authField.label}>New password</span>
          <input
            type="password"
            autoComplete="new-password"
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
          {busy ? 'Working…' : 'Set new password'}
        </button>
      </form>

      {/* Links last an hour and work once, so this is the common failure and it
          needs a way forward that is not the browser Back button. */}
      <a
        href="/forgot"
        className="mt-4 block text-center text-xs text-muted transition-colors hover:text-bright"
      >
        Link expired? Ask for another
      </a>
    </AuthCard>
  )
}
