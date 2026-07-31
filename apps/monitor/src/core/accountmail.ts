import { randomUUID } from 'node:crypto'
import { mailboxOf, type MailMessage } from './mime.js'
import type { EmailIdentity } from './email.js'

/**
 * The two account emails: prove this address, and take this account back.
 *
 * Separate from `email.ts`, which composes the seat alert, because these are a
 * different kind of message with a different failure mode. An alert that does
 * not arrive costs a seat. One of these that does not arrive costs the account,
 * and the person cannot work around it, so the link is the entire content and
 * everything else on the page is subordinate to it.
 *
 * Nothing here touches the database or decides policy. It renders a link into a
 * message and hands it to whatever can send one, so the tests read strings.
 */

/**
 * Anything that can put a composed message on the wire.
 *
 * Narrower than `Transport`, which speaks in `NotificationPayload` because it
 * exists to deliver seat alerts. Both shipped transports implement this too, so
 * account mail travels the same configured relay or provider as the alerts do
 * rather than growing a second mail path with its own credentials.
 */
export interface AccountMailer {
  sendMail(message: MailMessage, idempotencyKey: string): Promise<void>
}

/** Present only when an operator configured a provider. Absent is a real state. */
export interface AccountMailDelivery {
  mailer: AccountMailer
  identity: EmailIdentity
}

export interface AccountMailOptions {
  /** Where the web app lives, which is what the link in the message points at. */
  appUrl: string
  delivery?: AccountMailDelivery | null
  /**
   * Used only when there is no delivery configured, and then it carries the
   * link itself. See `send` for why that is deliberate and what it costs.
   */
  log?: (msg: string, meta?: Record<string, unknown>) => void
  now?: () => number
  /** Injectable so a test can pin the Message-ID. */
  messageId?: () => string
}

export type AccountMailKind = 'verify' | 'reset'

export class AccountMail {
  private readonly appUrl: string
  private readonly delivery: AccountMailDelivery | null
  private readonly log: (msg: string, meta?: Record<string, unknown>) => void
  private readonly now: () => number
  private readonly messageId: () => string

  constructor(opts: AccountMailOptions) {
    // Normalised once so `${appUrl}/verify` cannot become a double slash, which
    // some routers treat as a different path and some proxies reject outright.
    this.appUrl = opts.appUrl.replace(/\/+$/, '')
    this.delivery = opts.delivery ?? null
    this.log = opts.log ?? (() => {})
    this.now = opts.now ?? Date.now
    this.messageId = opts.messageId ?? (() => randomUUID())
  }

  /** Whether a message actually goes to a mailbox, as opposed to the log. */
  get enabled(): boolean {
    return this.delivery !== null
  }

  /**
   * The URL a student opens. The token rides in the query string because the
   * web app has to read it out of the address bar and hand it back to the API,
   * and a fragment is invisible to anything that is not JavaScript.
   */
  linkFor(kind: AccountMailKind, token: string): string {
    return `${this.appUrl}/${kind}?token=${encodeURIComponent(token)}`
  }

  /**
   * Send one, or log the link if nothing is configured to send it.
   *
   * The fallback is what keeps the service usable with no mail provider: signup
   * must not fail because an operator has not signed up to Resend yet, and a
   * verification step nobody can complete is worse than none. In that mode this
   * process IS the mail transport and its console is the inbox, which is stated
   * in the README and printed at startup, because a link in a log is a link
   * anyone reading the log can use.
   *
   * With a provider configured the token never reaches the log, on any path,
   * including the failure path: the error is reported without the message.
   */
  async send(kind: AccountMailKind, to: string, token: string): Promise<void> {
    const link = this.linkFor(kind, token)
    if (this.delivery === null) {
      this.log(`no email provider is configured, so the ${label(kind)} link is printed here`, {
        to,
        link,
        hint: 'set CLASSPIK_EMAIL_PROVIDER to mail these instead of logging them',
      })
      return
    }

    const message = compose(kind, to, link, this.delivery.identity, {
      at: this.now(),
      messageId: `<${this.messageId()}@${domainOf(this.delivery.identity.from)}>`,
    })
    // The key is the message id rather than anything derived from the token,
    // because a provider echoes an idempotency key back in its own logs and
    // support tooling, and the token is the one string that must not travel.
    await this.delivery.mailer.sendMail(message, message.messageId)
  }
}

