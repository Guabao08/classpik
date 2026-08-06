import { useCallback, useState } from 'react'
import { api, ApiError } from '../lib/api'
import { resendOutcome, type ResendState } from '../lib/resend'

export type { ResendState }

/**
 * Asking for the confirmation link again, held in one place because two screens
 * offer it: the banner across the top of the app, and the account screen.
 *
 * The decision about what to say lives in `lib/resend.ts`, where it can be
 * tested. The interesting cases are both there: `verified` coming back true,
 * which happens when the link was opened on a phone while this tab still showed
 * the button, and `sent` coming back false, which is the monitor telling us
 * plainly that nothing went out.
 */
export function useResendVerification(mailEnabled: boolean): {
  state: ResendState
  detail: string
  resend: () => Promise<void>
} {
  const [state, setState] = useState<ResendState>('idle')
  const [detail, setDetail] = useState('')

  const resend = useCallback(async () => {
    if (state === 'sending') return
    setState('sending')
    try {
      const outcome = resendOutcome(await api.requestVerification(), mailEnabled)
      setState(outcome.state)
      setDetail(outcome.detail)
    } catch (err) {
      setState('failed')
      setDetail(err instanceof ApiError ? err.message : 'Could not send the link')
    }
  }, [state, mailEnabled])

  return { state, detail, resend }
}

/** What an unconfirmed address costs, in one sentence, wherever it is said. */
export const VERIFY_COST =
  'Everything else already works: search, watches, and every alert inside the app. ' +
  'Only email alerts wait on this. We send to an address somebody has opened a link at, ' +
  'so nobody can point ClassPik at a stranger.'

/**
 * Why the Email toggle is not offered, and the one button that changes it.
 *
 * Shown rather than hidden, and shown as a nudge rather than as an error: the
 * account works, the watches work, and the in-app alerts work. What does not
 * work is the channel that reaches a mailbox nobody has proved they read. A
 * greyed-out toggle with no explanation is how a student concludes the feature
 * is broken.
 */
export default function VerifyBanner({
  email,
  mailEnabled,
}: {
  email: string
  /** `accountMail` from the monitor. See `resendOutcome` for what it changes. */
  mailEnabled: boolean
}) {
  const { state, detail, resend } = useResendVerification(mailEnabled)

  return (
    <div className="border-b border-wait/25 bg-wait/8 px-5 py-3.5 md:px-9">
      <p className="text-sm font-semibold">Confirm {email} to get alerts by email</p>
      <p className="mt-1 text-xs leading-relaxed text-ink-soft">
        {state === 'sent'
          ? detail || 'Sent. Open the link in that inbox; it lasts a day.'
          : state === 'throttled' || state === 'failed'
            ? detail
            : VERIFY_COST}
      </p>
      {/* Still offered after a throttled or failed attempt, because in both of
          those the useful next move is to try this again later. Only a real
          send takes the button away. */}
      {state !== 'sent' && (
        <button
          onClick={() => void resend()}
          disabled={state === 'sending'}
          className="mt-2.5  border border-rule px-3 py-1.5 text-xs font-semibold transition-colors hover:border-ink/25 disabled:opacity-50"
        >
          {state === 'sending' ? 'Sending…' : 'Send the link again'}
        </button>
      )}
    </div>
  )
}
