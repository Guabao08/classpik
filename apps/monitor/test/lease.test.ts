import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrate, openDb, type Db } from '../src/core/db.js'
import { Repo } from '../src/core/repo.js'
import { Poller } from '../src/core/poller.js'
import type {
  FetchOptions,
  RawSection,
  SchoolConfig,
  SisAdapter,
  SisId,
  Subject,
  Term,
} from '../src/adapters/types.js'
import { SCHOOL_ID, TERM, testSchool } from './helpers.js'

/**
 * Two workers, one database.
 *
 * This is the file that decides whether the multi-worker claim is true. The
 * README used to say running two pollers would double our request rate at a
 * registrar, and that is not a theoretical cost: getting blocked is the
 * realistic way this service dies, and it takes every student at that school
 * with it. So the assertions here are about requests, not about rows.
 *
 * Deliberately two SEPARATE connections to the same file rather than one shared
 * handle. Sharing a handle would make the test pass through JavaScript's single
 * thread rather than through SQLite's locking, which is the thing actually being
 * relied on, and it would prove nothing about two processes.
 */

const SUBJECTS = Array.from({ length: 40 }, (_, i) => `SUBJ${String(i).padStart(2, '0')}`)

/** Records every upstream fetch the fleet makes, and yields so workers interleave. */
class RecordingAdapter implements SisAdapter {
  readonly id = 'banner9' as const

  constructor(private readonly fetches: string[]) {}

  async listTerms(): Promise<Term[]> {
    return [{ code: TERM, description: 'Fall 2026' }]
  }

  async listSubjects(): Promise<Subject[]> {
    return SUBJECTS.map((code) => ({ code, description: code }))
  }

  async fetchSections(
    _school: SchoolConfig,
    _term: string,
    subject: string,
    _opts: FetchOptions = {}
  ): Promise<RawSection[]> {
    this.fetches.push(subject)
    // A real fetch suspends here, which is exactly where a second worker gets
    // its chance to claim the same target if claiming is not exclusive.
    await new Promise((r) => setTimeout(r, 1))
    return [
      {
        crn: `${subject}-1`,
        subject,
        courseNumber: '101',
        code: `${subject} 101`,
        title: 'Something',
        section: 'A',
        credits: 3,
        instructor: null,
        meetingDays: null,
        meetingTime: null,
        campus: null,
        level: 'UGRD',
        seats: 0,
        capacity: 30,
        enrollment: 30,
        waitlist: 0,
        waitlistCap: 0,
        waitlistAvailable: 0,
      },
    ]
  }
}

/**
 * Suspends inside `fetchSections` until it is told to finish, which is what a
 * registrar holding us on a Retry-After looks like from in here.
 */
class SuspendingAdapter implements SisAdapter {
  readonly id = 'banner9' as const
  subject = ''

  private enter!: () => void
  readonly started: Promise<void> = new Promise((r) => { this.enter = r })
  private release!: () => void
  private readonly gate: Promise<void> = new Promise((r) => { this.release = r })

  constructor(private readonly fetches: string[]) {}

  /** The target id this adapter is currently holding open. */
  get claimed(): string {
    return `${SCHOOL_ID}:${TERM}:${this.subject}`
  }

  finish(): void {
    this.release()
  }

  async listTerms(): Promise<Term[]> {
    return [{ code: TERM, description: 'Fall 2026' }]
  }

  async listSubjects(): Promise<Subject[]> {
    return SUBJECTS.map((code) => ({ code, description: code }))
  }

  async fetchSections(
    _school: SchoolConfig,
    _term: string,
    subject: string,
    _opts: FetchOptions = {}
  ): Promise<RawSection[]> {
    this.subject = subject
    this.fetches.push(subject)
    this.enter()
    await this.gate
    return []
  }
}

