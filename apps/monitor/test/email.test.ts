import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { composeAlertEmail, ResendTransport, RESEND_ENDPOINT } from '../src/core/email.js'
import { emailFromEnv } from '../src/config/email.js'
import { Dispatcher, PermanentDeliveryError, type NotificationPayload } from '../src/core/notify.js'
import type { EventRow, SectionRow } from '../src/core/repo.js'
import type { RawSection } from '../src/adapters/types.js'
import { SCHOOL_ID, setupEnv, TERM, type TestEnv } from './helpers.js'

const API_KEY = 're_test_00000000_notarealkey'
const IDENTITY = { from: 'ClassPik <alerts@classpik.app>', replyTo: null }

const section = (over: Partial<SectionRow> = {}): SectionRow =>
  ({
    id: 'test-university:202608:30412',
    school_id: SCHOOL_ID,
    term: '202608',
    crn: '30412',
    subject: 'MATH',
    course_number: '221',
    code: 'MATH 221',
    title: 'Linear Algebra',
    section: 'B',
    instructor: 'A. Lovelace',
    meeting_days: 'MWF',
    meeting_time: '10:00 am',
    campus: 'Main',
    seats: 1,
    capacity: 90,
    enrollment: 89,
    waitlist: 0,
    waitlist_cap: 25,
    ...over,
  }) as SectionRow

const payload = (over: Partial<NotificationPayload> = {}): NotificationPayload => ({
  watchId: 'watch-1',
  userId: 'user-1',
  section: section(),
  event: { id: 77, kind: 'seat_opened', new_seats: 1, at: Date.UTC(2026, 6, 28, 22, 4, 11) } as EventRow,
  title: 'MATH 221 B has a seat open',
  body: 'Linear Algebra. 1 of 90 free. Register before it goes.',
  ...over,
})

interface Capture {
  url: string
  init: RequestInit
  body: Record<string, unknown>
}

/** A fetch that records the call and answers with whatever the test wants. */
function fakeFetch(
  respond: () => Response | Promise<Response>
): { impl: typeof fetch; calls: Capture[] } {
  const calls: Capture[] = []
  const impl = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init, body: JSON.parse(init.body as string) })
    return await respond()
  }) as unknown as typeof fetch
  return { impl, calls }
}

const ok = () => new Response(JSON.stringify({ id: '49a3999c-0ce1-4ea6-ab68-afcd6dc2e794' }), { status: 200 })

const transport = (respond: () => Response | Promise<Response> = ok) => {
  const { impl, calls } = fakeFetch(respond)
  return { t: new ResendTransport({ apiKey: API_KEY, ...IDENTITY, fetchImpl: impl }), calls }
}

describe('alert composition', () => {
  it('uses the notification title as the subject, so a lock screen shows the decision', () => {
    const m = composeAlertEmail(payload(), 'student@example.edu', IDENTITY)
    expect(m.subject).toBe('MATH 221 B has a seat open')
  })

  it('carries the facts a student needs to act in both alternatives', () => {
    const m = composeAlertEmail(payload(), 'student@example.edu', IDENTITY)
    for (const part of [m.text, m.html]) {
      expect(part).toContain('MATH 221 B')
      expect(part).toContain('Linear Algebra')
      expect(part).toContain('30412')
      expect(part).toContain('1 of 90')
      expect(part).toContain('A. Lovelace')
      expect(part).toContain('MWF 10:00 am')
    }
  })

  it('says how to stop the alerts, in both alternatives', () => {
    const m = composeAlertEmail(payload(), 'student@example.edu', IDENTITY)
    expect(m.text).toContain('Remove the watch')
    expect(m.html).toContain('Remove the watch')
  })

  it('omits optional facts rather than printing empty labels', () => {
    const bare = section({ instructor: null, meeting_days: null, meeting_time: null, campus: null, waitlist_cap: 0 })
    const m = composeAlertEmail(payload({ section: bare }), 'student@example.edu', IDENTITY)
    expect(m.text).not.toContain('Instructor')
    expect(m.text).not.toContain('Meets')
    expect(m.text).not.toContain('Campus')
    expect(m.text).not.toContain('Waitlist')
  })

  it('escapes a course title so a registrar cannot inject markup into the HTML part', () => {
    const nasty = section({ title: 'Algebra <script>alert(1)</script>' })
    const m = composeAlertEmail(payload({ section: nasty }), 'student@example.edu', IDENTITY)
    expect(m.html).not.toContain('<script>')
    expect(m.html).toContain('&lt;script&gt;')
  })

  it('dates the message when the seat opened rather than when we got round to sending', () => {
    const m = composeAlertEmail(payload(), 'student@example.edu', IDENTITY)
    expect(m.date).toBe(Date.UTC(2026, 6, 28, 22, 4, 11))
  })

  it('reuses one Message-ID across retries so a receiver can drop a duplicate copy', () => {
    const first = composeAlertEmail(payload(), 'student@example.edu', IDENTITY)
    const second = composeAlertEmail(payload(), 'student@example.edu', IDENTITY)
    expect(first.messageId).toBe(second.messageId)
    expect(first.messageId).toBe('<watch-1.77@classpik.app>')
  })

  it('gives a different event its own Message-ID', () => {
    const other = payload({ event: { id: 78, kind: 'seat_opened', at: 1 } as EventRow })
    expect(composeAlertEmail(other, 'student@example.edu', IDENTITY).messageId).toBe(
      '<watch-1.78@classpik.app>'
    )
  })
})

