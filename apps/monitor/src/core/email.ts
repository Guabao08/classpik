import { assertHeaderSafe, mailboxOf, type MailMessage } from './mime.js'
import { PermanentDeliveryError, type NotificationPayload, type Transport } from './notify.js'
import type { SectionRow } from './repo.js'

/**
 * The alert email itself, and the HTTP provider transport that sends it.
 *
 * This is the product at the moment it matters. A student gets one of these
 * while they are in a lecture or asleep, reads the first six words on a lock
 * screen, and decides whether to open their laptop. So the subject carries the
 * whole decision, the first line of the body repeats it, and the details sit
 * underneath for the person who wants them.
 */

export interface EmailIdentity {
  /** RFC 5322 From, display name optional: `ClassPik alerts <alerts@classpik.app>`. */
  from: string
  replyTo?: string | null
}

/** Public so a test can point the transport at nothing that exists. */
export const RESEND_ENDPOINT = 'https://api.resend.com/emails'

export function composeAlertEmail(
  payload: NotificationPayload,
  to: string,
  identity: EmailIdentity,
  opts: { boundary?: string } = {}
): MailMessage {
  const facts = sectionFacts(payload.section)
  return {
    from: identity.from,
    to,
    replyTo: identity.replyTo ?? null,
    subject: payload.title,
    text: textBody(payload, facts),
    html: htmlBody(payload, facts),
    // The event's own timestamp, not the send time: it is when the seat
    // actually opened, and it keeps a retry byte-identical to the first try.
    date: payload.event.at,
    messageId: messageIdFor(payload, identity.from),
    boundary: opts.boundary,
  }
}

/**
 * Derived from the watch and the event rather than random, so a retry after a
 * lost response carries the id the first attempt used and a receiver holding
 * the first copy can drop the second. A duplicate alert is worse than a late
 * one: the student has already run for the seat, and the second message tells
 * them to run again.
 */
export function messageIdFor(payload: NotificationPayload, from: string): string {
  const domain = mailboxOf(from).split('@')[1]!
  return `<${payload.watchId}.${payload.event.id}@${domain}>`
}

export interface ResendOptions extends EmailIdentity {
  apiKey: string
  endpoint?: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

/**
 * Resend over plain HTTPS. No SDK and no dependency: it is one POST with a
 * bearer token, and `fetchImpl` is injectable exactly the way `WebhookTransport`
 * does it, so every branch below is testable with no network and no key.
 *
 * The provider signs DKIM, resolves MX, handles bounces and keeps the sending
 * IP warm, which is the entire argument for using one rather than talking to a
 * university's mail exchanger ourselves.
 */
export class ResendTransport implements Transport {
  readonly channel = 'email'

  private readonly apiKey: string
  private readonly endpoint: string
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number
  private readonly identity: EmailIdentity

  constructor(opts: ResendOptions) {
    this.apiKey = opts.apiKey
    this.endpoint = opts.endpoint ?? RESEND_ENDPOINT
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch
    this.timeoutMs = opts.timeoutMs ?? 15_000
    this.identity = { from: opts.from, replyTo: opts.replyTo ?? null }

    // Fail at boot on a malformed From rather than at the one moment a student
    // is waiting on a seat.
    mailboxOf(opts.from)
  }

  async send(payload: NotificationPayload, target: string | null): Promise<void> {
    const to = recipientOf(target)

    let message: MailMessage
    try {
      message = composeAlertEmail(payload, to, this.identity)
      // Resend builds the MIME itself, so the only composition rule that still
      // applies is the one that matters: a course title carrying a CR must not
      // become a header the registrar wrote for us.
      assertHeaderSafe('Subject', message.subject)
    } catch (err) {
      throw new PermanentDeliveryError(
        `could not compose the alert email: ${describe(err)}`,
        err
      )
    }

    // One controller and one timer for the whole exchange, headers and body.
    // Clearing the timer as soon as the headers arrived left `res.text()` below
    // running with the abort already disarmed, so a 502 whose chunked body then
    // stalled hung this send forever, and with it the flush loop and the whole
    // poller. A bad gateway is a likelier way to lose the service than a dead
    // relay is.
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)

    try {
      return await this.exchange(controller, message, `${payload.watchId}:${payload.event.id}`)
    } finally {
      clearTimeout(timer)
    }
  }

  private async exchange(
    controller: AbortController,
    message: MailMessage,
    idempotencyKey: string
  ): Promise<void> {
    let res: Response
    try {
      res = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          // Only the header names are ever interpolated into anything below.
          // The Dispatcher persists err.message into notifications.last_error,
          // so an error string built from this object would write the API key
          // to disk.
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          // The queue is already UNIQUE (watch_id, event_id), so this key means
          // a retry after a network timeout cannot double-send even when the
          // first request actually landed.
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({
          from: message.from,
          to: message.to,
          subject: message.subject,
          text: message.text,
          html: message.html,
          ...(message.replyTo ? { reply_to: message.replyTo } : {}),
          headers: { 'Auto-Submitted': 'auto-generated', 'Message-ID': message.messageId },
        }),
        signal: controller.signal,
      })
    } catch (err) {
      // An abort or a socket failure says nothing about the message, so it goes
      // back on the retry ladder.
      throw new Error(`Resend request failed: ${describe(err)}`)
    }

    if (res.ok) return

    const detail = await readDetail(res)
    const message2 = `Resend responded ${res.status}${detail ? `: ${detail}` : ''}`
    // Branching on the HTTP status, which Resend documents, rather than on a
    // body field name, which it does not.
    if (isPermanentStatus(res.status)) throw new PermanentDeliveryError(message2)
    throw new Error(message2)
  }
}