function label(kind: AccountMailKind): string {
  return kind === 'verify' ? 'address verification' : 'password reset'
}

function domainOf(from: string): string {
  return mailboxOf(from).split('@')[1]!
}

/**
 * Composition, kept pure and exported so the copy is testable without a socket.
 *
 * Two rules shape both messages. Say what will happen if the reader ignores
 * this, because that is the question a stranger who did not ask for it is
 * actually asking. And never carry anything about the account beyond the
 * address the message is already going to: these are the mails a mistyped
 * signup sends to a bystander.
 */
export function compose(
  kind: AccountMailKind,
  to: string,
  link: string,
  identity: EmailIdentity,
  meta: { at: number; messageId: string; boundary?: string }
): MailMessage {
  const copy = kind === 'verify' ? verifyCopy(link) : resetCopy(link)
  return {
    from: identity.from,
    to,
    replyTo: identity.replyTo ?? null,
    subject: copy.subject,
    text: copy.text,
    html: copy.html,
    date: meta.at,
    messageId: meta.messageId,
    boundary: meta.boundary,
  }
}

function verifyCopy(link: string): { subject: string; text: string; html: string } {
  const subject = 'Confirm your ClassPik email address'
  const lead =
    'Confirm this address so ClassPik can email you when a seat opens. The link works for 24 hours.'
  const tail =
    'If you did not create a ClassPik account, ignore this. Nothing will be sent to this ' +
    'address again, and the account cannot email you until somebody opens the link above.'
  return {
    subject,
    text: body(subject, lead, link, tail),
    html: htmlBody(subject, lead, link, 'Confirm this address', tail),
  }
}

function resetCopy(link: string): { subject: string; text: string; html: string } {
  const subject = 'Reset your ClassPik password'
  const lead =
    'Open this link to choose a new password. It works once, and it expires in one hour.'
  const tail =
    'If you did not ask for this, ignore it. Your password has not changed and nobody can ' +
    'change it without this link. Every other link like it stops working the moment one is used.'
  return {
    subject,
    text: body(subject, lead, link, tail),
    html: htmlBody(subject, lead, link, 'Choose a new password', tail),
  }
}

function body(subject: string, lead: string, link: string, tail: string): string {
  // The bare URL on its own line, because a mail client that does not linkify
  // still leaves something a person can select, and a line-wrapped link is one
  // a person cannot.
  return [subject, '', lead, '', link, '', tail].join('\n')
}

function htmlBody(
  subject: string,
  lead: string,
  link: string,
  action: string,
  tail: string
): string {
  // Same inline-style, table-free shape as the alert, and for the same reason:
  // mail clients strip style blocks. The URL is repeated as text under the
  // button, because a button is not something a suspicious reader can inspect
  // and this is exactly the message a phishing-aware student should inspect.
  const safeLink = escapeAttribute(link)
  return [
    '<!doctype html>',
    '<html lang="en"><body style="margin:0;padding:24px;background:#f3f4f6;',
    'font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif">',
    '<div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;padding:24px">',
    `<h1 style="margin:0 0 8px;font-size:20px;line-height:1.3;color:#111827">${escapeHtml(subject)}</h1>`,
    `<p style="margin:0 0 20px;font-size:15px;line-height:1.5;color:#374151">${escapeHtml(lead)}</p>`,
    `<p style="margin:0 0 20px"><a href="${safeLink}" `,
    'style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;',
    `border-radius:8px;padding:10px 18px;font-size:15px;font-weight:600">${escapeHtml(action)}</a></p>`,
    '<p style="margin:0 0 20px;font-size:12px;line-height:1.5;color:#6b7280;word-break:break-all">',
    `${escapeHtml(link)}</p>`,
    '<hr style="border:none;border-top:1px solid #e5e7eb;margin:20px 0 12px">',
    `<p style="margin:0;font-size:12px;line-height:1.5;color:#6b7280">${escapeHtml(tail)}</p>`,
    '</div></body></html>',
  ].join('')
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** An href sits inside quotes, so a quote in the URL would end the attribute. */
function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/'/g, '&#39;')
}
