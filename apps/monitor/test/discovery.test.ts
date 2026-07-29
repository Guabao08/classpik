import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SubjectDiscovery } from '../src/core/discovery.js'
import { Poller } from '../src/core/poller.js'
import { FixtureAdapter, type FixtureSection } from '../src/adapters/fixture.js'
import { SisError, type SisAdapter, type SisId, type Subject } from '../src/adapters/types.js'
import { setupEnv, SCHOOL_ID, TERM, type TestEnv } from './helpers.js'

/**
 * Discovery, and the line it must not cross.
 *
 * The whole feature is worth nothing if it turns a two hundred subject
 * catalogue into two hundred poll targets, so most of what is asserted here is
 * an absence: subjects recorded, requests not made.
 */

const SECTIONS: FixtureSection[] = [
  { crn: '30412', subject: 'MATH', courseNumber: '221', title: 'Linear Algebra', section: 'B', seats: 0, capacity: 90, waitlist: 14, waitlistCap: 25 },
  { crn: '30188', subject: 'CS', courseNumber: '260', title: 'Data Structures', section: 'A', seats: 0, capacity: 240, waitlist: 0, waitlistCap: 40 },
  { crn: '31000', subject: 'ANTH', courseNumber: '101', title: 'Human Origins', section: 'A', seats: 4, capacity: 60, waitlist: 0, waitlistCap: 0 },
]

const BIG_CATALOG: Subject[] = Array.from({ length: 180 }, (_, i) => ({
  code: `S${String(i).padStart(3, '0')}`,
  description: `Subject ${i}`,
}))

/** Answers listSubjects with whatever it is given, and counts every call. */
class CatalogAdapter implements SisAdapter {
  readonly id = 'banner9' as const
  listSubjectsCalls = 0
  fetchCalls: string[] = []

  constructor(private readonly subjects: Subject[]) {}

  async listTerms() {
    return [{ code: TERM, description: 'Fall 2026' }]
  }

  async listSubjects(): Promise<Subject[]> {
    this.listSubjectsCalls++
    return this.subjects
  }

  async fetchSections(_school: unknown, _term: string, subject: string) {
    this.fetchCalls.push(subject)
    return []
  }
}

