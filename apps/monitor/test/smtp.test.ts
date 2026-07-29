import { Duplex } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { SmtpTransport, type ConnectFn, type UpgradeFn } from '../src/core/smtp.js'
import { PermanentDeliveryError, type NotificationPayload } from '../src/core/notify.js'
import type { EventRow, SectionRow } from '../src/core/repo.js'

const FROM = 'ClassPik <alerts@classpik.app>'
const TO = 'student@example.edu'

const payload = (over: Partial<NotificationPayload> = {}): NotificationPayload => ({
  watchId: 'watch-1',
  userId: 'user-1',
  section: {
    id: 'test-university:202608:30412', school_id: 'test-university', term: '202608', crn: '30412',
    subject: 'MATH', course_number: '221', code: 'MATH 221', title: 'Linear Algebra', section: 'B',
    instructor: 'A. Lovelace', meeting_days: 'MWF', meeting_time: '10:00 am', campus: 'Main',
    seats: 1, capacity: 90, enrollment: 89, waitlist: 0, waitlist_cap: 25,
  } as SectionRow,
  event: { id: 77, kind: 'seat_opened', new_seats: 1, at: Date.UTC(2026, 6, 28, 22, 4, 11) } as EventRow,
  title: 'MATH 221 B has a seat open',
  body: 'Linear Algebra. 1 of 90 free. Register before it goes.',
  ...over,
})

/**
 * One half of a socket pair. The transport writes into `_write`, the scripted
 * server answers by pushing back, so the real reply parser runs against real
 * chunk boundaries rather than being mocked out.
 */
class FakeSocket extends Duplex {
  readonly written: string[] = []

  constructor(private readonly onWrite: (chunk: string, socket: FakeSocket) => void) {
    super()
  }

  override _read(): void {}

  override _write(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    const text = chunk.toString('utf8')
    this.written.push(text)
    cb()
    this.onWrite(text, this)
  }

  say(text: string): void {
    this.push(text)
  }
}

interface Step {
  expect: RegExp
  /** An array is pushed as separate chunks, which is how a real socket splits. */
  reply?: string | string[]
}

interface FakeServer {
  socket: FakeSocket
  connect: ConnectFn
  mismatches: string[]
  connects: number
}

function smtpServer(script: Step[], greeting: string | null = '220 smtp.test ESMTP ready\r\n'): FakeServer {
  const mismatches: string[] = []
  let step = 0
  const server: FakeServer = {
    mismatches,
    connects: 0,
    connect: async () => {
      server.connects++
      return server.socket
    },
    socket: new FakeSocket((chunk, socket) => {
      const current = script[step]
      if (!current) {
        // QUIT after the script is done is expected, not an error.
        if (/^QUIT/.test(chunk)) socket.say('221 Bye\r\n')
        return
      }
      step++
      if (!current.expect.test(chunk)) {
        mismatches.push(`expected ${current.expect} but got ${JSON.stringify(chunk.slice(0, 60))}`)
        socket.say('500 unexpected command\r\n')
        return
      }
      if (current.reply === undefined) return
      if (!Array.isArray(current.reply)) {
        socket.say(current.reply)
        return
      }
      // Spaced out in time so the pieces are genuinely separate data events
      // rather than one buffer the reader happens to see whole.
      current.reply.forEach((piece, i) => setTimeout(() => socket.say(piece), i * 5))
    }),
  }
  if (greeting !== null) server.socket.say(greeting)
  return server
}

const EHLO_FULL = [
  '250-smtp.test Hello',
  '250-SIZE 10485760',
  '250-STARTTLS',
  '250 AUTH PLAIN LOGIN',
  '',
].join('\r\n')

