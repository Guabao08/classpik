import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { createApi } from '../src/api/server.js'
import { Poller } from '../src/core/poller.js'
import { SubjectDiscovery } from '../src/core/discovery.js'
import { ConsoleTransport, Dispatcher } from '../src/core/notify.js'
import { FixtureAdapter, type FixtureSection } from '../src/adapters/fixture.js'
import type { SisAdapter, SisId, RawSection } from '../src/adapters/types.js'
import { sectionId } from '../src/core/repo.js'
import { authHeaders, setupEnv, signUp, SCHOOL_ID, TERM, TEST_PASSWORD, type TestAccount, type TestEnv } from './helpers.js'

/** Stands in for CLASSPIK_ADMIN_TOKEN. The operator-only routes need it. */
const ADMIN_TOKEN = 'test-operator-token'

const SECTIONS: FixtureSection[] = [
  { crn: '30412', subject: 'MATH', courseNumber: '221', title: 'Linear Algebra', section: 'B', seats: 0, capacity: 90, waitlist: 14, waitlistCap: 25 },
  { crn: '30418', subject: 'MATH', courseNumber: '221', title: 'Linear Algebra', section: 'E', seats: 22, capacity: 90, waitlist: 0, waitlistCap: 25 },
]

const raw = (over: Partial<RawSection> = {}): RawSection => ({
  crn: '30412', subject: 'MATH', courseNumber: '221', code: 'MATH 221',
  title: 'Linear Algebra', section: 'B', credits: 3, instructor: 'Whitfield',
  meetingDays: 'MWF', meetingTime: '10:00a', campus: null, level: null,
  seats: 0, capacity: 90, enrollment: 90, waitlist: 14, waitlistCap: 25, waitlistAvailable: 11,
  ...over,
})

