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

export interface TestAccount {
  userId: string
  email: string
  password: string
  token: string
}

export const TEST_PASSWORD = 'correct-horse-battery-staple'

/**
 * Signs up over HTTP rather than writing rows directly, because the signup path
 * is part of what these tests are checking and a shortcut around it would leave
 * the authenticated path, the entire point of the feature, untested.
 */
export async function signUp(
  base: string,
  email: string,
  password: string = TEST_PASSWORD
): Promise<TestAccount> {
  const res = await fetch(`${base}/api/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  if (res.status !== 201) {
    throw new Error(`signup for ${email} failed: ${res.status} ${await res.text()}`)
  }
  const body = (await res.json()) as { token: string; user: { id: string; email: string } }
  return { userId: body.user.id, email: body.user.email, password, token: body.token }
}

/** Adds the bearer header only when a token is present, so tests can also send none. */
export function authHeaders(token: string | null): Record<string, string> {
  return token === null ? {} : { Authorization: `Bearer ${token}` }
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
