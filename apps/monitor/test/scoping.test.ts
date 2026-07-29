import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { createApi } from '../src/api/server.js'
import { FixtureAdapter } from '../src/adapters/fixture.js'
import { MAX_LEVELS, normalizeLevel, parseLevels } from '../src/core/levels.js'
import { preferencesOf } from '../src/core/repo.js'
import type { RawSection } from '../src/adapters/types.js'
import {
  authHeaders,
  setupEnv,
  signUp,
  testSchool,
  SCHOOL_ID,
  TERM,
  TEST_PASSWORD,
  type TestAccount,
  type TestEnv,
} from './helpers.js'

/**
 * School, term and level scoping.
 *
 * The failure this exists to prevent is invisible with one school configured
 * and immediate with two: Find classes returning one list with two
 * universities' courses in it, which no query a student can type separates.
 *
 * The other half is the part that must NOT be scoped. A watchlist is a record
 * of what someone already asked for, not a question about what exists, so a
 * transfer student keeps every watch from their old school. A watchlist that
 * quietly dropped them would look exactly like the alerts working.
 */

const NEXT_TERM = '202701'
const OLD_SCHOOL = 'old-university'
const OLD_TERM = '202508'

const raw = (over: Partial<RawSection> = {}): RawSection => ({
  crn: '30412', subject: 'MATH', courseNumber: '221', code: 'MATH 221',
  title: 'Linear Algebra', section: 'B', credits: 3, instructor: 'Whitfield',
  meetingDays: 'MWF', meetingTime: '10:00a', campus: null, level: 'UGRD',
  seats: 0, capacity: 90, enrollment: 90, waitlist: 14, waitlistCap: 25, waitlistAvailable: 11,
  ...over,
})

// --------------------------------------------------------------------- pure

describe('level codes', () => {
  it('compares case and spacing insensitively', () => {
    expect(normalizeLevel('ugrd')).toBe('UGRD')
    expect(normalizeLevel('  Law  ')).toBe('LAW')
    expect(normalizeLevel('Graduate  Studies')).toBe('GRADUATE STUDIES')
  })

  it('refuses to guess that two different codes mean the same level', () => {
    // A registrar that publishes both keeps them apart, and folding them here
    // would merge two levels a student can see are different.
    expect(normalizeLevel('UG')).not.toBe(normalizeLevel('UGRD'))
  })

  it('keeps the registrar spelling and drops duplicates by the compared form', () => {
    expect(parseLevels(['UGRD', 'ugrd', 'GRAD'])).toEqual(['UGRD', 'GRAD'])
  })

  it('keeps a code we have never seen, since the set is per institution', () => {
    expect(parseLevels(['MEDS', 'LAW', 'PHRM', 'Undergraduate'])).toEqual([
      'MEDS', 'LAW', 'PHRM', 'Undergraduate',
    ])
  })

  it('rejects input that is not a list of strings', () => {
    expect(() => parseLevels('UGRD')).toThrow(/list of level codes/)
    expect(() => parseLevels([1])).toThrow(/must be a string/)
  })

  it('refuses more levels than a person could plausibly hold', () => {
    const many = Array.from({ length: MAX_LEVELS + 1 }, (_, i) => `L${i}`)
    expect(() => parseLevels(many)).toThrow(/at most/)
  })

  it('drops blanks rather than storing a level nobody can tick', () => {
    expect(parseLevels(['', '   ', 'UGRD'])).toEqual(['UGRD'])
  })
})

// ------------------------------------------------------------- the data layer

