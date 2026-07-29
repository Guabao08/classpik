import { randomBytes } from 'node:crypto'

/**
 * Message assembly, pure and with no IO, for the same reason `diff.ts` is: these
 * are the rules that fail silently rather than loudly. A body line starting with
 * a dot truncates the message at that line. A course title carrying a stray CR
 * becomes a header the registrar wrote for us. A non-ASCII subject sent raw gets
 * the whole message rejected by some receivers and mojibaked by the rest.
 *
 * Nothing here knows about SMTP sockets or HTTP providers, so all of it is
 * testable by comparing strings.
 */

export const CRLF = '\r\n'

/** An encoded word may be 75 characters including its delimiters (RFC 2047). */
const ENCODED_WORD_LIMIT = 75
const ENCODED_WORD_OVERHEAD = '=?UTF-8?B??='.length
/** Base64 grows 3 bytes into 4 characters, so round the budget down to a group. */
const ENCODED_WORD_BASE64 = Math.floor((ENCODED_WORD_LIMIT - ENCODED_WORD_OVERHEAD) / 4) * 4
const ENCODED_WORD_BYTES = (ENCODED_WORD_BASE64 / 4) * 3

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export interface MailMessage {
  /** May carry a display name: `ClassPik <alerts@classpik.app>`. */
  from: string
  to: string
  subject: string
  text: string
  html: string
  /** Epoch millis for the `Date` header. */
  date: number
  /** Including the angle brackets. */
  messageId: string
  replyTo?: string | null
  /** Extra headers, encoded and injection-checked like every other one. */
  headers?: Record<string, string>
  /** Injectable so a test can assert against a fixed multipart boundary. */
  boundary?: string
}

/**
 * Every terminator in a mail message is CRLF, and every JS template literal
 * gives LF. One pass over all three forms, so a CRLF is never turned into
 * CRCRLF by converting twice.
 */
export function normalizeEol(text: string): string {
  return text.replace(/\r\n|\r|\n/g, CRLF)
}

/**
 * RFC 5321 section 4.5.2. DATA ends at a line containing only a dot, so a body
 * line that begins with one has to be doubled and the receiver strips it back.
 * Skipping this does not throw anywhere: it silently truncates the message at
 * the offending line, or eats one character from it.
 *
 * Must run after `normalizeEol`, or a lone CR hides the start of a line.
 */
export function dotStuff(body: string): string {
  const stuffed = body.replace(/\r\n\./g, `${CRLF}..`)
  return stuffed.startsWith('.') ? `.${stuffed}` : stuffed
}

/** CR and LF are rejected rather than escaped: there is no legitimate reason for
 * one to be in a header, and a course title comes from a registrar, which is
 * upstream data we do not control. */
export function assertHeaderSafe(name: string, value: string): void {
  if (/[\r\n]/.test(value)) {
    throw new Error(`header "${name}" contains a line break`)
  }
}

/**
 * Deliberately narrow. Every RFC 5322 address regex in circulation is wrong in
 * one direction or the other, so this rejects only what is unambiguously
 * unusable as an SMTP path and leaves the relay to be the authority on the rest.
 */