describe('ResendTransport', () => {
  it('posts the message to the documented endpoint', async () => {
    const { t, calls } = transport()
    await t.send(payload(), 'student@example.edu')

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(RESEND_ENDPOINT)
    expect(calls[0]!.init.method).toBe('POST')
    expect(calls[0]!.body).toMatchObject({
      from: 'ClassPik <alerts@classpik.app>',
      to: 'student@example.edu',
      subject: 'MATH 221 B has a seat open',
    })
    expect(String(calls[0]!.body.text)).toContain('MATH 221 B')
    expect(String(calls[0]!.body.html)).toContain('<html')
  })

  it('authenticates with a bearer token', async () => {
    const { t, calls } = transport()
    await t.send(payload(), 'student@example.edu')
    const headers = calls[0]!.init.headers as Record<string, string>
    expect(headers.Authorization).toBe(`Bearer ${API_KEY}`)
    expect(headers['Content-Type']).toBe('application/json')
  })

  it('derives the idempotency key from the watch and event, so a retry cannot double-send', async () => {
    const { t, calls } = transport()
    await t.send(payload(), 'student@example.edu')
    await t.send(payload(), 'student@example.edu')
    const keys = calls.map((c) => (c.init.headers as Record<string, string>)['Idempotency-Key'])
    expect(keys).toEqual(['watch-1:77', 'watch-1:77'])
  })

  it('marks itself auto-generated so vacation responders stay out of the queue', async () => {
    const { t, calls } = transport()
    await t.send(payload(), 'student@example.edu')
    expect(calls[0]!.body.headers).toMatchObject({ 'Auto-Submitted': 'auto-generated' })
  })

  it('sends reply_to only when one is configured', async () => {
    const { impl, calls } = fakeFetch(ok)
    await new ResendTransport({ apiKey: API_KEY, from: IDENTITY.from, fetchImpl: impl }).send(
      payload(),
      'student@example.edu'
    )
    expect(calls[0]!.body).not.toHaveProperty('reply_to')

    const second = fakeFetch(ok)
    await new ResendTransport({
      apiKey: API_KEY,
      from: IDENTITY.from,
      replyTo: 'help@classpik.app',
      fetchImpl: second.impl,
    }).send(payload(), 'student@example.edu')
    expect(second.calls[0]!.body.reply_to).toBe('help@classpik.app')
  })

  it('treats a rejected from-domain as permanent instead of retrying it four more times', async () => {
    const { t } = transport(
      () =>
        new Response(JSON.stringify({ name: 'invalid_from_address', message: 'domain is not verified' }), {
          status: 422,
        })
    )
    await expect(t.send(payload(), 'student@example.edu')).rejects.toThrow(PermanentDeliveryError)
    await expect(t.send(payload(), 'student@example.edu')).rejects.toThrow(/domain is not verified/)
  })

  it('treats a rejected API key as permanent', async () => {
    const { t } = transport(() => new Response('{"message":"invalid api key"}', { status: 403 }))
    await expect(t.send(payload(), 'student@example.edu')).rejects.toThrow(PermanentDeliveryError)
  })

  it('treats a rate limit as transient, since it is exactly what backoff is for', async () => {
    const { t } = transport(() => new Response('{"message":"rate limit"}', { status: 429 }))
    const err = await t.send(payload(), 'student@example.edu').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(PermanentDeliveryError)
  })

  it('treats a provider outage as transient', async () => {
    const { t } = transport(() => new Response('gateway timeout', { status: 503 }))
    const err = await t.send(payload(), 'student@example.edu').catch((e: unknown) => e)
    expect(err).not.toBeInstanceOf(PermanentDeliveryError)
    expect((err as Error).message).toContain('503')
  })

  it('survives an error body that is not JSON, which is how providers report an edge failure', async () => {
    const { t } = transport(() => new Response('<html>Bad Gateway</html>', { status: 502 }))
    const err = await t.send(payload(), 'student@example.edu').catch((e: unknown) => e)
    expect((err as Error).message).toContain('502')
    expect((err as Error).message).toContain('Bad Gateway')
  })

  it('never puts the API key in the error, because the Dispatcher writes that to disk', async () => {
    const { t } = transport(() => new Response('{"message":"restricted_api_key"}', { status: 401 }))
    const err = await t.send(payload(), 'student@example.edu').catch((e: unknown) => e)
    expect((err as Error).message).not.toContain(API_KEY)
    expect((err as Error).message).not.toContain('Bearer')
  })

  it('treats a network failure as transient and keeps the key out of that message too', async () => {
    const impl = (async () => {
      throw new Error('fetch failed')
    }) as unknown as typeof fetch
    const t = new ResendTransport({ apiKey: API_KEY, ...IDENTITY, fetchImpl: impl })
    const err = await t.send(payload(), 'student@example.edu').catch((e: unknown) => e)
    expect(err).not.toBeInstanceOf(PermanentDeliveryError)
    expect((err as Error).message).toContain('fetch failed')
    expect((err as Error).message).not.toContain(API_KEY)
  })

  it('gives up on a hung provider rather than holding the flush loop open', async () => {
    const impl = (async (_url: string, init: RequestInit = {}) => {
      await new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('This operation was aborted')))
      })
      return new Response('', { status: 200 })
    }) as unknown as typeof fetch

    const t = new ResendTransport({ apiKey: API_KEY, ...IDENTITY, fetchImpl: impl, timeoutMs: 25 })
    const err = await t.send(payload(), 'student@example.edu').catch((e: unknown) => e)
    expect(err).not.toBeInstanceOf(PermanentDeliveryError)
    expect((err as Error).message).toContain('aborted')
  })

  it('gives up on a provider that sends headers and then stalls the body', async () => {
    // The abort used to be disarmed the moment the headers arrived, so reading
    // the error body of a 502 whose chunked body never finished hung this send
    // forever, and with it the flush loop and the whole poll loop. A bad
    // gateway is a likelier way to lose the service than a dead relay is.
    const impl = (async (_url: string, init: RequestInit = {}) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"mess'))
          // Real fetch errors the body stream on abort. Nothing else ever ends it.
          init.signal?.addEventListener('abort', () => controller.error(new Error('aborted')))
        },
      })
      return new Response(body, { status: 502 })
    }) as unknown as typeof fetch

    const t = new ResendTransport({ apiKey: API_KEY, ...IDENTITY, fetchImpl: impl, timeoutMs: 25 })
    const err = await t.send(payload(), 'student@example.edu').catch((e: unknown) => e)

    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(PermanentDeliveryError)
    expect((err as Error).message).toContain('502')
  })

  it('rejects a malformed address without spending a request on it', async () => {
    const { t, calls } = transport()
    await expect(t.send(payload(), 'not-an-address')).rejects.toThrow(PermanentDeliveryError)
    await expect(t.send(payload(), 'not-an-address')).rejects.toThrow(/not a usable email address/)
    expect(calls).toHaveLength(0)
  })

  it('rejects a missing address, since no retry will supply one', async () => {
    const { t, calls } = transport()
    await expect(t.send(payload(), null)).rejects.toThrow(PermanentDeliveryError)
    expect(calls).toHaveLength(0)
  })

  it('refuses a course title carrying a line break rather than letting it become a header', async () => {
    const { t, calls } = transport()
    const injected = payload({ title: 'seat open\r\nBcc: attacker@evil.test' })
    await expect(t.send(injected, 'student@example.edu')).rejects.toThrow(PermanentDeliveryError)
    expect(calls).toHaveLength(0)
  })

  it('refuses to construct with a From address nobody could send from', () => {
    expect(() => new ResendTransport({ apiKey: API_KEY, from: 'alerts-at-classpik' })).toThrow(
      /not a usable email address/
    )
  })
})