describe('multi-worker leasing', () => {
  let dir: string
  let dbA: Db
  let dbB: Db
  let repoA: Repo
  let repoB: Repo
  let school: SchoolConfig
  const clock = { now: 1_800_000_000_000 }

  beforeEach(() => {
    clock.now = 1_800_000_000_000
    dir = mkdtempSync(join(tmpdir(), 'classpik-lease-'))
    const path = join(dir, 'classpik.db')
    dbA = openDb(path)
    migrate(dbA)
    dbB = openDb(path)
    repoA = new Repo(dbA, () => clock.now)
    repoB = new Repo(dbB, () => clock.now)

    school = testSchool()
    repoA.upsertSchool(school)
    repoA.replaceTerms(SCHOOL_ID, [{ code: TERM, description: 'Fall 2026' }])
    for (const subject of SUBJECTS) {
      repoA.ensureTarget(SCHOOL_ID, TERM, subject, school.polling.baseIntervalMs)
    }
  })

  afterEach(() => {
    dbA.close()
    dbB.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const workerFor = (repo: Repo, id: string, fetches: string[], batchSize: number): Poller =>
    new Poller(repo, new Map<SisId, SisAdapter>([['banner9', new RecordingAdapter(fetches)]]), null, {
      now: () => clock.now,
      random: () => 0.5,
      batchSize,
      workerId: id,
    })

  it('never sends two workers at the same subject, and leaves none behind', async () => {
    const fetches: string[] = []
    const a = workerFor(repoA, 'worker-a', fetches, SUBJECTS.length)
    const b = workerFor(repoB, 'worker-b', fetches, SUBJECTS.length)

    const [ra, rb] = await Promise.all([a.tick(), b.tick()])

    // The assertion that matters: one request per subject across the fleet, not
    // one per subject per worker.
    expect(fetches).toHaveLength(SUBJECTS.length)
    expect(new Set(fetches).size).toBe(SUBJECTS.length)
    expect([...fetches].sort()).toEqual([...SUBJECTS].sort())

    // And every target was actually reached, so "no duplicates" was not bought
    // by quietly dropping work.
    expect(ra.polled + rb.polled).toBe(SUBJECTS.length)
    const targets = repoA.listTargets()
    expect(targets.filter((t) => t.last_polled_at === null)).toEqual([])
    expect(targets.filter((t) => t.lease_owner !== null)).toEqual([])

    // Both workers did real work. A one-worker-does-everything outcome would
    // satisfy every assertion above while proving nothing about sharing.
    expect(ra.polled).toBeGreaterThan(0)
    expect(rb.polled).toBeGreaterThan(0)
  })

  it('shares the work across many small ticks without repeating any of it', async () => {
    // Smaller batches than there is work, so the two drain the queue over
    // several rounds and a target can be double-claimed between rounds as
    // easily as within one.
    const fetches: string[] = []
    const a = workerFor(repoA, 'worker-a', fetches, 3)
    const b = workerFor(repoB, 'worker-b', fetches, 3)

    let polled = 0
    for (let round = 0; round < 20 && polled < SUBJECTS.length; round++) {
      const [ra, rb] = await Promise.all([a.tick(), b.tick()])
      polled += ra.polled + rb.polled
    }

    expect(polled).toBe(SUBJECTS.length)
    expect(new Set(fetches).size).toBe(SUBJECTS.length)
    expect(fetches).toHaveLength(SUBJECTS.length)
    expect(repoA.listTargets().filter((t) => t.last_polled_at === null)).toEqual([])
  })

  it('hands disjoint rows to two claimers that ask before either has polled', async () => {
    // The narrow property everything above rests on. A SELECT of due targets
    // followed by an UPDATE would hand both callers the same five rows, because
    // both would read before either wrote.
    const first = repoA.claimTargets('worker-a', 5, clock.now)
    const second = repoB.claimTargets('worker-b', 5, clock.now)

    expect(first).toHaveLength(5)
    expect(second).toHaveLength(5)
    const overlap = first.filter((t) => second.some((o) => o.id === t.id))
    expect(overlap).toEqual([])
    expect(second.every((t) => t.lease_owner === 'worker-b')).toBe(true)
  })

  it('holds a claim against other workers until it expires', async () => {
    const [claimed] = repoA.claimTargets('worker-a', 1, clock.now, 60_000)
    expect(claimed).toBeDefined()

    const contested = repoB.claimTargets('worker-b', SUBJECTS.length, clock.now)
    expect(contested.map((t) => t.id)).not.toContain(claimed!.id)
  })

  it('recovers a target from a worker that died holding it', async () => {
    // The failure the expiry exists for. Without it this target is never polled
    // again and the students watching sections in it simply stop being told
    // anything, with nothing anywhere saying why.
    const [claimed] = repoA.claimTargets('doomed-worker', 1, clock.now, 60_000)
    expect(claimed).toBeDefined()

    clock.now += 60_001
    const rescued = repoB.claimTargets('worker-b', SUBJECTS.length, clock.now)
    expect(rescued.map((t) => t.id)).toContain(claimed!.id)
    expect(repoA.getTarget(claimed!.id)!.lease_owner).toBe('worker-b')
  })

  it('hands a claim straight back when the tick is aborted after taking it', async () => {
    const fetches: string[] = []
    const a = workerFor(repoA, 'worker-a', fetches, SUBJECTS.length)
    const controller = new AbortController()
    controller.abort()

    expect((await a.tick(controller.signal)).polled).toBe(0)
    expect(fetches).toEqual([])
    // Nothing was claimed at all, so there is nothing for the rest of the fleet
    // to wait out.
    expect(repoA.listTargets().filter((t) => t.lease_owner !== null)).toEqual([])

    const b = workerFor(repoB, 'worker-b', fetches, SUBJECTS.length)
    expect((await b.tick()).polled).toBe(SUBJECTS.length)
  })

  it('frees the lease whether the poll succeeded or failed', async () => {
    const broken: SisAdapter = {
      id: 'banner9',
      listTerms: async () => [],
      listSubjects: async () => [],
      fetchSections: async () => {
        throw new Error('upstream is down')
      },
    }
    const a = new Poller(repoA, new Map<SisId, SisAdapter>([['banner9', broken]]), null, {
      now: () => clock.now,
      random: () => 0.5,
      batchSize: 5,
      workerId: 'worker-a',
    })

    const result = await a.tick()
    expect(result.outcomes.every((o) => o.ok === false)).toBe(true)
    expect(repoA.listTargets().filter((t) => t.lease_owner !== null)).toEqual([])
  })

  it('holds the target through a fetch that outlasts the lease', async () => {
    // The window that used to be open, and the worst possible moment for it.
    // A lease was a flat two minutes with nothing renewing it, while one
    // fetchSections is the session handshake plus two requests per page, each
    // of which may retry and each of which honours Retry-After up to a minute.
    // So a registrar answering 429 stretched a fetch past the lease, and a
    // second worker claimed the same subject: the fleet doubled its request
    // rate at a registrar precisely when that registrar was asking us to slow
    // down.
    const fetches: string[] = []
    const suspended = new SuspendingAdapter(fetches)
    const a = new Poller(repoA, new Map<SisId, SisAdapter>([['banner9', suspended]]), null, {
      now: () => clock.now,
      random: () => 0.5,
      batchSize: 1,
      workerId: 'worker-a',
      leaseMs: 120_000,
      // Real milliseconds, because the renewal is a wall clock timer while
      // leaseMs is measured on the injected clock this test moves by hand.
      leaseRenewMs: 5,
    })
    const b = workerFor(repoB, 'worker-b', fetches, SUBJECTS.length)

    const inFlight = a.tick()
    await suspended.started
    // Past the expiry the claim was taken with, then long enough in real time
    // for the renewal timer to notice and push it back out.
    clock.now += 120_001
    await new Promise((r) => setTimeout(r, 40))

    expect((await b.tick()).outcomes.map((o) => o.targetId)).not.toContain(suspended.claimed)

    suspended.finish()
    await inFlight

    // One request per subject across the fleet, which is the entire claim.
    expect(fetches.filter((s) => s === suspended.subject)).toHaveLength(1)
  })

  it('does not unlatch the new owner when a lapsed worker finally reports back', async () => {
    // Renewal makes this rare rather than impossible: a worker suspended by the
    // operating system, or one whose database write blocked, still comes back
    // to a target somebody else now owns. Recording its result must not free
    // that lease, or a third worker takes the same subject while the second is
    // mid-fetch.
    const fetches: string[] = []
    const suspended = new SuspendingAdapter(fetches)
    const a = new Poller(repoA, new Map<SisId, SisAdapter>([['banner9', suspended]]), null, {
      now: () => clock.now,
      random: () => 0.5,
      batchSize: 1,
      workerId: 'worker-a',
      leaseMs: 60_000,
      // Never fires within the test, so this is the un-renewed case on purpose.
      leaseRenewMs: 10 * 60_000,
    })

    const inFlight = a.tick()
    await suspended.started
    clock.now += 60_001

    const stolen = repoB.claimTargets('worker-b', SUBJECTS.length, clock.now, 60_000)
    expect(stolen.map((t) => t.id)).toContain(suspended.claimed)

    suspended.finish()
    await inFlight

    const after = repoB.getTarget(suspended.claimed)!
    expect(after.lease_owner).toBe('worker-b')
    expect(after.lease_expires_at).toBe(clock.now + 60_000)
  })

  it('gives a second worker nothing when the first has already taken it all', async () => {
    const fetches: string[] = []
    const a = workerFor(repoA, 'worker-a', fetches, SUBJECTS.length)
    const b = workerFor(repoB, 'worker-b', fetches, SUBJECTS.length)

    await a.tick()
    expect((await b.tick()).polled).toBe(0)
    expect(fetches).toHaveLength(SUBJECTS.length)
  })
})