export function assertMailbox(addr: string): void {
  if (addr === '') throw new Error('email address is empty')
  if (/[\r\n]/.test(addr)) throw new Error('email address contains a line break')
  if (/[\s<>,;"\\]/.test(addr)) {
    throw new Error(`email address contains a character an SMTP path cannot carry: ${addr}`)
  }
  const at = addr.indexOf('@')
  if (at <= 0 || at !== addr.lastIndexOf('@') || at === addr.length - 1) {
    throw new Error(`not a usable email address: ${addr}`)
  }
  const domain = addr.slice(at + 1)
  if (domain.startsWith('.') || domain.endsWith('.') || domain.includes('..')) {
    throw new Error(`email address has an unusable domain: ${addr}`)
  }
}

const WITH_DISPLAY_NAME = /^(.*?)<([^<>]*)>$/

/** The bare mailbox out of either `a@b` or `Name <a@b>`, for the SMTP envelope. */
export function mailboxOf(input: string): string {
  const trimmed = input.trim()
  const m = WITH_DISPLAY_NAME.exec(trimmed)
  const addr = (m ? m[2]! : trimmed).trim()
  assertMailbox(addr)
  return addr
}

/** Header-ready form of an address, with the display name encoded or quoted. */
export function formatAddress(input: string): string {
  const trimmed = input.trim()
  const m = WITH_DISPLAY_NAME.exec(trimmed)
  if (!m) {
    assertMailbox(trimmed)
    return trimmed
  }
  const addr = m[2]!.trim()
  assertMailbox(addr)
  const name = m[1]!.trim().replace(/^"(.*)"$/s, '$1')
  return name === '' ? `<${addr}>` : `${encodeDisplayName(name)} <${addr}>`
}

/**
 * RFC 2047 encoded words for anything a header cannot carry literally. Two
 * constraints do the real work here: a word may not exceed 75 characters
 * including its delimiters, and a multi-byte UTF-8 sequence may never be split
 * across two words, because each word is decoded independently.
 */
export function encodeHeaderValue(value: string): string {
  if (isPrintableAscii(value)) return value

  const words: string[] = []
  let chunk: Buffer[] = []
  let size = 0

  const flush = (): void => {
    if (size === 0) return
    words.push(`=?UTF-8?B?${Buffer.concat(chunk).toString('base64')}?=`)
    chunk = []
    size = 0
  }

  // Iterating the string yields whole code points, so a surrogate pair stays
  // together and no chunk ever ends mid-character.
  for (const ch of value) {
    const bytes = Buffer.from(ch, 'utf8')
    if (size + bytes.length > ENCODED_WORD_BYTES) flush()
    chunk.push(bytes)
    size += bytes.length
  }
  flush()

  // Folding: CRLF plus a space is the continuation, and a receiver drops the
  // whitespace between two adjacent encoded words when it reassembles them.
  return words.join(`${CRLF} `)
}

/**
 * RFC 5322 section 3.3. Built from fixed English tables rather than
 * `toUTCString`, which emits the obsolete `GMT` zone, or anything
 * locale-sensitive, which produces a rejected header on a non-English host.
 */
export function formatDate(at: number): string {
  const d = new Date(at)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return (
    `${DAYS[d.getUTCDay()]}, ${pad(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} +0000`
  )
}

/**
 * The boundary must not occur in either part. Base64 bodies use only
 * `A-Za-z0-9+/=`, so a token containing an underscore cannot collide by
 * construction rather than by luck.
 */
export function mimeBoundary(rand: (n: number) => Buffer = randomBytes): string {
  return `=_cp_${rand(12).toString('hex')}`
}

/**
 * Base64 at 76 columns. Chosen over quoted-printable because it makes the
 * 998-octet line limit, 8-bit characters, and trailing whitespace all
 * impossible at once, and nobody reads raw source of a transactional alert.
 */
export function wrapBase64(text: string, columns = 76): string {
  const b64 = Buffer.from(normalizeEol(text), 'utf8').toString('base64')
  const lines: string[] = []
  for (let i = 0; i < b64.length; i += columns) lines.push(b64.slice(i, i + columns))
  return lines.join(CRLF)
}

/**
 * A complete RFC 5322 message, CRLF terminated, ready to hand to DATA once it
 * has been dot-stuffed.
 *
 * `multipart/alternative`, not `mixed`, and text before HTML: RFC 2046 section
 * 5.1.4 says a client renders the last part it understands, so the richer one
 * goes last.
 */
export function buildMessage(m: MailMessage): string {
  const boundary = m.boundary ?? mimeBoundary()

  const raw: Array<[string, string]> = [
    ['From', m.from],
    ['To', m.to],
  ]
  if (m.replyTo) raw.push(['Reply-To', m.replyTo])
  raw.push(['Subject', m.subject])
  for (const [name, value] of Object.entries(m.headers ?? {})) raw.push([name, value])

  // Injection is checked on the raw values, before encoding. Checking after
  // would pass, since base64 hides a CR rather than removing it, and the
  // receiver would decode a subject with a line break back out of it.
  for (const [name, value] of raw) assertHeaderSafe(name, value)

  const lines = [
    `From: ${formatAddress(m.from)}`,
    `To: ${formatAddress(m.to)}`,
    ...(m.replyTo ? [`Reply-To: ${formatAddress(m.replyTo)}`] : []),
    `Subject: ${encodeHeaderValue(m.subject)}`,
    `Date: ${formatDate(m.date)}`,
    `Message-ID: ${m.messageId}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    // RFC 3834. Without it a student's out-of-office responder answers every
    // seat alert, and those replies land wherever Reply-To points.
    'Auto-Submitted: auto-generated',
    ...Object.entries(m.headers ?? {}).map(([name, value]) => `${name}: ${encodeHeaderValue(value)}`),
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrapBase64(m.text),
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrapBase64(m.html),
    `--${boundary}--`,
    '',
  ]

  return lines.join(CRLF)
}

function encodeDisplayName(name: string): string {
  if (!isPrintableAscii(name)) return encodeHeaderValue(name)
  // RFC 5322 section 3.2.3 specials. Unquoted, "Registrar, ClassPik" parses as
  // two addresses and the message goes somewhere nobody intended.
  if (/[()<>@,;:\\".[\]]/.test(name)) return `"${name.replace(/(["\\])/g, '\\$1')}"`
  return name
}

function isPrintableAscii(value: string): boolean {
  return /^[\x20-\x7e]*$/.test(value)
}
