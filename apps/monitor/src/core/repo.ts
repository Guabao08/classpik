import { randomUUID } from 'node:crypto'
import type { RawSection, SchoolConfig } from '../adapters/types.js'
import type { DetectedEvent, SectionState } from './diff.js'
import { tx, type Db } from './db.js'

/**
 * Every SQL statement in the service lives here. Nothing above this layer knows
 * it is talking to SQLite, which is what makes the eventual move to Postgres a
 * contained change.
 */

export type SectionStatus = 'open' | 'waitlist' | 'full'

export interface SectionRow {
  id: string
  target_id: string
  school_id: string
  term: string
  crn: string
  subject: string
  course_number: string
  code: string
  title: string
  section: string
  credits: number | null
  instructor: string | null
  meeting_days: string | null
  meeting_time: string | null
  campus: string | null
  seats: number
  capacity: number
  enrollment: number
  waitlist: number
  waitlist_cap: number
  waitlist_available: number
  status: SectionStatus
  present: number
  first_seen_at: number
  last_polled_at: number
  last_changed_at: number | null
}

export interface TargetRow {
  id: string
  school_id: string
  term: string
  subject: string
  interval_ms: number
  next_poll_at: number
  last_polled_at: number | null
  last_changed_at: number | null
  first_polled_at: number | null
  poll_count: number
  change_count: number
  consecutive_errors: number
  last_error: string | null
  active: number
}

export interface WatchRow {
  id: string
  user_id: string
  section_id: string
  mode: 'notify' | 'claim'
  channel: string
  target: string | null
  active: number
  created_at: number
  last_notified_at: number | null
}

export interface EventRow {
  id: number
  section_id: string
  kind: string
  prev_seats: number | null
  new_seats: number
  prev_waitlist: number | null
  new_waitlist: number
  detail: string
  at: number
}

export interface NotificationRow {
  id: number
  watch_id: string
  event_id: number
  channel: string
  target: string | null
  status: 'pending' | 'delivered' | 'failed'
  attempts: number
  last_error: string | null
  next_retry_at: number | null
  created_at: number
  delivered_at: number | null
}

export function sectionId(schoolId: string, term: string, crn: string): string {
  return `${schoolId}:${term}:${crn}`
}

export function targetId(schoolId: string, term: string, subject: string): string {
  return `${schoolId}:${term}:${subject}`
}

export function statusOf(s: {
  seats: number
  waitlist: number
  waitlistCap: number
}): SectionStatus {
  if (s.seats > 0) return 'open'
  if (s.waitlistCap > 0 && s.waitlist < s.waitlistCap) return 'waitlist'
  return 'full'
}

