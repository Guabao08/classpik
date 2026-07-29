import { randomUUID } from 'node:crypto'
import type { RawSection, SchoolConfig } from '../adapters/types.js'
import type { DetectedEvent, SectionState } from './diff.js'
import { normalizeLevel } from './levels.js'
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
  /** The registrar's own level code, kept for display. Null when none is published. */
  level: string | null
  /** The same code folded for comparison. The only one search matches on. */
  level_norm: string | null
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
  /** Which worker currently holds this target, or null if it is free. */
  lease_owner: string | null
  /** When that claim lapses, so a worker that died does not strand the target. */
  lease_expires_at: number | null
}

export interface SubjectRow {
  school_id: string
  term: string
  code: string
  description: string
  discovered_at: number
  /** Null until a browse granted this subject its one bootstrap fetch. */
  seeded_at: number | null
  /**
   * 1 when a poll target already exists for this subject, however it got there.
   *
   * Not the same question as `seeded_at`, which records only that a browse
   * bought the fetch. A school onboarded from its config list has targets and no
   * `seeded_at` at all, so reading that column alone told a client every subject
   * at such a school was unfetched, which is the opposite of true.
   */
  has_target: number
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

export interface UserRow {
  id: string
  email: string
  email_norm: string
  password_hash: string
  created_at: number
  last_login_at: number | null
  failed_logins: number
  locked_until: number | null
  /** Where this account is shopping. Null until they choose, and changeable after. */
  school_id: string | null
  term: string | null
  /** JSON array of level codes. Read it through `preferencesOf`, never raw. */
  levels: string
}

/**
 * The scope a signed-in student's catalog search defaults to.
 *
 * Search only. The watchlist, the events feed and delivery all ignore this on
 * purpose: a transfer student keeps every watch from their old school, and a
 * senior keeps the graduate seminar they are watching after unticking GRAD.
 */
export interface UserPreferences {
  schoolId: string | null
  term: string | null
  levels: string[]
}

/**
 * Decodes the stored preferences off a user row.
 *
 * Bad JSON becomes no levels rather than throwing. A malformed column is our
 * bug, and the cost of it should be a search that is too wide for one account,
 * not a 500 on every route that touches that account.
 */
export function preferencesOf(u: UserRow): UserPreferences {
  let levels: string[] = []
  try {
    const parsed: unknown = JSON.parse(u.levels)
    if (Array.isArray(parsed)) levels = parsed.filter((l): l is string => typeof l === 'string')
  } catch {
    /* fall through to no levels, which scopes nothing */
  }
  return { schoolId: u.school_id, term: u.term, levels }
}

export interface SessionRow {
  token_hash: string
  user_id: string
  created_at: number
  expires_at: number
  revoked_at: number | null
  user_agent: string | null
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

/**
 * SQLITE_CONSTRAINT_UNIQUE. Checked by code rather than by matching the message
 * text, so that a foreign-key failure or a full disk is never mistaken for a
 * duplicate and swallowed.
 */
const SQLITE_CONSTRAINT_UNIQUE = 2067

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { errcode?: number }).errcode === SQLITE_CONSTRAINT_UNIQUE
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

  // --------------------------------------------------------------- subjects

  /**
   * Record the subjects a school offers in a term.
   *
   * Writing a row here creates no polling work at all, which is the point. A
   * large university publishes a couple of hundred subject codes and almost
   * nobody watches most of them, so treating discovery as an instruction to
   * poll would multiply our request rate at that registrar by a hundred to
   * serve a handful of students. A subject earns a poll target later, from
   * demand, and never from the size of the catalogue.
   *
   * `seeded_at` is deliberately left alone on conflict: rediscovering a subject
   * we have already fetched must not make it look unfetched and buy a second
   * request.
   */
  recordSubjects(
    schoolId: string,
    term: string,
    subjects: Array<{ code: string; description: string }>
  ): { recorded: number; added: number } {
    const before = this.countSubjects(schoolId, term)
    const now = this.now()
    tx(this.db, () => {
      const stmt = this.db.prepare(
        `INSERT INTO subjects (school_id, term, code, description, discovered_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(school_id, term, code) DO UPDATE SET description = excluded.description`
      )
      for (const s of subjects) {
        const code = s.code.trim().toUpperCase()
        if (code === '') continue
        stmt.run(schoolId, term, code, s.description.trim() || code, now)
      }
    })
    return { recorded: subjects.length, added: this.countSubjects(schoolId, term) - before }
  }

