import { useEffect, useRef, useState } from 'react'
import { api, ApiError } from '../lib/api'
import { AuthCard } from './AuthCard'

/**
 * Where a confirmation link lands.
 *
 * No form and no button: the link in the mail is the entire credential, and
 * asking somebody to press "confirm" after they already pressed "confirm" in
 * their inbox is a step that only exists to make the screen look busy.
 *
 * Deliberately reachable signed out. The mailbox is very often on a different
 * device from the one that signed up, and a confirmation screen that demands a
 * sign-in first is asking for the thing this account cannot do yet.
 */
export default function VerifyView({ token }: { token: string | null }) {
  const [state, setState] = useState<'working' | 'done' | 'failed'>('working')
  const [message, setMessage] = useState('')
  /**
   * Which token has already been spent by this mount.
   *
   * The effect below is the rare one that must run exactly once, because the
   * request inside it consumes a single-use credential. React deliberately runs
   * effects twice in development, and this screen showed "that link did not
   * work" every single time as a result: the first call confirmed the address
   * and the second was told, correctly, that the token was already used. The
   * second answer is the one that reached the screen.
   *
   * A cleanup flag does not fix that. It suppresses the FIRST call's result,
   * which is the one that succeeded, so it makes the wrong answer the only
   * answer. Remembering the token is what actually stops the second request.
   */
  const spent = useRef<string | null>(null)

  useEffect(() => {
    if (token === null) {
      setState('failed')
      setMessage('That link is missing its token. Open the one in the email rather than typing it.')
      return
    }
    if (spent.current === token) return
    spent.current = token
    api
      .verifyEmail(token)
      .then((res) => {
        setState('done')
        setMessage(res.email)
      })
      .catch((err) => {
        setState('failed')
        setMessage(err instanceof ApiError ? err.message : 'Something went wrong')
      })
  }, [token])

  return (
    <AuthCard>
      {state === 'working' && (
        <>
          <h1 className="text-lg font-bold tracking-[-0.02em]">Confirming…</h1>
          <p className="mt-1.5 text-sm leading-relaxed text-ink-soft">One moment.</p>
        </>
      )}

      {state === 'done' && (
        <>
          <h1 className="text-lg font-bold tracking-[-0.02em]">Address confirmed</h1>
          <p className="mt-1.5 text-sm leading-relaxed text-ink-soft">
            ClassPik can now email <span className="num">{message}</span> when a seat opens.
          </p>
          <a
            href="/app"
            className="mt-5 block  bg-ink px-4 py-2.5 text-center text-sm font-medium text-paper transition-opacity hover:opacity-90"
          >
            Go to your watchlist
          </a>
        </>
      )}

      {state === 'failed' && (
        <>
          <h1 className="text-lg font-bold tracking-[-0.02em]">That link did not work</h1>
          <p className="mt-1.5 text-sm leading-relaxed text-ink-soft">{message}</p>
          <p className="mt-4 text-xs leading-relaxed text-ink-soft">
            Links last a day and work once. Sign in and ask for a new one from your watchlist.
          </p>
          <a
            href="/login"
            className="mt-5 block  border border-rule px-4 py-2.5 text-center text-sm font-semibold transition-colors hover:border-ink/25"
          >
            Sign in
          </a>
        </>
      )}
    </AuthCard>
  )
}