export class Repo {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now
  ) {}

  get raw(): Db {
    return this.db
  }

  // ---------------------------------------------------------------- schools

  upsertSchool(cfg: SchoolConfig): void {
    this.db
      .prepare(
        `INSERT INTO schools (id, name, sis, base_url, enabled, config_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name, sis = excluded.sis, base_url = excluded.base_url,
           enabled = excluded.enabled, config_json = excluded.config_json`
      )
      .run(cfg.id, cfg.name, cfg.sis, cfg.baseUrl, cfg.enabled ? 1 : 0, JSON.stringify(cfg), this.now())
  }

  listSchools(): SchoolConfig[] {
    const rows = this.db.prepare('SELECT config_json FROM schools ORDER BY name').all() as Array<{
      config_json: string
    }>
    return rows.map((r) => JSON.parse(r.config_json) as SchoolConfig)
  }

  getSchool(id: string): SchoolConfig | null {
    const row = this.db.prepare('SELECT config_json FROM schools WHERE id = ?').get(id) as
      | { config_json: string }
      | undefined
    return row ? (JSON.parse(row.config_json) as SchoolConfig) : null
  }

  replaceTerms(schoolId: string, terms: Array<{ code: string; description: string }>): void {
    tx(this.db, () => {
      this.db.prepare('DELETE FROM terms WHERE school_id = ?').run(schoolId)
      const ins = this.db.prepare(
        'INSERT INTO terms (school_id, code, description) VALUES (?, ?, ?)'
      )
      for (const t of terms) ins.run(schoolId, t.code, t.description)
    })
  }

  listTerms(schoolId: string): Array<{ code: string; description: string }> {
    return this.db
      .prepare('SELECT code, description FROM terms WHERE school_id = ? ORDER BY code DESC')
      .all(schoolId) as Array<{ code: string; description: string }>
  }

  // ---------------------------------------------------------------- targets

  ensureTarget(schoolId: string, term: string, subject: string, intervalMs: number): TargetRow {
    const id = targetId(schoolId, term, subject)
    const now = this.now()
    this.db
      .prepare(
        `INSERT INTO poll_targets (id, school_id, term, subject, interval_ms, next_poll_at, active, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?)
         ON CONFLICT(id) DO UPDATE SET active = 1`
      )
      .run(id, schoolId, term, subject, intervalMs, now, now)
    return this.getTarget(id)!
  }

  getTarget(id: string): TargetRow | null {
    return (this.db.prepare('SELECT * FROM poll_targets WHERE id = ?').get(id) as unknown as TargetRow) ?? null
  }

  listTargets(): TargetRow[] {
    return this.db.prepare('SELECT * FROM poll_targets ORDER BY id').all() as unknown as TargetRow[]
  }

  /** Targets due for polling, soonest first, only those someone is watching. */
  dueTargets(limit = 25, at = this.now()): TargetRow[] {
    return this.db
      .prepare(
        `SELECT t.* FROM poll_targets t
         WHERE t.active = 1 AND t.next_poll_at <= ?
           AND EXISTS (
             SELECT 1 FROM sections s
             JOIN watches w ON w.section_id = s.id AND w.active = 1
             WHERE s.target_id = t.id
           )
         ORDER BY t.next_poll_at ASC
         LIMIT ?`
      )
      .all(at, limit) as unknown as TargetRow[]
  }

  /**
   * Targets that have never been polled. They have no sections yet, so no
   * watches can point at them, so `dueTargets` would never pick them up. This
   * is the bootstrap path that breaks that chicken-and-egg.
   */
  unseededTargets(limit = 25, at = this.now()): TargetRow[] {
    return this.db
      .prepare(
        `SELECT * FROM poll_targets
         WHERE active = 1 AND last_polled_at IS NULL AND next_poll_at <= ?
         ORDER BY next_poll_at ASC LIMIT ?`
      )
      .all(at, limit) as unknown as TargetRow[]
  }

  countWatchersForTarget(id: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(DISTINCT w.id) AS n FROM watches w
         JOIN sections s ON s.id = w.section_id
         WHERE s.target_id = ? AND w.active = 1`
      )
      .get(id) as { n: number }
    return row.n
  }

  recordPollSuccess(id: string, nextPollAt: number, intervalMs: number, changed: boolean): void {
    const now = this.now()
    this.db
      .prepare(
        `UPDATE poll_targets SET
           last_polled_at = ?,
           first_polled_at = COALESCE(first_polled_at, ?),
           next_poll_at = ?,
           interval_ms = ?,
           poll_count = poll_count + 1,
           change_count = change_count + ?,
           last_changed_at = CASE WHEN ? THEN ? ELSE last_changed_at END,
           consecutive_errors = 0,
           last_error = NULL
         WHERE id = ?`
      )
      .run(now, now, nextPollAt, intervalMs, changed ? 1 : 0, changed ? 1 : 0, now, id)
  }

  recordPollError(id: string, nextPollAt: number, message: string, permanent = false): void {
    const now = this.now()
    this.db
      .prepare(
        `UPDATE poll_targets SET
           last_polled_at = ?,
           first_polled_at = COALESCE(first_polled_at, ?),
           next_poll_at = ?,
           poll_count = poll_count + 1,
           consecutive_errors = consecutive_errors + 1,
           last_error = ?,
           active = ?
         WHERE id = ?`
      )
      .run(now, now, nextPollAt, message.slice(0, 500), permanent ? 0 : 1, id)
  }

  // --------------------------------------------------------------- sections

  getSectionStates(targetId: string): Map<string, SectionState> {
    const rows = this.db
      .prepare(
        `SELECT crn, seats, capacity, enrollment, waitlist, waitlist_cap, waitlist_available
         FROM sections WHERE target_id = ? AND present = 1`
      )
      .all(targetId) as Array<{
      crn: string
      seats: number
      capacity: number
      enrollment: number
      waitlist: number
      waitlist_cap: number
      waitlist_available: number
    }>

    return new Map(
      rows.map((r) => [
        r.crn,
        {
          seats: r.seats,
          capacity: r.capacity,
          enrollment: r.enrollment,
          waitlist: r.waitlist,
          waitlistCap: r.waitlist_cap,
          waitlistAvailable: r.waitlist_available,
        },
      ])
    )
  }

  upsertSection(
    target: { id: string; school_id: string; term: string },
    s: RawSection,
    changed: boolean
  ): string {
    const id = sectionId(target.school_id, target.term, s.crn)
    const now = this.now()
    this.db
      .prepare(
        `INSERT INTO sections (
           id, target_id, school_id, term, crn, subject, course_number, code, title, section,
           credits, instructor, meeting_days, meeting_time, campus,
           seats, capacity, enrollment, waitlist, waitlist_cap, waitlist_available,
           status, present, first_seen_at, last_polled_at, last_changed_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title, section = excluded.section, credits = excluded.credits,
           instructor = excluded.instructor, meeting_days = excluded.meeting_days,
           meeting_time = excluded.meeting_time, campus = excluded.campus,
           seats = excluded.seats, capacity = excluded.capacity, enrollment = excluded.enrollment,
           waitlist = excluded.waitlist, waitlist_cap = excluded.waitlist_cap,
           waitlist_available = excluded.waitlist_available,
           status = excluded.status, present = 1,
           last_polled_at = excluded.last_polled_at,
           last_changed_at = CASE WHEN ? THEN excluded.last_polled_at ELSE sections.last_changed_at END`
      )
      .run(
        id, target.id, target.school_id, target.term, s.crn, s.subject, s.courseNumber, s.code,
        s.title, s.section, s.credits, s.instructor, s.meetingDays, s.meetingTime, s.campus,
        s.seats, s.capacity, s.enrollment, s.waitlist, s.waitlistCap, s.waitlistAvailable,
        statusOf(s), now, now, changed ? now : null,
        changed ? 1 : 0
      )
    return id
  }

  markSectionsAbsent(targetId: string, crns: string[]): void {
    if (crns.length === 0) return
    const placeholders = crns.map(() => '?').join(',')
    this.db
      .prepare(`UPDATE sections SET present = 0 WHERE target_id = ? AND crn IN (${placeholders})`)
      .run(targetId, ...crns)
  }

  getSection(id: string): SectionRow | null {
    return (this.db.prepare('SELECT * FROM sections WHERE id = ?').get(id) as unknown as SectionRow) ?? null
  }

  searchSections(opts: {
    schoolId?: string
    term?: string
    subject?: string
    query?: string
    status?: SectionStatus
    limit?: number
  }): SectionRow[] {
    const where: string[] = ['present = 1']
    const args: unknown[] = []
    if (opts.schoolId) { where.push('school_id = ?'); args.push(opts.schoolId) }
    if (opts.term) { where.push('term = ?'); args.push(opts.term) }
    if (opts.subject) { where.push('subject = ?'); args.push(opts.subject.toUpperCase()) }
    if (opts.status) { where.push('status = ?'); args.push(opts.status) }
    if (opts.query) {
      // Match "MATH221" as readily as "MATH 221", since nobody types the space.
      const q = `%${opts.query.trim().toLowerCase()}%`
      const compact = `%${opts.query.trim().toLowerCase().replace(/\s+/g, '')}%`
      where.push(
        `(LOWER(code) LIKE ? OR REPLACE(LOWER(code), ' ', '') LIKE ? OR LOWER(title) LIKE ? OR crn LIKE ? OR LOWER(COALESCE(instructor, '')) LIKE ?)`
      )
      args.push(q, compact, q, q, q)
    }
    args.push(opts.limit ?? 100)
    return this.db
      .prepare(
        `SELECT * FROM sections WHERE ${where.join(' AND ')} ORDER BY code, section LIMIT ?`
      )
      .all(...(args as never[])) as unknown as SectionRow[]
  }

  // ---------------------------------------------------------------- watches

  createWatch(input: {
    userId: string
    sectionId: string
    mode?: 'notify' | 'claim'
    channel?: string
    target?: string | null
  }): WatchRow {
    const existing = this.db
      .prepare('SELECT * FROM watches WHERE user_id = ? AND section_id = ?')
      .get(input.userId, input.sectionId) as unknown as WatchRow | undefined

    if (existing) {
      this.db
        .prepare('UPDATE watches SET active = 1, mode = ?, channel = ?, target = ? WHERE id = ?')
        .run(
          input.mode ?? existing.mode,
          input.channel ?? existing.channel,
          input.target ?? existing.target,
          existing.id
        )
      return this.getWatch(existing.id)!
    }

    const id = randomUUID()
    this.db
      .prepare(
        `INSERT INTO watches (id, user_id, section_id, mode, channel, target, active, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?)`
      )
      .run(
        id,
        input.userId,
        input.sectionId,
        input.mode ?? 'notify',
        input.channel ?? 'console',
        input.target ?? null,
        this.now()
      )
    return this.getWatch(id)!
  }

  getWatch(id: string): WatchRow | null {
    return (this.db.prepare('SELECT * FROM watches WHERE id = ?').get(id) as unknown as WatchRow) ?? null
  }

  deactivateWatch(id: string): boolean {
    const before = this.getWatch(id)
    if (!before) return false
    this.db.prepare('UPDATE watches SET active = 0 WHERE id = ?').run(id)
    return true
  }

  listWatches(userId: string): Array<WatchRow & { section: SectionRow }> {
    const rows = this.db
      .prepare(
        `SELECT w.*, s.id AS s_id FROM watches w
         JOIN sections s ON s.id = w.section_id
         WHERE w.user_id = ? AND w.active = 1
         ORDER BY w.created_at DESC`
      )
      .all(userId) as unknown as Array<WatchRow & { s_id: string }>
    return rows.map((r) => ({ ...r, section: this.getSection(r.s_id)! }))
  }

  activeWatchesForSection(sectionId: string): WatchRow[] {
    return this.db
      .prepare('SELECT * FROM watches WHERE section_id = ? AND active = 1')
      .all(sectionId) as unknown as WatchRow[]
  }

  // ----------------------------------------------------------------- events

  recordEvent(sectionId: string, e: DetectedEvent): number {
    const info = this.db
      .prepare(
        `INSERT INTO events (section_id, kind, prev_seats, new_seats, prev_waitlist, new_waitlist, detail, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(sectionId, e.kind, e.prevSeats, e.newSeats, e.prevWaitlist, e.newWaitlist, e.detail, this.now())
    return Number(info.lastInsertRowid)
  }

  listEvents(opts: { sectionId?: string; userId?: string; limit?: number } = {}): EventRow[] {
    if (opts.userId) {
      return this.db
        .prepare(
          `SELECT e.* FROM events e
           JOIN watches w ON w.section_id = e.section_id AND w.active = 1
           WHERE w.user_id = ?
           ORDER BY e.at DESC LIMIT ?`
        )
        .all(opts.userId, opts.limit ?? 50) as unknown as EventRow[]
    }
    if (opts.sectionId) {
      return this.db
        .prepare('SELECT * FROM events WHERE section_id = ? ORDER BY at DESC LIMIT ?')
        .all(opts.sectionId, opts.limit ?? 50) as unknown as EventRow[]
    }
    return this.db
      .prepare('SELECT * FROM events ORDER BY at DESC LIMIT ?')
      .all(opts.limit ?? 50) as unknown as EventRow[]
  }

  /**
   * Events joined to the section they belong to. The alerts UI needs the course
   * code next to each event, and doing that join here beats making the client
   * fetch every section separately.
   */
  listEventsDetailed(
    opts: { userId?: string; sectionId?: string; limit?: number } = {}
  ): Array<EventRow & { code: string; section_label: string; crn: string; title: string }> {
    const limit = opts.limit ?? 50
    const select = `SELECT e.*, s.code, s.section AS section_label, s.crn, s.title FROM events e
                    JOIN sections s ON s.id = e.section_id`

    if (opts.userId) {
      return this.db
        .prepare(
          `${select}
           JOIN watches w ON w.section_id = e.section_id AND w.active = 1
           WHERE w.user_id = ? ORDER BY e.at DESC LIMIT ?`
        )
        .all(opts.userId, limit) as unknown as Array<
        EventRow & { code: string; section_label: string; crn: string; title: string }
      >
    }
    if (opts.sectionId) {
      return this.db
        .prepare(`${select} WHERE e.section_id = ? ORDER BY e.at DESC LIMIT ?`)
        .all(opts.sectionId, limit) as unknown as Array<
        EventRow & { code: string; section_label: string; crn: string; title: string }
      >
    }
    return this.db.prepare(`${select} ORDER BY e.at DESC LIMIT ?`).all(limit) as unknown as Array<
      EventRow & { code: string; section_label: string; crn: string; title: string }
    >
  }

  // ---------------------------------------------------------- notifications

  /**
   * Queue is UNIQUE on (watch_id, event_id), so a retry of the same poll can
   * never double-notify. Idempotency is enforced by the schema, not by hoping
   * the caller gets it right.
   */
  enqueueNotification(watch: WatchRow, eventId: number): number | null {
    try {
      const info = this.db
        .prepare(
          `INSERT INTO notifications (watch_id, event_id, channel, target, status, created_at, next_retry_at)
           VALUES (?, ?, ?, ?, 'pending', ?, ?)`
        )
        .run(watch.id, eventId, watch.channel, watch.target, this.now(), this.now())
      return Number(info.lastInsertRowid)
    } catch {
      return null
    }
  }

  pendingNotifications(limit = 50, at = this.now()): NotificationRow[] {
    return this.db
      .prepare(
        `SELECT * FROM notifications
         WHERE status = 'pending' AND (next_retry_at IS NULL OR next_retry_at <= ?)
         ORDER BY created_at ASC LIMIT ?`
      )
      .all(at, limit) as unknown as NotificationRow[]
  }

  markNotificationDelivered(id: number): void {
    const now = this.now()
    this.db
      .prepare(
        `UPDATE notifications SET status = 'delivered', delivered_at = ?, attempts = attempts + 1 WHERE id = ?`
      )
      .run(now, id)
    this.db
      .prepare(
        `UPDATE watches SET last_notified_at = ?
         WHERE id = (SELECT watch_id FROM notifications WHERE id = ?)`
      )
      .run(now, id)
  }

  markNotificationFailed(id: number, error: string, nextRetryAt: number | null): void {
    this.db
      .prepare(
        `UPDATE notifications SET
           status = CASE WHEN ? IS NULL THEN 'failed' ELSE 'pending' END,
           attempts = attempts + 1,
           last_error = ?,
           next_retry_at = ?
         WHERE id = ?`
      )
      .run(nextRetryAt, error.slice(0, 500), nextRetryAt, id)
  }

  getNotification(id: number): NotificationRow | null {
    return (
      (this.db.prepare('SELECT * FROM notifications WHERE id = ?').get(id) as unknown as NotificationRow) ??
      null
    )
  }

  // ------------------------------------------------------------------ stats

  stats(): {
    schools: number
    targets: number
    activeTargets: number
    sections: number
    watches: number
    events: number
    pollCount: number
    pendingNotifications: number
  } {
    const one = (sql: string): number => (this.db.prepare(sql).get() as { n: number }).n
    return {
      schools: one('SELECT COUNT(*) AS n FROM schools'),
      targets: one('SELECT COUNT(*) AS n FROM poll_targets'),
      activeTargets: one('SELECT COUNT(*) AS n FROM poll_targets WHERE active = 1'),
      sections: one('SELECT COUNT(*) AS n FROM sections WHERE present = 1'),
      watches: one('SELECT COUNT(*) AS n FROM watches WHERE active = 1'),
      events: one('SELECT COUNT(*) AS n FROM events'),
      pollCount: one('SELECT COALESCE(SUM(poll_count), 0) AS n FROM poll_targets'),
      pendingNotifications: one("SELECT COUNT(*) AS n FROM notifications WHERE status = 'pending'"),
    }
  }
}
