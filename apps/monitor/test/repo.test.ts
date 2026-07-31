import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { migrate, openDb, tx } from '../src/core/db.js'
import { sectionId, statusOf, targetId } from '../src/core/repo.js'
import { setupEnv, SCHOOL_ID, TERM, type TestEnv } from './helpers.js'
import type { RawSection } from '../src/adapters/types.js'

const section = (over: Partial<RawSection> = {}): RawSection => ({
  crn: '10001',
  subject: 'MATH',
  courseNumber: '221',
  code: 'MATH 221',
  title: 'Linear Algebra',
  section: 'A',
  credits: 3,
  instructor: 'Whitfield',
  meetingDays: 'MWF',
  meetingTime: '10:00a',
  campus: null,
  level: null,
  seats: 0,
  capacity: 90,
  enrollment: 90,
  waitlist: 5,
  waitlistCap: 20,
  waitlistAvailable: 15,
  ...over,
})

describe('migrations', () => {
  it('is idempotent', () => {
    const db = openDb(':memory:')
    const first = migrate(db)
    const second = migrate(db)
    expect(first.applied.length).toBeGreaterThan(0)
    expect(second.applied).toEqual([])
    expect(second.from).toBe(first.to)
    db.close()
  })

  it('upgrades a database that already has data in it', () => {
    // The path a deployed instance actually takes. A fresh-database test would
    // never catch a migration that only works on an empty schema.
    const db = openDb(':memory:')
    migrate(db)
    db.prepare(
      'INSERT INTO schools (id,name,sis,base_url,enabled,config_json,created_at) VALUES (?,?,?,?,?,?,?)'
    ).run('s1', 'S', 'banner9', 'https://s.invalid', 1, '{}', 0)
    db.prepare(
      `INSERT INTO poll_targets (id,school_id,term,subject,interval_ms,next_poll_at,created_at)
       VALUES (?,?,?,?,?,?,?)`
    ).run('s1:202608:MATH', 's1', '202608', 'MATH', 60_000, 0, 0)
    db.prepare(
      `INSERT INTO sections (
         id,target_id,school_id,term,crn,subject,course_number,code,title,section,
         seats,capacity,enrollment,waitlist,waitlist_cap,waitlist_available,status,
         first_seen_at,last_polled_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      's1:202608:10001', 's1:202608:MATH', 's1', '202608', '10001', 'MATH', '221',
      'MATH 221', 'Linear Algebra', 'A', 0, 90, 90, 5, 20, 15, 'full', 0, 0
    )

    // Rewind the schema all the way back to version 1 so every later migration
    // runs again over populated tables, as each did on an instance that
    // predates it. Undoing the lease and level columns needs their indexes
    // dropped first, because SQLite refuses to drop a column an index still
    // refers to.
    // auth_tokens before users, since it references it and foreign keys are on.
    db.exec('DROP TABLE auth_tokens')
    db.exec('DROP TABLE users')
    db.exec('DROP TABLE sessions')
    db.exec('DROP TABLE subjects')
    db.exec('DROP INDEX idx_sections_scope')
    db.exec('ALTER TABLE sections DROP COLUMN level')
    db.exec('ALTER TABLE sections DROP COLUMN level_norm')
    db.exec('DROP INDEX idx_targets_due')
    db.exec('ALTER TABLE poll_targets DROP COLUMN lease_owner')
    db.exec('ALTER TABLE poll_targets DROP COLUMN lease_expires_at')
    db.exec('CREATE INDEX idx_targets_due ON poll_targets (active, next_poll_at)')
    db.prepare('UPDATE schema_version SET version = ?').run(1)

    const result = migrate(db)
    expect(result.from).toBe(1)
    expect(result.applied).toEqual([
      'accounts',
      'subjects and leases',
      'scoping',
      'account recovery',
    ])
    expect(db.prepare('SELECT COUNT(*) AS n FROM schools').get()).toEqual({ n: 1 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM users').get()).toEqual({ n: 0 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM subjects').get()).toEqual({ n: 0 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM auth_tokens').get()).toEqual({ n: 0 })
    // The existing target survived the ALTER and came out unleased, rather than
    // the migration having quietly rebuilt the table and lost it.
    expect(db.prepare('SELECT id, lease_owner, lease_expires_at FROM poll_targets').get()).toEqual({
      id: 's1:202608:MATH',
      lease_owner: null,
      lease_expires_at: null,
    })
    // A section that predates level scoping keeps its row and comes out
    // unclassified, which is what makes it visible to every level rather than
    // to none until the next poll fills it in.
    expect(db.prepare('SELECT id, level, level_norm FROM sections').get()).toEqual({
      id: 's1:202608:10001',
      level: null,
      level_norm: null,
    })
    db.close()
  })

  it('cascades sessions away when their account is deleted', () => {
    const db = openDb(':memory:')
    migrate(db)
    db.prepare(
      'INSERT INTO users (id,email,email_norm,password_hash,created_at) VALUES (?,?,?,?,?)'
    ).run('u1', 'a@b.co', 'a@b.co', 'x', 0)
    db.prepare(
      'INSERT INTO sessions (token_hash,user_id,created_at,expires_at) VALUES (?,?,?,?)'
    ).run('h1', 'u1', 0, 1)
    db.prepare('DELETE FROM users WHERE id = ?').run('u1')
    expect(db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 0 })
    db.close()
  })

  it('refuses two accounts for the same normalised email', () => {
    const db = openDb(':memory:')
    migrate(db)
    const ins = db.prepare(
      'INSERT INTO users (id,email,email_norm,password_hash,created_at) VALUES (?,?,?,?,?)'
    )
    ins.run('u1', 'Ada@B.co', 'ada@b.co', 'x', 0)
    expect(() => ins.run('u2', 'ada@b.co', 'ada@b.co', 'y', 0)).toThrow()
    db.close()
  })

  it('enforces foreign keys', () => {
    const db = openDb(':memory:')
    migrate(db)
    expect(() =>
      db
        .prepare('INSERT INTO watches (id, user_id, section_id, created_at) VALUES (?,?,?,?)')
        .run('w1', 'u1', 'does-not-exist', Date.now())
    ).toThrow()
    db.close()
  })
})

describe('tx', () => {
  const school = (db: ReturnType<typeof openDb>, id: string) =>
    db
      .prepare(
        'INSERT INTO schools (id,name,sis,base_url,enabled,config_json,created_at) VALUES (?,?,?,?,?,?,?)'
      )
      .run(id, id.toUpperCase(), 'banner9', `https://${id}.invalid`, 1, '{}', 0)

  const count = (db: ReturnType<typeof openDb>): number =>
    (db.prepare('SELECT COUNT(*) AS n FROM schools').get() as { n: number }).n

  it('rolls back on throw', () => {
    const db = openDb(':memory:')
    migrate(db)
    expect(() =>
      tx(db, () => {
        db.prepare(
          'INSERT INTO schools (id,name,sis,base_url,enabled,config_json,created_at) VALUES (?,?,?,?,?,?,?)'
        ).run('x', 'X', 'banner9', 'https://x.invalid', 1, '{}', 0)
        throw new Error('boom')
      })
    ).toThrow('boom')
    const n = db.prepare('SELECT COUNT(*) AS n FROM schools').get() as { n: number }
    expect(n.n).toBe(0)
    db.close()
  })

  it('nests, committing the inner and outer work together', () => {
    const db = openDb(':memory:')
    migrate(db)
    tx(db, () => {
      school(db, 'outer')
      tx(db, () => school(db, 'inner'))
    })
    expect(count(db)).toBe(2)
    db.close()
  })

  it('reports the real error from an inner transaction, not a nesting one', () => {
    // SQLite has no nested BEGIN. An inner tx used to throw "cannot start a
    // transaction within a transaction" at its own BEGIN and then destroy the
    // caller's error with a second throw from the rollback, so whatever
    // actually went wrong never reached anyone.
    const db = openDb(':memory:')
    migrate(db)
    expect(() =>
      tx(db, () => {
        school(db, 'outer')
        tx(db, () => {
          throw new Error('the real problem')
        })
      })
    ).toThrow('the real problem')
    expect(count(db)).toBe(0)
    db.close()
  })

  it('unwinds only the inner work when the caller catches the inner failure', () => {
    const db = openDb(':memory:')
    migrate(db)
    tx(db, () => {
      school(db, 'kept')
      try {
        tx(db, () => {
          school(db, 'discarded')
          throw new Error('inner')
        })
      } catch {
        // The point: the outer transaction is still usable afterwards.
      }
      school(db, 'also-kept')
    })
    expect(count(db)).toBe(2)
    expect(db.prepare('SELECT id FROM schools ORDER BY id').all()).toEqual([
      { id: 'also-kept' },
      { id: 'kept' },
    ])
    db.close()
  })

  it('handles siblings and three levels without leaving a savepoint open', () => {
    const db = openDb(':memory:')
    migrate(db)
    tx(db, () => {
      tx(db, () => school(db, 'a'))
      tx(db, () => {
        school(db, 'b')
        tx(db, () => school(db, 'c'))
      })
    })
    expect(count(db)).toBe(3)
    // Every level released, so the handle is out of a transaction entirely and
    // the next unrelated write is not silently riding on an open one.
    expect(db.isTransaction).toBe(false)
    db.close()
  })
})

describe('statusOf', () => {
  it('is open when seats remain', () => {
    expect(statusOf({ seats: 3, waitlist: 0, waitlistCap: 10 })).toBe('open')
  })
  it('is waitlist when full but the waitlist has room', () => {
    expect(statusOf({ seats: 0, waitlist: 4, waitlistCap: 10 })).toBe('waitlist')
  })
  it('is full when both are exhausted', () => {
    expect(statusOf({ seats: 0, waitlist: 10, waitlistCap: 10 })).toBe('full')
  })
  it('is full when there is no waitlist at all', () => {
    expect(statusOf({ seats: 0, waitlist: 0, waitlistCap: 0 })).toBe('full')
  })
})

describe('Repo', () => {
  let env: TestEnv
  beforeEach(() => { env = setupEnv() })
  afterEach(() => env.close())

  it('round-trips a school config', () => {
    const loaded = env.repo.getSchool(SCHOOL_ID)
    expect(loaded?.name).toBe('Test University')
    expect(loaded?.polling.minIntervalMs).toBe(60_000)
  })

  it('replaces terms wholesale rather than accumulating them', () => {
    env.repo.replaceTerms(SCHOOL_ID, [
      { code: '202608', description: 'Fall 2026' },
      { code: '202602', description: 'Spring 2026' },
    ])
    env.repo.replaceTerms(SCHOOL_ID, [{ code: '202608', description: 'Fall 2026' }])
    expect(env.repo.listTerms(SCHOOL_ID)).toHaveLength(1)
  })

  it('ensureTarget is idempotent', () => {
    const a = env.repo.ensureTarget(SCHOOL_ID, TERM, 'MATH', 60_000)
    const b = env.repo.ensureTarget(SCHOOL_ID, TERM, 'MATH', 60_000)
    expect(a.id).toBe(b.id)
    expect(env.repo.listTargets()).toHaveLength(1)
    expect(a.id).toBe(targetId(SCHOOL_ID, TERM, 'MATH'))
  })

  it('upserts a section and updates it in place', () => {
    const target = env.repo.ensureTarget(SCHOOL_ID, TERM, 'MATH', 60_000)
    const id = env.repo.upsertSection(target, section(), false)
    expect(id).toBe(sectionId(SCHOOL_ID, TERM, '10001'))

    env.repo.upsertSection(target, section({ seats: 4 }), true)
    const stored = env.repo.getSection(id)!
    expect(stored.seats).toBe(4)
    expect(stored.status).toBe('open')
    expect(env.repo.searchSections({})).toHaveLength(1)
  })

  it('only stamps last_changed_at when something actually changed', () => {
    const target = env.repo.ensureTarget(SCHOOL_ID, TERM, 'MATH', 60_000)
    const id = env.repo.upsertSection(target, section(), false)
    expect(env.repo.getSection(id)!.last_changed_at).toBeNull()

    env.clock.now += 1000
    env.repo.upsertSection(target, section({ seats: 2 }), true)
    expect(env.repo.getSection(id)!.last_changed_at).toBe(env.clock.now)
  })

  it('returns previous states keyed by CRN', () => {
    const target = env.repo.ensureTarget(SCHOOL_ID, TERM, 'MATH', 60_000)
    env.repo.upsertSection(target, section({ crn: 'A', seats: 1 }), false)
    env.repo.upsertSection(target, section({ crn: 'B', seats: 0 }), false)

    const states = env.repo.getSectionStates(target.id)
    expect(states.size).toBe(2)
    expect(states.get('A')!.seats).toBe(1)
    expect(states.get('B')!.waitlistAvailable).toBe(15)
  })

  it('excludes absent sections from state and search', () => {
    const target = env.repo.ensureTarget(SCHOOL_ID, TERM, 'MATH', 60_000)
    env.repo.upsertSection(target, section({ crn: 'A' }), false)
    env.repo.markSectionsAbsent(target.id, ['A'])
    expect(env.repo.getSectionStates(target.id).size).toBe(0)
    expect(env.repo.searchSections({})).toHaveLength(0)
  })

  describe('searchSections', () => {
    beforeEach(() => {
      const target = env.repo.ensureTarget(SCHOOL_ID, TERM, 'MATH', 60_000)
      env.repo.upsertSection(target, section({ crn: '30412', code: 'MATH 221', seats: 0 }), false)
      env.repo.upsertSection(
        target,
        section({ crn: '88888', code: 'MATH 310', title: 'Real Analysis', seats: 5, instructor: 'Ferreira' }),
        false
      )
    })

    it('matches a course code with a space', () => {
      expect(env.repo.searchSections({ query: 'MATH 310' })).toHaveLength(1)
    })

    it('matches a course code without the space, because nobody types it', () => {
      expect(env.repo.searchSections({ query: 'math310' })).toHaveLength(1)
    })

    it('matches on title, CRN, and instructor', () => {
      expect(env.repo.searchSections({ query: 'analysis' })).toHaveLength(1)
      expect(env.repo.searchSections({ query: '88888' })).toHaveLength(1)
      expect(env.repo.searchSections({ query: 'ferreira' })).toHaveLength(1)
    })

    it('matches a partial CRN, which is how students actually paste them', () => {
      expect(env.repo.searchSections({ query: '304' })).toHaveLength(1)
    })

    it('matches across fields, so a digit in a course code counts too', () => {
      // "2" is in MATH 221's code but in neither CRN nor MATH 310. Broad
      // matching is right for a search box; narrowing is the caller's job.
      expect(env.repo.searchSections({ query: '2' })).toHaveLength(1)
    })

    it('filters by status', () => {
      expect(env.repo.searchSections({ status: 'open' })).toHaveLength(1)
      expect(env.repo.searchSections({ status: 'waitlist' })).toHaveLength(1)
    })

    it('respects the limit', () => {
      expect(env.repo.searchSections({ limit: 1 })).toHaveLength(1)
    })
  })

  describe('watches', () => {
    let sid: string
    beforeEach(() => {
      const target = env.repo.ensureTarget(SCHOOL_ID, TERM, 'MATH', 60_000)
      sid = env.repo.upsertSection(target, section(), false)
    })

    it('creates and lists a watch', () => {
      const w = env.repo.createWatch({ userId: 'roshan', sectionId: sid })
      expect(w.mode).toBe('notify')
      const list = env.repo.listWatches('roshan')
      expect(list).toHaveLength(1)
      expect(list[0]!.section.code).toBe('MATH 221')
    })

    it('is idempotent per user and section', () => {
      const a = env.repo.createWatch({ userId: 'roshan', sectionId: sid })
      const b = env.repo.createWatch({ userId: 'roshan', sectionId: sid, mode: 'claim' })
      expect(b.id).toBe(a.id)
      expect(b.mode).toBe('claim')
      expect(env.repo.listWatches('roshan')).toHaveLength(1)
    })

    it('reactivates rather than duplicating after removal', () => {
      const a = env.repo.createWatch({ userId: 'roshan', sectionId: sid })
      env.repo.deactivateWatch(a.id)
      expect(env.repo.listWatches('roshan')).toHaveLength(0)

      const b = env.repo.createWatch({ userId: 'roshan', sectionId: sid })
      expect(b.id).toBe(a.id)
      expect(env.repo.listWatches('roshan')).toHaveLength(1)
    })

    it('keeps different users separate', () => {
      env.repo.createWatch({ userId: 'roshan', sectionId: sid })
      env.repo.createWatch({ userId: 'andy', sectionId: sid })
      expect(env.repo.activeWatchesForSection(sid)).toHaveLength(2)
      expect(env.repo.listWatches('roshan')).toHaveLength(1)
    })

    it('reports false when deactivating an unknown watch', () => {
      expect(env.repo.deactivateWatch('nope')).toBe(false)
    })
  })

  describe('due targets', () => {
    it('ignores targets nobody is watching', () => {
      const target = env.repo.ensureTarget(SCHOOL_ID, TERM, 'MATH', 60_000)
      env.repo.upsertSection(target, section(), false)
      env.repo.recordPollSuccess(target.id, env.clock.now - 1, 60_000, false)
      expect(env.repo.dueTargets(10, env.clock.now)).toHaveLength(0)
    })

    it('returns a watched target once it is due', () => {
      const target = env.repo.ensureTarget(SCHOOL_ID, TERM, 'MATH', 60_000)
      const sid = env.repo.upsertSection(target, section(), false)
      env.repo.createWatch({ userId: 'roshan', sectionId: sid })
      env.repo.recordPollSuccess(target.id, env.clock.now - 1, 60_000, false)

      const due = env.repo.dueTargets(10, env.clock.now)
      expect(due.map((t) => t.id)).toEqual([target.id])
    })

    it('does not return a target before its next poll time', () => {
      const target = env.repo.ensureTarget(SCHOOL_ID, TERM, 'MATH', 60_000)
      const sid = env.repo.upsertSection(target, section(), false)
      env.repo.createWatch({ userId: 'roshan', sectionId: sid })
      env.repo.recordPollSuccess(target.id, env.clock.now + 60_000, 60_000, false)
      expect(env.repo.dueTargets(10, env.clock.now)).toHaveLength(0)
    })

    it('surfaces never-polled targets through the bootstrap path', () => {
      // These have no sections, so no watches, so dueTargets can never see them.
      const target = env.repo.ensureTarget(SCHOOL_ID, TERM, 'MATH', 60_000)
      expect(env.repo.dueTargets(10, env.clock.now)).toHaveLength(0)
      expect(env.repo.unseededTargets(10, env.clock.now).map((t) => t.id)).toEqual([target.id])
    })

    it('stops surfacing a target as unseeded once polled', () => {
      const target = env.repo.ensureTarget(SCHOOL_ID, TERM, 'MATH', 60_000)
      env.repo.recordPollSuccess(target.id, env.clock.now + 1000, 60_000, false)
      expect(env.repo.unseededTargets(10, env.clock.now)).toHaveLength(0)
    })

    it('claims a never-polled target and an unwatched one only while unpolled', () => {
      // claimTargets replaced dueTargets + unseededTargets in the loop, so it
      // has to carry the same rule: bootstrap once, then only for demand.
      const target = env.repo.ensureTarget(SCHOOL_ID, TERM, 'MATH', 60_000)
      expect(env.repo.claimTargets('w1', 10, env.clock.now).map((t) => t.id)).toEqual([target.id])

      env.repo.upsertSection(target, section(), false)
      env.repo.recordPollSuccess(target.id, env.clock.now - 1, 60_000, false)
      expect(env.repo.claimTargets('w1', 10, env.clock.now)).toEqual([])
    })

    it('keeps a target claimable when its only poll ever was a transient error', () => {
      // The failure that used to delete a subject from the catalog for good. A
      // bootstrap fetch that 503s creates no sections, so no watch can ever
      // point at the target, and the error is not permanent so `active` stays
      // 1. Keyed on last_polled_at alone, that target was never claimed again,
      // nothing reported it as dead, and stats counted it as healthy.
      const target = env.repo.ensureTarget(SCHOOL_ID, TERM, 'PHIL', 60_000)
      env.repo.claimTargets('w1', 10, env.clock.now)
      env.repo.recordPollError(target.id, env.clock.now + 1000, 'upstream 503', false, 'w1')

      expect(env.repo.getTarget(target.id)!.active).toBe(1)
      // Still polite: the error backoff on next_poll_at is respected.
      expect(env.repo.claimTargets('w1', 10, env.clock.now)).toEqual([])

      env.clock.now += 1001
      expect(env.repo.claimTargets('w1', 10, env.clock.now).map((t) => t.id)).toEqual([target.id])
    })

    it('keeps retrying a target that has failed many times and never succeeded', () => {
      const target = env.repo.ensureTarget(SCHOOL_ID, TERM, 'PHIL', 60_000)
      for (let i = 0; i < 5; i++) {
        env.repo.recordPollError(target.id, env.clock.now - 1, 'upstream 503')
      }
      expect(env.repo.claimTargets('w1', 10, env.clock.now).map((t) => t.id)).toEqual([target.id])
    })

    it('goes quiet again once a poll has actually produced something', () => {
      // The retry window closes on the first success, not on the first attempt.
      // Otherwise a subject that genuinely has no classes is polled forever.
      const target = env.repo.ensureTarget(SCHOOL_ID, TERM, 'PHIL', 60_000)
      env.repo.recordPollError(target.id, env.clock.now - 1, 'upstream 503')
      env.repo.recordPollSuccess(target.id, env.clock.now - 1, 60_000, false)
      expect(env.repo.claimTargets('w1', 10, env.clock.now)).toEqual([])

      // And a later error does not reopen it, because it did answer once.
      env.repo.recordPollError(target.id, env.clock.now - 1, 'upstream 503')
      expect(env.repo.claimTargets('w1', 10, env.clock.now)).toEqual([])
    })

    it('still refuses a never-productive target a permanent error switched off', () => {
      const target = env.repo.ensureTarget(SCHOOL_ID, TERM, 'PHIL', 60_000)
      env.repo.recordPollError(target.id, env.clock.now - 1, 'no such subject', true)
      expect(env.repo.claimTargets('w1', 10, env.clock.now)).toEqual([])
    })

    it('renews only a lease the asking worker still holds', () => {
      const target = env.repo.ensureTarget(SCHOOL_ID, TERM, 'MATH', 60_000)
      env.repo.claimTargets('w1', 1, env.clock.now, 30_000)

      expect(env.repo.renewLease(target.id, 'w1', env.clock.now + 90_000)).toBe(true)
      expect(env.repo.getTarget(target.id)!.lease_expires_at).toBe(env.clock.now + 90_000)

      // A worker that lost the target cannot take it back by renewing, which
      // would put two of us at the same registrar for one subject.
      expect(env.repo.renewLease(target.id, 'w2', env.clock.now + 999_000)).toBe(false)
      expect(env.repo.getTarget(target.id)!.lease_expires_at).toBe(env.clock.now + 90_000)
    })

    it('will not let a lapsed worker unlatch the lease of the one that replaced it', () => {
      // Worker A's lease expires mid-fetch, B claims the target and starts its
      // own fetch, then A comes back and records. Clearing the lease
      // unconditionally handed the same target to a third worker while B was
      // still in flight.
      const target = env.repo.ensureTarget(SCHOOL_ID, TERM, 'MATH', 60_000)
      env.repo.claimTargets('worker-a', 1, env.clock.now, 30_000)
      env.clock.now += 30_001
      env.repo.claimTargets('worker-b', 1, env.clock.now, 30_000)

      env.repo.recordPollSuccess(target.id, env.clock.now + 60_000, 60_000, false, 'worker-a')
      const after = env.repo.getTarget(target.id)!
      expect(after.lease_owner).toBe('worker-b')
      expect(after.lease_expires_at).toBe(env.clock.now + 30_000)
    })

    it('frees its own lease on the way out, whether the poll worked or not', () => {
      const ok = env.repo.ensureTarget(SCHOOL_ID, TERM, 'MATH', 60_000)
      const bad = env.repo.ensureTarget(SCHOOL_ID, TERM, 'CS', 60_000)
      env.repo.claimTargets('w1', 2, env.clock.now, 30_000)

      env.repo.recordPollSuccess(ok.id, env.clock.now + 1000, 60_000, false, 'w1')
      env.repo.recordPollError(bad.id, env.clock.now + 1000, 'upstream 503', false, 'w1')

      expect(env.repo.getTarget(ok.id)!.lease_owner).toBeNull()
      expect(env.repo.getTarget(bad.id)!.lease_owner).toBeNull()
    })

    it('claims a polled target once somebody is watching it', () => {
      const target = env.repo.ensureTarget(SCHOOL_ID, TERM, 'MATH', 60_000)
      const sid = env.repo.upsertSection(target, section(), false)
      env.repo.recordPollSuccess(target.id, env.clock.now - 1, 60_000, false)
      env.repo.createWatch({ userId: 'roshan', sectionId: sid })

      const claimed = env.repo.claimTargets('w1', 10, env.clock.now, 30_000)
      expect(claimed.map((t) => t.id)).toEqual([target.id])
      expect(claimed[0]!.lease_owner).toBe('w1')
      expect(claimed[0]!.lease_expires_at).toBe(env.clock.now + 30_000)
    })

    it('will not claim a target before its next poll time, lease or no lease', () => {
      const target = env.repo.ensureTarget(SCHOOL_ID, TERM, 'MATH', 60_000)
      env.repo.recordPollSuccess(target.id, env.clock.now + 60_000, 60_000, false)
      expect(env.repo.claimTargets('w1', 10, env.clock.now)).toEqual([])
    })

    it('will not claim a target a permanent error switched off', () => {
      const target = env.repo.ensureTarget(SCHOOL_ID, TERM, 'MATH', 60_000)
      env.repo.recordPollError(target.id, env.clock.now - 1, 'no such subject', true)
      expect(env.repo.claimTargets('w1', 10, env.clock.now)).toEqual([])
    })

    it('releases only the leases the asking worker actually holds', () => {
      const mine = env.repo.ensureTarget(SCHOOL_ID, TERM, 'MATH', 60_000)
      const theirs = env.repo.ensureTarget(SCHOOL_ID, TERM, 'CS', 60_000)
      env.repo.claimTargets('w1', 1, env.clock.now)
      env.repo.claimTargets('w2', 1, env.clock.now)

      // Whichever way the two rows fell, releasing as w1 frees exactly one.
      expect(env.repo.releaseTargets([mine.id, theirs.id], 'w1')).toBe(1)
      const still = env.repo.listTargets().filter((t) => t.lease_owner !== null)
      expect(still).toHaveLength(1)
      expect(still[0]!.lease_owner).toBe('w2')
    })

    it('counts distinct watchers, which is the whole dedupe premise', () => {
      const target = env.repo.ensureTarget(SCHOOL_ID, TERM, 'MATH', 60_000)
      const a = env.repo.upsertSection(target, section({ crn: 'A' }), false)
      const b = env.repo.upsertSection(target, section({ crn: 'B' }), false)
      env.repo.createWatch({ userId: 'u1', sectionId: a })
      env.repo.createWatch({ userId: 'u2', sectionId: a })
      env.repo.createWatch({ userId: 'u3', sectionId: b })
      // Three students, two sections, still ONE polled target.
      expect(env.repo.countWatchersForTarget(target.id)).toBe(3)
      expect(env.repo.listTargets()).toHaveLength(1)
    })
  })

  describe('poll bookkeeping', () => {
    it('clears the error counter on success', () => {
      const target = env.repo.ensureTarget(SCHOOL_ID, TERM, 'MATH', 60_000)
      env.repo.recordPollError(target.id, env.clock.now + 1000, 'upstream 500')
      expect(env.repo.getTarget(target.id)!.consecutive_errors).toBe(1)

      env.repo.recordPollSuccess(target.id, env.clock.now + 1000, 60_000, false)
      const after = env.repo.getTarget(target.id)!
      expect(after.consecutive_errors).toBe(0)
      expect(after.last_error).toBeNull()
    })

    it('accumulates consecutive errors', () => {
      const target = env.repo.ensureTarget(SCHOOL_ID, TERM, 'MATH', 60_000)
      env.repo.recordPollError(target.id, 0, 'a')
      env.repo.recordPollError(target.id, 0, 'b')
      expect(env.repo.getTarget(target.id)!.consecutive_errors).toBe(2)
    })

    it('deactivates a target on a permanent error', () => {
      const target = env.repo.ensureTarget(SCHOOL_ID, TERM, 'MATH', 60_000)
      env.repo.recordPollError(target.id, 0, 'no adapter', true)
      expect(env.repo.getTarget(target.id)!.active).toBe(0)
    })

    it('tracks poll and change counts', () => {
      const target = env.repo.ensureTarget(SCHOOL_ID, TERM, 'MATH', 60_000)
      env.repo.recordPollSuccess(target.id, 0, 60_000, false)
      env.repo.recordPollSuccess(target.id, 0, 60_000, true)
      const t = env.repo.getTarget(target.id)!
      expect(t.poll_count).toBe(2)
      expect(t.change_count).toBe(1)
      expect(t.last_changed_at).toBe(env.clock.now)
    })
  })

  describe('notifications', () => {
    it('refuses to queue the same event twice for one watch', () => {
      const target = env.repo.ensureTarget(SCHOOL_ID, TERM, 'MATH', 60_000)
      const sid = env.repo.upsertSection(target, section(), false)
      const watch = env.repo.createWatch({ userId: 'roshan', sectionId: sid })
      const eventId = env.repo.recordEvent(sid, {
        kind: 'seat_opened', prevSeats: 0, newSeats: 1, prevWaitlist: 0, newWaitlist: 0,
        detail: '1 seat opened',
      })

      expect(env.repo.enqueueNotification(watch, eventId)).not.toBeNull()
      // Same watch, same event: the UNIQUE constraint is the idempotency guard.
      expect(env.repo.enqueueNotification(watch, eventId)).toBeNull()
      expect(env.repo.pendingNotifications()).toHaveLength(1)
    })

    it('raises rather than reporting a failed queue insert as already queued', () => {
      // Null has to mean exactly one thing. A blanket catch turned a full disk
      // or a foreign key failure into a silent "already queued", which the
      // poller reads as nothing to do: the seat opened, the event row exists,
      // and the student is never told, with no row and no log line anywhere.
      const target = env.repo.ensureTarget(SCHOOL_ID, TERM, 'MATH', 60_000)
      const sid = env.repo.upsertSection(target, section(), false)
      const watch = env.repo.createWatch({ userId: 'roshan', sectionId: sid })

      // An event id that was never written, which is the foreign key failing
      // rather than a duplicate.
      expect(() => env.repo.enqueueNotification(watch, 987_654)).toThrow(/FOREIGN KEY/i)
      expect(env.repo.pendingNotifications()).toHaveLength(0)
    })

    it('records an event and reads it straight back by its id', () => {
      // Delivery resolves the event by primary key rather than by scanning a
      // window of recent ones, so a busy section cannot age an alert out.
      const target = env.repo.ensureTarget(SCHOOL_ID, TERM, 'MATH', 60_000)
      const sid = env.repo.upsertSection(target, section(), false)
      const eventId = env.repo.recordEvent(sid, {
        kind: 'seat_opened', prevSeats: 0, newSeats: 1, prevWaitlist: 0, newWaitlist: 0, detail: 'x',
      })
      expect(env.repo.getEvent(eventId)!.kind).toBe('seat_opened')
      expect(env.repo.getEvent(987_654)).toBeNull()
    })

    it('holds back a notification until its retry time', () => {
      const target = env.repo.ensureTarget(SCHOOL_ID, TERM, 'MATH', 60_000)
      const sid = env.repo.upsertSection(target, section(), false)
      const watch = env.repo.createWatch({ userId: 'roshan', sectionId: sid })
      const eventId = env.repo.recordEvent(sid, {
        kind: 'seat_opened', prevSeats: 0, newSeats: 1, prevWaitlist: 0, newWaitlist: 0, detail: 'x',
      })
      const id = env.repo.enqueueNotification(watch, eventId)!

      env.repo.markNotificationFailed(id, 'timeout', env.clock.now + 30_000)
      expect(env.repo.pendingNotifications(10, env.clock.now)).toHaveLength(0)
      expect(env.repo.pendingNotifications(10, env.clock.now + 30_000)).toHaveLength(1)
    })

    it('marks a notification failed for good when retry time is null', () => {
      const target = env.repo.ensureTarget(SCHOOL_ID, TERM, 'MATH', 60_000)
      const sid = env.repo.upsertSection(target, section(), false)
      const watch = env.repo.createWatch({ userId: 'roshan', sectionId: sid })
      const eventId = env.repo.recordEvent(sid, {
        kind: 'seat_opened', prevSeats: 0, newSeats: 1, prevWaitlist: 0, newWaitlist: 0, detail: 'x',
      })
      const id = env.repo.enqueueNotification(watch, eventId)!
      env.repo.markNotificationFailed(id, 'gave up', null)
      expect(env.repo.getNotification(id)!.status).toBe('failed')
      expect(env.repo.pendingNotifications(10, env.clock.now + 1e9)).toHaveLength(0)
    })

    it('stamps the watch when a notification is delivered', () => {
      const target = env.repo.ensureTarget(SCHOOL_ID, TERM, 'MATH', 60_000)
      const sid = env.repo.upsertSection(target, section(), false)
      const watch = env.repo.createWatch({ userId: 'roshan', sectionId: sid })
      const eventId = env.repo.recordEvent(sid, {
        kind: 'seat_opened', prevSeats: 0, newSeats: 1, prevWaitlist: 0, newWaitlist: 0, detail: 'x',
      })
      const id = env.repo.enqueueNotification(watch, eventId)!
      env.repo.markNotificationDelivered(id)

      expect(env.repo.getNotification(id)!.status).toBe('delivered')
      expect(env.repo.getWatch(watch.id)!.last_notified_at).toBe(env.clock.now)
    })
  })

  describe('events', () => {
    it('lists events scoped to a user via their watches', () => {
      const target = env.repo.ensureTarget(SCHOOL_ID, TERM, 'MATH', 60_000)
      const watched = env.repo.upsertSection(target, section({ crn: 'A' }), false)
      const other = env.repo.upsertSection(target, section({ crn: 'B' }), false)
      env.repo.createWatch({ userId: 'roshan', sectionId: watched })

      const e = { prevSeats: 0, newSeats: 1, prevWaitlist: 0, newWaitlist: 0, detail: 'x' } as const
      env.repo.recordEvent(watched, { ...e, kind: 'seat_opened' })
      env.repo.recordEvent(other, { ...e, kind: 'seat_opened' })

      expect(env.repo.listEvents({ userId: 'roshan' })).toHaveLength(1)
      expect(env.repo.listEvents({})).toHaveLength(2)
    })
  })

  describe('recovery tokens', () => {
    const HOUR = 60 * 60_000

    /** An account to hang tokens off, since auth_tokens has a foreign key. */
    const account = (email = 'ada@classpik.test') =>
      env.repo.createUser({ email, emailNorm: email, passwordHash: 'scrypt$x' })!

    const issue = (
      userId: string,
      hash: string,
      purpose = 'reset_password',
      ttl = HOUR,
      emailNorm = 'ada@classpik.test'
    ) => env.repo.createAuthToken({ userId, purpose, tokenHash: hash, emailNorm, expiresAt: env.clock.now + ttl })

    it('stores the digest it was handed and nothing resembling a token', () => {
      const user = account()
      const row = issue(user.id, 'digest-of-the-token')
      expect(row.token_hash).toBe('digest-of-the-token')
      expect(row.consumed_at).toBeNull()
      expect(row.expires_at).toBe(env.clock.now + HOUR)
    })

    it('spends a token exactly once', () => {
      const user = account()
      issue(user.id, 'h1')
      expect(env.repo.consumeAuthToken('h1', 'reset_password', env.clock.now)).not.toBeNull()
      expect(env.repo.consumeAuthToken('h1', 'reset_password', env.clock.now)).toBeNull()
    })

    it('refuses a token that has expired', () => {
      const user = account()
      issue(user.id, 'h1')
      expect(env.repo.consumeAuthToken('h1', 'reset_password', env.clock.now + HOUR)).toBeNull()
      // And the row was not consumed by the refusal, so nothing was destroyed
      // by an attempt that failed.
      expect(env.repo.getAuthToken('h1')!.consumed_at).toBeNull()
    })

    it('refuses a token minted for the other errand', () => {
      // The purpose is part of the lookup, so a 24 hour verification link can
      // never be spent as a password reset.
      const user = account()
      issue(user.id, 'h1', 'verify_email', 24 * HOUR)
      expect(env.repo.consumeAuthToken('h1', 'reset_password', env.clock.now)).toBeNull()
      expect(env.repo.consumeAuthToken('h1', 'verify_email', env.clock.now)).not.toBeNull()
    })

    it('refuses a digest nobody issued', () => {
      expect(env.repo.consumeAuthToken('never-issued', 'reset_password', env.clock.now)).toBeNull()
    })

    it('burns every outstanding token of one purpose without touching the other', () => {
      const user = account()
      issue(user.id, 'r1')
      issue(user.id, 'r2')
      issue(user.id, 'v1', 'verify_email', 24 * HOUR)

      expect(env.repo.revokeAuthTokens(user.id, 'reset_password', env.clock.now)).toBe(2)
      expect(env.repo.consumeAuthToken('r1', 'reset_password', env.clock.now)).toBeNull()
      expect(env.repo.consumeAuthToken('v1', 'verify_email', env.clock.now)).not.toBeNull()
    })

    it('leaves another account\'s tokens alone', () => {
      const ada = account('ada@classpik.test')
      const bob = account('bob@classpik.test')
      issue(ada.id, 'a1')
      issue(bob.id, 'b1')

      env.repo.revokeAuthTokens(ada.id, 'reset_password', env.clock.now)
      expect(env.repo.consumeAuthToken('b1', 'reset_password', env.clock.now)).not.toBeNull()
    })

    it('counts recent tokens per account and purpose, which is what the throttle reads', () => {
      const user = account()
      issue(user.id, 'r1')
      env.clock.now += 2 * HOUR
      issue(user.id, 'r2')
      issue(user.id, 'v1', 'verify_email', 24 * HOUR)

      expect(env.repo.countAuthTokensSince(user.id, 'reset_password', env.clock.now - HOUR)).toBe(1)
      expect(env.repo.countAuthTokensSince(user.id, 'reset_password', 0)).toBe(2)
      expect(env.repo.countAuthTokensSince(user.id, 'verify_email', 0)).toBe(1)
    })

    it('purges expired rows without touching a live one', () => {
      const user = account()
      issue(user.id, 'dead')
      issue(user.id, 'live', 'verify_email', 24 * HOUR)
      expect(env.repo.purgeExpiredAuthTokens(env.clock.now + HOUR)).toBe(1)
      expect(env.repo.getAuthToken('dead')).toBeNull()
      expect(env.repo.getAuthToken('live')).not.toBeNull()
    })

    it('takes an account\'s tokens with it when the account goes', () => {
      const user = account()
      issue(user.id, 'h1')
      env.repo.raw.prepare('DELETE FROM users WHERE id = ?').run(user.id)
      expect(env.repo.getAuthToken('h1')).toBeNull()
    })

    it('does everything a completed reset has to do, in one call', () => {
      const user = account()
      issue(user.id, 'r1')
      issue(user.id, 'r2')
      env.repo.createSession({ userId: user.id, tokenHash: 's1', expiresAt: env.clock.now + 1e9 })
      env.repo.lockUser(user.id, env.clock.now + HOUR)
      env.repo.countLoginFailure(user.id)

      env.repo.completePasswordReset(user.id, 'scrypt$new', env.clock.now)

      const after = env.repo.getUser(user.id)!
      expect(after.password_hash).toBe('scrypt$new')
      expect(after.locked_until).toBeNull()
      expect(after.failed_logins).toBe(0)
      // Reading the link is the same proof a verification link asks for.
      expect(after.email_verified_at).toBe(env.clock.now)
      expect(env.repo.resolveSession('s1', env.clock.now)).toBeNull()
      expect(env.repo.consumeAuthToken('r1', 'reset_password', env.clock.now)).toBeNull()
      expect(env.repo.consumeAuthToken('r2', 'reset_password', env.clock.now)).toBeNull()
    })

    it('does not backdate a verification that already happened', () => {
      const user = account()
      env.repo.markEmailVerified(user.id, env.clock.now)
      const first = env.repo.getUser(user.id)!.email_verified_at
      env.clock.now += HOUR
      env.repo.completePasswordReset(user.id, 'scrypt$new', env.clock.now)
      expect(env.repo.getUser(user.id)!.email_verified_at).toBe(first)
    })

    it('spares one session on a password change and kills the rest', () => {
      const user = account()
      env.repo.createSession({ userId: user.id, tokenHash: 'keep', expiresAt: env.clock.now + 1e9 })
      env.repo.createSession({ userId: user.id, tokenHash: 'drop1', expiresAt: env.clock.now + 1e9 })
      env.repo.createSession({ userId: user.id, tokenHash: 'drop2', expiresAt: env.clock.now + 1e9 })
      issue(user.id, 'r1')

      expect(env.repo.completePasswordChange(user.id, 'scrypt$new', 'keep', env.clock.now)).toBe(2)
      expect(env.repo.resolveSession('keep', env.clock.now)).not.toBeNull()
      expect(env.repo.resolveSession('drop1', env.clock.now)).toBeNull()
      // An outstanding reset link is a live key to the account, so it goes too.
      expect(env.repo.consumeAuthToken('r1', 'reset_password', env.clock.now)).toBeNull()
    })

    it('revokes every session for an account when nothing is spared', () => {
      const user = account()
      env.repo.createSession({ userId: user.id, tokenHash: 's1', expiresAt: env.clock.now + 1e9 })
      env.repo.createSession({ userId: user.id, tokenHash: 's2', expiresAt: env.clock.now + 1e9 })
      expect(env.repo.revokeSessionsForUser(user.id, env.clock.now)).toBe(2)
    })
  })

  it('reports stats', () => {
    const target = env.repo.ensureTarget(SCHOOL_ID, TERM, 'MATH', 60_000)
    const sid = env.repo.upsertSection(target, section(), false)
    env.repo.createWatch({ userId: 'roshan', sectionId: sid })
    const stats = env.repo.stats()
    expect(stats).toMatchObject({ schools: 1, targets: 1, sections: 1, watches: 1 })
  })
})
