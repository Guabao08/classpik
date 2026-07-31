import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { createApi, type RateLimitConfig } from '../src/api/server.js'
import { AccountMail, compose, type AccountMailer } from '../src/core/accountmail.js'
import {
  EMAIL_VERIFY_TTL_MS,
  hashPassword,
  hashRecoveryToken,
  hashSessionToken,
  mintRecoveryToken,
  PASSWORD_RESET_TTL_MS,
  verifyPassword,
} from '../src/core/auth.js'
import { buildMessage, type MailMessage } from '../src/core/mime.js'
import { Dispatcher } from '../src/core/notify.js'
import { authHeaders, setupEnv, signUp, SCHOOL_ID, TERM, TEST_PASSWORD, type TestAccount, type TestEnv } from './helpers.js'

/**
 * Account recovery: proving an address, and getting back in without one.
 *
 * Everything here runs offline. The mailer is a capture, so a test reads the
 * link out of the message body exactly as a student reads it out of their inbox,
 * which is the only honest way to test that the link works.
 */

const APP_URL = 'https://app.classpik.test'
const FROM = 'ClassPik <alerts@classpik.test>'
const NEW_PASSWORD = 'a-brand-new-passphrase'

interface Captured {
  to: string
  subject: string
  text: string
  html: string
  key: string
}

interface LogLine {
  msg: string
  meta: Record<string, unknown> | undefined
}

/** A mailer that keeps what it was handed. `delayMs` stands in for a real relay. */
function capture(delayMs = 0): { sent: Captured[]; mailer: AccountMailer } {
  const sent: Captured[] = []
  return {
    sent,
    mailer: {
      async sendMail(message: MailMessage, key: string): Promise<void> {
        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
        sent.push({
          to: message.to,
          subject: message.subject,
          text: message.text,
          html: message.html,
          key,
        })
      },
    },
  }
}