describe('SubjectDiscovery', () => {
  let env: TestEnv
  beforeEach(() => {
    env = setupEnv()
    env.repo.replaceTerms(SCHOOL_ID, [{ code: TERM, description: 'Fall 2026' }])
  })
  afterEach(() => env.close())

  const build = (adapter: SisAdapter) =>
    new SubjectDiscovery(env.repo, new Map<SisId, SisAdapter>([['banner9', adapter]]), {
      now: () => env.clock.now,
    })

  it('records what a school offers without creating a single poll target', async () => {
    // The point of the whole design. A hundred and eighty subjects become a
    // hundred and eighty browsable rows and zero upstream requests.
    const adapter = new CatalogAdapter(BIG_CATALOG)
    const result = await build(adapter).run()

    expect(result.queried).toBe(1)
    expect(result.added).toBe(180)
    expect(env.repo.listSubjects(SCHOOL_ID, TERM)).toHaveLength(180)
    expect(env.repo.listTargets()).toEqual([])
    expect(adapter.fetchCalls).toEqual([])
  })

  it('costs one request per term, not one per subject', async () => {
    const adapter = new CatalogAdapter(BIG_CATALOG)
    await build(adapter).run()
    expect(adapter.listSubjectsCalls).toBe(1)
  })

  it('is idempotent, and re-running it adds nothing and polls nothing', async () => {
    const adapter = new CatalogAdapter(BIG_CATALOG)
    const discovery = build(adapter)
    await discovery.run()
    const second = await discovery.run()

    expect(second.added).toBe(0)
    expect(env.repo.listSubjects(SCHOOL_ID, TERM)).toHaveLength(180)
    expect(env.repo.listTargets()).toEqual([])
  })

  it('updates a description without disturbing an existing seed', async () => {
    // Rediscovery must not make a subject we have already fetched look
    // unfetched, or every discovery cycle buys a second request for it.
    await build(new CatalogAdapter([{ code: 'MATH', description: 'Math' }])).run()
    env.repo.markSubjectSeeded(SCHOOL_ID, TERM, 'MATH', env.clock.now)

    await build(new CatalogAdapter([{ code: 'MATH', description: 'Mathematics' }])).run()
    const row = env.repo.getSubject(SCHOOL_ID, TERM, 'MATH')!
    expect(row.description).toBe('Mathematics')
    expect(row.seeded_at).toBe(env.clock.now)
  })

  it('skips a school with no known terms rather than guessing one', async () => {
    env.repo.replaceTerms(SCHOOL_ID, [])
    const adapter = new CatalogAdapter(BIG_CATALOG)
    const result = await build(adapter).run()

    expect(result.queried).toBe(0)
    expect(adapter.listSubjectsCalls).toBe(0)
  })

  it('skips a disabled school', async () => {
    const disabled = setupEnv({ enabled: false })
    disabled.repo.replaceTerms(SCHOOL_ID, [{ code: TERM, description: 'Fall 2026' }])
    const adapter = new CatalogAdapter(BIG_CATALOG)
    const discovery = new SubjectDiscovery(
      disabled.repo,
      new Map<SisId, SisAdapter>([['banner9', adapter]])
    )

    expect((await discovery.run()).queried).toBe(0)
    disabled.close()
  })

  it('survives a registrar that will not answer, and says so', async () => {
    const failing: SisAdapter = {
      id: 'banner9',
      listTerms: async () => [],
      listSubjects: async () => {
        throw new SisError('upstream 503', null, true)
      },
      fetchSections: async () => [],
    }
    const lines: string[] = []
    const discovery = new SubjectDiscovery(
      env.repo,
      new Map<SisId, SisAdapter>([['banner9', failing]]),
      { log: (msg) => lines.push(msg) }
    )

    const result = await discovery.run()
    expect(result.errors).toBe(1)
    expect(result.added).toBe(0)
    expect(lines).toContain('subject discovery failed')
  })

  it('stops partway through when it is aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const adapter = new CatalogAdapter(BIG_CATALOG)
    expect((await build(adapter).run(controller.signal)).queried).toBe(0)
    expect(adapter.listSubjectsCalls).toBe(0)
  })

  describe('the on-demand seed', () => {
    beforeEach(async () => {
      await build(new CatalogAdapter([
        { code: 'MATH', description: 'Mathematics' },
        { code: 'ANTH', description: 'Anthropology' },
      ])).run()
    })

    it('turns a browsed subject into exactly one poll target', () => {
      const discovery = build(new CatalogAdapter([]))
      expect(discovery.seed(SCHOOL_ID, TERM, 'ANTH')).toBe('queued')

      const targets = env.repo.listTargets()
      expect(targets.map((t) => t.id)).toEqual([`${SCHOOL_ID}:${TERM}:ANTH`])
      expect(env.repo.getSubject(SCHOOL_ID, TERM, 'ANTH')!.seeded_at).toBe(env.clock.now)
    })

    it('buys one fetch however many people browse the same subject', () => {
      const discovery = build(new CatalogAdapter([]))
      expect(discovery.seed(SCHOOL_ID, TERM, 'ANTH')).toBe('queued')
      expect(discovery.seed(SCHOOL_ID, TERM, 'ANTH')).toBe('already')
      expect(discovery.seed(SCHOOL_ID, TERM, 'anth')).toBe('already')
      expect(env.repo.listTargets()).toHaveLength(1)
    })

    it('refuses a subject the school does not publish', () => {
      // Without this the route is an open instruction to make our server go and
      // fetch whatever a caller names at a university.
      const discovery = build(new CatalogAdapter([]))
      expect(discovery.seed(SCHOOL_ID, TERM, 'NOPE')).toBe('unknown')
      expect(env.repo.listTargets()).toEqual([])
    })

    it('refuses a term the school does not have', () => {
      const discovery = build(new CatalogAdapter([]))
      expect(discovery.seed(SCHOOL_ID, '199901', 'MATH')).toBe('unknown')
      expect(env.repo.listTargets()).toEqual([])
    })

    it('refuses an unknown school', () => {
      const discovery = build(new CatalogAdapter([]))
      expect(discovery.seed('not-a-school', TERM, 'MATH')).toBe('unknown')
    })

    it('accepts a subject the config named even before discovery has run', () => {
      // A school onboarded the old way still works, and its configured list is
      // as good a demand signal as the discovered catalogue.
      const discovery = build(new CatalogAdapter([]))
      expect(discovery.seed(SCHOOL_ID, TERM, 'CS')).toBe('queued')
    })

    it('will not re-arm a target a permanent error switched off', () => {
      const discovery = build(new CatalogAdapter([]))
      discovery.seed(SCHOOL_ID, TERM, 'ANTH')
      const id = `${SCHOOL_ID}:${TERM}:ANTH`
      env.repo.recordPollError(id, env.clock.now + 1000, 'no such subject', true)
      expect(env.repo.getTarget(id)!.active).toBe(0)

      expect(discovery.seed(SCHOOL_ID, TERM, 'ANTH')).toBe('already')
      expect(env.repo.getTarget(id)!.active).toBe(0)
    })

    it('makes the subject searchable after one poll, and then goes quiet', async () => {
      // The bootstrap in full: browse, one fetch, sections exist, a watch is now
      // possible. And with nobody watching, the poller never returns to it.
      const adapter = new FixtureAdapter(SECTIONS)
      const poller = new Poller(
        env.repo,
        new Map<SisId, SisAdapter>([['banner9', adapter]]),
        null,
        { now: () => env.clock.now, random: () => 0.5 }
      )
      build(new CatalogAdapter([])).seed(SCHOOL_ID, TERM, 'ANTH')

      expect((await poller.tick()).polled).toBe(1)
      expect(env.repo.searchSections({ subject: 'ANTH' })).toHaveLength(1)
      expect(adapter.pollCount('ANTH')).toBe(1)

      // A whole day later, still nobody watching, still one request spent.
      env.clock.now += 24 * 60 * 60_000
      expect((await poller.tick()).polled).toBe(0)
      expect(adapter.pollCount('ANTH')).toBe(1)
    })

    it('keeps polling the subject once somebody actually watches it', async () => {
      const adapter = new FixtureAdapter(SECTIONS)
      const poller = new Poller(
        env.repo,
        new Map<SisId, SisAdapter>([['banner9', adapter]]),
        null,
        { now: () => env.clock.now, random: () => 0.5 }
      )
      build(new CatalogAdapter([])).seed(SCHOOL_ID, TERM, 'ANTH')
      await poller.tick()

      const section = env.repo.searchSections({ subject: 'ANTH' })[0]!
      env.repo.createWatch({ userId: 'roshan', sectionId: section.id })

      env.clock.now += 24 * 60 * 60_000
      expect((await poller.tick()).polled).toBe(1)
      expect(adapter.pollCount('ANTH')).toBe(2)
    })
  })
})
