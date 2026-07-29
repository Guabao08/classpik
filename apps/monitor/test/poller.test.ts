import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FixtureAdapter, type FixtureSection } from '../src/adapters/fixture.js'
import { SisError, type SisAdapter, type SisId } from '../src/adapters/types.js'
import { Poller, Runner } from '../src/core/poller.js'
import { SubjectDiscovery } from '../src/core/discovery.js'
import { ConsoleTransport, Dispatcher } from '../src/core/notify.js'
import { sectionId } from '../src/core/repo.js'
import { setupEnv, SCHOOL_ID, TERM, type TestEnv } from './helpers.js'

/** The end-to-end behaviour: poll, detect, record, queue. */

const SECTIONS: FixtureSection[] = [
  { crn: '30412', subject: 'MATH', courseNumber: '221', title: 'Linear Algebra', section: 'B', seats: 0, capacity: 90, waitlist: 14, waitlistCap: 25 },
  { crn: '30418', subject: 'MATH', courseNumber: '221', title: 'Linear Algebra', section: 'E', seats: 22, capacity: 90, waitlist: 0, waitlistCap: 25 },
  { crn: '30188', subject: 'CS', courseNumber: '260', title: 'Data Structures', section: 'A', seats: 0, capacity: 240, waitlist: 0, waitlistCap: 40 },
]

function build(env: TestEnv, adapter: SisAdapter) {
  const adapters = new Map<SisId, SisAdapter>([['banner9', adapter]])
  const transport = new ConsoleTransport(() => {})
  const dispatcher = new Dispatcher(env.repo, [transport], { now: () => env.clock.now })
  const poller = new Poller(env.repo, adapters, dispatcher, {
    now: () => env.clock.now,
    random: () => 0.5,
  })
  return { poller, dispatcher, transport }
}