/** Greeting, EHLO, AUTH PLAIN, then a clean send. */
function happyScript(over: Partial<Record<'auth' | 'mail' | 'rcpt' | 'data' | 'body', string>> = {}): Step[] {
  return [
    { expect: /^EHLO /, reply: EHLO_FULL },
    { expect: /^AUTH PLAIN /, reply: over.auth ?? '235 2.7.0 Accepted\r\n' },
    { expect: /^MAIL FROM:/, reply: over.mail ?? '250 2.1.0 Ok\r\n' },
    { expect: /^RCPT TO:/, reply: over.rcpt ?? '250 2.1.5 Ok\r\n' },
    { expect: /^DATA/, reply: over.data ?? '354 End data with <CR><LF>.<CR><LF>\r\n' },
    { expect: /^From: /, reply: over.body ?? '250 2.0.0 Ok: queued as 9AF12\r\n' },
    { expect: /^QUIT/, reply: '221 2.0.0 Bye\r\n' },
  ]
}

function transportFor(server: FakeServer, over: Record<string, unknown> = {}): SmtpTransport {
  return new SmtpTransport({
    host: 'smtp.test',
    secure: true,
    user: 'resend',
    pass: 'super-secret-relay-password',
    from: FROM,
    ehloName: 'monitor.classpik.app',
    timeoutMs: 200,
    connect: server.connect,
    boundary: () => 'FIXED',
    ...over,
  })
}

const wire = (server: FakeServer): string => server.socket.written.join('')

