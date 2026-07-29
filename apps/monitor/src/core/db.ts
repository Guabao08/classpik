import { DatabaseSync } from 'node:sqlite'

/**
 * SQLite via node:sqlite, which ships with Node 22.5+ and therefore costs us
 * zero native dependencies and zero setup. It is real SQL with real
 * transactions, and every query lives behind the repo layer, so moving to
 * Postgres when this outgrows one box is a repo rewrite, not an app rewrite.
 */

export type Db = DatabaseSync

export interface MigrationsResult {
  from: number
  to: number
  applied: string[]
}

const MIGRATIONS: Array<{ version: number; name: string; sql: string }> = [
  {
    version: 1,
    name: 'initial',
    sql: `
      CREATE TABLE schools (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        sis         TEXT NOT NULL,
        base_url    TEXT NOT NULL,
        enabled     INTEGER NOT NULL DEFAULT 1,
        config_json TEXT NOT NULL,
        created_at  INTEGER NOT NULL
      );

      CREATE TABLE terms (
        school_id   TEXT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
        code        TEXT NOT NULL,
        description TEXT NOT NULL,
        PRIMARY KEY (school_id, code)
      );

      -- The polling unit. One row per (school, term, subject), NOT per section.
      -- One upstream request returns every section for a subject, so this is
      -- what makes cost scale with distinct subjects watched rather than with
      -- users: fifty students watching different CS sections is one target.
      CREATE TABLE poll_targets (
        id                 TEXT PRIMARY KEY,
        school_id          TEXT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
        term               TEXT NOT NULL,
        subject            TEXT NOT NULL,
        interval_ms        INTEGER NOT NULL,
        next_poll_at       INTEGER NOT NULL,
        last_polled_at     INTEGER,
        last_changed_at    INTEGER,
        first_polled_at    INTEGER,
        poll_count         INTEGER NOT NULL DEFAULT 0,
        change_count       INTEGER NOT NULL DEFAULT 0,
        consecutive_errors INTEGER NOT NULL DEFAULT 0,
        last_error         TEXT,
        active             INTEGER NOT NULL DEFAULT 1,
        created_at         INTEGER NOT NULL,
        UNIQUE (school_id, term, subject)
      );

      CREATE INDEX idx_targets_due ON poll_targets (active, next_poll_at);

      CREATE TABLE sections (
        id                  TEXT PRIMARY KEY,
        target_id           TEXT NOT NULL REFERENCES poll_targets(id) ON DELETE CASCADE,
        school_id           TEXT NOT NULL,
        term                TEXT NOT NULL,
        crn                 TEXT NOT NULL,
        subject             TEXT NOT NULL,
        course_number       TEXT NOT NULL,
        code                TEXT NOT NULL,
        title               TEXT NOT NULL,
        section             TEXT NOT NULL,
        credits             REAL,
        instructor          TEXT,
        meeting_days        TEXT,
        meeting_time        TEXT,
        campus              TEXT,
        seats               INTEGER NOT NULL,
        capacity            INTEGER NOT NULL,
        enrollment          INTEGER NOT NULL,
        waitlist            INTEGER NOT NULL,
        waitlist_cap        INTEGER NOT NULL,
        waitlist_available  INTEGER NOT NULL,
        status              TEXT NOT NULL,
        present             INTEGER NOT NULL DEFAULT 1,
        first_seen_at       INTEGER NOT NULL,
        last_polled_at      INTEGER NOT NULL,
        last_changed_at     INTEGER,
        UNIQUE (school_id, term, crn)
      );

      CREATE INDEX idx_sections_target ON sections (target_id);
      CREATE INDEX idx_sections_code   ON sections (school_id, term, code);

      CREATE TABLE watches (
        id             TEXT PRIMARY KEY,
        user_id        TEXT NOT NULL,
        section_id     TEXT NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
        mode           TEXT NOT NULL DEFAULT 'notify',
        channel        TEXT NOT NULL DEFAULT 'console',
        target         TEXT,
        active         INTEGER NOT NULL DEFAULT 1,
        created_at     INTEGER NOT NULL,
        last_notified_at INTEGER,
        UNIQUE (user_id, section_id)
      );

      CREATE INDEX idx_watches_section ON watches (section_id, active);
      CREATE INDEX idx_watches_user    ON watches (user_id, active);

      CREATE TABLE events (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        section_id    TEXT NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
        kind          TEXT NOT NULL,
        prev_seats    INTEGER,
        new_seats     INTEGER NOT NULL,
        prev_waitlist INTEGER,
        new_waitlist  INTEGER NOT NULL,
        detail        TEXT NOT NULL,
        at            INTEGER NOT NULL
      );

      CREATE INDEX idx_events_section ON events (section_id, at DESC);
      CREATE INDEX idx_events_at      ON events (at DESC);

      CREATE TABLE notifications (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        watch_id     TEXT NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
        event_id     INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        channel      TEXT NOT NULL,
        target       TEXT,
        status       TEXT NOT NULL DEFAULT 'pending',
        attempts     INTEGER NOT NULL DEFAULT 0,
        last_error   TEXT,
        next_retry_at INTEGER,
        created_at   INTEGER NOT NULL,
        delivered_at INTEGER,
        UNIQUE (watch_id, event_id)
      );

      CREATE INDEX idx_notifications_pending ON notifications (status, next_retry_at);
    `,
  },
  {
    version: 2,
    name: 'accounts',
    sql: `
      -- ClassPik accounts. These are our users, never a school login: no row
      -- here is ever presented to an SIS.
      CREATE TABLE users (
        id            TEXT PRIMARY KEY,
        email         TEXT NOT NULL,
        -- Uniqueness rides on the normalised form so that Ada@x.edu and
        -- ada@x.edu cannot become two accounts that both look correct.
        email_norm    TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at    INTEGER NOT NULL,
        last_login_at INTEGER,
        -- Consecutive bad passwords, reset by a success. Drives the lockout.
        failed_logins INTEGER NOT NULL DEFAULT 0,
        locked_until  INTEGER
      );

      -- The primary key is the SHA-256 of the bearer token, never the token
      -- itself, so a database leak yields nothing that can be replayed.
      CREATE TABLE sessions (
        token_hash TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        revoked_at INTEGER,
        user_agent TEXT
      );

      CREATE INDEX idx_sessions_user   ON sessions (user_id, expires_at);
      CREATE INDEX idx_sessions_expiry ON sessions (expires_at);
    `,
  },
  {
    version: 3,
    name: 'subjects and leases',
    sql: `
      -- Every subject a school offers in a term, as the SIS reports it.
      --
      -- This is a browsing catalogue, NOT a poll list. A large university has
      -- upwards of two hundred subject codes, and polling all of them because
      -- we happen to know their names is exactly the impolite behaviour the
      -- per-subject design exists to avoid. A row here costs zero requests.
      -- What turns a subject into upstream traffic is seeded_at, and only a
      -- deliberate human action sets that: see Repo.markSubjectSeeded.
      CREATE TABLE subjects (
        school_id     TEXT NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
        term          TEXT NOT NULL,
        code          TEXT NOT NULL,
        description   TEXT NOT NULL,
        discovered_at INTEGER NOT NULL,
        -- When someone first browsed this subject and we granted it the one
        -- fetch that makes its sections watchable. NULL means we know the
        -- subject exists and have never asked the registrar about it.
        seeded_at     INTEGER,
        PRIMARY KEY (school_id, term, code)
      );

      -- Target leasing, which is what lets more than one poller share a
      -- database without both of them fetching the same subject and doubling
      -- our request rate at a registrar. The expiry is the important half: a
      -- worker that dies mid-poll must not hold a target forever.
      ALTER TABLE poll_targets ADD COLUMN lease_owner TEXT;
      ALTER TABLE poll_targets ADD COLUMN lease_expires_at INTEGER;

      DROP INDEX idx_targets_due;
      CREATE INDEX idx_targets_due ON poll_targets (active, next_poll_at, lease_expires_at);
    `,
  },
  {
    version: 4,
    name: 'scoping',
    sql: `
      -- Which catalogue a student is actually shopping in. Search defaults to
      -- these three, so that an undergraduate at one university does not get a
      -- blended list of two universities' classes the day a second school is
      -- configured. The watchlist and the alerts deliberately ignore all of
      -- them: see Repo.listWatches.
      --
      -- No foreign key on school_id. A student who transfers keeps an account
      -- pointing at a school we may later stop carrying, and a reference would
      -- either block removing that school or take the preference with it.
      ALTER TABLE users ADD COLUMN school_id TEXT;
      ALTER TABLE users ADD COLUMN term TEXT;
      -- A JSON array of level codes. A list rather than one value, because a
      -- senior takes a graduate seminar, a graduate student takes an
      -- undergraduate prerequisite, and a law or medical student is neither of
      -- the two options a boolean would have offered. A column rather than a
      -- join table, because this set is only ever read and written whole, one
      -- per account, and a second table would buy a join on every search for
      -- nothing.
      ALTER TABLE users ADD COLUMN levels TEXT NOT NULL DEFAULT '[]';

      -- Level belongs to the section, not to the account reading it: it is what
      -- the registrar publishes about who may enrol. level keeps the
      -- registrar's own spelling for display, level_norm is the only thing ever
      -- compared, so UGRD and ugrd are one level rather than two. Neither is
      -- constrained to a set of values, because the set is per institution and
      -- an enum here would silently hide every level we had not enumerated.
      ALTER TABLE sections ADD COLUMN level TEXT;
      ALTER TABLE sections ADD COLUMN level_norm TEXT;

      -- Exactly what catalog search filters on, in the order it filters: one
      -- school, one term, then the levels the student ticked.
      CREATE INDEX idx_sections_scope ON sections (school_id, term, level_norm);
    `,
  },
]

