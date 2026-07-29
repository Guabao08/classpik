import { migrate, openDb, type Db } from '../src/core/db.js'
import { Repo } from '../src/core/repo.js'
import { parseSchoolConfig } from '../src/config/schools.js'
import type { SchoolConfig } from '../src/adapters/types.js'

export const SCHOOL_ID = 'test-university'
export const TERM = '202608'

export function testSchool(over: Record<string, unknown> = {}): SchoolConfig {
  return parseSchoolConfig(
    {
      id: SCHOOL_ID,
      name: 'Test University',
      sis: 'banner9',
      baseUrl: 'https://banner.test.invalid',
      subjects: ['MATH', 'CS'],
      polling: {
        baseIntervalMs: 300_000,
        minIntervalMs: 60_000,
        maxIntervalMs: 1_800_000,
        hotWindowMs: 900_000,
      },
      enabled: true,
      ...over,
    },
    'test'
  )
}

export interface TestEnv {
  db: Db
  repo: Repo
  school: SchoolConfig
  /** Mutable clock so tests can advance time without sleeping. */
  clock: { now: number }
  close(): void
}

export function setupEnv(over: Record<string, unknown> = {}): TestEnv {
  const clock = { now: 1_800_000_000_000 }
  const db = openDb(':memory:')
  migrate(db)
  const repo = new Repo(db, () => clock.now)
  const school = testSchool(over)
  repo.upsertSchool(school)
  return { db, repo, school, clock, close: () => db.close() }
}