describe('SmtpTransport', () => {
  it('walks the submission sequence in order and hangs up politely', async () => {
    const server = smtpServer(happyScript())
    await transportFor(server).send(payload(), TO)

    expect(server.mismatches).toEqual([])
    const commands = server.socket.written.map((w) => w.split('\r\n')[0])
    expect(commands[0]).toBe('EHLO monitor.classpik.app')
    expect(commands[1]).toMatch(/^AUTH PLAIN /)
    expect(commands[2]).toBe('MAIL FROM:<alerts@classpik.app>')
    expect(commands[3]).toBe('RCPT TO:<student@example.edu>')
    expect(commands[4]).toBe('DATA')
    expect(commands[6]).toBe('QUIT')
    expect(server.socket.destroyed).toBe(true)
  })

  it('sends a well formed message and terminates DATA with a lone dot', async () => {
    const server = smtpServer(happyScript())
    await transportFor(server).send(payload(), TO)

    const body = server.socket.written[5]!
    expect(body).toContain('Subject: MATH 221 B has a seat open')
    expect(body).toContain('To: student@example.edu')
    expect(body).toContain('Date: Tue, 28 Jul 2026 22:04:11 +0000')
    expect(body).toContain('Content-Type: multipart/alternative; boundary="FIXED"')
    expect(body).toContain('Content-Type: text/plain; charset=utf-8')
    expect(body).toContain('Content-Type: text/html; charset=utf-8')
    expect(body.endsWith('\r\n.\r\n')).toBe(true)
    // Nothing but the terminator may be a lone dot on its own line.
    expect(body.slice(0, -5).split('\r\n').filter((l) => l === '.')).toEqual([])
  })

  it('reads a multiline EHLO as one reply and picks a mechanism the server offered', async () => {
    const server = smtpServer([
      // Every capability line arrives in one chunk with `250-` continuations.
      { expect: /^EHLO /, reply: EHLO_FULL },
      { expect: /^AUTH PLAIN /, reply: '235 Accepted\r\n' },
      { expect: /^MAIL FROM:/, reply: '250 Ok\r\n' },
      { expect: /^RCPT TO:/, reply: '250 Ok\r\n' },
      { expect: /^DATA/, reply: '354 go\r\n' },
      { expect: /^From: /, reply: '250 queued\r\n' },
      { expect: /^QUIT/, reply: '221 Bye\r\n' },
    ])
    await transportFor(server).send(payload(), TO)
    expect(server.mismatches).toEqual([])
  })

  it('falls back to AUTH LOGIN when the server does not offer PLAIN', async () => {
    const server = smtpServer([
      { expect: /^EHLO /, reply: '250-smtp.test Hello\r\n250 AUTH LOGIN\r\n' },
      { expect: /^AUTH LOGIN$/m, reply: '334 VXNlcm5hbWU6\r\n' },
      { expect: /^cmVzZW5k/, reply: '334 UGFzc3dvcmQ6\r\n' },
      { expect: /^c3VwZXI/, reply: '235 Accepted\r\n' },
      { expect: /^MAIL FROM:/, reply: '250 Ok\r\n' },
      { expect: /^RCPT TO:/, reply: '250 Ok\r\n' },
      { expect: /^DATA/, reply: '354 go\r\n' },
      { expect: /^From: /, reply: '250 queued\r\n' },
      { expect: /^QUIT/, reply: '221 Bye\r\n' },
    ])
    await transportFor(server).send(payload(), TO)
    expect(server.mismatches).toEqual([])
  })

  it('reassembles a reply that arrives split across two chunks mid-line', async () => {
    const server = smtpServer([
      { expect: /^EHLO /, reply: ['250-smtp.test Hel', 'lo\r\n250 AUTH PL', 'AIN\r\n'] },
      { expect: /^AUTH PLAIN /, reply: '235 Accepted\r\n' },
      { expect: /^MAIL FROM:/, reply: '250 Ok\r\n' },
      { expect: /^RCPT TO:/, reply: '250 Ok\r\n' },
      { expect: /^DATA/, reply: '354 go\r\n' },
      { expect: /^From: /, reply: '250 queued\r\n' },
      { expect: /^QUIT/, reply: '221 Bye\r\n' },
    ])
    await transportFor(server).send(payload(), TO)
    expect(server.mismatches).toEqual([])
  })

  it('keeps two replies arriving in one chunk separate instead of merging them', async () => {
    // The server answers MAIL FROM and RCPT TO in a single write, which is what
    // a pipelining relay looks like from this side. Merging them would leave
    // the session one reply behind for the rest of the exchange.
    const server = smtpServer([
      { expect: /^EHLO /, reply: EHLO_FULL },
      { expect: /^AUTH PLAIN /, reply: '235 Accepted\r\n' },
      { expect: /^MAIL FROM:/, reply: '250 2.1.0 sender ok\r\n250 2.1.5 recipient ok\r\n' },
      { expect: /^RCPT TO:/ },
      { expect: /^DATA/, reply: '354 go\r\n' },
      { expect: /^From: /, reply: '250 queued\r\n' },
      { expect: /^QUIT/, reply: '221 Bye\r\n' },
    ])
    await transportFor(server).send(payload(), TO)
    expect(server.mismatches).toEqual([])
  })

  it('treats a rejected mailbox as permanent rather than retrying it for eight minutes', async () => {
    const server = smtpServer(happyScript({ rcpt: '550 5.1.1 No such user here\r\n' }))
    const err = await transportFor(server).send(payload(), TO).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PermanentDeliveryError)
    expect((err as Error).message).toContain('No such user here')
  })

  it('treats greylisting as transient, since it is exactly what the retry ladder is for', async () => {
    const server = smtpServer(happyScript({ rcpt: '450 4.2.0 Greylisted, try again later\r\n' }))
    const err = await transportFor(server).send(payload(), TO).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(PermanentDeliveryError)
    expect((err as Error).message).toContain('Greylisted')
  })

  it('treats a busy relay closing the door as transient', async () => {
    const server = smtpServer([{ expect: /^EHLO /, reply: '421 4.7.0 Too many connections\r\n' }])
    const err = await transportFor(server).send(payload(), TO).catch((e: unknown) => e)
    expect(err).not.toBeInstanceOf(PermanentDeliveryError)
  })

  it('surfaces bad credentials as permanent without echoing the credential', async () => {
    const server = smtpServer(happyScript({ auth: '535 5.7.8 Authentication credentials invalid\r\n' }))
    const err = await transportFor(server).send(payload(), TO).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(PermanentDeliveryError)
    expect((err as Error).message).toContain('Authentication credentials invalid')
    // The Dispatcher writes err.message into notifications.last_error, so a
    // message built from the AUTH line would persist the relay password.
    expect((err as Error).message).not.toContain('super-secret-relay-password')
    expect((err as Error).message).not.toContain(
      Buffer.from('\0resend\0super-secret-relay-password').toString('base64')
    )
  })

  it('refuses to authenticate over a connection nothing has encrypted', async () => {
    const server = smtpServer([{ expect: /^EHLO /, reply: '250-smtp.test Hello\r\n250 AUTH PLAIN\r\n' }])
    const err = await transportFor(server, { secure: false }).send(payload(), TO).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(PermanentDeliveryError)
    expect((err as Error).message).toMatch(/in the clear/)
    expect(wire(server)).not.toContain('AUTH')
  })

  it('upgrades with STARTTLS and asks for capabilities again afterwards', async () => {
    const plain = smtpServer([
      { expect: /^EHLO /, reply: '250-smtp.test Hello\r\n250-STARTTLS\r\n250 AUTH PLAIN\r\n' },
      { expect: /^STARTTLS/, reply: '220 2.0.0 Ready to start TLS\r\n' },
    ])
    const secure = smtpServer(happyScript(), null)
    const upgrade: UpgradeFn = async () => secure.socket

    await transportFor(plain, { secure: false, upgrade }).send(payload(), TO)

    expect(plain.mismatches).toEqual([])
    expect(secure.mismatches).toEqual([])
    // RFC 3207 requires a second EHLO: everything learned before TLS is
    // discarded, so the pre-upgrade capability list cannot be reused.
    expect(secure.socket.written[0]).toBe('EHLO monitor.classpik.app\r\n')
    // Credentials go over the upgraded socket only.
    expect(wire(plain)).not.toContain('AUTH')
    expect(wire(secure)).toContain('AUTH PLAIN')
  })

  it('sends nothing over a cleartext socket beyond the STARTTLS handshake', async () => {
    const plain = smtpServer([
      { expect: /^EHLO /, reply: '250-smtp.test Hello\r\n250-STARTTLS\r\n250 AUTH PLAIN\r\n' },
      { expect: /^STARTTLS/, reply: '220 Ready\r\n' },
    ])
    const secure = smtpServer(happyScript(), null)
    await transportFor(plain, { secure: false, upgrade: (async () => secure.socket) as UpgradeFn }).send(
      payload(),
      TO
    )
    expect(plain.socket.written.map((w) => w.split('\r\n')[0])).toEqual([
      'EHLO monitor.classpik.app',
      'STARTTLS',
    ])
  })

  it('does not attempt STARTTLS on a connection that is already encrypted', async () => {
    const server = smtpServer(happyScript())
    await transportFor(server).send(payload(), TO)
    expect(wire(server)).not.toContain('STARTTLS')
  })

  it('gives up when the server advertises no mechanism we support', async () => {
    const server = smtpServer([
      { expect: /^EHLO /, reply: '250-smtp.test Hello\r\n250 AUTH GSSAPI XOAUTH2\r\n' },
    ])
    const err = await transportFor(server).send(payload(), TO).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PermanentDeliveryError)
    expect((err as Error).message).toContain('GSSAPI')
  })

  it('skips AUTH entirely for a relay that wants no credentials', async () => {
    const server = smtpServer([
      { expect: /^EHLO /, reply: '250-smtp.test Hello\r\n250 SIZE 0\r\n' },
      { expect: /^MAIL FROM:/, reply: '250 Ok\r\n' },
      { expect: /^RCPT TO:/, reply: '250 Ok\r\n' },
      { expect: /^DATA/, reply: '354 go\r\n' },
      { expect: /^From: /, reply: '250 queued\r\n' },
      { expect: /^QUIT/, reply: '221 Bye\r\n' },
    ])
    await transportFor(server, { user: null, pass: null }).send(payload(), TO)
    expect(server.mismatches).toEqual([])
  })

  it('refuses a message larger than the advertised SIZE instead of earning a bare 552', async () => {
    const server = smtpServer([{ expect: /^EHLO /, reply: '250-smtp.test Hello\r\n250 SIZE 100\r\n' }])
    const err = await transportFor(server, { user: null, pass: null })
      .send(payload(), TO)
      .catch((e: unknown) => e)

    expect(err).toBeInstanceOf(PermanentDeliveryError)
    expect((err as Error).message).toMatch(/advertised a 100 byte limit/)
    expect(wire(server)).not.toContain('MAIL FROM')
  })

  it('rejects a recipient with a line break before a socket is ever opened', async () => {
    const server = smtpServer([])
    const err = await transportFor(server)
      .send(payload(), 'student@example.edu\r\nBcc: attacker@evil.test')
      .catch((e: unknown) => e)

    expect(err).toBeInstanceOf(PermanentDeliveryError)
    expect(server.connects).toBe(0)
  })

  it('rejects a missing recipient before a socket is ever opened', async () => {
    const server = smtpServer([])
    await expect(transportFor(server).send(payload(), null)).rejects.toThrow(PermanentDeliveryError)
    expect(server.connects).toBe(0)
  })

  it('rejects a course title carrying a line break rather than sending the header it would become', async () => {
    const server = smtpServer([])
    const injected = payload({ title: 'seat open\r\nBcc: attacker@evil.test' })
    const err = await transportFor(server).send(injected, TO).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(PermanentDeliveryError)
    expect((err as Error).message).toMatch(/could not compose/)
    expect(server.connects).toBe(0)
  })

  it('trips the command timeout instead of hanging when a server goes silent', async () => {
    const server = smtpServer([{ expect: /^EHLO /, reply: undefined }])
    const started = Date.now()
    const err = await transportFor(server, { timeoutMs: 60 }).send(payload(), TO).catch((e: unknown) => e)

    expect((err as Error).message).toMatch(/timed out after 60ms waiting for a reply to EHLO/)
    expect(err).not.toBeInstanceOf(PermanentDeliveryError)
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(server.socket.destroyed).toBe(true)
  })

  it('times out on a server that accepts the connection and never greets', async () => {
    const server = smtpServer([], null)
    const err = await transportFor(server, { timeoutMs: 60 }).send(payload(), TO).catch((e: unknown) => e)
    expect((err as Error).message).toMatch(/waiting for a reply to the greeting/)
  })

  it('quits and destroys the socket even when the message itself is refused', async () => {
    const server = smtpServer(happyScript({ body: '554 5.7.1 Message refused\r\n' }))
    const err = await transportFor(server).send(payload(), TO).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(PermanentDeliveryError)
    expect(wire(server)).toContain('QUIT')
    // A worker that leaks one socket per failed alert runs out during exactly
    // the add/drop hour it is needed most.
    expect(server.socket.destroyed).toBe(true)
  })

  it('reports a connection that fails outright as transient', async () => {
    const t = new SmtpTransport({
      host: 'smtp.test',
      from: FROM,
      connect: (async () => {
        throw new Error('ECONNREFUSED 127.0.0.1:465')
      }) as ConnectFn,
    })
    const err = await t.send(payload(), TO).catch((e: unknown) => e)
    expect(err).not.toBeInstanceOf(PermanentDeliveryError)
    expect((err as Error).message).toContain('ECONNREFUSED')
  })

  it('reports a server that drops the connection mid-session as transient', async () => {
    const server = smtpServer([{ expect: /^EHLO /, reply: EHLO_FULL }])
    const t = transportFor(server, {
      connect: (async () => {
        // Cut the socket the moment the first command is answered.
        setTimeout(() => server.socket.destroy(), 10)
        return server.socket
      }) as ConnectFn,
    })
    const err = await t.send(payload(), TO).catch((e: unknown) => e)
    expect(err).not.toBeInstanceOf(PermanentDeliveryError)
    expect((err as Error).message).toMatch(/closed the connection|timed out/)
  })

  it('refuses to construct with a From address nobody could send from', () => {
    expect(() => new SmtpTransport({ host: 'smtp.test', from: 'alerts-at-classpik' })).toThrow(
      /not a usable email address/
    )
  })

  it('announces itself on the email channel so a watch routes to it', () => {
    expect(new SmtpTransport({ host: 'smtp.test', from: FROM }).channel).toBe('email')
  })
})