describe('Poller', () => {
  let env: TestEnv
  beforeEach(() => { env = setupEnv() })
  afterEach(() => env.close())

  it('seeds sections on the first poll of a target', async () => {
    const { poller } = build(env, new FixtureAdapter(SECTIONS))
    const target = env.repo.ensureTarget(SCHOOL_ID, TERM, 'MATH', 60_000)

    const out = await poller.pollTarget(target)
    expect(out.ok).toBe(true)
    expect(out.sectionsSeen).toBe(2)
    expect(env.repo.searchSections({ subject: 'MATH' })).toHaveLength(2)
  })

  it('records no events on the first poll, even for open sections', async () => {
    // 30418 has 22 seats free. It must NOT look like it just opened.
    const { poller } = build(env, new FixtureAdapter(SECTIONS))
    const target = env.repo.ensureTarget(SCHOOL_ID, TERM, 'MATH', 60_000)

    const out = await poller.pollTarget(target)
    expect(out.eventsRecorded).toBe(0)
    expect(env.repo.listEvents({})).toHaveLength(0)
  })

  it('detects a seat opening on a later poll and queues the watcher', async () => {
    const adapter = new FixtureAdapter(SECTIONS, { 2: { '30412': { seats: 1 } } })
    const { poller } = build(env, adapter)
    const target = env.repo.ensureTarget(SCHOOL_ID, TERM, 'MATH', 60_000)

    await poller.pollTarget(target)
    const sid = sectionId(SCHOOL_ID, TERM, '30412')
    env.repo.createWatch({ userId: 'roshan', sectionId: sid })

    env.clock.now += 60_000
    const out = await poller.pollTarget(env.repo.getTarget(target.id)!)

    expect(out.eventsRecorded).toBe(1)
    expect(out.notificationsQueued).toBe(1)
    const events = env.repo.listEvents({ sectionId: sid })
    expect(events[0]!.kind).toBe('seat_opened')
    expect(events[0]!.new_seats).toBe(1)
  })

  it('does not queue anything for a section nobody watches', async () => {
    const adapter = new FixtureAdapter(SECTIONS, { 2: { '30412': { seats: 1 } } })
    const { poller } = build(env, adapter)
    const target = env.repo.ensureTarget(SCHOOL_ID, TERM, 'MATH', 60_000)

    await poller.pollTarget(target)
    env.clock.now += 60_000
    const out = await poller.pollTarget(env.repo.getTarget(target.id)!)

    expect(out.eventsRecorded).toBe(1)
    expect(out.notificationsQueued).toBe(0)
  })

  it('queues one notification per watcher, from one upstream request', async () => {
    // The dedupe premise: three students, one poll.
    const adapter = new FixtureAdapter(SECTIONS, { 2: { '30412': { seats: 2 } } })
    const { poller } = build(env, adapter)
    const target = env.repo.ensureTarget(SCHOOL_ID, TERM, 'MATH', 60_000)

    await poller.pollTarget(target)
    const sid = sectionId(SCHOOL_ID, TERM, '30412')
    for (const u of ['roshan', 'andy', 'sam']) {
      env.repo.createWatch({ userId: u, sectionId: sid })
    }

    env.clock.now += 60_000
    const out = await poller.pollTarget(env.repo.getTarget(target.id)!)

    expect(out.notificationsQueued).toBe(3)
    expect(adapter.pollCount('MATH')).toBe(2)
  })

  it('does not re-notify while the section simply stays open', async () => {
    const adapter = new FixtureAdapter(SECTIONS, {
      2: { '30412': { seats: 1 } },
      3: { '30412': { seats: 1 } },
      4: { '30412': { seats: 1 } },
    })
    const { poller } = build(env, adapter)
    const target = env.repo.ensureTarget(SCHOOL_ID, TERM, 'MATH', 60_000)
    await poller.pollTarget(target)
    env.repo.createWatch({ userId: 'roshan', sectionId: sectionId(SCHOOL_ID, TERM, '30412') })

    let queued = 0
    for (let i = 0; i < 3; i++) {
      env.clock.now += 60_000
      queued += (await poller.pollTarget(env.repo.getTarget(target.id)!)).notificationsQueued
    }
    expect(queued).toBe(1)
  })

  it('notifies again when a seat closes and later reopens', async () => {
    const adapter = new FixtureAdapter(SECTIONS, {
      2: { '30412': { seats: 1 } },
      3: { '30412': { seats: 0 } },
      4: { '30412': { seats: 3 } },
    })
    const { poller } = build(env, adapter)
    const target = env.repo.ensureTarget(SCHOOL_ID, TERM, 'MATH', 60_000)
    await poller.pollTarget(target)
    env.repo.createWatch({ userId: 'roshan', sectionId: sectionId(SCHOOL_ID, TERM, '30412') })

    let queued = 0
    for (let i = 0; i < 3; i++) {
      env.clock.now += 60_000
      queued += (await poller.pollTarget(env.repo.getTarget(target.id)!)).notificationsQueued
    }
    expect(queued).toBe(2)
  })

  it('flags a vanished section absent instead of deleting it', async () => {
    const adapter = new FixtureAdapter(SECTIONS)
    const { poller } = build(env, adapter)
    const target = env.repo.ensureTarget(SCHOOL_ID, TERM, 'MATH', 60_000)
    await poller.pollTarget(target)

    const shrunk = new FixtureAdapter(SECTIONS.filter((s) => s.crn !== '30418'))
    const { poller: p2 } = build(env, shrunk)
    env.clock.now += 60_000
    const out = await p2.pollTarget(env.repo.getTarget(target.id)!)

    expect(out.removed).toBe(1)
    expect(env.repo.searchSections({ subject: 'MATH' })).toHaveLength(1)
    // Still on disk, just not present, so nothing is lost if it returns.
    expect(env.repo.getSection(sectionId(SCHOOL_ID, TERM, '30418'))).not.toBeNull()
  })

  it('drops to the floor after a change and stays there through the hot window', async () => {
    // The seat stays open across polls 2-4, so only poll 2 is a change.
    const adapter = new FixtureAdapter(SECTIONS, {
      2: { '30412': { seats: 1 } },
      3: { '30412': { seats: 1 } },
      4: { '30412': { seats: 1 } },
    })
    const { poller } = build(env, adapter)
    const target = env.repo.ensureTarget(SCHOOL_ID, TERM, 'MATH', 60_000)

    await poller.pollTarget(target)

    env.clock.now += 60_000
    const changed = await poller.pollTarget(env.repo.getTarget(target.id)!)
    expect(changed.nextPollAt - env.clock.now).toBe(60_000)

    // A minute later nothing has changed, but we are still inside the 15 minute
    // hot window, so staying at the floor is correct: a section that just moved
    // is the most likely one to move again.
    env.clock.now += 60_000
    const stillHot = await poller.pollTarget(env.repo.getTarget(target.id)!)
    expect(stillHot.nextPollAt - env.clock.now).toBe(60_000)
  })

  it('backs off once the target falls out of the hot window', async () => {
    const adapter = new FixtureAdapter(SECTIONS, {
      2: { '30412': { seats: 1 } },
      3: { '30412': { seats: 1 } },
    })
    const { poller } = build(env, adapter)
    const target = env.repo.ensureTarget(SCHOOL_ID, TERM, 'MATH', 60_000)

    await poller.pollTarget(target)
    env.clock.now += 60_000
    await poller.pollTarget(env.repo.getTarget(target.id)!)

    // Past the 15 minute window with nothing new.
    env.clock.now += env.school.polling.hotWindowMs + 1
    const cooled = await poller.pollTarget(env.repo.getTarget(target.id)!)
    expect(cooled.nextPollAt - env.clock.now).toBeGreaterThan(60_000)
  })

  describe('failures', () => {
    const failing = (err: Error): SisAdapter => ({
      id: 'banner9',
      listTerms: async () => [],
      listSubjects: async () => [],
      fetchSections: async () => { throw err },
    })

    it('records a transient failure and backs off without disabling the target', async () => {
      const { poller } = build(env, failing(new SisError('upstream 503', null, true)))
      const target = env.repo.ensureTarget(SCHOOL_ID, TERM, 'MATH', 60_000)
      const out = await poller.pollTarget(target)

      expect(out.ok).toBe(false)
      expect(out.error).toContain('503')
      const after = env.repo.getTarget(target.id)!
      expect(after.consecutive_errors).toBe(1)
      expect(after.active).toBe(1)
      expect(after.next_poll_at).toBeGreaterThan(env.clock.now)
    })

    it('disables the target on a permanent failure', async () => {
      const { poller } = build(env, failing(new SisError('bad config', null, false)))
      const target = env.repo.ensureTarget(SCHOOL_ID, TERM, 'MATH', 60_000)
      await poller.pollTarget(target)
      expect(env.repo.getTarget(target.id)!.active).toBe(0)
    })

    it('treats an unknown error as transient rather than giving up on a school', async () => {
      const { poller } = build(env, failing(new Error('kaboom')))
      const target = env.repo.ensureTarget(SCHOOL_ID, TERM, 'MATH', 60_000)
      await poller.pollTarget(target)
      expect(env.repo.getTarget(target.id)!.active).toBe(1)
    })

    it('backs off further with each consecutive failure', async () => {
      const { poller } = build(env, failing(new SisError('boom')))
      const target = env.repo.ensureTarget(SCHOOL_ID, TERM, 'MATH', 60_000)

      const first = await poller.pollTarget(env.repo.getTarget(target.id)!)
      const second = await poller.pollTarget(env.repo.getTarget(target.id)!)
      expect(second.nextPollAt - env.clock.now).toBeGreaterThan(first.nextPollAt - env.clock.now)
    })

    it('does not lose stored sections when a poll fails', async () => {
      const { poller } = build(env, new FixtureAdapter(SECTIONS))
      const target = env.repo.ensureTarget(SCHOOL_ID, TERM, 'MATH', 60_000)
      await poller.pollTarget(target)

      const { poller: broken } = build(env, failing(new SisError('down')))
      await broken.pollTarget(env.repo.getTarget(target.id)!)

      expect(env.repo.searchSections({ subject: 'MATH' })).toHaveLength(2)
    })

    it('fails a target whose school has no adapter, permanently', async () => {
      const poller = new Poller(env.repo, new Map(), null, { now: () => env.clock.now })
      const target = env.repo.ensureTarget(SCHOOL_ID, TERM, 'MATH', 60_000)
      const out = await poller.pollTarget(target)
      expect(out.error).toContain('no adapter')
      expect(env.repo.getTarget(target.id)!.active).toBe(0)
    })
  })

  describe('tick', () => {
    it('bootstraps never-polled targets that no watch can yet reference', async () => {
      const { poller } = build(env, new FixtureAdapter(SECTIONS))
      env.repo.ensureTarget(SCHOOL_ID, TERM, 'MATH', 60_000)

      const result = await poller.tick()
      expect(result.polled).toBe(1)
      expect(env.repo.searchSections({})).toHaveLength(2)
    })

    it('skips targets that are seeded but unwatched', async () => {
      const { poller } = build(env, new FixtureAdapter(SECTIONS))
      const target = env.repo.ensureTarget(SCHOOL_ID, TERM, 'MATH', 60_000)
      await poller.tick()

      env.clock.now += 3_600_000
      env.repo.recordPollSuccess(target.id, env.clock.now - 1, 60_000, false)
      expect((await poller.tick()).polled).toBe(0)
    })

    it('polls a watched target once it comes due', async () => {
      const { poller } = build(env, new FixtureAdapter(SECTIONS))
      const target = env.repo.ensureTarget(SCHOOL_ID, TERM, 'MATH', 60_000)
      await poller.tick()
      env.repo.createWatch({ userId: 'roshan', sectionId: sectionId(SCHOOL_ID, TERM, '30412') })

      env.clock.now += 3_600_000
      env.repo.recordPollSuccess(target.id, env.clock.now - 1, 60_000, false)
      expect((await poller.tick()).polled).toBe(1)
    })

    it('does not poll the same target twice in one tick', async () => {
      const adapter = new FixtureAdapter(SECTIONS)
      const { poller } = build(env, adapter)
      env.repo.ensureTarget(SCHOOL_ID, TERM, 'MATH', 60_000)
      await poller.tick()
      expect(adapter.pollCount('MATH')).toBe(1)
    })

    it('honours an abort signal partway through', async () => {
      const { poller } = build(env, new FixtureAdapter(SECTIONS))
      env.repo.ensureTarget(SCHOOL_ID, TERM, 'MATH', 60_000)
      env.repo.ensureTarget(SCHOOL_ID, TERM, 'CS', 60_000)

      const controller = new AbortController()
      controller.abort()
      expect((await poller.tick(controller.signal)).polled).toBe(0)
    })

    it('respects the batch size', async () => {
      const { poller } = build(env, new FixtureAdapter(SECTIONS))
      const small = new Poller(
        env.repo,
        new Map<SisId, SisAdapter>([['banner9', new FixtureAdapter(SECTIONS)]]),
        null,
        { now: () => env.clock.now, batchSize: 1 }
      )
      env.repo.ensureTarget(SCHOOL_ID, TERM, 'MATH', 60_000)
      env.repo.ensureTarget(SCHOOL_ID, TERM, 'CS', 60_000)
      expect((await small.tick()).polled).toBe(1)
      void poller
    })
  })

  it('delivers a real notification end to end', async () => {
    const adapter = new FixtureAdapter(SECTIONS, { 2: { '30412': { seats: 1 } } })
    const { poller, dispatcher, transport } = build(env, adapter)
    const target = env.repo.ensureTarget(SCHOOL_ID, TERM, 'MATH', 60_000)

    await poller.pollTarget(target)
    env.repo.createWatch({ userId: 'roshan', sectionId: sectionId(SCHOOL_ID, TERM, '30412') })
    env.clock.now += 60_000
    await poller.pollTarget(env.repo.getTarget(target.id)!)

    const result = await dispatcher.flush()
    expect(result.delivered).toBe(1)
    expect(transport.sent).toHaveLength(1)
    expect(transport.sent[0]!.title).toBe('MATH 221 B has a seat open')
    expect(transport.sent[0]!.userId).toBe('roshan')
  })
})

