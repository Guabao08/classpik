import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ConsoleTransport,
  Dispatcher,
  PermanentDeliveryError,
  renderMessage,
  WebhookTransport,
  type NotificationPayload,
  type Transport,
} from '../src/core/notify.js'
import type { EventRow, SectionRow } from '../src/core/repo.js'
import { setupEnv, SCHOOL_ID, TERM, type TestEnv } from './helpers.js'
import type { RawSection } from '../src/adapters/types.js'

const raw = (over: Partial<RawSection> = {}): RawSection => ({
  crn: '30412', subject: 'MATH', courseNumber: '221', code: 'MATH 221',
  title: 'Linear Algebra', section: 'B', credits: 3, instructor: null,
  meetingDays: null, meetingTime: null, campus: null, level: null,
  seats: 0, capacity: 90, enrollment: 90, waitlist: 14, waitlistCap: 25, waitlistAvailable: 11,
  ...over,
})

class FailingTransport implements Transport {
  readonly channel = 'console'
  attempts = 0
  constructor(private readonly failTimes: number) {}
  async send(): Promise<void> {
    this.attempts++
    if (this.attempts <= this.failTimes) throw new Error(`attempt ${this.attempts} failed`)
  }
}

class RefusingTransport implements Transport {
  readonly channel = 'console'
  attempts = 0
  constructor(private readonly reason = 'not a usable email address: bogus') {}
  async send(): Promise<void> {
    this.attempts++
    throw new PermanentDeliveryError(this.reason)
  }
}

describe('renderMessage', () => {
  const section = { code: 'MATH 221', section: 'B', title: 'Linear Algebra', capacity: 90 } as SectionRow

  it('uses singular wording for one seat', () => {
    const m = renderMessage(section, { kind: 'seat_opened', new_seats: 1, detail: '' } as EventRow)
    expect(m.title).toBe('MATH 221 B has a seat open')
  })

  it('uses plural wording for several', () => {
    const m = renderMessage(section, { kind: 'seat_opened', new_seats: 4, detail: '' } as EventRow)
    expect(m.title).toBe('MATH 221 B has 4 seats open')
    expect(m.body).toContain('4 of 90 free')
  })

  it('has distinct copy for a waitlist opening', () => {
    const m = renderMessage(section, { kind: 'waitlist_opened', new_seats: 0, detail: '' } as EventRow)
    expect(m.title).toContain('waitlist reopened')
  })

  it('falls back to the event detail for other kinds', () => {
    const m = renderMessage(section, {
      kind: 'capacity_changed', new_seats: 0, detail: 'Capacity changed from 90 to 120',
    } as EventRow)
    expect(m.body).toBe('Capacity changed from 90 to 120')
  })
})

