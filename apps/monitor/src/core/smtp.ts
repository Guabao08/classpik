import { connect as netConnect } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import type { Duplex } from 'node:stream'
import { hostname } from 'node:os'
import { buildMessage, CRLF, dotStuff, mailboxOf, type MailMessage } from './mime.js'
import { PermanentDeliveryError, type NotificationPayload, type Transport } from './notify.js'
import { composeAlertEmail, describe, recipientOf, type EmailIdentity } from './email.js'

/**
 * SMTP submission, hand rolled on node:net and node:tls.
 *
 * The distinction that makes this defensible is submission versus delivery.
 * Handing one small message to one known relay over one authenticated TLS
 * socket is a bounded state machine, and the relay owns DKIM signing, MX
 * resolution, bounce processing and IP reputation. Direct-to-MX delivery is a
 * product, not a module, and is deliberately not attempted here.
 *
 * We do not take nodemailer, which is a good library with genuinely no runtime
 * dependencies. Everything it earns its keep on (attachments, embedded images,
 * XOAUTH2, connection pooling, DSN, SMTPUTF8) is absent from what ClassPik
 * sends. The day any of those land, take the dependency rather than slowly
 * growing a worse nodemailer.
 */

export type ConnectFn = (opts: {
  host: string
  port: number
  secure: boolean
  timeoutMs: number
}) => Promise<Duplex>
export type UpgradeFn = (socket: Duplex, servername: string, timeoutMs: number) => Promise<Duplex>

export interface SmtpOptions extends EmailIdentity {
  host: string
  /** Defaults to 465, implicit TLS, per RFC 8314. */
  port?: number
  /** Implicit TLS from the first byte. False means a cleartext port plus STARTTLS. */
  secure?: boolean
  user?: string | null
  pass?: string | null
  /** The name we announce in EHLO. */
  ehloName?: string
  /** Ceiling on every step, the TCP connect and the TLS handshake included.
   * RFC 5321 allows minutes; a notification worker should not wait that long,
   * and a socket with no timeout is how the queue stalls. */
  timeoutMs?: number
  /**
   * Refuse to send anything over a socket nothing has encrypted. On by default.
   * Turning it off is for a local sink such as Mailpit and nothing else: with
   * it off, a relay that drops STARTTLS from its EHLO gets the student's
   * address and the course they are watching in cleartext on the wire.
   */
  requireTls?: boolean
  connect?: ConnectFn
  upgrade?: UpgradeFn
  boundary?: () => string
}

interface SmtpReply {
  code: number
  /** Reply text with the three-digit code and its separator stripped. */
  lines: string[]
  /** The raw reply, codes included, for an error message. */
  raw: string
}

interface Capabilities {
  keywords: Set<string>
  auth: Set<string>
  /** Zero when the server did not advertise SIZE. */
  maxSize: number
}

export class SmtpTransport implements Transport {
  readonly channel = 'email'

  private readonly host: string
  private readonly port: number
  private readonly secure: boolean
  private readonly user: string | null
  private readonly pass: string | null
  private readonly ehloName: string
  private readonly timeoutMs: number
  private readonly requireTls: boolean
  private readonly connectImpl: ConnectFn
  private readonly upgradeImpl: UpgradeFn
  private readonly identity: EmailIdentity
  private readonly boundary?: () => string

  constructor(opts: SmtpOptions) {
    this.host = opts.host
    this.secure = opts.secure ?? true
    this.port = opts.port ?? (this.secure ? 465 : 587)
    this.user = opts.user ?? null
    this.pass = opts.pass ?? null
    this.ehloName = opts.ehloName ?? hostname()
    this.timeoutMs = opts.timeoutMs ?? 20_000
    this.requireTls = opts.requireTls ?? true
    this.connectImpl = opts.connect ?? defaultConnect
    this.upgradeImpl = opts.upgrade ?? defaultUpgrade
    this.identity = { from: opts.from, replyTo: opts.replyTo ?? null }
    this.boundary = opts.boundary

    // A typo in the From address should stop the process at boot, not at the
    // one moment a student is waiting on a seat.
    mailboxOf(opts.from)
  }

  async send(payload: NotificationPayload, target: string | null): Promise<void> {
    const recipient = recipientOf(target)
    return this.sendMail(composeAlertEmail(payload, recipient, this.identity))
  }