/**
 * 401 and 403 are our key, 422 is our from-domain or the recipient, 400 is a
 * body we built wrong. None of those change by waiting. 409 is an idempotency
 * race, 429 is a quota, 5xx is theirs, and all three do.
 */
function isPermanentStatus(status: number): boolean {
  if (status === 429 || status === 409) return false
  if (status >= 500) return false
  return status >= 400
}

/**
 * Defensive on purpose. Resend documents its status codes but not its error
 * body, and PoliteClient already learned the same lesson from Banner serving
 * HTML with a 200: read text, try JSON, fall back to a prefix of the raw body.
 */
async function readDetail(res: Response): Promise<string> {
  let text: string
  try {
    text = await res.text()
  } catch {
    return ''
  }
  if (text.trim() === '') return ''
  try {
    const parsed = JSON.parse(text) as { message?: unknown; name?: unknown }
    if (typeof parsed.message === 'string') {
      return typeof parsed.name === 'string' ? `${parsed.name}: ${parsed.message}` : parsed.message
    }
  } catch {
    // Not JSON. The raw prefix is more useful in a log than a parse error is.
  }
  return text.slice(0, 200).replace(/\s+/g, ' ').trim()
}

/**
 * Shared by both transports. A missing or unusable address is permanent by
 * definition: the same string comes back on every retry.
 */
export function recipientOf(target: string | null): string {
  if (!target) throw new PermanentDeliveryError('email transport requires a recipient address')
  try {
    return mailboxOf(target)
  } catch (err) {
    throw new PermanentDeliveryError(
      `cannot deliver to ${JSON.stringify(target)}: ${describe(err)}`,
      err
    )
  }
}

export function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ------------------------------------------------------------------- the copy

type Fact = [label: string, value: string]

function sectionFacts(s: SectionRow): Fact[] {
  const facts: Fact[] = [
    ['Course', `${s.code} ${s.section}`.trim()],
    ['Title', s.title],
    ['CRN', s.crn],
    ['Seats', `${s.seats} of ${s.capacity}`],
  ]
  if (s.waitlist_cap > 0) facts.push(['Waitlist', `${s.waitlist} of ${s.waitlist_cap}`])
  if (s.instructor) facts.push(['Instructor', s.instructor])
  const meets = [s.meeting_days, s.meeting_time].filter(Boolean).join(' ')
  if (meets) facts.push(['Meets', meets])
  if (s.campus) facts.push(['Campus', s.campus])
  facts.push(['Term', s.term])
  return facts
}

function textBody(payload: NotificationPayload, facts: Fact[]): string {
  const width = Math.max(...facts.map(([label]) => label.length))
  return [
    payload.title,
    '',
    payload.body,
    '',
    ...facts.map(([label, value]) => `${label.padEnd(width)}  ${value}`),
    '',
    'Register in your school\'s own system now. A seat that opens in a full',
    'section is usually gone within minutes, and ClassPik does not hold it',
    'for you.',
    '',
    '--',
    'You are getting this because you asked ClassPik to watch this section.',
    'Remove the watch in your ClassPik account and the alerts stop.',
  ].join('\n')
}

function htmlBody(payload: NotificationPayload, facts: Fact[]): string {
  const rows = facts
    .map(
      ([label, value]) =>
        `<tr><td style="padding:4px 16px 4px 0;color:#6b7280;white-space:nowrap">${escapeHtml(label)}</td>` +
        `<td style="padding:4px 0;color:#111827">${escapeHtml(value)}</td></tr>`
    )
    .join('')

  // Inline styles and a table for the facts, because mail clients strip style
  // blocks and have no reliable grid. Deliberately plain: an alert that renders
  // as text when images are blocked still does its whole job.
  return [
    '<!doctype html>',
    '<html lang="en"><body style="margin:0;padding:24px;background:#f3f4f6;',
    'font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif">',
    '<div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;padding:24px">',
    `<h1 style="margin:0 0 8px;font-size:20px;line-height:1.3;color:#111827">${escapeHtml(payload.title)}</h1>`,
    `<p style="margin:0 0 20px;font-size:15px;line-height:1.5;color:#374151">${escapeHtml(payload.body)}</p>`,
    `<table style="width:100%;border-collapse:collapse;font-size:14px">${rows}</table>`,
    '<p style="margin:20px 0 0;font-size:14px;line-height:1.5;color:#374151">',
    'Register in your school\'s own system now. A seat that opens in a full section is usually',
    ' gone within minutes, and ClassPik does not hold it for you.</p>',
    '<hr style="border:none;border-top:1px solid #e5e7eb;margin:20px 0 12px">',
    '<p style="margin:0;font-size:12px;line-height:1.5;color:#6b7280">',
    'You are getting this because you asked ClassPik to watch this section.',
    ' Remove the watch in your ClassPik account and the alerts stop.</p>',
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