export function openDb(path = ':memory:'): Db {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 5000')
  return db
}

export function migrate(db: Db): MigrationsResult {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)')
  const row = db.prepare('SELECT version FROM schema_version LIMIT 1').get() as
    | { version: number }
    | undefined

  const from = row?.version ?? 0
  const applied: string[] = []

  for (const m of MIGRATIONS) {
    if (m.version <= from) continue
    db.exec('BEGIN')
    try {
      db.exec(m.sql)
      if (row === undefined && applied.length === 0) {
        db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(m.version)
      } else {
        db.prepare('UPDATE schema_version SET version = ?').run(m.version)
      }
      db.exec('COMMIT')
      applied.push(m.name)
    } catch (err) {
      db.exec('ROLLBACK')
      throw new Error(`migration ${m.version} (${m.name}) failed: ${String(err)}`)
    }
  }

  const to = MIGRATIONS.at(-1)?.version ?? 0
  return { from, to, applied }
}

/**
 * Nesting depth per database handle, so `tx` can tell an outermost call from an
 * inner one. A WeakMap rather than a field because `Db` is node:sqlite's type
 * and not ours to extend.
 */
const txDepth = new WeakMap<Db, number>()

/**
 * Run `fn` in a transaction, rolling back if it throws. Reentrant.
 *
 * The nesting matters. SQLite has no nested BEGIN, so an inner `tx` used to
 * throw "cannot start a transaction within a transaction" at its own BEGIN, and
 * then the inner catch issued a ROLLBACK that tore down the OUTER transaction
 * and threw a second time from the rollback itself. The caller saw a confusing
 * SQLITE_ERROR about transaction nesting instead of whatever really failed, and
 * the outer writes were gone. An inner call now uses a SAVEPOINT, which is the
 * one construct SQLite does nest, so an inner failure unwinds only its own work
 * and the real error is what propagates.
 */