  /**
   * Submit a message somebody else composed, which is how the account emails
   * (verify an address, reset a password) go out over the same relay as the
   * seat alerts rather than needing a second connection configured elsewhere.
   */
  async sendMail(message: MailMessage): Promise<void> {
    const envelopeFrom = mailboxOf(this.identity.from)

    let raw: string
    let recipient: string
    try {
      recipient = mailboxOf(message.to)
      // The injected boundary is a test affordance and applies to whatever this
      // transport sends, so it fills in here rather than at each call site.
      raw = buildMessage({ ...message, boundary: message.boundary ?? this.boundary?.() })
    } catch (err) {
      // Composition only fails on data we cannot make into a legal message, and
      // the next attempt would be handed exactly the same data.
      throw new PermanentDeliveryError(`could not compose the alert email: ${describe(err)}`, err)
    }

    const socket = await this.connectImpl({
      host: this.host,
      port: this.port,
      secure: this.secure,
      timeoutMs: this.timeoutMs,
    })
    const channel = new SmtpChannel(socket)
    try {
      await this.converse(channel, envelopeFrom, recipient, raw)
    } finally {
      await channel.hangUp(this.timeoutMs)
    }
  }

  private async converse(
    ch: SmtpChannel,
    envelopeFrom: string,
    recipient: string,
    raw: string
  ): Promise<void> {
    check(await ch.read(this.timeoutMs, 'the greeting'), [220], 'the greeting')

    let caps = await this.ehlo(ch)
    let encrypted = this.secure

    if (!encrypted && caps.keywords.has('STARTTLS')) {
      await this.command(ch, 'STARTTLS', [220], 'STARTTLS')
      await ch.upgrade(this.host, this.upgradeImpl, this.timeoutMs)
      // RFC 3207: both sides discard everything learned before TLS, so the
      // capability list has to be asked for again rather than reused.
      caps = await this.ehlo(ch)
      encrypted = true
    }

    // Before MAIL FROM, and independent of whether credentials are configured.
    // Opportunistic STARTTLS decides on a pre-TLS EHLO, which is a reply an
    // attacker on the path can rewrite, so a stripped `250-STARTTLS` line used
    // to mean the whole message went out in the clear: the student's address in
    // RCPT TO and in the To header, plus the course they are watching. Nothing
    // in the exchange would have said so.
    if (!encrypted && this.requireTls) {
      throw new PermanentDeliveryError(
        `refusing to talk to ${this.host}:${this.port} in the clear: the server offered no ` +
          'STARTTLS. Use the implicit-TLS submission port, or set CLASSPIK_SMTP_REQUIRE_TLS=0 ' +
          'if this really is a local sink'
      )
    }

    if (this.user !== null && this.pass !== null) {
      if (!encrypted) {
        throw new PermanentDeliveryError(
          `refusing to send SMTP credentials to ${this.host}:${this.port} in the clear: ` +
            'the server offered no STARTTLS, so use the implicit-TLS submission port instead'
        )
      }
      await this.authenticate(ch, caps)
    }

    const bytes = Buffer.byteLength(raw, 'utf8')
    if (caps.maxSize > 0 && bytes > caps.maxSize) {
      // Sending past an advertised SIZE earns a 552 mid-DATA with no useful
      // diagnosis attached, so refuse locally where we can say why.
      throw new PermanentDeliveryError(
        `message is ${bytes} bytes but ${this.host} advertised a ${caps.maxSize} byte limit`
      )
    }

    await this.command(ch, `MAIL FROM:<${envelopeFrom}>`, [250], `MAIL FROM:<${envelopeFrom}>`)
    // 251 means the relay will forward it on, which is still an accepted
    // recipient rather than something to retry.
    await this.command(ch, `RCPT TO:<${recipient}>`, [250, 251], `RCPT TO:<${recipient}>`)
    await this.command(ch, 'DATA', [354], 'DATA')

    ch.write(`${dotStuff(raw)}.${CRLF}`)
    check(await ch.read(this.timeoutMs, 'the message body'), [250], 'the message body')
  }

  private async ehlo(ch: SmtpChannel): Promise<Capabilities> {
    // No HELO fallback. Every relay that accepts submission has spoken ESMTP
    // for two decades, and a fallback path is one nobody would ever exercise.
    const reply = await this.command(ch, `EHLO ${this.ehloName}`, [250], 'EHLO')
    const keywords = new Set<string>()
    const auth = new Set<string>()
    let maxSize = 0

    // The first line is the server's own greeting text, not a capability.
    for (const line of reply.lines.slice(1)) {
      const parts = line.trim().split(/\s+/)
      const keyword = (parts[0] ?? '').toUpperCase()
      if (keyword === '') continue
      keywords.add(keyword)
      if (keyword === 'AUTH') for (const mech of parts.slice(1)) auth.add(mech.toUpperCase())
      if (keyword === 'SIZE' && parts[1]) maxSize = Number(parts[1]) || 0
    }
    return { keywords, auth, maxSize }
  }