  /**
   * Every subject row carries whether a poll target exists for it, computed in
   * the same statement rather than left to the caller to look up per row.
   */
  private static readonly SUBJECT_SELECT = `
    SELECT s.*,
           EXISTS (
             SELECT 1 FROM poll_targets t
             WHERE t.school_id = s.school_id AND t.term = s.term AND t.subject = s.code
           ) AS has_target
    FROM subjects s`

  listSubjects(schoolId: string, term?: string): SubjectRow[] {
    if (term === undefined) {
      return this.db
        .prepare(`${Repo.SUBJECT_SELECT} WHERE s.school_id = ? ORDER BY s.term DESC, s.code`)
        .all(schoolId) as unknown as SubjectRow[]
    }
    return this.db
      .prepare(`${Repo.SUBJECT_SELECT} WHERE s.school_id = ? AND s.term = ? ORDER BY s.code`)
      .all(schoolId, term) as unknown as SubjectRow[]
  }

  getSubject(schoolId: string, term: string, code: string): SubjectRow | null {
    return (
      (this.db
        .prepare(`${Repo.SUBJECT_SELECT} WHERE s.school_id = ? AND s.term = ? AND s.code = ?`)
        .get(schoolId, term, code.toUpperCase()) as unknown as SubjectRow) ?? null
    )
  }

  countSubjects(schoolId: string, term?: string): number {
    const row =
      term === undefined
        ? (this.db.prepare('SELECT COUNT(*) AS n FROM subjects WHERE school_id = ?').get(schoolId) as {
            n: number
          })
        : (this.db
            .prepare('SELECT COUNT(*) AS n FROM subjects WHERE school_id = ? AND term = ?')
            .get(schoolId, term) as { n: number })
    return row.n
  }