describe('level through the data layer', () => {
  let env: TestEnv

  beforeEach(() => {
    env = setupEnv()
  })
  afterEach(() => env.close())

  it('carries a level from the adapter into the stored section', async () => {
    const adapter = new FixtureAdapter([
      { crn: '1', subject: 'CS', courseNumber: '610', title: 'Distributed Systems', section: 'A', level: 'GRAD', seats: 0, capacity: 30 },
      { crn: '2', subject: 'CS', courseNumber: '260', title: 'Data Structures', section: 'A', seats: 4, capacity: 30 },
    ])
    const fetched = await adapter.fetchSections(env.school, TERM, 'CS')
    expect(fetched.map((s) => s.level)).toEqual(['GRAD', null])

    const target = env.repo.ensureTarget(SCHOOL_ID, TERM, 'CS', 60_000)
    for (const s of fetched) env.repo.upsertSection(target, s, false)

    const grad = env.repo.getSection(`${SCHOOL_ID}:${TERM}:1`)!
    expect(grad.level).toBe('GRAD')
    expect(grad.level_norm).toBe('GRAD')
    expect(env.repo.getSection(`${SCHOOL_ID}:${TERM}:2`)!.level).toBeNull()
  })

  it('keeps the registrar spelling for display and the folded one for matching', () => {
    const target = env.repo.ensureTarget(SCHOOL_ID, TERM, 'MATH', 60_000)
    const id = env.repo.upsertSection(target, raw({ level: 'ugrd' }), false)
    const row = env.repo.getSection(id)!
    expect(row.level).toBe('ugrd')
    expect(row.level_norm).toBe('UGRD')
    expect(env.repo.searchSections({ levels: ['UGRD'] })).toHaveLength(1)
  })

  it('reclassifies a section when the registrar moves it', () => {
    const target = env.repo.ensureTarget(SCHOOL_ID, TERM, 'MATH', 60_000)
    const id = env.repo.upsertSection(target, raw({ level: 'UGRD' }), false)
    env.repo.upsertSection(target, raw({ level: 'GRAD' }), false)
    expect(env.repo.getSection(id)!.level).toBe('GRAD')
  })

  it('treats an empty level string as no level at all', () => {
    const target = env.repo.ensureTarget(SCHOOL_ID, TERM, 'MATH', 60_000)
    const id = env.repo.upsertSection(target, raw({ level: '  ' }), false)
    expect(env.repo.getSection(id)!.level).toBeNull()
  })
})

// ------------------------------------------------------------------- search

describe('scoped catalog search', () => {
  let env: TestEnv

  beforeEach(() => {
    env = setupEnv()
    env.repo.upsertSchool(testSchool({ id: OLD_SCHOOL, name: 'Old University' }))

    const here = env.repo.ensureTarget(SCHOOL_ID, TERM, 'MATH', 60_000)
    env.repo.upsertSection(here, raw({ crn: '30412', level: 'UGRD' }), false)
    env.repo.upsertSection(here, raw({ crn: '30501', courseNumber: '501', code: 'MATH 501', title: 'Measure Theory', level: 'GRAD' }), false)
    env.repo.upsertSection(here, raw({ crn: '30250', courseNumber: '250', code: 'MATH 250', title: 'Discrete Math', level: null }), false)

    const later = env.repo.ensureTarget(SCHOOL_ID, NEXT_TERM, 'MATH', 60_000)
    env.repo.upsertSection(later, raw({ crn: '40412', level: 'UGRD' }), false)

    const elsewhere = env.repo.ensureTarget(OLD_SCHOOL, OLD_TERM, 'HIST', 60_000)
    env.repo.upsertSection(elsewhere, raw({ crn: '50101', subject: 'HIST', courseNumber: '101', code: 'HIST 101', title: 'Modern Europe', level: 'UGRD' }), false)
  })
  afterEach(() => env.close())

  it('separates two schools that are both configured', () => {
    expect(env.repo.searchSections({ schoolId: SCHOOL_ID })).toHaveLength(4)
    expect(env.repo.searchSections({ schoolId: OLD_SCHOOL })).toHaveLength(1)
  })

  it('separates two terms at one school', () => {
    expect(env.repo.searchSections({ schoolId: SCHOOL_ID, term: TERM })).toHaveLength(3)
    expect(env.repo.searchSections({ schoolId: SCHOOL_ID, term: NEXT_TERM })).toHaveLength(1)
  })

  it('narrows to a level, and shows a section the registrar never classified', () => {
    const found = env.repo.searchSections({ schoolId: SCHOOL_ID, term: TERM, levels: ['UGRD'] })
    // MATH 221 because it is UGRD, MATH 250 because nothing said it is not.
    expect(found.map((s) => s.code).sort()).toEqual(['MATH 221', 'MATH 250'])
  })

  it('takes any of several levels at once', () => {
    const found = env.repo.searchSections({ schoolId: SCHOOL_ID, term: TERM, levels: ['UGRD', 'GRAD'] })
    expect(found).toHaveLength(3)
  })

  it('treats an empty level list as no level filter rather than as no levels', () => {
    expect(env.repo.searchSections({ schoolId: SCHOOL_ID, term: TERM, levels: [] })).toHaveLength(3)
  })

  it('reads the levels a school publishes off the catalog itself', () => {
    expect(env.repo.listLevels(SCHOOL_ID, TERM)).toEqual([
      { level: 'GRAD', sections: 1 },
      { level: 'UGRD', sections: 1 },
    ])
    expect(env.repo.listLevels(OLD_SCHOOL)).toEqual([{ level: 'UGRD', sections: 1 }])
  })
})

