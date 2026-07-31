import { useState, type FormEvent } from 'react'
import { api, ApiError, type User } from '../lib/api'
import { authField } from './AuthCard'
import { useResendVerification, VERIFY_COST } from './VerifyBanner'

/**
 * The account itself: which address this is, whether it has been proved, and
 * the one thing a signed-in student can change about their credentials.
 *
 * It lives inside the app rather than at its own path because it needs a
 * session to mean anything, and a signed-out /account would only ever be a
 * redirect to /login. Reached from the sidebar, next to the address it is about.
 */
export default function AccountView({
  user,
  emailConfigured,
  mailEnabled,
}: {
  user: User
  /**
   * Whether this monitor has a provider that can send mail at all. Without one
   * an unconfirmed address costs nothing today, and saying otherwise would be
   * nagging a student about a channel the operator has not switched on.
   */
  emailConfigured: boolean
  /**
   * Whether a confirmation or reset link reaches a mailbox, as opposed to the
   * operator's log. Read separately from `emailConfigured` because they are two
   * facts about the server even where one setting happens to decide both, and
   * this is the one that decides whether "Sent" would be a lie.
   */
  mailEnabled: boolean
}) {
  return (
    <div className="px-5 py-6 md:px-9 md:py-8">
      <header className="mb-7">
        <h1 className="text-2xl font-bold tracking-[-0.02em]">Account</h1>
        <p className="mt-1.5 text-sm text-muted">
          A ClassPik account, and only that. We have never had your school login.
        </p>
      </header>

      <div className="max-w-[520px] space-y-5">
        <EmailPanel user={user} emailConfigured={emailConfigured} mailEnabled={mailEnabled} />
        <PasswordPanel />
      </div>
    </div>
  )
}

function EmailPanel({
  user,
  emailConfigured,
  mailEnabled,
}: {
  user: User
  emailConfigured: boolean
  mailEnabled: boolean
}) {
  const { state, detail, resend } = useResendVerification(mailEnabled)

  return (
    <section className="panel p-5">
      <h2 className="text-sm font-semibold">Email address</h2>
      <div className="mt-2.5 flex flex-wrap items-center gap-2.5">
        <span className="num min-w-0 break-all text-sm">{user.email}</span>
        <span
          className={`shrink-0 rounded-full border px-2.5 py-1 text-[11px] font-semibold ${
            user.emailVerified
              ? 'border-open/25 bg-open/12 text-open'
              : 'border-wait/25 bg-wait/10 text-wait'
          }`}
        >
          {user.emailVerified ? 'Confirmed' : 'Not confirmed'}
        </span>
      </div>

      {user.emailVerified ? (
        <p className="mt-3 text-xs leading-relaxed text-muted">
          Seat alerts can reach this address. ClassPik only ever sends to the address on the
          account, so there is nowhere else for a watch to point.
        </p>
      ) : (
        <>
          <p className="mt-3 text-xs leading-relaxed text-muted">
            {state === 'sent'
              ? detail || 'Sent. Open the link in that inbox; it lasts a day.'
              : state === 'throttled' || state === 'failed'
                ? detail
                : emailConfigured
                  ? VERIFY_COST
                  : 'This monitor has no mail provider configured, so nothing is sent by email ' +
                    'yet and confirming costs you nothing today. It is what email alerts will ' +
                    'wait on once one is.'}
          </p>
          {state !== 'sent' && (
            <button
              onClick={() => void resend()}
              disabled={state === 'sending'}
              className="mt-3 rounded-lg border border-line px-3 py-1.5 text-xs font-semibold transition-colors hover:border-white/25 disabled:opacity-50"
            >
              {state === 'sending' ? 'Sending…' : 'Send the link again'}
            </button>
          )}
        </>
      )}
    </section>
  )
}

/**
 * Changing the password from inside the app.
 *
 * The current password is asked for even though a session already got us here,
 * because the two prove different things: the session says this browser was
 * signed in at some point, the password says the account holder is at the
 * keyboard now. The monitor enforces that; this form only stops being surprising
 * about it.
 *
 * No rules are restated here. The monitor owns the minimum length, and a second
 * copy in this file is a number that drifts.
 */
function PasswordPanel() {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [revoked, setRevoked] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    setRevoked(null)
    try {
      const res = await api.changePassword(current, next)
      // Cleared rather than left sitting in the DOM, since the old one is now
      // worthless and the new one has no business staying on screen.
      setCurrent('')
      setNext('')
      setRevoked(res.sessionsRevoked)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="panel p-5">
      <h2 className="text-sm font-semibold">Change password</h2>
      <p className="mt-1.5 text-xs leading-relaxed text-muted">
        This browser stays signed in. Every other session is cut off, which is how a password
        somebody else has seen stops being their way in without waiting a month for the token to
        expire.
      </p>

      <form onSubmit={submit} className="mt-4 space-y-3">
        <label className="block">
          <span className={authField.label}>Current password</span>
          <input
            type="password"
            autoComplete="current-password"
            required
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            className={authField.input}
          />
        </label>

        <label className="block">
          <span className={authField.label}>New password</span>
          <input
            type="password"
            autoComplete="new-password"
            required
            value={next}
            onChange={(e) => setNext(e.target.value)}
            className={authField.input}
          />
        </label>

        {error && (
          <p className="rounded-xl border border-full/25 bg-full/8 px-3.5 py-2.5 text-sm text-full">
            {error}
          </p>
        )}

        {revoked !== null && (
          <p className="rounded-xl border border-open/25 bg-open/8 px-3.5 py-2.5 text-sm leading-relaxed">
            Password changed.{' '}
            <span className="text-muted">
              {revoked === 0 ? (
                'No other device was signed in.'
              ) : (
                <>
                  Signed out <span className="num">{revoked}</span> other{' '}
                  {revoked === 1 ? 'session' : 'sessions'}.
                </>
              )}
            </span>
          </p>
        )}

        <button type="submit" disabled={busy} className={authField.submit}>
          {busy ? 'Working…' : 'Change password'}
        </button>
      </form>

      {/* The way out for somebody who cannot answer the first field, which is
          the state this whole panel is unusable in. */}
      <a
        href="/forgot"
        className="mt-3.5 block text-xs text-muted transition-colors hover:text-bright"
      >
        Do not remember the current one? Email yourself a reset link
      </a>
    </section>
  )
}