export function tx<T>(db: Db, fn: () => T): T {
  // isTransaction covers a transaction someone opened without going through
  // here, which our own counter cannot see.
  const depth = txDepth.get(db) ?? 0
  const nested = depth > 0 || db.isTransaction

  if (!nested) {
    db.exec('BEGIN')
    txDepth.set(db, 1)
    try {
      const out = fn()
      db.exec('COMMIT')
      return out
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    } finally {
      txDepth.set(db, 0)
    }
  }

  // Savepoint names are not parameterisable, so this is built rather than
  // bound. It is a depth counter, never anything a caller supplies.
  const name = `classpik_sp_${depth}`
  db.exec(`SAVEPOINT ${name}`)
  txDepth.set(db, depth + 1)
  try {
    const out = fn()
    // RELEASE is the savepoint form of COMMIT: it merges this level's work into
    // the enclosing transaction rather than writing anything to disk.
    db.exec(`RELEASE ${name}`)
    return out
  } catch (err) {
    // ROLLBACK TO leaves the savepoint on the stack, so it needs releasing too
    // or the next sibling call reuses a name that is still open.
    db.exec(`ROLLBACK TO ${name}`)
    db.exec(`RELEASE ${name}`)
    throw err
  } finally {
    txDepth.set(db, depth)
  }
}