// --------------------------------------------------------------- over HTTP

describe('scoping over HTTP', () => {
  let env: TestEnv
  let server: Server
  let base: string
  let alice: TestAccount
  let oldSectionId: string

  beforeEach(async () => {
    env = setupEnv()
    env.repo.replaceTerms(SCHOOL_ID, [
      { code: TERM, description: 'Fall 2026' },
      { code: NEXT_TERM, description: 'Spring 2027' },
    ])
    env.repo.upsertSchool(testSchool({ id: OLD_SCHOOL, name: 'Old University' }))
    env.repo.replaceTerms(OLD_SCHOOL, [{ code: OLD_TERM, description: 'Fall 2025' }])

    const here = env.repo.ensureTarget(SCHOOL_ID, TERM, 'MATH', 60_000)
    env.repo.upsertSection(here, raw({ crn: '30412', level: 'UGRD' }), false)
    env.repo.upsertSection(here, raw({ crn: '30501', courseNumber: '501', code: 'MATH 501', title: 'Measure Theory', level: 'GRAD' }), false)
    env.repo.upsertSection(here, raw({ crn: '30250', courseNumber: '250', code: 'MATH 250', title: 'Discrete Math', level: null }), false)

    const later = env.repo.ensureTarget(SCHOOL_ID, NEXT_TERM, 'MATH', 60_000)
    env.repo.upsertSection(later, raw({ crn: '40412', level: 'UGRD' }), false)

    const elsewhere = env.repo.ensureTarget(OLD_SCHOOL, OLD_TERM, 'HIST', 60_000)
    oldSectionId = env.repo.upsertSection(
      elsewhere,
      raw({ crn: '50101', subject: 'HIST', courseNumber: '101', code: 'HIST 101', title: 'Modern Europe', level: 'UGRD' }),
      false
    )

    server = createApi({ repo: env.repo, now: () => env.clock.now })
    await new Promise<void>((r) => server.listen(0, r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

    alice = await signUp(base, 'alice@classpik.test', TEST_PASSWORD, {
      school: SCHOOL_ID,
      term: TERM,
      levels: ['UGRD'],
    })
  })

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()))
    env.close()
  })

  const get = (path: string, token: string | null = alice.token) =>
    fetch(`${base}${path}`, { headers: authHeaders(token) })
  const post = (path: string, body?: unknown, token: string | null = alice.token) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  const codes = async (path: string, token: string | null = alice.token): Promise<string[]> => {
    const res = await get(path, token)
    expect(res.status, path).toBe(200)
    const body = (await res.json()) as { sections: Array<{ code: string }> }
    return body.sections.map((s) => s.code).sort()
  }

  describe('defaults', () => {
    it('scopes a signed-in student to their own school, term and level', async () => {
      // MATH 501 is graduate and MATH 221 next term is a different term, so
      // neither belongs in an undergraduate's search this term.
      expect(await codes('/api/sections')).toEqual(['MATH 221', 'MATH 250'])
    })

    it('never mixes two universities into one list', async () => {
      expect(await codes('/api/sections')).not.toContain('HIST 101')
    })

    it('shows a signed-out caller the whole catalog, as before', async () => {
      expect(await codes('/api/sections', null)).toEqual([
        'HIST 101', 'MATH 221', 'MATH 221', 'MATH 250', 'MATH 501',
      ])
    })

    it('reports the scope it applied, so a client can show it and offer a way out', async () => {
      const body = (await (await get('/api/sections')).json()) as {
        scope: { school: string | null; term: string | null; levels: string[] }
      }
      expect(body.scope).toEqual({ school: SCHOOL_ID, term: TERM, levels: ['UGRD'] })
    })

    it('varies on the credential, since the same URL answers differently per account', async () => {
      const res = await get('/api/sections')
      expect(res.headers.get('vary')?.toLowerCase()).toContain('authorization')
    })

    it('carries the registrar level on each section', async () => {
      const body = (await (await get('/api/sections?level=any')).json()) as {
        sections: Array<{ code: string; level: string | null }>
      }
      const byCode = new Map(body.sections.map((s) => [s.code, s.level]))
      expect(byCode.get('MATH 501')).toBe('GRAD')
      expect(byCode.get('MATH 250')).toBeNull()
    })
  })

  describe('widening, which is the student\'s own act', () => {
    it('takes an explicit term over the account default', async () => {
      expect(await codes(`/api/sections?term=${NEXT_TERM}`)).toEqual(['MATH 221'])
    })

    it('takes an explicit level, and takes several', async () => {
      expect(await codes('/api/sections?level=GRAD')).toEqual(['MATH 250', 'MATH 501'])
      expect(await codes('/api/sections?level=UGRD&level=GRAD')).toEqual([
        'MATH 221', 'MATH 250', 'MATH 501',
      ])
      expect(await codes('/api/sections?level=UGRD,GRAD')).toEqual([
        'MATH 221', 'MATH 250', 'MATH 501',
      ])
    })

    it('clears one dimension with any, leaving the others in place', async () => {
      expect(await codes('/api/sections?level=any')).toEqual([
        'MATH 221', 'MATH 250', 'MATH 501',
      ])
      expect(await codes('/api/sections?term=any')).toEqual([
        'MATH 221', 'MATH 221', 'MATH 250',
      ])
    })

    it('drops a term and level inherited from another school when a school is named', async () => {
      // Term codes and level codes are institution-defined, so the account's
      // 202608 and UGRD mean nothing at a school that spells them differently.
      // Carrying them across would return almost nothing and read as a school
      // that failed to load.
      expect(await codes(`/api/sections?school=${OLD_SCHOOL}`)).toEqual(['HIST 101'])
    })

    it('still applies levels chosen without a school, which asked for them everywhere', async () => {
      const dana = await signUp(base, 'dana@classpik.test', TEST_PASSWORD, { levels: ['UGRD'] })
      expect(await codes('/api/sections', dana.token)).toEqual([
        'HIST 101', 'MATH 221', 'MATH 221', 'MATH 250',
      ])
    })

    it('shows everything again with school=any', async () => {
      expect(await codes('/api/sections?school=any')).toEqual([
        'HIST 101', 'MATH 221', 'MATH 221', 'MATH 250', 'MATH 501',
      ])
    })

    it('lets a student with two levels ticked see both', async () => {
      const res = await post('/api/auth/preferences', { levels: ['UGRD', 'GRAD'] })
      expect(res.status).toBe(200)
      expect(((await res.json()) as { user: { levels: string[] } }).user.levels).toEqual(['UGRD', 'GRAD'])
      expect(await codes('/api/sections')).toEqual(['MATH 221', 'MATH 250', 'MATH 501'])
    })
  })

  describe('the watchlist, which is deliberately unscoped', () => {
    it('keeps a watch at a school the student is no longer set to', async () => {
      // Alice watched a class at her old university before transferring.
      expect((await post('/api/watches', { sectionId: oldSectionId })).status).toBe(201)
      expect((await post('/api/auth/preferences', { school: SCHOOL_ID, term: TERM, levels: ['UGRD'] })).status).toBe(200)

      const watches = (await (await get('/api/watches')).json()) as {
        watches: Array<{ section: { id: string; schoolId: string; code: string } }>
      }
      expect(watches.watches.map((w) => w.section.code)).toContain('HIST 101')
      expect(watches.watches[0]!.section.schoolId).toBe(OLD_SCHOOL)

      // And the same section is correctly absent from her scoped search, which
      // is the whole point: search is scoped, the watchlist is not.
      expect(await codes('/api/sections')).not.toContain('HIST 101')
    })

    it('keeps a watch on a level the student has not ticked', async () => {
      const gradId = `${SCHOOL_ID}:${TERM}:30501`
      expect((await post('/api/watches', { sectionId: gradId })).status).toBe(201)
      const watches = (await (await get('/api/watches')).json()) as {
        watches: Array<{ section: { code: string } }>
      }
      expect(watches.watches.map((w) => w.section.code)).toEqual(['MATH 501'])
    })

    it('still delivers events for a watch outside the current scope', async () => {
      expect((await post('/api/watches', { sectionId: oldSectionId })).status).toBe(201)
      env.repo.recordEvent(oldSectionId, {
        kind: 'seat_opened', prevSeats: 0, newSeats: 1, prevWaitlist: 0, newWaitlist: 0,
        detail: '1 seat opened',
      })
      const body = (await (await get('/api/events')).json()) as { events: Array<{ code: string }> }
      expect(body.events.map((e) => e.code)).toEqual(['HIST 101'])
    })
  })

  describe('preferences', () => {
    it('records what was chosen at signup', async () => {
      const body = (await (await get('/api/auth/me')).json()) as {
        user: { school: string; term: string; levels: string[] }
      }
      expect(body.user).toMatchObject({ school: SCHOOL_ID, term: TERM, levels: ['UGRD'] })
    })

    it('signs up perfectly well without any of them', async () => {
      const bob = await signUp(base, 'bob@classpik.test')
      expect(preferencesOf(env.repo.getUser(bob.userId)!)).toEqual({
        schoolId: null, term: null, levels: [],
      })
      expect(await codes('/api/sections', bob.token)).toHaveLength(5)
    })

    it('changes one field without disturbing the others', async () => {
      await post('/api/auth/preferences', { term: NEXT_TERM })
      const prefs = preferencesOf(env.repo.getUser(alice.userId)!)
      expect(prefs).toEqual({ schoolId: SCHOOL_ID, term: NEXT_TERM, levels: ['UGRD'] })
    })

    it('clears a field with null, which is how a student widens for good', async () => {
      await post('/api/auth/preferences', { term: null, levels: null })
      expect(preferencesOf(env.repo.getUser(alice.userId)!)).toEqual({
        schoolId: SCHOOL_ID, term: null, levels: [],
      })
      expect(await codes('/api/sections')).toEqual([
        'MATH 221', 'MATH 221', 'MATH 250', 'MATH 501',
      ])
    })

    it('clears the old school\'s levels when only the school is moved', async () => {
      // The transfer student's first request at a new school, and what any
      // client that is not our own React app sends. The stored UGRD is Test
      // University's code; Old University publishes UG, so carrying it across
      // filtered the new catalog on a code that school has never published and
      // Find classes came back empty with nothing said about why.
      const there = env.repo.ensureTarget(OLD_SCHOOL, OLD_TERM, 'PHIL', 60_000)
      env.repo.upsertSection(
        there,
        raw({ crn: '50201', subject: 'PHIL', courseNumber: '201', code: 'PHIL 201', title: 'Ethics', level: 'UG' }),
        false
      )

      const res = await post('/api/auth/preferences', { school: OLD_SCHOOL })
      expect(res.status).toBe(200)

      const prefs = preferencesOf(env.repo.getUser(alice.userId)!)
      expect(prefs.levels).toEqual([])
      // The old school's term code means nothing here either, and it is dropped
      // for the same reason once we can prove this school does not publish it.
      expect(prefs.term).toBeNull()

      // And the point of all of it: the new school's catalog is actually there.
      expect(await codes('/api/sections')).toEqual(['HIST 101', 'PHIL 201'])
    })

    it('keeps levels the same request also stated, since that was said on purpose', async () => {
      const res = await post('/api/auth/preferences', {
        school: OLD_SCHOOL,
        term: OLD_TERM,
        levels: ['UGRD'],
      })
      expect(res.status).toBe(200)
      expect(preferencesOf(env.repo.getUser(alice.userId)!)).toEqual({
        schoolId: OLD_SCHOOL, term: OLD_TERM, levels: ['UGRD'],
      })
    })

    it('leaves levels alone when the school is not what changed', async () => {
      await post('/api/auth/preferences', { term: NEXT_TERM })
      expect(preferencesOf(env.repo.getUser(alice.userId)!).levels).toEqual(['UGRD'])

      // Re-stating the same school is not a move either.
      await post('/api/auth/preferences', { school: SCHOOL_ID })
      expect(preferencesOf(env.repo.getUser(alice.userId)!).levels).toEqual(['UGRD'])
    })

    it('keeps levels when the school is cleared, which asked for them everywhere', async () => {
      await post('/api/auth/preferences', { school: null })
      expect(preferencesOf(env.repo.getUser(alice.userId)!).levels).toEqual(['UGRD'])
    })

    it('refuses a school that does not exist rather than scoping to nothing', async () => {
      const res = await post('/api/auth/preferences', { school: 'not-a-school' })
      expect(res.status).toBe(400)
      expect(preferencesOf(env.repo.getUser(alice.userId)!).schoolId).toBe(SCHOOL_ID)
    })

    it('refuses a term the school does not have', async () => {
      const res = await post('/api/auth/preferences', { term: '999999' })
      expect(res.status).toBe(400)
      expect(((await res.json()) as { error: string }).error).toContain('no term')
    })

    it('accepts a term at a school whose terms are not known yet', async () => {
      // Refusing every term at a freshly configured school would lock its
      // students out of choosing one at all.
      env.repo.upsertSchool(testSchool({ id: 'fresh-university', name: 'Fresh University' }))
      const res = await post('/api/auth/preferences', { school: 'fresh-university', term: '1232' })
      expect(res.status).toBe(200)
    })

    it('refuses a term with no school to read it against', async () => {
      const bob = await signUp(base, 'bob2@classpik.test')
      const res = await post('/api/auth/preferences', { term: TERM }, bob.token)
      expect(res.status).toBe(400)
    })

    it('refuses levels that are not a list of codes', async () => {
      expect((await post('/api/auth/preferences', { levels: 'UGRD' })).status).toBe(400)
      expect((await post('/api/auth/preferences', { levels: [7] })).status).toBe(400)
      expect(preferencesOf(env.repo.getUser(alice.userId)!).levels).toEqual(['UGRD'])
    })

    it('refuses an unknown school at signup without creating the account', async () => {
      const res = await post('/api/auth/signup', {
        email: 'carol@classpik.test', password: TEST_PASSWORD, school: 'not-a-school',
      }, null)
      expect(res.status).toBe(400)
      const login = await post('/api/auth/login', {
        email: 'carol@classpik.test', password: TEST_PASSWORD,
      }, null)
      expect(login.status).toBe(401)
    })

    it('takes an account, since these belong to one', async () => {
      expect((await post('/api/auth/preferences', { levels: [] }, null)).status).toBe(401)
    })
  })

  describe('GET /api/levels', () => {
    it('lists the levels a school publishes, which is where the boxes come from', async () => {
      const body = (await (await get(`/api/levels?school=${SCHOOL_ID}&term=${TERM}`)).json()) as {
        levels: Array<{ level: string; sections: number }>
      }
      expect(body.levels).toEqual([
        { level: 'GRAD', sections: 1 },
        { level: 'UGRD', sections: 1 },
      ])
    })

    it('404s a school we do not carry', async () => {
      expect((await get('/api/levels?school=not-a-school')).status).toBe(404)
    })

    it('needs a school, since levels are institution-defined', async () => {
      expect((await get('/api/levels')).status).toBe(400)
    })
  })
})
