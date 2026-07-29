import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { createApi } from '../src/api/server.js'
import { Poller } from '../src/core/poller.js'
import { ConsoleTransport, Dispatcher } from '../src/core/notify.js'
import { FixtureAdapter, type FixtureSection } from '../src/adapters/fixture.js'
import type { SisAdapter, SisId, RawSection } from '../src/adapters/types.js'
import { sectionId } from '../src/core/repo.js'
import { authHeaders, setupEnv, signUp, SCHOOL_ID, TERM, type TestAccount, type TestEnv } from './helpers.js'

const SECTIONS: FixtureSection[] = [
  { crn: '30412', subject: 'MATH', courseNumber: '221', title: 'Linear Algebra', section: 'B', seats: 0, capacity: 90, waitlist: 14, waitlistCap: 25 },
  { crn: '30418', subject: 'MATH', courseNumber: '221', title: 'Linear Algebra', section: 'E', seats: 22, capacity: 90, waitlist: 0, waitlistCap: 25 },
]

const raw = (over: Partial<RawSection> = {}): RawSection => ({
  crn: '30412', subject: 'MATH', courseNumber: '221', code: 'MATH 221',
  title: 'Linear Algebra', section: 'B', credits: 3, instructor: 'Whitfield',
  meetingDays: 'MWF', meetingTime: '10:00a', campus: null,
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

    server = createApi({
      repo: env.repo,
      poller,
      dispatcher,
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
      const created = await (await post('/api/watches', { sectionId: sid, channel: 'email' })).json() as any
      const listed = await (await get('/api/watches')).json() as any

      expect(created.watch.channel).toBe('email')
      expect(listed.watches[0].target).toBe(alice.email)
    })

    it('accepts an explicit address other than the account address', async () => {
      dispatcher.register(emailTransport)
      await post('/api/watches', { sectionId: sid, channel: 'email', target: 'phone@example.edu' })
      const listed = await (await get('/api/watches')).json() as any
      expect(listed.watches[0].target).toBe('phone@example.edu')
    })

    it('rejects an address that could never be delivered to', async () => {
      dispatcher.register(emailTransport)
      const res = await post('/api/watches', { sectionId: sid, channel: 'email', target: 'phone-at-example' })
      expect(res.status).toBe(400)
      expect((await res.json() as any).error).toContain('not a usable email address')
    })

    it('rejects an address carrying a line break, which is the header injection path', async () => {
      dispatcher.register(emailTransport)
      const res = await post('/api/watches', {
        sectionId: sid, channel: 'email', target: 'a@b.test\r\nBcc: attacker@evil.test',
      })
      expect(res.status).toBe(400)
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
    it('runs a cycle and reports what happened', async () => {
      const body = await (await post('/api/poll')).json() as any
      expect(body).toHaveProperty('polled')
      expect(body).toHaveProperty('dispatch')
    })

    it('detects an opening through the full stack', async () => {
      // Seed, watch, then let the fixture free a seat on the next poll.
      const adapters = new Map<SisId, SisAdapter>([
        ['banner9', new FixtureAdapter(SECTIONS, { 2: { '30412': { seats: 1 } } })],
      ])
      const transport = new ConsoleTransport(() => {})
      const dispatcher = new Dispatcher(env.repo, [transport], { now: () => env.clock.now })
      const poller = new Poller(env.repo, adapters, dispatcher, { now: () => env.clock.now, random: () => 0.5 })

      const server2 = createApi({ repo: env.repo, poller, dispatcher, now: () => env.clock.now })
      await new Promise<void>((r) => server2.listen(0, r))
      const b2 = `http://127.0.0.1:${(server2.address() as AddressInfo).port}`

      // Same database, so alice's session is valid against this server too.
      const auth = authHeaders(alice.token)
      await fetch(`${b2}/api/poll`, { method: 'POST', headers: auth })
      await fetch(`${b2}/api/watches`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...auth },
        body: JSON.stringify({ sectionId: sectionId(SCHOOL_ID, TERM, '30412') }),
      })

      env.clock.now += 3_600_000
      const result = await (await fetch(`${b2}/api/poll`, { method: 'POST', headers: auth })).json() as any

      expect(result.notificationsQueued).toBe(1)
      expect(result.dispatch.delivered).toBe(1)
      expect(transport.sent[0]!.title).toContain('MATH 221 B')

      await new Promise<void>((r) => server2.close(() => r()))
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
      expect(res.headers.get('vary')).toBe('Origin')
    })
  })
})