describe('Runner', () => {
  let env: TestEnv
  beforeEach(() => { env = setupEnv() })
  afterEach(() => env.close())

  /** A dispatcher whose flush never settles, which is what a wedged relay looks like. */
  const wedgedDispatcher = () =>
    ({ flush: () => new Promise<never>(() => {}) }) as unknown as Dispatcher

  it('keeps ticking after a flush that never settles', async () => {
    // The regression, and it took the whole product down: a transport that hung
    // left `running` true forever, so every later tick returned at that guard.
    // The process stayed up and /api/stats looked healthy while the service
    // polled nothing and delivered nothing until someone restarted it.
    const { poller } = build(env, new FixtureAdapter(SECTIONS))
    let ticks = 0
    const counting = {
      tick: async () => {
        ticks++
        return { polled: 0, outcomes: [], notificationsQueued: 0 }
      },
    } as unknown as Poller
    void poller

    const runner = new Runner(counting, wedgedDispatcher(), {
      tickIntervalMs: 10,
      tickBudgetMs: 30,
      log: () => {},
    })
    runner.start()
    await new Promise((r) => setTimeout(r, 250))
    await runner.stop()

    expect(ticks).toBeGreaterThan(1)
  })

  it('fills the browsable subject catalogue as it runs, and polls none of it', async () => {
    env.repo.replaceTerms(SCHOOL_ID, [{ code: TERM, description: 'Fall 2026' }])
    const adapter = new FixtureAdapter(SECTIONS)
    const { poller, dispatcher } = build(env, adapter)
    const discovery = new SubjectDiscovery(
      env.repo,
      new Map<SisId, SisAdapter>([['banner9', adapter]]),
      { now: () => env.clock.now }
    )
    const runner = new Runner(poller, dispatcher, {
      tickIntervalMs: 10,
      now: () => env.clock.now,
      discovery,
      log: () => {},
    })
    runner.start()
    await new Promise((r) => setTimeout(r, 60))
    await runner.stop()

    expect(env.repo.listSubjects(SCHOOL_ID, TERM).map((s) => s.code)).toEqual(['CS', 'MATH'])
    // Knowing a subject exists is not permission to poll it. Everything else
    // about this feature depends on that staying true.
    expect(env.repo.listTargets()).toEqual([])
    expect(adapter.pollCount('MATH')).toBe(0)
    expect(adapter.pollCount('CS')).toBe(0)
  })

  it('does not re-ask a registrar for its subject list on every tick', async () => {
    env.repo.replaceTerms(SCHOOL_ID, [{ code: TERM, description: 'Fall 2026' }])
    let calls = 0
    const counting: SisAdapter = {
      id: 'banner9',
      listTerms: async () => [],
      listSubjects: async () => {
        calls++
        return [{ code: 'MATH', description: 'Mathematics' }]
      },
      fetchSections: async () => [],
    }
    const { poller, dispatcher } = build(env, counting)
    const runner = new Runner(poller, dispatcher, {
      tickIntervalMs: 5,
      now: () => env.clock.now,
      discovery: new SubjectDiscovery(
        env.repo,
        new Map<SisId, SisAdapter>([['banner9', counting]]),
        { now: () => env.clock.now }
      ),
      discoveryIntervalMs: 24 * 60 * 60_000,
      log: () => {},
    })
    runner.start()
    await new Promise((r) => setTimeout(r, 80))
    await runner.stop()

    // Many ticks, one catalogue request. A subject list changes between terms,
    // not between ticks.
    expect(calls).toBe(1)
  })

  it('prunes expired sessions as it goes, since nothing else ever did', async () => {
    // One row per login, kept for the life of the database otherwise.
    const user = env.repo.createUser({
      email: 'ada@classpik.test', emailNorm: 'ada@classpik.test', passwordHash: 'scrypt$not-used-here',
    })!
    env.repo.createSession({ userId: user.id, tokenHash: 'dead', expiresAt: env.clock.now - 1 })
    env.repo.createSession({ userId: user.id, tokenHash: 'live', expiresAt: env.clock.now + 60_000 })

    const { poller, dispatcher } = build(env, new FixtureAdapter(SECTIONS))
    const runner = new Runner(poller, dispatcher, {
      tickIntervalMs: 10_000,
      now: () => env.clock.now,
      repo: env.repo,
      log: () => {},
    })
    runner.start()
    await new Promise((r) => setTimeout(r, 50))
    await runner.stop()

    expect(env.repo.getSession('dead')).toBeNull()
    expect(env.repo.getSession('live')).not.toBeNull()
  })
})