  /**
   * Only mechanisms from the post-TLS EHLO are offered, and the command line is
   * never echoed into an error: the Dispatcher writes `err.message` straight
   * into `notifications.last_error`, so an error carrying the AUTH payload would
   * persist the relay password to disk in base64.
   */
  private async authenticate(ch: SmtpChannel, caps: Capabilities): Promise<void> {
    const user = this.user!
    const pass = this.pass!

    if (caps.auth.has('PLAIN')) {
      // RFC 4616: authzid NUL authcid NUL passwd, empty authzid, sent as the
      // client-initiated initial response so it costs one round trip.
      const payload = Buffer.from(`\0${user}\0${pass}`, 'utf8').toString('base64')
      await this.command(ch, `AUTH PLAIN ${payload}`, [235], 'authentication')
      return
    }

    if (caps.auth.has('LOGIN')) {
      // Never standardised, universally implemented. The 334 challenges are
      // base64 of "Username:" and "Password:"; we answer in order rather than
      // matching the text, since not every server sends exactly those strings.
      await this.command(ch, 'AUTH LOGIN', [334], 'authentication')
      await this.command(ch, Buffer.from(user, 'utf8').toString('base64'), [334], 'authentication')
      await this.command(ch, Buffer.from(pass, 'utf8').toString('base64'), [235], 'authentication')
      return
    }

    throw new PermanentDeliveryError(
      `${this.host} advertises no AUTH mechanism we support (offered: ${[...caps.auth].join(', ') || 'none'})`
    )
  }

  private async command(
    ch: SmtpChannel,
    line: string,
    ok: number[],
    label: string
  ): Promise<SmtpReply> {
    ch.write(line + CRLF)
    const reply = await ch.read(this.timeoutMs, label)
    check(reply, ok, label)
    return reply
  }
}

/**
 * 5xx is the server saying no and meaning it: a bad mailbox, a rejected sender,
 * bad credentials. 4xx is greylisting, a full mailbox, a busy relay, all of
 * which are exactly what the retry ladder exists for.
 */
function check(reply: SmtpReply, ok: number[], label: string): void {
  if (ok.includes(reply.code)) return
  const message = `SMTP ${label} rejected: ${reply.raw}`
  if (reply.code >= 500 && reply.code < 600) throw new PermanentDeliveryError(message)
  throw new Error(message)
}

/**
 * The socket wrapper, which is where hand-rolled SMTP clients actually break.
 * Two independent bugs live in reply reading: a reply split across two TCP
 * chunks has to be reassembled, and two replies arriving in one chunk must not
 * be merged. Both are silent when wrong, and desynchronise the rest of the
 * session, so the buffer is the only thing that reads from the socket.
 */
class SmtpChannel {
  private socket: Duplex
  private buffer = ''
  private lines: string[] = []
  private readonly ready: SmtpReply[] = []
  private waiting: { resolve: (r: SmtpReply) => void; reject: (e: Error) => void } | null = null
  private broken: Error | null = null
  private closed = false

  private readonly onData = (chunk: unknown): void => this.consume(String(chunk))
  private readonly onError = (err: Error): void => this.fail(err)
  private readonly onClose = (): void => this.fail(new Error('the server closed the connection'))

  constructor(socket: Duplex) {
    this.socket = socket
    this.attach(socket)
  }

  write(text: string): void {
    if (this.broken) throw this.broken
    this.socket.write(text)
  }

