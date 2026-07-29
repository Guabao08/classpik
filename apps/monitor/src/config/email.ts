import { mailboxOf } from '../core/mime.js'
import { ResendTransport } from '../core/email.js'
import { SmtpTransport } from '../core/smtp.js'
import type { Transport } from '../core/notify.js'

/**
 * Email delivery is opt-in through the environment.
 *
 * Two rules shape this file. With nothing set the service starts normally and
 * simply does not offer the channel, because a monitor that refuses to boot
 * without a mail provider is a monitor nobody can try. But once an operator has
 * asked for email, a half-finished configuration is a loud error rather than a
 * quiet fallback: silently not sending is the failure this whole service exists
 * to prevent.
 *
 * Credentials come from the environment only. They are ClassPik's own service
 * credentials, never a school login, and nothing here is reachable from
 * `src/adapters` or from a `schools/*.yaml`.
 */

export interface EmailSetup {
  provider: 'resend' | 'smtp'
  transport: Transport
  /** For a log line at startup, safe to print. */
  detail: string
}

export function emailFromEnv(env: NodeJS.ProcessEnv = process.env): EmailSetup | null {
  const provider = (env.CLASSPIK_EMAIL_PROVIDER ?? '').trim().toLowerCase()
  if (provider === '') return null

  if (provider !== 'resend' && provider !== 'smtp') {
    throw new Error(
      `CLASSPIK_EMAIL_PROVIDER must be "resend" or "smtp", got ${JSON.stringify(provider)}`
    )
  }

  const from = demand(env, 'CLASSPIK_EMAIL_FROM')
  const replyTo = optional(env, 'CLASSPIK_EMAIL_REPLY_TO')

  // Parsed here so a typo in the From address stops startup, rather than
  // surfacing as a failed delivery weeks later when a seat finally opens.
  try {
    mailboxOf(from)
    if (replyTo) mailboxOf(replyTo)
  } catch (err) {
    throw new Error(`CLASSPIK_EMAIL_FROM is not usable: ${err instanceof Error ? err.message : err}`)
  }

  if (provider === 'resend') {
    return {
      provider,
      transport: new ResendTransport({ apiKey: demand(env, 'RESEND_API_KEY'), from, replyTo }),
      detail: `resend as ${from}`,
    }
  }

  const host = demand(env, 'CLASSPIK_SMTP_HOST')
  // Implicit TLS by default, per RFC 8314: it has no plaintext phase and so no
  // downgrade window, and it is the simpler of the two paths to get right.
  const starttls = truthy(env.CLASSPIK_SMTP_STARTTLS)
  const port = Number(env.CLASSPIK_SMTP_PORT ?? (starttls ? 587 : 465))
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`CLASSPIK_SMTP_PORT is not a port number: ${env.CLASSPIK_SMTP_PORT}`)
  }

  const user = optional(env, 'CLASSPIK_SMTP_USER')
  const pass = optional(env, 'CLASSPIK_SMTP_PASS')
  // One without the other is always a mistake, and the mistake is invisible:
  // the connection succeeds and the relay refuses every message.
  if ((user === null) !== (pass === null)) {
    throw new Error('CLASSPIK_SMTP_USER and CLASSPIK_SMTP_PASS must be set together')
  }

  return {
    provider,
    transport: new SmtpTransport({
      host,
      port,
      secure: !starttls,
      user,
      pass,
      from,
      replyTo,
    }),
    detail: `smtp ${host}:${port} ${starttls ? 'starttls' : 'implicit tls'} as ${from}`,
  }
}

function demand(env: NodeJS.ProcessEnv, name: string): string {
  const value = optional(env, name)
  if (value === null) {
    throw new Error(`${name} is required when CLASSPIK_EMAIL_PROVIDER is set`)
  }
  return value
}

function optional(env: NodeJS.ProcessEnv, name: string): string | null {
  const value = (env[name] ?? '').trim()
  return value === '' ? null : value
}

function truthy(value: string | undefined): boolean {
  const v = (value ?? '').trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes'
}