describe('emailFromEnv', () => {
  it('offers no email channel at all when nothing is configured', () => {
    expect(emailFromEnv({})).toBeNull()
    expect(emailFromEnv({ CLASSPIK_EMAIL_PROVIDER: '  ' })).toBeNull()
  })

  it('builds a Resend transport on the email channel', () => {
    const setup = emailFromEnv({
      CLASSPIK_EMAIL_PROVIDER: 'resend',
      CLASSPIK_EMAIL_FROM: 'ClassPik <alerts@classpik.app>',
      RESEND_API_KEY: API_KEY,
    })
    expect(setup?.provider).toBe('resend')
    expect(setup?.transport.channel).toBe('email')
  })

  it('never puts the API key in the startup log line', () => {
    const setup = emailFromEnv({
      CLASSPIK_EMAIL_PROVIDER: 'resend',
      CLASSPIK_EMAIL_FROM: 'alerts@classpik.app',
      RESEND_API_KEY: API_KEY,
    })
    expect(setup?.detail).not.toContain(API_KEY)
  })

  it('defaults SMTP to implicit TLS on 465, which has no downgrade window', () => {
    const setup = emailFromEnv({
      CLASSPIK_EMAIL_PROVIDER: 'smtp',
      CLASSPIK_EMAIL_FROM: 'alerts@classpik.app',
      CLASSPIK_SMTP_HOST: 'smtp.resend.com',
    })
    expect(setup?.detail).toContain('465')
    expect(setup?.detail).toContain('implicit tls')
  })

  it('defaults to 587 when the operator asks for STARTTLS', () => {
    const setup = emailFromEnv({
      CLASSPIK_EMAIL_PROVIDER: 'smtp',
      CLASSPIK_EMAIL_FROM: 'alerts@classpik.app',
      CLASSPIK_SMTP_HOST: 'smtp.resend.com',
      CLASSPIK_SMTP_STARTTLS: '1',
    })
    expect(setup?.detail).toContain('587')
    expect(setup?.detail).toContain('starttls')
  })

  it('fails loudly on a provider asked for but not finished, rather than quietly not sending', () => {
    expect(() =>
      emailFromEnv({ CLASSPIK_EMAIL_PROVIDER: 'resend', CLASSPIK_EMAIL_FROM: 'a@b.test' })
    ).toThrow(/RESEND_API_KEY is required/)
    expect(() => emailFromEnv({ CLASSPIK_EMAIL_PROVIDER: 'resend' })).toThrow(
      /CLASSPIK_EMAIL_FROM is required/
    )
    expect(() =>
      emailFromEnv({ CLASSPIK_EMAIL_PROVIDER: 'smtp', CLASSPIK_EMAIL_FROM: 'a@b.test' })
    ).toThrow(/CLASSPIK_SMTP_HOST is required/)
  })

  it('requires TLS unless an operator explicitly gives it up, and says so in the log line', () => {
    const strict = emailFromEnv({
      CLASSPIK_EMAIL_PROVIDER: 'smtp',
      CLASSPIK_EMAIL_FROM: 'alerts@classpik.app',
      CLASSPIK_SMTP_HOST: 'relay.internal',
      CLASSPIK_SMTP_STARTTLS: '1',
    })
    expect(strict?.detail).not.toContain('NOT REQUIRED')

    const relaxed = emailFromEnv({
      CLASSPIK_EMAIL_PROVIDER: 'smtp',
      CLASSPIK_EMAIL_FROM: 'alerts@classpik.app',
      CLASSPIK_SMTP_HOST: 'localhost',
      CLASSPIK_SMTP_STARTTLS: '1',
      CLASSPIK_SMTP_REQUIRE_TLS: '0',
    })
    // Opting out has to be visible at startup, since nothing later will say it.
    expect(relaxed?.detail).toContain('NOT REQUIRED')
  })

  it('rejects an SMTP user without a password, which fails invisibly at the relay', () => {
    expect(() =>
      emailFromEnv({
        CLASSPIK_EMAIL_PROVIDER: 'smtp',
        CLASSPIK_EMAIL_FROM: 'a@b.test',
        CLASSPIK_SMTP_HOST: 'smtp.test',
        CLASSPIK_SMTP_USER: 'resend',
      })
    ).toThrow(/must be set together/)
  })

  it('rejects an unknown provider by name', () => {
    expect(() => emailFromEnv({ CLASSPIK_EMAIL_PROVIDER: 'sendgrid' })).toThrow(/"resend" or "smtp"/)
  })

  it('rejects a From address at boot rather than at the moment a seat opens', () => {
    expect(() =>
      emailFromEnv({
        CLASSPIK_EMAIL_PROVIDER: 'resend',
        CLASSPIK_EMAIL_FROM: 'ClassPik <alerts at classpik>',
        RESEND_API_KEY: API_KEY,
      })
    ).toThrow(/CLASSPIK_EMAIL_FROM is not usable/)
  })

  it('rejects a port that is not a port', () => {
    expect(() =>
      emailFromEnv({
        CLASSPIK_EMAIL_PROVIDER: 'smtp',
        CLASSPIK_EMAIL_FROM: 'a@b.test',
        CLASSPIK_SMTP_HOST: 'smtp.test',
        CLASSPIK_SMTP_PORT: 'submission',
      })
    ).toThrow(/not a port number/)
  })
})