describe('WebhookTransport', () => {
  const payload = {
    watchId: 'w', userId: 'u',
    section: { id: 's', code: 'MATH 221', section: 'B', crn: '30412', title: 'Linear Algebra', seats: 1, capacity: 90, waitlist: 0 } as SectionRow,
    event: { kind: 'seat_opened', at: 123 } as EventRow,
    title: 'MATH 221 B has a seat open',
    body: 'Register now',
  } as NotificationPayload

  /** Public DNS, injected, so the suite never resolves a name off the machine. */
  const publicDns = async () => ['203.0.113.10']
  const webhook = (fetchImpl?: typeof fetch, lookup = publicDns) =>
    new WebhookTransport(fetchImpl ?? globalThis.fetch, 10_000, { lookup })

  it('POSTs JSON to the target', async () => {
    let seen: { url: string; body: unknown; redirect: unknown } | null = null
    const fetchImpl = (async (url: string | URL, init: RequestInit = {}) => {
      seen = { url: String(url), body: JSON.parse(init.body as string), redirect: init.redirect }
      return new Response('', { status: 200 })
    }) as unknown as typeof fetch

    await webhook(fetchImpl).send(payload, 'https://hooks.test/abc')
    expect(seen!.url).toBe('https://hooks.test/abc')
    expect(seen!.body).toMatchObject({ type: 'seat_opened', title: 'MATH 221 B has a seat open' })
    // A redirect is a second URL nobody validated, so it is never followed.
    expect(seen!.redirect).toBe('manual')
  })

  it('requires a target', async () => {
    await expect(new WebhookTransport().send(payload, null)).rejects.toThrow(/requires a target/)
  })

  it('rejects a malformed URL', async () => {
    await expect(new WebhookTransport().send(payload, 'not a url')).rejects.toThrow(/invalid webhook URL/)
  })

  it('refuses plain HTTP to a remote host, since alerts carry schedule data', async () => {
    await expect(new WebhookTransport().send(payload, 'http://evil.test/x')).rejects.toThrow(/non-HTTPS/)
  })

  it('refuses a private address by default, whatever the scheme', async () => {
    // The server is the one making this request, so a loopback target reaches
    // services that assume network isolation, and 169.254.169.254 is the cloud
    // metadata endpoint. The response status came back through
    // notifications.last_error, which made this a crude internal port scanner.
    const never = (async () => {
      throw new Error('should not have been fetched')
    }) as unknown as typeof fetch
    for (const target of [
      'http://localhost:9999/hook',
      'http://127.0.0.1:6379/x',
      'https://10.0.0.5/hook',
      'https://169.254.169.254/latest/meta-data/',
      'https://172.16.4.4/hook',
      'https://[fd00::1]/hook',
      'https://sink.local/hook',
    ]) {
      await expect(new WebhookTransport(never).send(payload, target), target).rejects.toThrow(
        /private address|non-HTTPS/
      )
    }
  })

  it('refuses a public name that resolves to a private address', async () => {
    const never = (async () => {
      throw new Error('should not have been fetched')
    }) as unknown as typeof fetch
    await expect(
      webhook(never, async () => ['10.1.2.3']).send(payload, 'https://internal.evil.test/hook')
    ).rejects.toThrow(/private address/)
  })

  it('allows http on localhost only when development mode is switched on', async () => {
    const fetchImpl = (async () => new Response('', { status: 200 })) as unknown as typeof fetch
    const dev = new WebhookTransport(fetchImpl, 10_000, { allowPrivateTargets: true })
    await expect(dev.send(payload, 'http://localhost:9999/hook')).resolves.toBeUndefined()
  })

  it('treats a redirect as a failure rather than following it somewhere unvalidated', async () => {
    const fetchImpl = (async () => new Response('', { status: 302 })) as unknown as typeof fetch
    await expect(webhook(fetchImpl).send(payload, 'https://hooks.test/x')).rejects.toThrow(/redirect/)
  })

  it('throws on a non-2xx response so the queue retries', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch
    await expect(webhook(fetchImpl).send(payload, 'https://hooks.test/x')).rejects.toThrow(/500/)
  })
})