  /**
   * Claim the single bootstrap fetch a subject is allowed, returning false if
   * it was already claimed.
   *
   * The WHERE clause carries `seeded_at IS NULL`, so the row itself is the
   * arbiter. Two students opening the same subject at the same moment, or one
   * student refreshing, must buy exactly one request between them, and a check
   * followed by an update in the caller would let both through.
   */
  markSubjectSeeded(schoolId: string, term: string, code: string, at = this.now()): boolean {
    const info = this.db
      .prepare(
        `UPDATE subjects SET seeded_at = ?
         WHERE school_id = ? AND term = ? AND code = ? AND seeded_at IS NULL`
      )
      .run(at, schoolId, term, code.toUpperCase())
    return Number(info.changes) > 0
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

  /**
   * Targets due for polling, soonest first, only those someone is watching.
   *
   * Read-only, and the poll loop no longer uses it: taking work needs the
   * exclusivity of `claimTargets`, since a plain SELECT hands two workers the
   * same rows. Kept because this and `unseededTargets` are the two halves of
   * the claim predicate stated one rule at a time, which is worth being able to
   * read and to check independently.
   */
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
   *
   * Read-only, like `dueTargets`. `claimTargets` is what the loop takes work
   * with, and it is slightly wider than this: a target whose only polls were
   * errors still has no sections, so it stays claimable there too. See
   * NEVER_PRODUCED.
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

  /**
   * "This target has been polled and has never once produced anything."
   *
   * `consecutive_errors` is zeroed by every success and incremented by every
   * error, while `poll_count` counts both, so the two are equal exactly when
   * every poll this target has ever had was an error. One success anywhere in
   * its history moves them apart forever.
   *
   * That distinction is load-bearing, and it used to be missing. A target's
   * first-ever fetch is the one that creates its sections, a watch can only
   * name a section, and the claim predicate lets a polled target through only
   * for a live watch. So a single 503 on a bootstrap fetch used to remove that
   * subject from the catalog permanently: the fetch stamped `last_polled_at`,
   * no sections existed for a watch to point at, `active` stayed 1 because a
   * transient error is not a permanent one, and nothing anywhere reported it as
   * dead. Re-browsing the subject did not help either, since `seed` sees the
   * target row and answers 'already'.
   *
   * Retrying stays polite because `next_poll_at` already carries the error
   * backoff, and `active = 0` is still the permanent off switch for a genuine
   * 4xx. A target that succeeded and returned nothing is NOT covered here: it
   * answered, so curiosity has been paid for, and it goes quiet.
   */
  private static readonly NEVER_PRODUCED = 't.poll_count <= t.consecutive_errors'

  /**
   * Take exclusive ownership of up to `limit` targets that are ready to poll.
   *
   * This is the whole of multi-worker safety, and it rests on one property:
   * `UPDATE ... RETURNING` is a single statement, so SQLite runs it inside its
   * own implicit transaction with the write lock held. Two workers issuing this
   * at the same moment are serialised, and the second one's subquery re-reads
   * rows the first has already stamped, so it sees them as leased and skips
   * them. The two get disjoint sets. A SELECT followed by an UPDATE would not
   * do this: both would read the same rows before either wrote, and both would
   * fetch the same subject, which is precisely the doubled request rate at a
   * registrar that this exists to prevent.
   *
   * The lease expires rather than being held until released. A worker that is
   * killed between claiming and recording would otherwise hold its targets
   * forever, and the students watching those sections would simply stop being
   * told anything, silently, which is this service failing at the one thing it
   * does. Anything past `lease_expires_at` is fair game again.
   *
   * The predicate is the union of the two older queries plus the retry rule:
   * a target nobody has ever polled is claimable on its own (no sections exist
   * yet, so no watch can point at it), a target whose every poll so far was an
   * error is still claimable for the same reason, and a target that has
   * actually produced sections is claimable only while somebody is watching
   * something in it.
   */
  claimTargets(workerId: string, limit: number, at = this.now(), leaseMs = 120_000): TargetRow[] {
    if (limit <= 0) return []
    return this.db
      .prepare(
        `UPDATE poll_targets SET lease_owner = ?, lease_expires_at = ?
         WHERE id IN (
           SELECT t.id FROM poll_targets t
           WHERE t.active = 1
             AND t.next_poll_at <= ?
             AND (t.lease_owner IS NULL OR t.lease_expires_at IS NULL OR t.lease_expires_at <= ?)
             AND (
               t.last_polled_at IS NULL
               OR ${Repo.NEVER_PRODUCED}
               OR EXISTS (
                 SELECT 1 FROM sections s
                 JOIN watches w ON w.section_id = s.id AND w.active = 1
                 WHERE s.target_id = t.id
               )
             )
           ORDER BY (t.last_polled_at IS NOT NULL), t.next_poll_at ASC
           LIMIT ?
         )
         RETURNING *`
      )
      .all(workerId, at + leaseMs, at, at, limit) as unknown as TargetRow[]
  }

  /**
   * Push this worker's own lease further out, without taking one it does not
   * hold.
   *
   * A lease has to outlast the fetch it covers, and a fetch has no fixed
   * length: one `fetchSections` is several HTTP requests, each of which may
   * retry, and a registrar answering 429 with `Retry-After: 60` stretches every
   * one of them. A fixed expiry long enough for that worst case would also be
   * the delay a genuinely dead worker costs every student watching that
   * subject, so the expiry stays short and the live worker keeps saying it is
   * still here.
   *
   * `lease_owner = ?` is the whole point. A worker whose lease already lapsed
   * and was taken by somebody else must not be able to renew it back, or two
   * workers end up fetching the same subject, which is the doubled request rate
   * at a registrar this design exists to prevent.
   */
  renewLease(id: string, workerId: string, expiresAt: number): boolean {
    const info = this.db
      .prepare('UPDATE poll_targets SET lease_expires_at = ? WHERE id = ? AND lease_owner = ?')
      .run(expiresAt, id, workerId)
    return Number(info.changes) > 0
  }

  /**
   * Hand back targets claimed but not polled, so an aborted tick does not make
   * the rest of the fleet wait out a lease for work it could do now.
   *
   * Scoped to the owner: a lease that already lapsed and was taken by another
   * worker belongs to that worker, and releasing it from here would hand the
   * same target to a third.
   */
  releaseTargets(ids: string[], workerId: string): number {
    if (ids.length === 0) return 0
    const placeholders = ids.map(() => '?').join(',')
    const info = this.db
      .prepare(
        `UPDATE poll_targets SET lease_owner = NULL, lease_expires_at = NULL
         WHERE lease_owner = ? AND id IN (${placeholders})`
      )
      .run(workerId, ...ids)
    return Number(info.changes)
  }

  /** How much polling work a school actually has, which is not the same as being configured. */
  countTargetsForSchool(schoolId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM poll_targets WHERE school_id = ?')
      .get(schoolId) as { n: number }
    return row.n
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

  /**
   * SQL for "drop the lease, but only if it is still ours".
   *
   * A worker whose lease lapsed mid-fetch comes back and records its result
   * against a row another worker has since claimed and is fetching right now.
   * Clearing the lease unconditionally, which is what both record paths used to
   * do, unlatches that live owner and lets a third worker take the same target:
   * three requests at one registrar for one subject, from a fleet whose entire
   * claim is that this cannot happen. `releaseTargets` always got this right.
   *
   * A null `workerId` means "clear it whoever holds it", which is what a
   * migration script or a test that is not a worker wants.
   */
  private static readonly RELEASE_IF_OURS = `
           lease_owner = CASE WHEN ? IS NULL OR lease_owner IS NULL OR lease_owner = ?
                              THEN NULL ELSE lease_owner END,
           lease_expires_at = CASE WHEN ? IS NULL OR lease_owner IS NULL OR lease_owner = ?
                                   THEN NULL ELSE lease_expires_at END`

  recordPollSuccess(
    id: string,
    nextPollAt: number,
    intervalMs: number,
    changed: boolean,
    workerId: string | null = null
  ): void {
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
           last_error = NULL,
           ${Repo.RELEASE_IF_OURS}
         WHERE id = ?`
      )
      .run(
        now, now, nextPollAt, intervalMs, changed ? 1 : 0, changed ? 1 : 0, now,
        workerId, workerId, workerId, workerId,
        id
      )
  }

  recordPollError(
    id: string,
    nextPollAt: number,
    message: string,
    permanent = false,
    workerId: string | null = null
  ): void {
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
           active = ?,
           ${Repo.RELEASE_IF_OURS}
         WHERE id = ?`
      )
      .run(
        now, now, nextPollAt, message.slice(0, 500), permanent ? 0 : 1,
        workerId, workerId, workerId, workerId,
        id
      )
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
    // Empty and absent are the same fact here: the registrar told us nothing
    // about this section's level, and an empty string would otherwise become a
    // level that no student can ever tick.
    const level = s.level !== null && s.level.trim() !== '' ? s.level.trim() : null
    this.db
      .prepare(
        `INSERT INTO sections (
           id, target_id, school_id, term, crn, subject, course_number, code, title, section,
           credits, instructor, meeting_days, meeting_time, campus, level, level_norm,
           seats, capacity, enrollment, waitlist, waitlist_cap, waitlist_available,
           status, present, first_seen_at, last_polled_at, last_changed_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title, section = excluded.section, credits = excluded.credits,
           instructor = excluded.instructor, meeting_days = excluded.meeting_days,
           meeting_time = excluded.meeting_time, campus = excluded.campus,
           -- Refreshed rather than kept: a registrar reclassifying a section, or
           -- an install that only starts reporting levels later, has to be able
           -- to move it. Nothing about a level is a first-sighting fact.
           level = excluded.level, level_norm = excluded.level_norm,
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
        level, level === null ? null : normalizeLevel(level),
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

  /**
   * Catalog search. This, and only this, is scoped.
   *
   * `levels` is a list because a student can be at more than one at once, and
   * an empty or absent list means no level filter at all rather than "no
   * levels", which would return an empty catalog to every account that has not
   * chosen yet.
   */
  searchSections(opts: {
    schoolId?: string
    term?: string
    subject?: string
    /** Registrar level codes, matched case-insensitively. Any of them may match. */
    levels?: string[]
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
    if (opts.levels && opts.levels.length > 0) {
      const norms = [...new Set(opts.levels.map(normalizeLevel).filter((l) => l !== ''))]
      if (norms.length > 0) {
        // A section the registrar gave no level to matches every filter.
        // Excluding it would be the same bug as trusting an enum: an install
        // whose sections carry no level, or a field our mapping missed, would
        // hand every scoped student an empty catalog and look like a school
        // with no classes in it. An unclassified section is not evidence of a
        // mismatch, so it is shown.
        where.push(`(level_norm IS NULL OR level_norm IN (${norms.map(() => '?').join(',')}))`)
        args.push(...norms)
      }
    }
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

  /**
   * The levels this school actually publishes in a term, from the sections we
   * hold rather than from a list we invented.
   *
   * This is what makes ticking a second level possible in a client: the codes
   * differ per institution, so the only honest source for "which boxes exist"
   * is the catalog itself. Grouped on the normalised form so one level cannot
   * appear twice over a difference in case, and MIN picks one spelling
   * deterministically rather than letting SQLite choose a bare column.
   */
  listLevels(schoolId: string, term?: string): Array<{ level: string; sections: number }> {
    const where = ['present = 1', 'level_norm IS NOT NULL', 'school_id = ?']
    const args: unknown[] = [schoolId]
    if (term) { where.push('term = ?'); args.push(term) }
    return this.db
      .prepare(
        `SELECT MIN(level) AS level, COUNT(*) AS sections FROM sections
         WHERE ${where.join(' AND ')}
         GROUP BY level_norm ORDER BY level`
      )
      .all(...(args as never[])) as unknown as Array<{ level: string; sections: number }>
  }

  // --------------------------------------------------------------- accounts

  /**
   * Null when the address is taken. The UNIQUE index is the arbiter rather than
   * a prior SELECT, because two signups for the same address can interleave
   * between a check and an insert. Any other SQLite failure still throws: a
   * blanket catch here would turn a full disk into a silent "email taken".
   */
  createUser(input: {
    email: string
    emailNorm: string
    passwordHash: string
    /** Chosen at signup when the client asks, and changeable afterwards. */
    schoolId?: string | null
    term?: string | null
    levels?: string[]
  }): UserRow | null {
    const id = randomUUID()
    try {
      this.db
        .prepare(
          `INSERT INTO users (id, email, email_norm, password_hash, created_at, school_id, term, levels)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          input.email,
          input.emailNorm,
          input.passwordHash,
          this.now(),
          input.schoolId ?? null,
          input.term ?? null,
          JSON.stringify(input.levels ?? [])
        )
    } catch (err) {
      if (isUniqueViolation(err)) return null
      throw err
    }
    return this.getUser(id)
  }

