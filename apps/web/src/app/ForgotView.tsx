import { useEffect, useState, type FormEvent } from 'react'
import { api, ApiError } from '../lib/api'
import { AuthCard, authField } from './AuthCard'

/**
 * Ask for a reset link.
 *
 * Its own path rather than a mode of /reset, because /reset is where the emailed
 * link lands and that link always carries a token. One path serving both meant
 * the address bar could not tell you which of the two screens you were looking
 * at, and a student who opened an expired link got a form for a different job at
 * the same URL.
 *
 * The monitor answers this identically whether or not the address has an
 * account: same status, same body, same latency, on purpose. So this screen
 * shows one outcome and never goes looking for a second. Anything here that
 * distinguished "we sent it" from "no such account" would hand back the
 * enumeration oracle the server went to real trouble not to be.
 *
 * The monitor also owns the password rules, so nothing here repeats them.
 *
 * The one thing this screen does ask the monitor is whether it can send mail at
 * all. That is not about the address and so it is not an oracle: it is the same
 * answer for every visitor. Without it this screen said "Check your email" to a
 * student whose link was printed into a server log, and somebody who cannot sign
 * in and never gets a link creates a second account, which strands every watch
 * on the first one.
 */
export default function ForgotView() {
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // null until we know. Assuming mail works would put the wrong copy on screen
  // for the instant before the answer arrives, and this is the copy that decides
  // whether a student sits waiting for something that is not coming.
  const [mailEnabled, setMailEnabled] = useState<boolean | null>(null)

  useEffect(() => {
    let live = true
    void api
      .stats()
      .then((s) => {
        if (live) setMailEnabled(s.accountMail)
      })
      // A monitor we cannot reach is reported by the submit below, which is the
      // moment it matters. Failing here would only add a second way to say it.
      .catch(() => {})
    return () => {
      live = false
    }
  }, [])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const res = await api.requestPasswordReset(email)
      setSent(res.message)
    } catch (err) {
      // Only transport and rate limiting can land here. A refusal about the
      // address itself is the one thing this endpoint will not say.
      setError(err instanceof ApiError ? err.message : 'Something went wrong')
    } finally {
      setBusy(false)
    }
  }

  if (sent !== null) {
    return (
      <AuthCard>
        <h1 className="text-lg font-bold tracking-[-0.02em]">
          {mailEnabled === false ? 'This ClassPik cannot send email' : 'Check your email'}
        </h1>
        <p className="mt-1.5 text-sm leading-relaxed text-muted">
          {mailEnabled === false
            ? 'No mail provider is configured here, so no reset link was sent to any address. ' +
              'The monitor prints those links to its own log instead. Ask whoever runs this ' +
              'instance for it.'
            : sent}
        </p>
        <p className="mt-4 text-xs leading-relaxed text-muted">
          {mailEnabled === false
            ? 'Nothing about your account has changed, so your current password still works. ' +
              'Sending is the only part that is missing here.'
            : 'The link works once and expires in an hour. Nothing about your account has changed ' +
              'until you open it, so your current password still works in the meantime.'}
        </p>
        <a
          href="/login"
          className="mt-5 block rounded-xl border border-line px-4 py-2.5 text-center text-sm font-semibold transition-colors hover:border-white/25"
        >
          Back to sign in
        </a>
      </AuthCard>
    )
  }

  return (
    <AuthCard>
      <h1 className="text-lg font-bold tracking-[-0.02em]">Reset your password</h1>
      <p className="mt-1.5 text-sm leading-relaxed text-muted">
        Your ClassPik password, not your school login. We never had that one.
      </p>

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

        {error && (
          <p className="rounded-xl border border-full/25 bg-full/8 px-3.5 py-2.5 text-sm text-full">
            {error}
          </p>
        )}

        <button type="submit" disabled={busy} className={authField.submit}>
          {busy ? 'Working…' : 'Send me a link'}
        </button>
      </form>

      {/* Both ways out, because a forgotten password is very often a forgotten
          account: a second signup leaves every watch on the first one running
          somewhere the student will never look at again. */}
      <a
        href="/login"
        className="mt-4 block text-center text-xs text-muted transition-colors hover:text-bright"
      >
        Remembered it? Sign in
      </a>

      <a
        href="/signup"
        className="mt-2 block text-center text-xs text-muted transition-colors hover:text-bright"
      >
        No account yet? Create one
      </a>
    </AuthCard>
  )
}
