/**
 * What to say after asking the monitor for another verification link.
 *
 * Pure, and in `lib` rather than beside the component, for one reason: this is
 * the part that was wrong, and a React component is not something this repo can
 * test. `apps/web` has no test runner and adding one would be a pile of new
 * dependencies for a three-branch decision, so the decision moved somewhere a
 * plain function can check it. The component below it only renders the result.
 *
 * The bug this replaces: `POST /api/auth/verify/request` answers
 * `{ok, verified, sent}` and the monitor goes to real trouble to make `sent`
 * honest. It is false when the per-account budget is spent, false when no mail
 * provider is configured, and false when the provider refused the message. The
 * banner read only `verified` and reported "Sent" for every one of those, which
 * sent a student to watch an inbox nothing was ever going to arrive in.
 */

export type ResendState = 'idle' | 'sending' | 'sent' | 'throttled' | 'failed'

export interface ResendOutcome {
  state: ResendState
  detail: string
}

/**
 * `mailEnabled` is `accountMail` from `GET /api/stats`, and it is what separates
 * the two reasons nothing was sent. Both are honest answers and they need
 * different ones: a spent budget is the student's own repeated clicking and time
 * fixes it, while an unconfigured provider is the operator's and no amount of
 * waiting fixes it.
 */
export function resendOutcome(
  res: { verified: boolean; sent: boolean },
  mailEnabled: boolean
): ResendOutcome {
  // Not a failure and not a send: the link was opened on a phone while this tab
  // still showed the button. Saying so is more useful than reporting either.
  if (res.verified) {
    return { state: 'sent', detail: 'That address is already confirmed. Reload to clear this.' }
  }

  if (!res.sent) {
    return {
      state: 'throttled',
      detail: mailEnabled
        ? 'Nothing was sent: too many links have been asked for in the last hour. ' +
          'Check that inbox for one that already arrived, then try again later.'
        : 'Nothing was sent: this ClassPik has no mail provider configured, so links are ' +
          'printed in the monitor log instead. Ask whoever runs it.',
    }
  }

  return { state: 'sent', detail: '' }
}