  /**
   * Change where an account is shopping.
   *
   * A key that is absent is left alone and a key that is null is cleared, which
   * are different requests: "I moved term" must not silently drop the levels
   * the student ticked, and "show me every school" has to be sayable at all.
   *
   * Null when there is no such account, which a caller holding a live session
   * will not see, but a deleted account mid-request would.
   */
  setUserPreferences(
    userId: string,
    patch: { schoolId?: string | null; term?: string | null; levels?: string[] }
  ): UserRow | null {
    const sets: string[] = []
    const args: unknown[] = []
    if ('schoolId' in patch) { sets.push('school_id = ?'); args.push(patch.schoolId ?? null) }
    if ('term' in patch) { sets.push('term = ?'); args.push(patch.term ?? null) }
    if ('levels' in patch) { sets.push('levels = ?'); args.push(JSON.stringify(patch.levels ?? [])) }
    if (sets.length === 0) return this.getUser(userId)

    this.db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...([...args, userId] as never[]))
    return this.getUser(userId)
  }

  getUser(id: string): UserRow | null {
    return (this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as unknown as UserRow) ?? null
  }

  /** Looks up by the normalised address, which is what the UNIQUE index covers. */
  findUserByEmail(emailNorm: string): UserRow | null {
    return (
      (this.db.prepare('SELECT * FROM users WHERE email_norm = ?').get(emailNorm) as unknown as UserRow) ??
      null
    )
  }

  recordLoginSuccess(userId: string, at = this.now()): void {
    this.db
      .prepare('UPDATE users SET last_login_at = ?, failed_logins = 0, locked_until = NULL WHERE id = ?')
      .run(at, userId)
  }

  /**
   * Increments and returns the consecutive-failure count. Read back rather than
   * computed by the caller so two concurrent bad logins cannot both write the
   * same count and lose one.
   */
  countLoginFailure(userId: string): number {
    this.db.prepare('UPDATE users SET failed_logins = failed_logins + 1 WHERE id = ?').run(userId)
    return this.getUser(userId)?.failed_logins ?? 0
  }

  /**
   * Forgets the consecutive-failure count without recording a login.
   *
   * Called when a login arrives after a lockout window has elapsed. Without it
   * the counter only ever falls on a successful login, so an attacker who can
   * name a victim ratchets the lockout to its one hour cap and then holds the
   * account there forever with a handful of requests an hour, while the victim
   * cannot clear it because clearing it needs the login the lock is refusing.
   */
  resetLoginFailures(userId: string): void {
    this.db
      .prepare('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?')
      .run(userId)
  }

  lockUser(userId: string, until: number): void {
    this.db.prepare('UPDATE users SET locked_until = ? WHERE id = ?').run(until, userId)
  }

  // --------------------------------------------------------------- sessions

  createSession(input: {
    userId: string
    tokenHash: string
    expiresAt: number
    userAgent?: string | null
  }): SessionRow {
    this.db
      .prepare(
        `INSERT INTO sessions (token_hash, user_id, created_at, expires_at, user_agent)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        input.tokenHash,
        input.userId,
        this.now(),
        input.expiresAt,
        input.userAgent?.slice(0, 200) ?? null
      )
    return this.getSession(input.tokenHash)!
  }

  getSession(tokenHash: string): SessionRow | null {
    return (
      (this.db
        .prepare('SELECT * FROM sessions WHERE token_hash = ?')
        .get(tokenHash) as unknown as SessionRow) ?? null
    )
  }

  /**
   * The principal behind a token, or null if there is no live session for it.
   * Expiry and revocation are both checked in SQL so no caller can forget one.
   */
  resolveSession(tokenHash: string, at = this.now()): { user: UserRow; session: SessionRow } | null {
    const session = (this.db
      .prepare(
        `SELECT * FROM sessions
         WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?`
      )
      .get(tokenHash, at) as unknown as SessionRow) ?? null
    if (!session) return null
    const user = this.getUser(session.user_id)
    if (!user) return null
    return { user, session }
  }

  /** False when the token was already revoked or never existed. */
  revokeSession(tokenHash: string, at = this.now()): boolean {
    const info = this.db
      .prepare('UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL')
      .run(at, tokenHash)
    return Number(info.changes) > 0
  }

  revokeSessionsForUser(userId: string, at = this.now()): number {
    const info = this.db
      .prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
      .run(at, userId)
    return Number(info.changes)
  }

  /** Housekeeping. A dead session is unusable either way, this just stops the table growing. */
  purgeExpiredSessions(before = this.now()): number {
    const info = this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(before)
    return Number(info.changes)
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

  /**
   * Every active watch this account holds, at any school, in any term, at any
   * level. The absence of a scope here is the feature, not an oversight.
   *
   * A student who transfers, or who changes term when registration opens, is
   * still waiting on the sections they already asked about, and a watchlist
   * that quietly dropped them would look exactly like the alerts working. Only
   * catalog search is scoped, because only search is a question about what
   * exists rather than about what this person already chose.
   */
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

  /** One event by primary key, for a delivery that must not depend on recency. */
  getEvent(id: number): EventRow | null {
    return (this.db.prepare('SELECT * FROM events WHERE id = ?').get(id) as unknown as EventRow) ?? null
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
   *
   * Null means exactly one thing: this alert is already queued. A blanket catch
   * here would turn a full disk or a busy database into a silent "already
   * queued", and the caller reads that as nothing to do, so the seat opened,
   * the event row exists, and the student is never told. This is the one write
   * the whole product exists to perform.
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
    } catch (err) {
      if (isUniqueViolation(err)) return null
      throw err
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

  stats(at = this.now()): {
    schools: number
    targets: number
    activeTargets: number
    leasedTargets: number
    subjects: number
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
      // Targets a worker is holding right now. With one process this is 0
      // between ticks; with several it is roughly how much work is in flight.
      leasedTargets: (
        this.db
          .prepare('SELECT COUNT(*) AS n FROM poll_targets WHERE lease_expires_at > ?')
          .get(at) as { n: number }
      ).n,
      subjects: one('SELECT COUNT(*) AS n FROM subjects'),
      sections: one('SELECT COUNT(*) AS n FROM sections WHERE present = 1'),
      watches: one('SELECT COUNT(*) AS n FROM watches WHERE active = 1'),
      events: one('SELECT COUNT(*) AS n FROM events'),
      pollCount: one('SELECT COALESCE(SUM(poll_count), 0) AS n FROM poll_targets'),
      pendingNotifications: one("SELECT COUNT(*) AS n FROM notifications WHERE status = 'pending'"),
    }
  }
}