  read(timeoutMs: number, what: string): Promise<SmtpReply> {
    const queued = this.ready.shift()
    if (queued) return Promise.resolve(queued)
    if (this.broken) return Promise.reject(this.broken)

    return new Promise<SmtpReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting = null
        reject(new Error(`timed out after ${timeoutMs}ms waiting for a reply to ${what}`))
      }, timeoutMs)
      this.waiting = {
        resolve: (r) => {
          clearTimeout(timer)
          resolve(r)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        },
      }
    })
  }

  async upgrade(servername: string, upgradeImpl: UpgradeFn, timeoutMs: number): Promise<void> {
    this.detach()
    const next = await upgradeImpl(this.socket, servername, timeoutMs)
    // Anything the server sent before the handshake is discarded along with the
    // capabilities it announced, because none of it was authenticated.
    this.buffer = ''
    this.lines = []
    this.ready.length = 0
    this.socket = next
    this.attach(next)
  }

  /**
   * QUIT and destroy, whatever happened. A relay that failed mid-DATA still has
   * our socket, and a worker that leaks one per failed alert runs out of them
   * during exactly the add/drop hour it is needed most.
   */
  async hangUp(timeoutMs: number): Promise<void> {
    if (this.closed) return
    this.closed = true
    try {
      if (!this.broken) {
        this.socket.write(`QUIT${CRLF}`)
        await this.read(Math.min(timeoutMs, 5_000), 'QUIT')
      }
    } catch {
      // A relay that will not say goodbye politely is not a delivery failure,
      // and turning one into an error would mask the real cause above.
    } finally {
      this.detach()
      this.socket.destroy()
    }
  }

  private attach(socket: Duplex): void {
    socket.setEncoding('utf8')
    socket.on('data', this.onData)
    socket.on('error', this.onError)
    socket.on('close', this.onClose)
  }

  private detach(): void {
    this.socket.off('data', this.onData)
    this.socket.off('error', this.onError)
    this.socket.off('close', this.onClose)
  }

  private consume(chunk: string): void {
    this.buffer += chunk
    for (;;) {
      const idx = this.buffer.indexOf(CRLF)
      if (idx === -1) break
      const line = this.buffer.slice(0, idx)
      this.buffer = this.buffer.slice(idx + CRLF.length)
      this.lines.push(line)
      // RFC 5321 section 4.2.1: `250-` continues a multiline reply, `250 ` ends
      // it. A bare three-digit line is a legal final line too.
      if (line.length === 3 || (line.length > 3 && line[3] !== '-')) this.complete()
    }
  }

  private complete(): void {
    const lines = this.lines
    this.lines = []
    const last = lines[lines.length - 1]!
    const reply: SmtpReply = {
      code: Number(last.slice(0, 3)),
      lines: lines.map((l) => l.slice(4)),
      raw: lines.join(' '),
    }

    const waiter = this.waiting
    if (waiter) {
      this.waiting = null
      waiter.resolve(reply)
    } else {
      // A server allowed to answer before we asked, which is what pipelining
      // looks like from this side. Queue it rather than dropping it.
      this.ready.push(reply)
    }
  }

  private fail(err: Error): void {
    this.broken ??= err
    const waiter = this.waiting
    if (waiter) {
      this.waiting = null
      waiter.reject(this.broken)
    }
  }
}

/**
 * Both of these are raced against a timer, and that is the whole point of them.
 *
 * `timeoutMs` covers reply reads, but a read only exists once a socket does. A
 * relay that completes the TCP handshake and then never sends a ServerHello,
 * which is what a half-dead load balancer or a blackholing firewall looks like,
 * emits neither `secureConnect` nor `error`. The promise never settled, so
 * `send` never settled, so `Dispatcher.flush` never settled, so the Runner's
 * `running` latch stayed true and the service silently stopped polling every
 * section and delivering on every channel until someone restarted it. One bad
 * relay took the whole product down.
 */
const defaultConnect: ConnectFn = ({ host, port, secure, timeoutMs }) =>
  new Promise<Duplex>((resolve, reject) => {
    const socket = secure
      ? tlsConnect({ host, port, servername: host })
      : netConnect({ host, port })

    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`timed out after ${timeoutMs}ms connecting to ${host}:${port}`))
    }, timeoutMs)

    const onError = (err: Error): void => {
      clearTimeout(timer)
      socket.destroy()
      reject(err)
    }
    socket.once('error', onError)
    socket.once(secure ? 'secureConnect' : 'connect', () => {
      clearTimeout(timer)
      socket.off('error', onError)
      resolve(socket)
    })
  })

const defaultUpgrade: UpgradeFn = (socket, servername, timeoutMs) =>
  new Promise<Duplex>((resolve, reject) => {
    // rejectUnauthorized stays on. Turning it off to make a relay work is how a
    // STARTTLS connection quietly becomes a downgrade anybody can sit inside.
    const tlsSocket = tlsConnect({ socket, servername })

    // setTimeout on the underlying socket does not cover the handshake, so this
    // is a plain timer plus a destroy rather than socket.setTimeout.
    const timer = setTimeout(() => {
      tlsSocket.destroy()
      reject(new Error(`timed out after ${timeoutMs}ms on the TLS handshake with ${servername}`))
    }, timeoutMs)

    const onError = (err: Error): void => {
      clearTimeout(timer)
      tlsSocket.destroy()
      reject(err)
    }
    tlsSocket.once('error', onError)
    tlsSocket.once('secureConnect', () => {
      clearTimeout(timer)
      tlsSocket.off('error', onError)
      resolve(tlsSocket)
    })
  })