describe('API', () => {
  let env: TestEnv
  let server: Server
  let base: string
  let sid: string
  let alice: TestAccount
  let dispatcher: Dispatcher

  beforeEach(async () => {
    env = setupEnv()
    const target = env.repo.ensureTarget(SCHOOL_ID, TERM, 'MATH', 60_000)
    sid = env.repo.upsertSection(target, raw(), false)
    env.repo.upsertSection(target, raw({ crn: '30418', section: 'E', seats: 22 }), false)
    env.repo.replaceTerms(SCHOOL_ID, [{ code: TERM, description: 'Fall 2026' }])

    const adapters = new Map<SisId, SisAdapter>([['banner9', new FixtureAdapter(SECTIONS)]])
    dispatcher = new Dispatcher(env.repo, [new ConsoleTransport(() => {})], { now: () => env.clock.now })
    const poller = new Poller(env.repo, adapters, dispatcher, { now: () => env.clock.now })
    const discovery = new SubjectDiscovery(env.repo, adapters, { now: () => env.clock.now })

    server = createApi({
      repo: env.repo,
      poller,
      dispatcher,
      discovery,
      adminToken: ADMIN_TOKEN,
      corsOrigins: ['http://localhost:5173'],
      now: () => env.clock.now,
    })
    await new Promise<void>((r) => server.listen(0, r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    alice = await signUp(base, 'alice@classpik.test')
  })

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()))
    env.close()
  })

  // Every helper defaults to alice's token. Pass null to send no credentials.
  const get = (path: string, token: string | null = alice.token) =>
    fetch(`${base}${path}`, { headers: authHeaders(token) })
  const post = (path: string, body?: unknown, token: string | null = alice.token) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  const del = (path: string, token: string | null = alice.token) =>
    fetch(`${base}${path}`, { method: 'DELETE', headers: authHeaders(token) })

  it('reports health', async () => {
    const res = await get('/health')
    expect(res.status).toBe(200)
    expect(await res.json() as any).toEqual({ ok: true })
  })

  it('404s an unknown route with a useful message', async () => {
    const res = await get('/nope')
    expect(res.status).toBe(404)
    expect((await res.json() as any).error).toContain('GET /nope')
  })

  it('lists schools with their terms', async () => {
    const body = await (await get('/api/schools')).json() as any
    expect(body).toHaveLength(1)
    expect(body[0]).toMatchObject({ id: SCHOOL_ID, sis: 'banner9' })
    expect(body[0].terms).toEqual([{ code: TERM, description: 'Fall 2026' }])
  })

  it('returns stats', async () => {
    const body = await (await get('/api/stats')).json() as any
    expect(body).toMatchObject({ schools: 1, sections: 2, watches: 0 })
  })

  describe('GET /api/sections', () => {
    it('lists every section', async () => {
      const body = await (await get('/api/sections')).json() as any
      expect(body.count).toBe(2)
      expect(body.sections[0]).toHaveProperty('crn')
      expect(body.sections[0]).toHaveProperty('status')
    })

    it('filters by search query', async () => {
      expect((await (await get('/api/sections?q=math221')).json() as any).count).toBe(2)
      expect((await (await get('/api/sections?q=nothing')).json() as any).count).toBe(0)
    })

    it('filters by status', async () => {
      expect((await (await get('/api/sections?status=open')).json() as any).count).toBe(1)
      expect((await (await get('/api/sections?status=waitlist')).json() as any).count).toBe(1)
    })

    it('rejects a bad status instead of silently ignoring it', async () => {
      const res = await get('/api/sections?status=banana')
      expect(res.status).toBe(400)
    })

    it('clamps an absurd limit', async () => {
      expect((await get('/api/sections?limit=999999')).status).toBe(200)
    })

    it('returns one section with its event history', async () => {
      env.repo.recordEvent(sid, {
        kind: 'seat_opened', prevSeats: 0, newSeats: 1, prevWaitlist: 0, newWaitlist: 0, detail: '1 seat opened',
      })
      const body = await (await get(`/api/sections/${encodeURIComponent(sid)}`)).json() as any
      expect(body.section.crn).toBe('30412')
      expect(body.events).toHaveLength(1)
    })

    it('404s an unknown section', async () => {
      expect((await get('/api/sections/nope')).status).toBe(404)
    })
  })

  describe('watches', () => {
    it('creates a watch', async () => {
      const res = await post('/api/watches', { sectionId: sid })
      expect(res.status).toBe(201)
      const body = await res.json() as any
      expect(body.watch.mode).toBe('notify')
      expect(body.section.code).toBe('MATH 221')
    })

    it('lists the calling account\'s watches', async () => {
      await post('/api/watches', { sectionId: sid })
      const body = await (await get('/api/watches')).json() as any
      expect(body.watches).toHaveLength(1)
      expect(body.watches[0].section.crn).toBe('30412')
    })

    it('keeps users separate', async () => {
      const bob = await signUp(base, 'bob@classpik.test')
      await post('/api/watches', { sectionId: sid })
      expect((await (await get('/api/watches', bob.token)).json() as any).watches).toHaveLength(0)
    })

    it('is idempotent', async () => {
      await post('/api/watches', { sectionId: sid })
      await post('/api/watches', { sectionId: sid })
      expect((await (await get('/api/watches')).json() as any).watches).toHaveLength(1)
    })

    it('deletes a watch', async () => {
      const created = await (await post('/api/watches', { sectionId: sid })).json() as any
      const res = await del(`/api/watches/${created.watch.id}`)
      expect(res.status).toBe(200)
      expect((await (await get('/api/watches')).json() as any).watches).toHaveLength(0)
    })

    it('404s deleting an unknown watch', async () => {
      expect((await del('/api/watches/nope')).status).toBe(404)
    })

    it('rejects listing watches without a bearer token', async () => {
      const res = await get('/api/watches', null)
      expect(res.status).toBe(401)
      expect((await res.json() as any).error).toContain('authentication')
    })

    it('rejects a watch on a section that does not exist', async () => {
      const res = await post('/api/watches', { sectionId: 'ghost' })
      expect(res.status).toBe(404)
    })

    it('rejects an invalid mode', async () => {
      const res = await post('/api/watches', { sectionId: sid, mode: 'teleport' })
      expect(res.status).toBe(400)
    })

    it('requires a target for a webhook watch', async () => {
      const res = await post('/api/watches', { sectionId: sid, channel: 'webhook' })
      expect(res.status).toBe(400)
      expect((await res.json() as any).error).toContain('target')
    })

    it('refuses a webhook aimed at the machine the server runs on', async () => {
      // The server is the one that makes this request, so a loopback target is
      // a way to reach services that assume network isolation, and an RFC1918
      // or 169.254.169.254 target reaches the internal network and the cloud
      // metadata endpoint. It used to be stored verbatim with no check at all.
      for (const target of [
        'http://127.0.0.1:6379/x',
        'http://localhost:6379/x',
        'https://10.0.0.5/hook',
        'https://169.254.169.254/latest/meta-data/',
        'https://192.168.1.1/hook',
        'https://[::1]/hook',
      ]) {
        const res = await post('/api/watches', { sectionId: sid, channel: 'webhook', target })
        expect(res.status, target).toBe(400)
      }
      expect((await (await get('/api/watches')).json() as any).watches).toHaveLength(0)
    })

    it('refuses plain HTTP even to a public host, since alerts carry schedule data', async () => {
      const res = await post('/api/watches', { sectionId: sid, channel: 'webhook', target: 'http://hooks.test/x' })
      expect(res.status).toBe(400)
      expect((await res.json() as any).error).toContain('non-HTTPS')
    })

    it('accepts an ordinary HTTPS webhook', async () => {
      const res = await post('/api/watches', { sectionId: sid, channel: 'webhook', target: 'https://hooks.test/abc' })
      expect(res.status).toBe(201)
    })

    it('rejects a malformed JSON body', async () => {
      const res = await fetch(`${base}/api/watches`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(alice.token) },
        body: '{not json',
      })
      expect(res.status).toBe(400)
    })

    it('rejects a missing body', async () => {
      expect((await post('/api/watches')).status).toBe(400)
    })
  })

  describe('email watches', () => {
    /** Stands in for a configured provider. Nothing here sends anything. */
    const emailTransport = { channel: 'email', send: async () => {} }

    /**
     * Alerts only go to a proved address, so every test below that expects a
     * watch to be created has to start from one. The gate itself is covered in
     * auth.test.ts, next to the rest of the verification flow.
     */
    const verified = () => env.repo.markEmailVerified(alice.userId, env.clock.now)

    it('refuses an email watch to an address nobody has proved they read', async () => {
      dispatcher.register(emailTransport)
      const res = await post('/api/watches', { sectionId: sid, channel: 'email' })
      expect(res.status).toBe(403)
      expect((await res.json() as any).error).toContain('confirm your email')
      expect((await (await get('/api/watches')).json() as any).watches).toHaveLength(0)
    })

    it('refuses an email watch when the server cannot send email', async () => {
      const res = await post('/api/watches', { sectionId: sid, channel: 'email' })
      expect(res.status).toBe(400)
      expect((await res.json() as any).error).toContain('not configured')
    })

    it('advertises which channels it can deliver, so a client need not guess', async () => {
      const before = await (await get('/api/stats')).json() as any
      expect(before.channels).toEqual(['console'])

      dispatcher.register(emailTransport)
      const after = await (await get('/api/stats')).json() as any
      expect(after.channels).toEqual(['console', 'email'])
    })

    it('defaults an email watch to the address the account signed up with', async () => {
      dispatcher.register(emailTransport)
      verified()
      const created = await (await post('/api/watches', { sectionId: sid, channel: 'email' })).json() as any
      const listed = await (await get('/api/watches')).json() as any

      expect(created.watch.channel).toBe('email')
      expect(listed.watches[0].target).toBe(alice.email)
    })

    it('refuses to mail an address the account has not proved it controls', async () => {
      // This was a mail bomb: any account could aim every seat change on any
      // section at a stranger, sent from ClassPik's own domain, and the
      // stranger had no route that could touch the watch.
      dispatcher.register(emailTransport)
      const res = await post('/api/watches', { sectionId: sid, channel: 'email', target: 'victim@university.edu' })
      expect(res.status).toBe(403)
      expect((await res.json() as any).error).toContain('address on your account')
      expect((await (await get('/api/watches')).json() as any).watches).toHaveLength(0)
    })

    it('accepts the account address written out explicitly', async () => {
      dispatcher.register(emailTransport)
      verified()
      const res = await post('/api/watches', { sectionId: sid, channel: 'email', target: alice.email.toUpperCase() })
      expect(res.status).toBe(201)
      const listed = await (await get('/api/watches')).json() as any
      expect(listed.watches[0].target).toBe(alice.email)
    })

    it('rejects an address that could never be delivered to', async () => {
      dispatcher.register(emailTransport)
      const res = await post('/api/watches', { sectionId: sid, channel: 'email', target: 'phone-at-example' })
      expect(res.status).toBe(403)
    })

    it('rejects an address carrying a line break, which is the header injection path', async () => {
      dispatcher.register(emailTransport)
      const res = await post('/api/watches', {
        sectionId: sid, channel: 'email', target: 'a@b.test\r\nBcc: attacker@evil.test',
      })
      expect(res.status).toBe(403)
      expect((await (await get('/api/watches')).json() as any).watches).toHaveLength(0)
    })
  })

  describe('events', () => {
    it('lists events for a user via their watches', async () => {
      await post('/api/watches', { sectionId: sid })
      env.repo.recordEvent(sid, {
        kind: 'seat_opened', prevSeats: 0, newSeats: 1, prevWaitlist: 0, newWaitlist: 0, detail: 'x',
      })
      const body = await (await get('/api/events')).json() as any
      expect(body.events).toHaveLength(1)
    })

    it('returns nothing for a user watching nothing', async () => {
      const bob = await signUp(base, 'bob@classpik.test')
      await post('/api/watches', { sectionId: sid })
      env.repo.recordEvent(sid, {
        kind: 'seat_opened', prevSeats: 0, newSeats: 1, prevWaitlist: 0, newWaitlist: 0, detail: 'x',
      })
      expect((await (await get('/api/events', bob.token)).json() as any).events).toHaveLength(0)
    })

    it('ignores a userId query parameter now that the session decides', async () => {
      const bob = await signUp(base, 'bob@classpik.test')
      await post('/api/watches', { sectionId: sid })
      env.repo.recordEvent(sid, {
        kind: 'seat_opened', prevSeats: 0, newSeats: 1, prevWaitlist: 0, newWaitlist: 0, detail: 'x',
      })
      const path = `/api/events?userId=${encodeURIComponent(alice.userId)}`
      expect((await (await get(path, bob.token)).json() as any).events).toHaveLength(0)
    })
  })

  describe('POST /api/poll', () => {
    const asAdmin = (path: string) =>
      fetch(`${base}${path}`, { method: 'POST', headers: { 'X-Admin-Token': ADMIN_TOKEN } })

    it('runs a cycle and reports what happened', async () => {
      const body = await (await asAdmin('/api/poll')).json() as any
      expect(body).toHaveProperty('polled')
      expect(body).toHaveProperty('dispatch')
    })

    it('refuses an ordinary account, however new or old', async () => {
      // Signup is free and a tick fans out to a registrar with no cooldown, so
      // "has an account" was never authorisation for this: one signup plus a
      // loop here is how our IP gets blocked, which is the outcome this route
      // exists to avoid.
      const res = await post('/api/poll')
      expect(res.status).toBe(403)
      const anonymous = await post('/api/poll', undefined, null)
      expect(anonymous.status).toBe(403)
    })

    it('refuses a wrong operator token', async () => {
      const res = await fetch(`${base}/api/poll`, {
        method: 'POST',
        headers: { 'X-Admin-Token': `${ADMIN_TOKEN}x` },
      })
      expect(res.status).toBe(403)
    })

    it('is disabled outright when no operator token is configured', async () => {
      const server2 = createApi({ repo: env.repo, poller: undefined, now: () => env.clock.now })
      await new Promise<void>((r) => server2.listen(0, r))
      const b2 = `http://127.0.0.1:${(server2.address() as AddressInfo).port}`
      const res = await fetch(`${b2}/api/poll`, {
        method: 'POST',
        headers: { 'X-Admin-Token': ADMIN_TOKEN },
      })
      expect(res.status).toBe(403)
      expect((await res.json() as any).error).toContain('CLASSPIK_ADMIN_TOKEN')
      await new Promise<void>((r) => server2.close(() => r()))
    })

    it('holds a floor between two forced cycles, whoever is asking', async () => {
      expect((await asAdmin('/api/poll')).status).toBe(200)
      const immediate = await asAdmin('/api/poll')
      expect(immediate.status).toBe(429)

      env.clock.now += 30_000
      expect((await asAdmin('/api/poll')).status).toBe(200)
    })

    it('detects an opening through the full stack', async () => {
      // Seed, watch, then let the fixture free a seat on the next poll.
      const adapters = new Map<SisId, SisAdapter>([
        ['banner9', new FixtureAdapter(SECTIONS, { 2: { '30412': { seats: 1 } } })],
      ])
      const transport = new ConsoleTransport(() => {})
      const dispatcher = new Dispatcher(env.repo, [transport], { now: () => env.clock.now })
      const poller = new Poller(env.repo, adapters, dispatcher, { now: () => env.clock.now, random: () => 0.5 })

      const server2 = createApi({
        repo: env.repo, poller, dispatcher, adminToken: ADMIN_TOKEN, now: () => env.clock.now,
      })
      await new Promise<void>((r) => server2.listen(0, r))
      const b2 = `http://127.0.0.1:${(server2.address() as AddressInfo).port}`

      // Same database, so alice's session is valid against this server too.
      const auth = authHeaders(alice.token)
      const admin = { 'X-Admin-Token': ADMIN_TOKEN }
      await fetch(`${b2}/api/poll`, { method: 'POST', headers: admin })
      await fetch(`${b2}/api/watches`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...auth },
        body: JSON.stringify({ sectionId: sectionId(SCHOOL_ID, TERM, '30412') }),
      })

      env.clock.now += 3_600_000
      const result = await (await fetch(`${b2}/api/poll`, { method: 'POST', headers: admin })).json() as any

      expect(result.notificationsQueued).toBe(1)
      expect(result.dispatch.delivered).toBe(1)
      expect(transport.sent[0]!.title).toContain('MATH 221 B')

      await new Promise<void>((r) => server2.close(() => r()))
    })
  })

  describe('subjects', () => {
    beforeEach(() => {
      env.repo.recordSubjects(SCHOOL_ID, TERM, [
        { code: 'MATH', description: 'Mathematics' },
        { code: 'ANTH', description: 'Anthropology' },
      ])
    })

    it('lists the browsable catalogue without an account', async () => {
      const body = await (await get(`/api/subjects?school=${SCHOOL_ID}&term=${TERM}`, null)).json() as any
      expect(body.count).toBe(2)
      expect(body.subjects.map((s: any) => s.code)).toEqual(['ANTH', 'MATH'])
      // ANTH has never been fetched, and the client is told so rather than
      // being left to wonder why the subject has no sections. MATH has a poll
      // target from the school's own config, which is the other route to one:
      // reporting it as unfetched would offer a seed for work already queued.
      const byCode = new Map(body.subjects.map((s: any) => [s.code, s.seeded]))
      expect(byCode.get('ANTH')).toBe(false)
      expect(byCode.get('MATH')).toBe(true)
    })

    it('needs a school, and 404s for one it does not have', async () => {
      expect((await get('/api/subjects', null)).status).toBe(400)
      expect((await get('/api/subjects?school=nope', null)).status).toBe(404)
    })

    it('seeds a browsed subject and reports that nothing is there yet', async () => {
      const res = await post('/api/subjects/seed', { school: SCHOOL_ID, term: TERM, subject: 'ANTH' })
      expect(res.status).toBe(202)
      const body = await res.json() as any
      expect(body).toMatchObject({ subject: 'ANTH', status: 'queued', sections: 0 })
      expect(env.repo.getTarget(`${SCHOOL_ID}:${TERM}:ANTH`)).not.toBeNull()
    })

    it('marks the subject seeded so a second browse buys nothing', async () => {
      await post('/api/subjects/seed', { school: SCHOOL_ID, term: TERM, subject: 'ANTH' })
      const second = await post('/api/subjects/seed', { school: SCHOOL_ID, term: TERM, subject: 'ANTH' })
      expect(second.status).toBe(200)
      expect((await second.json() as any).status).toBe('already')

      const listed = await (await get(`/api/subjects?school=${SCHOOL_ID}&term=${TERM}`, null)).json() as any
      expect(listed.subjects.find((s: any) => s.code === 'ANTH').seeded).toBe(true)
    })

    it('refuses a subject the school does not publish', async () => {
      // The gate that keeps this from being "make our server fetch whatever I
      // name at a university".
      const res = await post('/api/subjects/seed', { school: SCHOOL_ID, term: TERM, subject: 'FAKE' })
      expect(res.status).toBe(404)
      expect(env.repo.listTargets().map((t) => t.id)).not.toContain(`${SCHOOL_ID}:${TERM}:FAKE`)
    })

    it('takes an account, because it is the one browse that costs a request', async () => {
      const res = await post('/api/subjects/seed', { school: SCHOOL_ID, term: TERM, subject: 'ANTH' }, null)
      expect(res.status).toBe(401)
      expect(env.repo.getTarget(`${SCHOOL_ID}:${TERM}:ANTH`)).toBeNull()
    })

    it('validates its arguments rather than seeding something surprising', async () => {
      expect((await post('/api/subjects/seed', { term: TERM, subject: 'ANTH' })).status).toBe(400)
      expect((await post('/api/subjects/seed', { school: SCHOOL_ID, subject: 'ANTH' })).status).toBe(400)
      expect((await post('/api/subjects/seed', { school: SCHOOL_ID, term: TERM })).status).toBe(400)
    })

    it('caps how many subjects one address can open', async () => {
      // A signed-in stranger walking a two hundred subject catalogue is the
      // same doubled request rate we refuse everywhere else, just slower.
      const limited = createApi({
        repo: env.repo,
        discovery: new SubjectDiscovery(env.repo, new Map(), { now: () => env.clock.now }),
        now: () => env.clock.now,
        rateLimit: { seedsPerHour: 1 },
      })
      await new Promise<void>((r) => limited.listen(0, r))
      const b2 = `http://127.0.0.1:${(limited.address() as AddressInfo).port}`
      const seed = (subject: string) =>
        fetch(`${b2}/api/subjects/seed`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders(alice.token) },
          body: JSON.stringify({ school: SCHOOL_ID, term: TERM, subject }),
        })

      expect((await seed('ANTH')).status).toBe(202)
      expect((await seed('MATH')).status).toBe(429)
      await new Promise<void>((r) => limited.close(() => r()))
    })

    it('says so plainly when the server was not given a discovery to use', async () => {
      const bare = createApi({ repo: env.repo, now: () => env.clock.now })
      await new Promise<void>((r) => bare.listen(0, r))
      const b2 = `http://127.0.0.1:${(bare.address() as AddressInfo).port}`
      const res = await fetch(`${b2}/api/subjects/seed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(alice.token) },
        body: JSON.stringify({ school: SCHOOL_ID, term: TERM, subject: 'ANTH' }),
      })
      expect(res.status).toBe(503)
      await new Promise<void>((r) => bare.close(() => r()))
    })
  })

  /**
   * Which address a per-source rate limit is charged to.
   *
   * This was `req.socket.remoteAddress` and nothing else, with a comment saying
   * the process listens directly. The documented deployment does not: `fly.toml`
   * declares `[http_service]`, so fly-proxy is in front and every request arrives
   * from one address. All five limiters then share one bucket, which turns
   * twenty sign-in attempts a minute into twenty for the whole user base during
   * registration week, and ten reset links an hour into a service-wide ceiling
   * one loop can hold at zero.
   */
  describe('the source address behind a proxy', () => {
    let proxied: Server | null = null

    const bootWith = async (clientIpHeader: string | null): Promise<string> => {
      proxied = createApi({
        repo: env.repo,
        now: () => env.clock.now,
        clientIpHeader,
        rateLimit: { authPerMinute: 1 },
      })
      await new Promise<void>((r) => proxied!.listen(0, r))
      return `http://127.0.0.1:${(proxied!.address() as AddressInfo).port}`
    }

    // An address with no account, so the answer is always 401 unless the bucket
    // is empty, which is 429. Nothing here depends on a password being right.
    const attempt = (b: string, forwarded: string | null) =>
      fetch(`${b}/api/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(forwarded === null ? {} : { 'X-Forwarded-For': forwarded }),
        },
        body: JSON.stringify({ email: 'nobody@classpik.test', password: TEST_PASSWORD }),
      })

    afterEach(async () => {
      if (proxied) await new Promise<void>((r) => proxied!.close(() => r()))
      proxied = null
    })

    it('ignores a forwarded header by default, since any client can write one', async () => {
      const b = await bootWith(null)
      expect((await attempt(b, '203.0.113.1')).status).toBe(401)
      expect((await attempt(b, '203.0.113.2')).status).toBe(429)
    })

    it('charges the forwarded address once an operator names the header', async () => {
      const b = await bootWith('x-forwarded-for')
      expect((await attempt(b, '203.0.113.1')).status).toBe(401)
      expect((await attempt(b, '203.0.113.2')).status).toBe(401)
      // And the budget is still real, per address rather than absent.
      expect((await attempt(b, '203.0.113.2')).status).toBe(429)
    })

    it('reads the last hop, so a caller cannot pick their own bucket', async () => {
      // X-Forwarded-For is a list every hop appends to, so a client sending one
      // of its own gets the proxy's view of it appended after. Reading the first
      // entry would hand every caller a fresh limit for the price of a header.
      const b = await bootWith('x-forwarded-for')
      expect((await attempt(b, 'not-really-me, 203.0.113.7')).status).toBe(401)
      expect((await attempt(b, 'somebody-else, 203.0.113.7')).status).toBe(429)
    })

    it('falls back to the socket when the named header is absent', async () => {
      const b = await bootWith('fly-client-ip')
      expect((await attempt(b, null)).status).toBe(401)
      expect((await attempt(b, null)).status).toBe(429)
    })
  })

  describe('caching', () => {
    it('forbids an intermediary from storing a response carrying a session token', async () => {
      const res = await post('/api/auth/login', { email: alice.email, password: TEST_PASSWORD }, null)
      expect(res.status).toBe(200)
      expect(res.headers.get('cache-control')).toBe('no-store')
    })

    it('forbids storing one account\'s data and varies on the credential', async () => {
      // A CDN keying on the URL alone would otherwise be free to hand alice's
      // watch list to bob.
      for (const path of ['/api/watches', '/api/auth/me', '/api/events']) {
        const res = await get(path)
        expect(res.status, path).toBe(200)
        expect(res.headers.get('cache-control'), path).toBe('no-store')
        expect(res.headers.get('vary')?.toLowerCase(), path).toContain('authorization')
      }
    })
  })

  describe('CORS', () => {
    it('allows a configured origin', async () => {
      const res = await fetch(`${base}/api/stats`, { headers: { Origin: 'http://localhost:5173' } })
      expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173')
    })

    it('does not allow an unconfigured origin', async () => {
      const res = await fetch(`${base}/api/stats`, { headers: { Origin: 'https://evil.test' } })
      expect(res.headers.get('access-control-allow-origin')).toBeNull()
    })

    it('answers preflight', async () => {
      const res = await fetch(`${base}/api/watches`, {
        method: 'OPTIONS', headers: { Origin: 'http://localhost:5173' },
      })
      expect(res.status).toBe(204)
      expect(res.headers.get('access-control-allow-methods')).toContain('POST')
    })

    it('allows the Authorization header through preflight', async () => {
      const res = await fetch(`${base}/api/watches`, {
        method: 'OPTIONS', headers: { Origin: 'http://localhost:5173' },
      })
      expect(res.headers.get('access-control-allow-headers')?.toLowerCase()).toContain('authorization')
    })

    it('varies on origin even when the origin is not allowed', async () => {
      const res = await fetch(`${base}/api/stats`, { headers: { Origin: 'https://evil.test' } })
      // Authorization rides along on every response now that a public route,
      // /api/sections, answers differently depending on who is asking.
      expect(res.headers.get('vary')).toBe('Origin, Authorization')
    })
  })
})