describe('Dispatcher', () => {
  let env: TestEnv
  let sid: string

  beforeEach(() => {
    env = setupEnv()
    const target = env.repo.ensureTarget(SCHOOL_ID, TERM, 'MATH', 60_000)
    sid = env.repo.upsertSection(target, raw({ seats: 1 }), false)
  })
  afterEach(() => env.close())

  const queue = (channel = 'console', target: string | null = null) => {
    const watch = env.repo.createWatch({ userId: 'roshan', sectionId: sid, channel, target })
    const eventId = env.repo.recordEvent(sid, {
      kind: 'seat_opened', prevSeats: 0, newSeats: 1, prevWaitlist: 0, newWaitlist: 0,
      detail: '1 seat opened',
    })
    env.repo.enqueueNotification(watch, eventId)
    return { watch, eventId }
  }

  it('delivers a pending notification', async () => {
    queue()
    const transport = new ConsoleTransport(() => {})
    const d = new Dispatcher(env.repo, [transport], { now: () => env.clock.now })

    const result = await d.flush()
    expect(result.delivered).toBe(1)
    expect(transport.sent[0]!.title).toContain('MATH 221 B')
  })

  it('drains the queue so a second flush does nothing', async () => {
    queue()
    const d = new Dispatcher(env.repo, [new ConsoleTransport(() => {})], { now: () => env.clock.now })
    await d.flush()
    expect((await d.flush()).delivered).toBe(0)
  })

  it('schedules a retry with growing backoff after a failure', async () => {
    queue()
    const d = new Dispatcher(env.repo, [new FailingTransport(10)], {
      now: () => env.clock.now, baseRetryMs: 1000, maxAttempts: 5,
    })

    expect((await d.flush()).retrying).toBe(1)
    // Held back until its retry time.
    expect((await d.flush()).retrying).toBe(0)

    env.clock.now += 1000
    expect((await d.flush()).retrying).toBe(1)
    env.clock.now += 1000
    // Second backoff is 2x, so 1s is not yet enough.
    expect((await d.flush()).retrying).toBe(0)
  })

  it('eventually succeeds when the transport recovers', async () => {
    queue()
    const transport = new FailingTransport(2)
    const d = new Dispatcher(env.repo, [transport], { now: () => env.clock.now, baseRetryMs: 1 })

    await d.flush()
    env.clock.now += 10
    await d.flush()
    env.clock.now += 10
    expect((await d.flush()).delivered).toBe(1)
    expect(transport.attempts).toBe(3)
  })

  it('gives up after maxAttempts and marks the notification failed', async () => {
    queue()
    const d = new Dispatcher(env.repo, [new FailingTransport(100)], {
      now: () => env.clock.now, baseRetryMs: 1, maxAttempts: 3,
    })

    for (let i = 0; i < 3; i++) {
      await d.flush()
      env.clock.now += 100_000
    }
    const pending = env.repo.pendingNotifications(10, env.clock.now + 1e9)
    expect(pending).toHaveLength(0)
  })

  it('retries when no transport is registered rather than dropping the alert', async () => {
    queue('sms', '+15555550123')
    const d = new Dispatcher(env.repo, [], { now: () => env.clock.now })
    const result = await d.flush()
    expect(result.retrying).toBe(1)
    expect(result.delivered).toBe(0)
  })

  it('routes each notification to the transport for its channel', async () => {
    const consoleT = new ConsoleTransport(() => {})
    let webhookCalls = 0
    const fetchImpl = (async () => { webhookCalls++; return new Response('', { status: 200 }) }) as unknown as typeof fetch

    const target2 = env.repo.ensureTarget(SCHOOL_ID, TERM, 'CS', 60_000)
    const sid2 = env.repo.upsertSection(target2, raw({ crn: '30188', subject: 'CS', code: 'CS 260' }), false)
    const w2 = env.repo.createWatch({ userId: 'andy', sectionId: sid2, channel: 'webhook', target: 'https://hooks.test/a' })
    const e2 = env.repo.recordEvent(sid2, {
      kind: 'seat_opened', prevSeats: 0, newSeats: 1, prevWaitlist: 0, newWaitlist: 0, detail: 'x',
    })
    env.repo.enqueueNotification(w2, e2)
    queue()

    const d = new Dispatcher(
      env.repo,
      [consoleT, new WebhookTransport(fetchImpl, 10_000, { lookup: async () => ['203.0.113.10'] })],
      { now: () => env.clock.now }
    )
    const result = await d.flush()

    expect(result.delivered).toBe(2)
    expect(consoleT.sent).toHaveLength(1)
    expect(webhookCalls).toBe(1)
  })

  it('stops immediately on a permanent rejection instead of climbing the retry ladder', async () => {
    queue()
    const transport = new RefusingTransport()
    const d = new Dispatcher(env.repo, [transport], {
      now: () => env.clock.now, baseRetryMs: 1, maxAttempts: 5,
    })

    const result = await d.flush()
    expect(result.failed).toBe(1)
    expect(result.retrying).toBe(0)

    env.clock.now += 1_000_000
    expect(await d.flush()).toMatchObject({ delivered: 0, retrying: 0, failed: 0 })
    expect(transport.attempts).toBe(1)
  })

  it('keeps the reason for a permanent rejection, which is the point of not retrying it', async () => {
    queue()
    const d = new Dispatcher(env.repo, [new RefusingTransport('550 no such mailbox')], {
      now: () => env.clock.now,
    })
    await d.flush()

    const row = env.repo.getNotification(1)!
    expect(row.status).toBe('failed')
    expect(row.attempts).toBe(1)
    expect(row.last_error).toContain('550 no such mailbox')
  })

  it('still retries an ordinary failure, so one permanent case does not make everything permanent', async () => {
    queue()
    const d = new Dispatcher(env.repo, [new FailingTransport(1)], {
      now: () => env.clock.now, baseRetryMs: 1,
    })
    expect((await d.flush()).retrying).toBe(1)
    env.clock.now += 10
    expect((await d.flush()).delivered).toBe(1)
  })

  it('reports the channels it can actually deliver, so the API can refuse the rest', async () => {
    const d = new Dispatcher(env.repo, [new ConsoleTransport(() => {}), new WebhookTransport()], {
      now: () => env.clock.now,
    })
    expect(d.channels).toEqual(['console', 'webhook'])
    expect(d.supports('console')).toBe(true)
    expect(d.supports('email')).toBe(false)
  })

  it('supports registering a transport after construction', async () => {
    queue()
    const d = new Dispatcher(env.repo, [], { now: () => env.clock.now })
    const t = new ConsoleTransport(() => {})
    d.register(t)
    expect((await d.flush()).delivered).toBe(1)
  })

  it('delivers an alert for an event older than the recent-history window', async () => {
    // The event used to be found by scanning the 200 most recent events for the
    // section. A notification on the retry ladder for a section that churns
    // past that window failed with "event N no longer exists", which is false:
    // the row is still there, nothing deletes events, and the student lost the
    // alert to a misleading error after five attempts.
    const { eventId } = queue()
    for (let i = 0; i < 220; i++) {
      env.clock.now += 1_000
      env.repo.recordEvent(sid, {
        kind: 'capacity_changed', prevSeats: 1, newSeats: 1, prevWaitlist: 0, newWaitlist: 0,
        detail: `churn ${i}`,
      })
    }
    expect(env.repo.listEvents({ sectionId: sid, limit: 200 }).some((e) => e.id === eventId)).toBe(false)

    const transport = new ConsoleTransport(() => {})
    const d = new Dispatcher(env.repo, [transport], { now: () => env.clock.now })
    expect((await d.flush()).delivered).toBe(1)
    expect(transport.sent[0]!.event.id).toBe(eventId)
  })

  it('respects the flush limit', async () => {
    const target2 = env.repo.ensureTarget(SCHOOL_ID, TERM, 'CS', 60_000)
    const sid2 = env.repo.upsertSection(target2, raw({ crn: '99', subject: 'CS', code: 'CS 260' }), false)
    const w2 = env.repo.createWatch({ userId: 'andy', sectionId: sid2 })
    const e2 = env.repo.recordEvent(sid2, {
      kind: 'seat_opened', prevSeats: 0, newSeats: 1, prevWaitlist: 0, newWaitlist: 0, detail: 'x',
    })
    env.repo.enqueueNotification(w2, e2)
    queue()

    const d = new Dispatcher(env.repo, [new ConsoleTransport(() => {})], { now: () => env.clock.now })
    expect((await d.flush(1)).delivered).toBe(1)
    expect((await d.flush(10)).delivered).toBe(1)
  })
})
