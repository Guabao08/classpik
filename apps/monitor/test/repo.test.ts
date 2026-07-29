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

    // Rewind the recorded version so the accounts migration runs again over
    // populated tables, as it would on an instance that predates it.
    db.exec('DROP TABLE users')
    db.exec('DROP TABLE sessions')
    db.prepare('UPDATE schema_version SET version = ?').run(1)

    const result = migrate(db)
    expect(result.from).toBe(1)
    expect(result.applied).toEqual(['accounts'])
    expect(db.prepare('SELECT COUNT(*) AS n FROM schools').get()).toEqual({ n: 1 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM users').get()).toEqual({ n: 0 })
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

  it('reports stats', () => {
    const target = env.repo.ensureTarget(SCHOOL_ID, TERM, 'MATH', 60_000)
    const sid = env.repo.upsertSection(target, section(), false)
    env.repo.createWatch({ userId: 'roshan', sectionId: sid })
    const stats = env.repo.stats()
    expect(stats).toMatchObject({ schools: 1, targets: 1, sections: 1, watches: 1 })
  })
})