describe('email through the delivery queue', () => {
  let env: TestEnv
  let sid: string

  const rawSection: RawSection = {
    crn: '30412', subject: 'MATH', courseNumber: '221', code: 'MATH 221',
    title: 'Linear Algebra', section: 'B', credits: 3, instructor: 'A. Lovelace',
    meetingDays: 'MWF', meetingTime: '10:00 am', campus: 'Main', level: 'UGRD',
    seats: 1, capacity: 90, enrollment: 89, waitlist: 0, waitlistCap: 25, waitlistAvailable: 25,
  }

  beforeEach(() => {
    env = setupEnv()
    const target = env.repo.ensureTarget(SCHOOL_ID, TERM, 'MATH', 60_000)
    sid = env.repo.upsertSection(target, rawSection, false)
  })
  afterEach(() => env.close())

  const queue = (address: string | null): void => {
    const watch = env.repo.createWatch({
      userId: 'roshan', sectionId: sid, channel: 'email', target: address,
    })
    const eventId = env.repo.recordEvent(sid, {
      kind: 'seat_opened', prevSeats: 0, newSeats: 1, prevWaitlist: 0, newWaitlist: 0,
      detail: '1 seat opened',
    })
    env.repo.enqueueNotification(watch, eventId)
  }

  it('delivers a queued email watch end to end', async () => {
    queue('student@example.edu')
    const { impl, calls } = fakeFetch(ok)
    const d = new Dispatcher(
      env.repo,
      [new ResendTransport({ apiKey: API_KEY, ...IDENTITY, fetchImpl: impl })],
      { now: () => env.clock.now }
    )

    expect((await d.flush()).delivered).toBe(1)
    expect(calls[0]!.body.to).toBe('student@example.edu')
    expect(calls[0]!.body.subject).toBe('MATH 221 B has a seat open')
  })

  it('fails a permanently bad address on the first attempt instead of burning five', async () => {
    queue('student@@example.edu')
    const { impl, calls } = fakeFetch(ok)
    const d = new Dispatcher(
      env.repo,
      [new ResendTransport({ apiKey: API_KEY, ...IDENTITY, fetchImpl: impl })],
      { now: () => env.clock.now, baseRetryMs: 1, maxAttempts: 5 }
    )

    const result = await d.flush()
    expect(result.failed).toBe(1)
    expect(result.retrying).toBe(0)
    expect(calls).toHaveLength(0)

    // Nothing is left to pick up, however far the clock moves.
    env.clock.now += 1_000_000
    expect(await d.flush()).toMatchObject({ delivered: 0, retrying: 0, failed: 0 })
  })

  it('records why a permanent failure failed, so the address can be corrected', async () => {
    queue('student@@example.edu')
    const d = new Dispatcher(
      env.repo,
      [new ResendTransport({ apiKey: API_KEY, ...IDENTITY, fetchImpl: fakeFetch(ok).impl })],
      { now: () => env.clock.now }
    )
    await d.flush()

    const row = env.repo.getNotification(1)!
    expect(row.status).toBe('failed')
    expect(row.attempts).toBe(1)
    expect(row.last_error).toContain('not a usable email address')
  })

  it('retries a provider outage on the normal ladder', async () => {
    queue('student@example.edu')
    let calls = 0
    const impl = (async () => {
      calls++
      return calls === 1 ? new Response('{"message":"down"}', { status: 500 }) : ok()
    }) as unknown as typeof fetch

    const d = new Dispatcher(
      env.repo,
      [new ResendTransport({ apiKey: API_KEY, ...IDENTITY, fetchImpl: impl })],
      { now: () => env.clock.now, baseRetryMs: 1_000 }
    )

    expect((await d.flush()).retrying).toBe(1)
    env.clock.now += 1_000
    expect((await d.flush()).delivered).toBe(1)
    expect(calls).toBe(2)
  })
})