/** The token out of the link, the way a browser would take it off the URL. */
function tokenIn(mail: Captured): string {
  const found = /[?&]token=([^\s"&]+)/.exec(mail.text)
  if (!found) throw new Error(`no token in the message body:\n${mail.text}`)
  return decodeURIComponent(found[1]!)
}

/** The send is deliberately off the response path, so tests wait for it. */
async function settle(sent: Captured[], count: number): Promise<Captured> {
  for (let i = 0; i < 200 && sent.length < count; i++) {
    await new Promise((r) => setTimeout(r, 5))
  }
  if (sent.length < count) throw new Error(`expected ${count} messages, saw ${sent.length}`)
  return sent[count - 1]!
}

// ------------------------------------------------------------------ the token

describe('recovery tokens', () => {
  it('mints a distinct high-entropy token every time', () => {
    const seen = new Set(Array.from({ length: 200 }, () => mintRecoveryToken()))
    expect(seen.size).toBe(200)
    for (const t of seen) expect(t.length).toBeGreaterThanOrEqual(40)
  })

  it('survives a round trip through a URL query string unchanged', () => {
    // base64url specifically. A `+` from plain base64 decodes back out of a
    // query string as a space, which would break exactly the links that happen
    // to contain one and leave the rest working.
    for (let i = 0; i < 200; i++) {
      const token = mintRecoveryToken()
      const url = new URL(`${APP_URL}/reset?token=${encodeURIComponent(token)}`)
      expect(url.searchParams.get('token')).toBe(token)
    }
  })

  it('hashes to a stable digest that is not the token', () => {
    const token = mintRecoveryToken()
    expect(hashRecoveryToken(token)).toBe(hashRecoveryToken(token))
    expect(hashRecoveryToken(token)).not.toBe(token)
    expect(hashRecoveryToken(token)).toHaveLength(64)
  })

  it('gives a reset link a far shorter life than a verification link', () => {
    // A reset token is a live password. A verification token is not, and it has
    // to survive being opened the next evening on another device.
    expect(PASSWORD_RESET_TTL_MS).toBe(60 * 60_000)
    expect(EMAIL_VERIFY_TTL_MS).toBe(24 * 60 * 60_000)
    expect(PASSWORD_RESET_TTL_MS).toBeLessThan(EMAIL_VERIFY_TTL_MS)
  })
})

// ------------------------------------------------------------------- the copy

describe('account email copy', () => {
  const at = 1_800_000_000_000
  const link = `${APP_URL}/reset?token=abc`
  const meta = { at, messageId: '<one@classpik.test>' }

  it('puts the link in both the text and the HTML part', () => {
    const m = compose('reset', 'ada@uni.test', link, { from: FROM }, meta)
    expect(m.text).toContain(link)
    expect(m.html).toContain(link)
  })

  it('tells a bystander what happens if they ignore it', () => {
    // Half the people who get one of these did not ask for it, because somebody
    // mistyped an address. "Ignore this" has to be an answer that works.
    expect(compose('verify', 'ada@uni.test', link, { from: FROM }, meta).text).toContain('ignore')
    expect(compose('reset', 'ada@uni.test', link, { from: FROM }, meta).text).toContain('ignore')
  })

  it('says how long each link lasts, in the units a person thinks in', () => {
    expect(compose('verify', 'a@b.test', link, { from: FROM }, meta).text).toContain('24 hours')
    expect(compose('reset', 'a@b.test', link, { from: FROM }, meta).text).toContain('one hour')
  })

  it('carries nothing about the account beyond the address it is going to', () => {
    const m = compose('reset', 'ada@uni.test', link, { from: FROM }, meta)
    // Not the school, not the watches, not the name. These are the messages a
    // mistyped signup delivers to a stranger.
    expect(m.text).not.toContain('ada@uni.test')
    expect(m.html).not.toContain('ada@uni.test')
  })

  it('builds into a legal message rather than one a relay would reject', () => {
    const raw = buildMessage(compose('verify', 'ada@uni.test', link, { from: FROM }, meta))
    expect(raw).toContain('Subject: Confirm your ClassPik email address')
    expect(raw).toContain('Content-Type: multipart/alternative')
  })

  it('escapes a link into the href rather than letting it end the attribute', () => {
    const hostile = `${APP_URL}/reset?token=a"onmouseover="alert(1)`
    const m = compose('reset', 'a@b.test', hostile, { from: FROM }, meta)
    expect(m.html).not.toContain('"onmouseover="')
    expect(m.html).toContain('&quot;onmouseover=&quot;')
  })
})

describe('AccountMail', () => {
  it('builds a link the web app can route', () => {
    const mail = new AccountMail({ appUrl: APP_URL })
    expect(mail.linkFor('verify', 'abc')).toBe(`${APP_URL}/verify?token=abc`)
    expect(mail.linkFor('reset', 'a+b/c')).toBe(`${APP_URL}/reset?token=a%2Bb%2Fc`)
  })

  it('does not double the slash when the app URL has a trailing one', () => {
    const mail = new AccountMail({ appUrl: 'https://classpik.test/' })
    expect(mail.linkFor('reset', 'abc')).toBe('https://classpik.test/reset?token=abc')
  })

  it('reports whether anything will actually be mailed', () => {
    expect(new AccountMail({ appUrl: APP_URL }).enabled).toBe(false)
    const { mailer } = capture()
    expect(
      new AccountMail({ appUrl: APP_URL, delivery: { mailer, identity: { from: FROM } } }).enabled
    ).toBe(true)
  })

  it('prints the link when nothing is configured to send it, rather than throwing', async () => {
    // The development path. A verification step nobody can complete is worse
    // than none, and signup must not fail because no provider is configured.
    const lines: LogLine[] = []
    const mail = new AccountMail({
      appUrl: APP_URL,
      log: (msg, meta) => lines.push({ msg, meta }),
    })
    await mail.send('reset', 'ada@uni.test', 'the-token')
    expect(lines).toHaveLength(1)
    expect(String(lines[0]!.meta!.link)).toContain('the-token')
  })

  it('keys the send on the message id rather than on anything derived from the token', async () => {
    // A provider echoes an idempotency key back into its own logs and support
    // tooling, which is not somewhere a live credential belongs.
    const { sent, mailer } = capture()
    const mail = new AccountMail({
      appUrl: APP_URL,
      delivery: { mailer, identity: { from: FROM } },
    })
    await mail.send('verify', 'ada@uni.test', 'the-token')
    expect(sent[0]!.key).not.toContain('the-token')
    expect(sent[0]!.key).toMatch(/^<.+@classpik\.test>$/)
  })
})

// -------------------------------------------------------------------- over HTTP

describe('account recovery over HTTP', () => {
  let env: TestEnv
  let server: Server
  let base: string
  let alice: TestAccount
  let sent: Captured[]
  let logs: LogLine[]

  const post = (path: string, body?: unknown, token: string | null = null) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  const get = (path: string, token: string | null = null) =>
    fetch(`${base}${path}`, { headers: authHeaders(token) })
  const login = (email: string, password: string) => post('/api/auth/login', { email, password })

  /**
   * A fresh server for one test, so a test that wants a slow relay or a tight
   * budget can have one without every other test paying for it.
   */
  async function boot(
    opts: {
      delayMs?: number
      delivery?: boolean
      rateLimit?: RateLimitConfig
      /** Lets a test present several source addresses from one socket. */
      clientIpHeader?: string
    } = {}
  ): Promise<void> {
    // A test that wants a different server closes the one it already has, or
    // the process keeps a listener per rebooted test and never exits.
    if (server?.listening) await new Promise<void>((r) => server.close(() => r()))
    const captured = capture(opts.delayMs ?? 0)
    sent = captured.sent
    logs = []
    const accountMail = new AccountMail({
      appUrl: APP_URL,
      delivery:
        opts.delivery === false
          ? null
          : { mailer: captured.mailer, identity: { from: FROM } },
      log: (msg, meta) => logs.push({ msg, meta }),
      now: () => env.clock.now,
    })
    server = createApi({
      repo: env.repo,
      accountMail,
      // Registered so the email channel is offered at all; what it would send is
      // beside the point here, and nothing in this file lets it.
      dispatcher: new Dispatcher(env.repo, [{ channel: 'email', send: async () => {} }], {
        now: () => env.clock.now,
      }),
      now: () => env.clock.now,
      clientIpHeader: opts.clientIpHeader ?? null,
      rateLimit: { authPerMinute: 500, signupsPerHour: 500, recoveryPerHour: 200, ...opts.rateLimit },
    })
    await new Promise<void>((r) => server.listen(0, r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  }

  beforeEach(() => {
    env = setupEnv()
  })

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()))
    env.close()
  })

  // ------------------------------------------------------------ verification

  describe('email verification', () => {
    beforeEach(async () => {
      await boot()
      alice = await signUp(base, 'alice@classpik.test')
    })

    it('advertises in GET /api/stats that account mail is deliverable', async () => {
      const body = await (await get('/api/stats')).json() as any
      expect(body.accountMail).toBe(true)
    })

    it('mails a link the moment an account is created', async () => {
      const mail = await settle(sent, 1)
      expect(mail.to).toBe('alice@classpik.test')
      expect(mail.subject).toContain('Confirm')
    })

    it('does not make signup wait on the mail provider', async () => {
      // The account and the session in the response are already real. A relay
      // taking fifteen seconds must not make creating an account take fifteen
      // seconds, and a relay having a bad minute must not turn a created
      // account into a 500 telling the student they have none.
      await boot({ delayMs: 400 })
      const started = Date.now()
      await signUp(base, 'slow@classpik.test')
      expect(Date.now() - started).toBeLessThan(300)
      expect((await settle(sent, 1)).to).toBe('slow@classpik.test')
    })

    it('creates the account even when the provider refuses the message', async () => {
      await boot()
      server.close()
      const failing = new AccountMail({
        appUrl: APP_URL,
        delivery: {
          mailer: { sendMail: async () => { throw new Error('relay is down') } },
          identity: { from: FROM },
        },
        now: () => env.clock.now,
      })
      server = createApi({ repo: env.repo, accountMail: failing, now: () => env.clock.now })
      await new Promise<void>((r) => server.listen(0, r))
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

      const bob = await signUp(base, 'bob@classpik.test')
      expect((await get('/api/auth/me', bob.token)).status).toBe(200)
    })

    it('starts every account unverified, because an address at signup is a claim', async () => {
      const me = await (await get('/api/auth/me', alice.token)).json() as any
      expect(me.user.emailVerified).toBe(false)
      expect(env.repo.getUser(alice.userId)!.email_verified_at).toBeNull()
    })

    it('marks the address proved when the link is opened', async () => {
      const token = tokenIn(await settle(sent, 1))
      const res = await post('/api/auth/verify', { token })
      expect(res.status).toBe(200)
      expect((await res.json() as any).email).toBe('alice@classpik.test')
      expect(env.repo.getUser(alice.userId)!.email_verified_at).toBe(env.clock.now)
      expect((await (await get('/api/auth/me', alice.token)).json() as any).user.emailVerified).toBe(true)
    })

    it('needs no session, because the link is opened wherever the mail is read', async () => {
      // The device holding the mailbox is very often not the device that signed
      // up, and asking somebody to sign in before confirming their address is
      // asking them to do the thing they cannot yet do.
      const token = tokenIn(await settle(sent, 1))
      expect((await post('/api/auth/verify', { token }, null)).status).toBe(200)
    })

    it('refuses a link that has already been used', async () => {
      const token = tokenIn(await settle(sent, 1))
      expect((await post('/api/auth/verify', { token })).status).toBe(200)
      const again = await post('/api/auth/verify', { token })
      expect(again.status).toBe(400)
      expect((await again.json() as any).error).toContain('not valid')
    })

    it('refuses a link that has expired', async () => {
      const token = tokenIn(await settle(sent, 1))
      env.clock.now += EMAIL_VERIFY_TTL_MS + 1
      expect((await post('/api/auth/verify', { token })).status).toBe(400)
      expect(env.repo.getUser(alice.userId)!.email_verified_at).toBeNull()
    })

    it('still works on the last millisecond before it expires', async () => {
      const token = tokenIn(await settle(sent, 1))
      env.clock.now += EMAIL_VERIFY_TTL_MS - 1
      expect((await post('/api/auth/verify', { token })).status).toBe(200)
    })

    it('refuses a token that was never issued', async () => {
      expect((await post('/api/auth/verify', { token: mintRecoveryToken() })).status).toBe(400)
    })

    it('answers an unknown link exactly as it answers a spent one', async () => {
      // "Already used" would confirm that the address has an account and that
      // somebody has recently acted on it.
      const token = tokenIn(await settle(sent, 1))
      await post('/api/auth/verify', { token })
      const spent = await post('/api/auth/verify', { token })
      const unknown = await post('/api/auth/verify', { token: mintRecoveryToken() })
      expect(spent.status).toBe(unknown.status)
      expect((await spent.json() as any).error).toBe((await unknown.json() as any).error)
    })

    it('verifies only the account the link was mailed to', async () => {
      const bob = await signUp(base, 'bob@classpik.test')
      const aliceToken = tokenIn(sent.find((m) => m.to === 'alice@classpik.test')!)
      await post('/api/auth/verify', { token: aliceToken })

      expect(env.repo.getUser(alice.userId)!.email_verified_at).not.toBeNull()
      expect(env.repo.getUser(bob.userId)!.email_verified_at).toBeNull()
    })

    it('cannot be presented to the reset route to change a password', async () => {
      // The purpose is part of the lookup. Otherwise the 24 hour link mailed at
      // signup is a longer-lived and more powerful secret than the one hour
      // reset flow deliberately issues.
      const token = tokenIn(await settle(sent, 1))
      const res = await post('/api/auth/reset', { token, password: NEW_PASSWORD })
      expect(res.status).toBe(400)
      expect((await login(alice.email, TEST_PASSWORD)).status).toBe(200)
      // And it is still spendable for what it was actually for.
      expect((await post('/api/auth/verify', { token })).status).toBe(200)
    })

    it('refuses a link issued for an address the account no longer uses', async () => {
      // A token is proof about the mailbox that received it and about nothing
      // else, so it must not travel with the account to a new address.
      const token = tokenIn(await settle(sent, 1))
      env.repo.raw
        .prepare('UPDATE users SET email = ?, email_norm = ? WHERE id = ?')
        .run('ada@classpik.test', 'ada@classpik.test', alice.userId)
      expect((await post('/api/auth/verify', { token })).status).toBe(400)
      expect(env.repo.getUser(alice.userId)!.email_verified_at).toBeNull()
    })

    it('resends on request, with a link that also works', async () => {
      await settle(sent, 1)
      const res = await post('/api/auth/verify/request', undefined, alice.token)
      expect(res.status).toBe(200)
      expect((await res.json() as any)).toMatchObject({ ok: true, verified: false, sent: true })
      const token = tokenIn(await settle(sent, 2))
      expect((await post('/api/auth/verify', { token })).status).toBe(200)
    })

    it('leaves the first link working after a resend', async () => {
      // Two links in a mailbox and no way to tell which is newer. Burning the
      // first would make the obvious choice the wrong one.
      const first = tokenIn(await settle(sent, 1))
      await post('/api/auth/verify/request', undefined, alice.token)
      await settle(sent, 2)
      expect((await post('/api/auth/verify', { token: first })).status).toBe(200)
    })

    it('refuses to resend for anyone without a session', async () => {
      expect((await post('/api/auth/verify/request')).status).toBe(401)
    })

    it('sends nothing when the address is already verified', async () => {
      const token = tokenIn(await settle(sent, 1))
      await post('/api/auth/verify', { token })
      const res = await post('/api/auth/verify/request', undefined, alice.token)
      expect(res.status).toBe(200)
      expect(await res.json() as any).toMatchObject({ verified: true, sent: false })
      expect(sent).toHaveLength(1)
    })

    it('stops mailing one address once the per-account budget is spent', async () => {
      // The cost of this route lands in a mailbox belonging to somebody who did
      // not necessarily ask for any of it.
      await settle(sent, 1)
      for (let i = 0; i < 20; i++) await post('/api/auth/verify/request', undefined, alice.token)
      expect(sent.length).toBeLessThanOrEqual(5)
    })

    it('rate limits link requests from one source address', async () => {
      await boot({ rateLimit: { recoveryPerHour: 2 } })
      const bob = await signUp(base, 'bob@classpik.test')
      expect((await post('/api/auth/verify/request', undefined, bob.token)).status).toBe(200)
      expect((await post('/api/auth/verify/request', undefined, bob.token)).status).toBe(200)
      const throttled = await post('/api/auth/verify/request', undefined, bob.token)
      expect(throttled.status).toBe(429)
      expect((await throttled.json() as any).error).toContain('this address')
    })
  })

  describe('what an unverified account cannot do', () => {
    let sid: string

    beforeEach(async () => {
      await boot()
      const target = env.repo.ensureTarget(SCHOOL_ID, TERM, 'MATH', 60_000)
      sid = env.repo.upsertSection(
        target,
        {
          crn: '30412', subject: 'MATH', courseNumber: '221', code: 'MATH 221',
          title: 'Linear Algebra', section: 'B', credits: 3, instructor: null,
          meetingDays: null, meetingTime: null, campus: null, level: null,
          seats: 0, capacity: 90, enrollment: 90, waitlist: 0, waitlistCap: 0, waitlistAvailable: 0,
        },
        false
      )
      alice = await signUp(base, 'alice@classpik.test')
    })

    it('cannot point a watch at its own unproved address', async () => {
      const res = await post('/api/watches', { sectionId: sid, channel: 'email' }, alice.token)
      expect(res.status).toBe(403)
      expect((await res.json() as any).error).toContain('confirm your email')
    })

    it('names the route that fixes it, rather than leaving a dead end', async () => {
      const res = await post('/api/watches', { sectionId: sid, channel: 'email' }, alice.token)
      expect((await res.json() as any).error).toContain('/api/auth/verify/request')
    })

    it('keeps every other part of the account working', async () => {
      // Being unverified costs the email channel and nothing else. Blocking
      // signin, search or watching would punish the student for a step they may
      // simply not have got to yet.
      expect((await get('/api/auth/me', alice.token)).status).toBe(200)
      expect((await login(alice.email, TEST_PASSWORD)).status).toBe(200)
      expect((await get('/api/sections', alice.token)).status).toBe(200)
      expect((await post('/api/watches', { sectionId: sid }, alice.token)).status).toBe(201)
    })

    it('can use the channel the moment the link is opened', async () => {
      await post('/api/auth/verify', { token: tokenIn(await settle(sent, 1)) })
      const res = await post('/api/watches', { sectionId: sid, channel: 'email' }, alice.token)
      expect(res.status).toBe(201)
    })
  })

  // ---------------------------------------------------------- password reset

  describe('password reset', () => {
    beforeEach(async () => {
      await boot()
      alice = await signUp(base, 'alice@classpik.test')
      await settle(sent, 1)
      sent.length = 0
    })

    const request = (email: string) => post('/api/auth/reset/request', { email })

    it('mails a link to an address that has an account', async () => {
      expect((await request(alice.email)).status).toBe(202)
      const mail = await settle(sent, 1)
      expect(mail.to).toBe(alice.email)
      expect(mail.subject).toContain('Reset')
    })

    it('answers an address with no account identically', async () => {
      // Any difference at all here is a free list of which addresses at a
      // university have ClassPik accounts, and it needs no password to read.
      const known = await request(alice.email)
      const unknown = await request('nobody@classpik.test')
      expect(known.status).toBe(unknown.status)
      expect(await known.text()).toBe(await unknown.text())
    })

    it('answers a string that is not an address the same way too', async () => {
      const nonsense = await request('not-an-address')
      const known = await request(alice.email)
      expect(nonsense.status).toBe(known.status)
      expect(await nonsense.text()).toBe(await known.text())
    })

    it('does not put the send on the response path, where a stopwatch reads it', async () => {
      // A provider takes hundreds of milliseconds and a lookup that finds
      // nothing takes none, which is the same oracle the status code was
      // careful not to be.
      await boot({ delayMs: 400 })
      const other = await signUp(base, 'ada@classpik.test')

      const timed = async (email: string): Promise<number> => {
        const started = Date.now()
        await request(email)
        return Date.now() - started
      }
      const known = await timed(other.email)
      const unknown = await timed('nobody@classpik.test')

      expect(known).toBeLessThan(200)
      expect(unknown).toBeLessThan(200)
      // And the mail really was sent, just not while the caller waited.
      expect((await settle(sent, 1)).to).toBe(other.email)
    })

    it('writes the response before it does any of the work behind the address', async () => {
      // The status and the body were already constant. The third oracle is the
      // clock, and not awaiting the send was one await too late to close it: an
      // async body runs synchronously up to its first await, and the first await
      // in issueRecovery is the send, so the budget check, the randomBytes and
      // the INSERT all landed on the response path. Measured against 5000 rows
      // that is a sub-millisecond but perfectly deterministic difference, which
      // twenty samples per candidate address sort out cleanly.
      //
      // Asserted as an ORDER rather than as a stopwatch delta, because a
      // stopwatch cannot see it from here: this client shares a process with the
      // server, so anything that holds the server's event loop holds the
      // client's too and both branches measure the same. The order is the fact
      // the stopwatch was only ever a proxy for, and unlike a duration it does
      // not depend on how fast this machine is. The existing "under 200ms" test
      // above stays, and this is what makes it mean something: 200ms is a
      // ceiling a 0.8ms leak passes without noticing.
      const order: string[] = []
      server.on('request', (_req, res) => {
        res.on('finish', () => order.push('answered'))
      })
      const real = env.repo.createAuthToken.bind(env.repo)
      ;(env.repo as any).createAuthToken = (input: Parameters<typeof real>[0]) => {
        order.push('minted')
        return real(input)
      }

      await request(alice.email)
      await settle(sent, 1)

      expect(order).toEqual(['answered', 'minted'])
    })

    it('lets one source drain only its own share of an account, never the whole allowance', async () => {
      // The silence of the per-account throttle is right, and it is also what
      // makes draining it invisible: the victim gets the same confident 202 and
      // no link, forever, with no way to tell that from a mail problem. So the
      // tight budget is keyed on the source address too, and a stranger spending
      // theirs leaves the student asking from their own machine untouched.
      await boot({ clientIpHeader: 'x-forwarded-for', rateLimit: { recoveryPerAccountPerHour: 2 } })
      const victim = await signUp(base, 'ada@classpik.test')
      await settle(sent, 1)
      sent.length = 0

      const from = (ip: string, email: string) =>
        fetch(`${base}/api/auth/reset/request`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
          body: JSON.stringify({ email }),
        })

      // A cron at one address, asking for this account's link all afternoon.
      for (let i = 0; i < 12; i++) {
        expect((await from('203.0.113.9', victim.email)).status).toBe(202)
      }
      await settle(sent, 2)
      await new Promise((r) => setTimeout(r, 50))
      expect(sent).toHaveLength(2)

      // The victim, from their own machine, still gets one.
      await from('198.51.100.4', victim.email)
      expect((await settle(sent, 3)).to).toBe(victim.email)
    })

    it('still bounds what lands in one mailbox however many addresses ask', async () => {
      // The other half of the split. The tight cap alone would let a rotating
      // source address mail a stranger all afternoon, which is the harm the
      // per-account budget was written for in the first place.
      await boot({
        clientIpHeader: 'x-forwarded-for',
        rateLimit: { recoveryPerAccountPerHour: 2, recoveryPerAccountTotalPerHour: 4 },
      })
      const victim = await signUp(base, 'ada@classpik.test')
      await settle(sent, 1)
      sent.length = 0

      for (let i = 0; i < 10; i++) {
        await fetch(`${base}/api/auth/reset/request`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `203.0.113.${i}` },
          body: JSON.stringify({ email: victim.email }),
        })
      }
      await settle(sent, 4)
      await new Promise((r) => setTimeout(r, 50))
      expect(sent).toHaveLength(4)
    })

    it('keeps answering the same way once the per-account budget is spent', async () => {
      // The throttle exists, and it is silent. A 429 on the sixth request for a
      // real address and a 202 on the sixth for a fictional one is the
      // enumeration oracle wearing a different status code.
      const answers = new Set<string>()
      for (let i = 0; i < 12; i++) {
        const res = await request(alice.email)
        answers.add(`${res.status} ${await res.text()}`)
      }
      expect(answers.size).toBe(1)
      // Five reached the mailbox and the other seven did not, which is the
      // whole of the throttle: the caller cannot tell those two apart.
      await settle(sent, 5)
      await new Promise((r) => setTimeout(r, 50))
      expect(sent).toHaveLength(5)
    })

    it('rate limits requests from one source address, whoever they name', async () => {
      await boot({ rateLimit: { recoveryPerHour: 2 } })
      expect((await request('a@classpik.test')).status).toBe(202)
      expect((await request('b@classpik.test')).status).toBe(202)
      expect((await request('c@classpik.test')).status).toBe(429)
    })

    it('sets the new password and refuses the old one', async () => {
      await request(alice.email)
      const token = tokenIn(await settle(sent, 1))

      const res = await post('/api/auth/reset', { token, password: NEW_PASSWORD })
      expect(res.status).toBe(200)
      expect((await login(alice.email, NEW_PASSWORD)).status).toBe(200)
      expect((await login(alice.email, TEST_PASSWORD)).status).toBe(401)
    })

    it('stores the new password hashed, never as written', async () => {
      await request(alice.email)
      await post('/api/auth/reset', { token: tokenIn(await settle(sent, 1)), password: NEW_PASSWORD })
      const row = env.repo.getUser(alice.userId)!
      expect(row.password_hash).not.toContain(NEW_PASSWORD)
      expect(await verifyPassword(NEW_PASSWORD, row.password_hash)).toBe(true)
    })

    it('revokes every session the old password left open', async () => {
      // A reset is what somebody does after losing control of their account. A
      // reset that leaves the intruder's thirty day bearer token working has
      // changed nothing they would notice.
      const phone = (await (await login(alice.email, TEST_PASSWORD)).json() as any).token
      await request(alice.email)
      await post('/api/auth/reset', { token: tokenIn(await settle(sent, 1)), password: NEW_PASSWORD })

      expect((await get('/api/auth/me', alice.token)).status).toBe(401)
      expect((await get('/api/auth/me', phone)).status).toBe(401)
    })

    it('hands back no session of its own', async () => {
      await request(alice.email)
      const res = await post('/api/auth/reset', { token: tokenIn(await settle(sent, 1)), password: NEW_PASSWORD })
      const body = await res.json() as any
      expect(body.token).toBeUndefined()
    })

    it('clears a lockout, since forgetting a password is how you get one', async () => {
      for (let i = 0; i < 5; i++) await login(alice.email, `wrong-${i}-attempt`)
      expect(env.repo.getUser(alice.userId)!.locked_until).not.toBeNull()

      await request(alice.email)
      await post('/api/auth/reset', { token: tokenIn(await settle(sent, 1)), password: NEW_PASSWORD })

      const user = env.repo.getUser(alice.userId)!
      expect(user.locked_until).toBeNull()
      expect(user.failed_logins).toBe(0)
      expect((await login(alice.email, NEW_PASSWORD)).status).toBe(200)
    })

    it('counts as proof of the address, because that is exactly what it is', async () => {
      // The link went to the account address and nowhere else, and reading it is
      // precisely what a verification link asks for. A second round trip to
      // establish a fact already established would be ceremony.
      await request(alice.email)
      await post('/api/auth/reset', { token: tokenIn(await settle(sent, 1)), password: NEW_PASSWORD })
      expect(env.repo.getUser(alice.userId)!.email_verified_at).not.toBeNull()
    })

    it('refuses a link that has already been used', async () => {
      await request(alice.email)
      const token = tokenIn(await settle(sent, 1))
      expect((await post('/api/auth/reset', { token, password: NEW_PASSWORD })).status).toBe(200)

      const again = await post('/api/auth/reset', { token, password: 'yet-another-passphrase' })
      expect(again.status).toBe(400)
      expect((await login(alice.email, 'yet-another-passphrase')).status).toBe(401)
    })

    it('lets only one of two requests carrying the same link through', async () => {
      // Single use is a property of one UPDATE holding the write lock, not of a
      // caller remembering to delete a row. Two in flight at once must not both
      // find consumed_at null.
      await request(alice.email)
      const token = tokenIn(await settle(sent, 1))
      const [a, b] = await Promise.all([
        post('/api/auth/reset', { token, password: NEW_PASSWORD }),
        post('/api/auth/reset', { token, password: 'a-different-passphrase' }),
      ])
      expect([a.status, b.status].sort()).toEqual([200, 400])
    })

    it('burns the other outstanding links when one is used', async () => {
      // A panicked student clicks the button three times. Two of those links are
      // still live keys to the account after the third one has done its job.
      await request(alice.email)
      await request(alice.email)
      const first = tokenIn(sent[0]!)
      const second = tokenIn(await settle(sent, 2))

      expect((await post('/api/auth/reset', { token: second, password: NEW_PASSWORD })).status).toBe(200)
      expect((await post('/api/auth/reset', { token: first, password: 'third-passphrase-here' })).status).toBe(400)
    })

    it('refuses a link an hour after it was issued', async () => {
      await request(alice.email)
      const token = tokenIn(await settle(sent, 1))
      env.clock.now += PASSWORD_RESET_TTL_MS + 1
      expect((await post('/api/auth/reset', { token, password: NEW_PASSWORD })).status).toBe(400)
      expect((await login(alice.email, TEST_PASSWORD)).status).toBe(200)
    })

    it('still works on the last millisecond before it expires', async () => {
      await request(alice.email)
      const token = tokenIn(await settle(sent, 1))
      env.clock.now += PASSWORD_RESET_TTL_MS - 1
      expect((await post('/api/auth/reset', { token, password: NEW_PASSWORD })).status).toBe(200)
    })

    it('changes only the account the link was mailed to', async () => {
      const bob = await signUp(base, 'bob@classpik.test')
      await request(alice.email)
      const token = tokenIn(sent.find((m) => m.to === alice.email)!)

      expect((await post('/api/auth/reset', { token, password: NEW_PASSWORD })).status).toBe(200)
      expect((await login(bob.email, TEST_PASSWORD)).status).toBe(200)
      expect((await login(bob.email, NEW_PASSWORD)).status).toBe(401)
    })

    it('is not made to act on another account by presenting that account\'s session', async () => {
      // The token names the account, never the caller. A signed-in Bob holding
      // a link that reached Alice's mailbox changes Alice's password, which is
      // the account whose mailbox proved it, and never his own.
      const bob = await signUp(base, 'bob@classpik.test')
      await request(alice.email)
      const token = tokenIn(sent.find((m) => m.to === alice.email)!)

      await post('/api/auth/reset', { token, password: NEW_PASSWORD }, bob.token)
      expect((await login(bob.email, TEST_PASSWORD)).status).toBe(200)
      expect((await login(bob.email, NEW_PASSWORD)).status).toBe(401)
      expect((await login(alice.email, NEW_PASSWORD)).status).toBe(200)
    })

    it('cannot be presented to the verification route', async () => {
      await request(alice.email)
      const token = tokenIn(await settle(sent, 1))
      expect((await post('/api/auth/verify', { token })).status).toBe(400)
      expect(env.repo.getUser(alice.userId)!.email_verified_at).toBeNull()
    })

    it('refuses a new password shorter than the minimum', async () => {
      await request(alice.email)
      const token = tokenIn(await settle(sent, 1))
      expect((await post('/api/auth/reset', { token, password: 'short' })).status).toBe(400)
      // And the link survives, so the student can try again with a longer one
      // rather than having spent their one link on a typo.
      expect((await post('/api/auth/reset', { token, password: NEW_PASSWORD })).status).toBe(200)
    })

    it('leaves the link spendable when the server sheds load mid-reset', async () => {
      // The token used to be spent before the work that can fail. hashPassword
      // throws KdfBusyError once the KDF queue is full, and that queue is
      // reachable from the unauthenticated login route by design, so a stranger
      // could hold it full and any reset landing in the window came back 503
      // with consumed_at already set: a dead link, an unchanged password, and
      // five such collisions exhausting the account's whole hourly allowance.
      await request(alice.email)
      const token = tokenIn(await settle(sent, 1))

      // Held from inside the process rather than over HTTP, because the queue is
      // module state in core/auth.ts and this is the same pool a burst of logins
      // fills. Topped up on a timer so it stays saturated for the whole request
      // rather than for the ~35ms one batch of hashes takes to drain.
      const held: Promise<unknown>[] = []
      const fill = (n: number): void => {
        for (let i = 0; i < n; i++) held.push(hashPassword('a-queue-filling-passphrase').catch(() => ''))
      }
      // Enough in one go to fill the 64 slot queue outright; anything past it is
      // refused immediately and costs nothing.
      fill(120)
      const topUp = setInterval(() => fill(20), 5)
      let busy: Response
      try {
        busy = await post('/api/auth/reset', { token, password: NEW_PASSWORD })
      } finally {
        clearInterval(topUp)
      }
      await Promise.all(held)

      expect(busy.status).toBe(503)
      // The whole point: the student comes back later and their link still works.
      expect((await post('/api/auth/reset', { token, password: NEW_PASSWORD })).status).toBe(200)
      expect((await login(alice.email, NEW_PASSWORD)).status).toBe(200)
    })

    it('refuses a password long enough to be a denial of service', async () => {
      await request(alice.email)
      const token = tokenIn(await settle(sent, 1))
      expect((await post('/api/auth/reset', { token, password: 'a'.repeat(5000) })).status).toBe(400)
    })

    it('requires both fields', async () => {
      expect((await post('/api/auth/reset', { password: NEW_PASSWORD })).status).toBe(400)
      expect((await post('/api/auth/reset', { token: mintRecoveryToken() })).status).toBe(400)
    })
  })

  // --------------------------------------------------------- password change

  describe('password change', () => {
    let phone: string

    beforeEach(async () => {
      await boot()
      alice = await signUp(base, 'alice@classpik.test')
      await settle(sent, 1)
      phone = (await (await login(alice.email, TEST_PASSWORD)).json() as any).token
    })

    const change = (currentPassword: string, password: string, token = alice.token) =>
      post('/api/auth/password', { currentPassword, password }, token)

    it('changes the password when the current one is given', async () => {
      expect((await change(TEST_PASSWORD, NEW_PASSWORD)).status).toBe(200)
      expect((await login(alice.email, NEW_PASSWORD)).status).toBe(200)
      expect((await login(alice.email, TEST_PASSWORD)).status).toBe(401)
    })

    it('keeps the caller signed in', async () => {
      // The whole shape of the route. Signing somebody out of the browser they
      // are typing in is a confusing way to reward them for tidying up.
      expect((await change(TEST_PASSWORD, NEW_PASSWORD)).status).toBe(200)
      expect((await get('/api/auth/me', alice.token)).status).toBe(200)
    })

    it('revokes every other session, which is the point of it', async () => {
      // This is what makes a leaked token recoverable in one request instead of
      // by waiting out a thirty day TTL on a session nobody can name.
      const res = await change(TEST_PASSWORD, NEW_PASSWORD)
      expect((await res.json() as any).sessionsRevoked).toBe(1)
      expect((await get('/api/auth/me', phone)).status).toBe(401)
    })

    it('refuses without the current password, even from a live session', async () => {
      // The session says this browser was signed in once. The password says the
      // person at the keyboard is the account holder, and those are different
      // facts: a borrowed laptop should not be enough to take an account.
      const res = await change('not-the-current-password', NEW_PASSWORD)
      expect(res.status).toBe(403)
      expect((await login(alice.email, TEST_PASSWORD)).status).toBe(200)
      expect((await login(alice.email, NEW_PASSWORD)).status).toBe(401)
    })

    it('leaves the other sessions alone when it refuses', async () => {
      await change('not-the-current-password', NEW_PASSWORD)
      expect((await get('/api/auth/me', phone)).status).toBe(200)
    })

    it('refuses without a session at all', async () => {
      expect((await post('/api/auth/password', { currentPassword: TEST_PASSWORD, password: NEW_PASSWORD })).status).toBe(401)
    })

    it('does not count toward the login lockout', async () => {
      // A borrowed tab guessing here would otherwise lock the owner out of the
      // account through a route that already needs their session.
      for (let i = 0; i < 8; i++) await change(`wrong-${i}-attempt`, NEW_PASSWORD)
      expect(env.repo.getUser(alice.userId)!.locked_until).toBeNull()
      expect((await login(alice.email, TEST_PASSWORD)).status).toBe(200)
    })

    it('refuses a new password shorter than the minimum', async () => {
      expect((await change(TEST_PASSWORD, 'short')).status).toBe(400)
      expect((await login(alice.email, TEST_PASSWORD)).status).toBe(200)
    })

    it('requires both fields', async () => {
      expect((await post('/api/auth/password', { password: NEW_PASSWORD }, alice.token)).status).toBe(400)
      expect((await post('/api/auth/password', { currentPassword: TEST_PASSWORD }, alice.token)).status).toBe(400)
    })

    it('burns any reset link still sitting in the mailbox', async () => {
      // Somebody who changes their password after being phished must not leave
      // the live key behind that prompted them to.
      await post('/api/auth/reset/request', { email: alice.email })
      const token = tokenIn(await settle(sent, 2))
      await change(TEST_PASSWORD, NEW_PASSWORD)

      expect((await post('/api/auth/reset', { token, password: 'a-third-passphrase' })).status).toBe(400)
      expect((await login(alice.email, NEW_PASSWORD)).status).toBe(200)
    })
  })

  // ----------------------------------------------------------- what leaks out

  describe('a token never travels anywhere but the mailbox', () => {
    beforeEach(async () => {
      await boot()
      alice = await signUp(base, 'alice@classpik.test')
    })

    it('is not in any response body on the way out', async () => {
      const bodies = [
        await (await post('/api/auth/signup', { email: 'ada@classpik.test', password: TEST_PASSWORD })).text(),
        await (await post('/api/auth/login', { email: alice.email, password: TEST_PASSWORD })).text(),
        await (await get('/api/auth/me', alice.token)).text(),
        await (await post('/api/auth/verify/request', undefined, alice.token)).text(),
        await (await post('/api/auth/reset/request', { email: alice.email })).text(),
      ]
      // Every token this server has minted by now, read back out of the only
      // place any of them was ever meant to appear.
      await settle(sent, 4)
      for (const body of bodies) {
        for (const mail of sent) expect(body).not.toContain(tokenIn(mail))
      }
    })

    it('is not in a log line once a provider is configured', async () => {
      await post('/api/auth/verify/request', undefined, alice.token)
      await post('/api/auth/reset/request', { email: alice.email })
      await settle(sent, 3)
      const printed = JSON.stringify(logs)
      for (const mail of sent) expect(printed).not.toContain(tokenIn(mail))
      expect(logs).toHaveLength(0)
    })

    it('is stored only as a digest, so a leaked database yields nothing replayable', async () => {
      const token = tokenIn(await settle(sent, 1))
      const rows = env.repo.raw.prepare('SELECT * FROM auth_tokens').all() as Array<Record<string, unknown>>
      expect(rows).toHaveLength(1)
      expect(JSON.stringify(rows)).not.toContain(token)
      expect(rows[0]!.token_hash).toBe(hashRecoveryToken(token))
    })

    it('is not usable as a session, even though both are hashed the same way', async () => {
      // The two digests are the same function of the same input, so what keeps a
      // verification link from being a bearer token is that they live in
      // different tables and are looked up by different code. Worth pinning,
      // because the day they diverge this is the assertion that says so.
      const token = tokenIn(await settle(sent, 1))
      expect(hashSessionToken(token)).toBe(hashRecoveryToken(token))
      expect((await get('/api/auth/me', token)).status).toBe(401)
      expect(env.repo.resolveSession(hashSessionToken(token), env.clock.now)).toBeNull()
    })
  })

  // -------------------------------------------------- with no provider at all

  describe('with no email provider configured', () => {
    beforeEach(async () => {
      await boot({ delivery: false })
    })

    it('says so in GET /api/stats, so the screens can stop promising mail', async () => {
      // Nothing in the API used to expose this. `channels` is about seat alerts
      // and says nothing about account mail, so ForgotView rendered "Check your
      // email" with total confidence while the link sat in docker logs. A
      // student who cannot sign in and never gets a link creates a second
      // account, which is the exact outcome this whole flow exists to prevent.
      const body = await (await get('/api/stats')).json() as any
      expect(body.accountMail).toBe(false)
    })

    it('still creates the account, rather than failing signup', async () => {
      // A monitor that refuses to sign anybody up because nobody has signed up
      // to Resend yet is a monitor nobody can try.
      alice = await signUp(base, 'alice@classpik.test')
      expect((await get('/api/auth/me', alice.token)).status).toBe(200)
    })

    it('prints the link, so the flow can still be completed and tested', async () => {
      alice = await signUp(base, 'alice@classpik.test')
      const line = logs.find((l) => l.msg.includes('verification'))
      expect(line).toBeDefined()
      const link = String(line!.meta!.link)
      const token = new URL(link).searchParams.get('token')!
      expect((await post('/api/auth/verify', { token })).status).toBe(200)
    })

    it('says out loud that the console is the transport', async () => {
      await signUp(base, 'alice@classpik.test')
      const line = logs.find((l) => l.msg.includes('no email provider'))
      expect(line).toBeDefined()
      expect(String(line!.meta!.hint)).toContain('CLASSPIK_EMAIL_PROVIDER')
    })

    it('still resets a password all the way through', async () => {
      alice = await signUp(base, 'alice@classpik.test')
      await post('/api/auth/reset/request', { email: alice.email })
      // Not awaited on the response path, so give the log line a moment.
      for (let i = 0; i < 100 && logs.length < 2; i++) await new Promise((r) => setTimeout(r, 5))
      const line = logs.find((l) => l.msg.includes('password reset'))!
      const token = new URL(String(line.meta!.link)).searchParams.get('token')!

      expect((await post('/api/auth/reset', { token, password: NEW_PASSWORD })).status).toBe(200)
      expect((await login(alice.email, NEW_PASSWORD)).status).toBe(200)
    })
  })
})
