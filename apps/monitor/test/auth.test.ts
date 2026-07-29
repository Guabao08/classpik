import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { randomBytes, scryptSync } from 'node:crypto'
import { createApi } from '../src/api/server.js'
import {
  bearerToken,
  hashPassword,
  hashSessionToken,
  lockoutMsFor,
  looksLikeEmail,
  MIN_PASSWORD_LENGTH,
  mintSessionToken,
  normalizeEmail,
  SESSION_TTL_MS,
  verifyPassword,
} from '../src/core/auth.js'
import type { RawSection } from '../src/adapters/types.js'
import { authHeaders, setupEnv, signUp, SCHOOL_ID, TERM, TEST_PASSWORD, type TestAccount, type TestEnv } from './helpers.js'

const raw = (over: Partial<RawSection> = {}): RawSection => ({
  crn: '30412', subject: 'MATH', courseNumber: '221', code: 'MATH 221',
  title: 'Linear Algebra', section: 'B', credits: 3, instructor: 'Whitfield',
  meetingDays: 'MWF', meetingTime: '10:00a', campus: null,
  seats: 0, capacity: 90, enrollment: 90, waitlist: 14, waitlistCap: 25, waitlistAvailable: 11,
  ...over,
})

// ---------------------------------------------------------------------- pure

describe('password hashing', () => {
  const password = 'a-perfectly-fine-password'

  it('produces a different hash every time for the same password', () => {
    // Equal hashes would mean no salt, which makes one rainbow table cover
    // every account that reused a common password.
    expect(hashPassword(password)).not.toBe(hashPassword(password))
  })

  it('accepts the password it was built from', () => {
    expect(verifyPassword(password, hashPassword(password))).toBe(true)
  })

  it('rejects a wrong password', () => {
    expect(verifyPassword('not-the-password', hashPassword(password))).toBe(false)
  })

  it('rejects a password differing only in case', () => {
    expect(verifyPassword(password.toUpperCase(), hashPassword(password))).toBe(false)
  })

  it('rejects a password that is a prefix of the real one', () => {
    expect(verifyPassword(password.slice(0, -1), hashPassword(password))).toBe(false)
  })

  it('stores neither the password nor anything resembling it', () => {
    const stored = hashPassword(password)
    expect(stored).not.toContain(password)
    expect(Buffer.from(stored).includes(Buffer.from(password))).toBe(false)
  })

  it('records the cost parameters alongside the digest', () => {
    const [scheme, n, r, p] = hashPassword(password).split('$')
    expect(scheme).toBe('scrypt')
    expect(Number(n)).toBeGreaterThanOrEqual(16_384)
    expect(Number(r)).toBeGreaterThan(0)
    expect(Number(p)).toBeGreaterThan(0)
  })

  it('verifies against the parameters in the hash rather than the current default', () => {
    // A hash written under an older, cheaper cost must keep working, otherwise
    // raising the cost silently locks every existing account out.
    const salt = randomBytes(16)
    const key = scryptSync(password, salt, 32, { N: 1024, r: 8, p: 1 })
    const legacy = ['scrypt', 1024, 8, 1, salt.toString('base64'), key.toString('base64')].join('$')
    expect(verifyPassword(password, legacy)).toBe(true)
    expect(verifyPassword('wrong', legacy)).toBe(false)
  })

  it('rejects a hash whose digest has been tampered with', () => {
    const parts = hashPassword(password).split('$')
    const key = Buffer.from(parts[5]!, 'base64')
    key[0] = key[0]! ^ 0xff
    parts[5] = key.toString('base64')
    expect(verifyPassword(password, parts.join('$'))).toBe(false)
  })

  it('rejects a hash whose salt has been swapped', () => {
    const parts = hashPassword(password).split('$')
    parts[4] = randomBytes(16).toString('base64')
    expect(verifyPassword(password, parts.join('$'))).toBe(false)
  })

  it('returns false rather than throwing on a malformed stored hash', () => {
    for (const junk of ['', 'not-a-hash', 'scrypt$$$$$', 'bcrypt$1$2$3$a$b', 'scrypt$16384$8$1$onlyfive']) {
      expect(verifyPassword(password, junk)).toBe(false)
    }
  })

  it('returns false rather than throwing on absurd cost parameters', () => {
    const parts = hashPassword(password).split('$')
    parts[1] = '999999999'
    expect(verifyPassword(password, parts.join('$'))).toBe(false)
    parts[1] = '0'
    expect(verifyPassword(password, parts.join('$'))).toBe(false)
    parts[1] = '-16384'
    expect(verifyPassword(password, parts.join('$'))).toBe(false)
  })

  it('rejects a truncated digest, which scrypt would otherwise accept as a prefix', () => {
    const parts = hashPassword(password).split('$')
    parts[5] = Buffer.from(parts[5]!, 'base64').subarray(0, 16).toString('base64')
    expect(verifyPassword(password, parts.join('$'))).toBe(false)
  })
})

describe('session tokens', () => {
  it('mints a distinct high-entropy token every time', () => {
    const seen = new Set(Array.from({ length: 200 }, () => mintSessionToken()))
    expect(seen.size).toBe(200)
    for (const t of seen) expect(t.length).toBeGreaterThanOrEqual(40)
  })

  it('hashes a token to a stable digest that is not the token', () => {
    const token = mintSessionToken()
    expect(hashSessionToken(token)).toBe(hashSessionToken(token))
    expect(hashSessionToken(token)).not.toBe(token)
    expect(hashSessionToken(token)).toHaveLength(64)
  })

  it('gives different tokens different digests', () => {
    expect(hashSessionToken(mintSessionToken())).not.toBe(hashSessionToken(mintSessionToken()))
  })

  it('reads a bearer token out of an Authorization header', () => {
    expect(bearerToken('Bearer abc123')).toBe('abc123')
    expect(bearerToken('bearer abc123')).toBe('abc123')
    expect(bearerToken('  Bearer   abc123  ')).toBe('abc123')
  })

  it('ignores an Authorization header that is not a bearer token', () => {
    expect(bearerToken(undefined)).toBeNull()
    expect(bearerToken('')).toBeNull()
    expect(bearerToken('Basic abc123')).toBeNull()
    expect(bearerToken('Bearer')).toBeNull()
    expect(bearerToken('Bearer   ')).toBeNull()
    expect(bearerToken('abc123')).toBeNull()
  })
})

describe('login lockout policy', () => {
  it('does not lock before the attempt limit', () => {
    for (let i = 0; i < 5; i++) expect(lockoutMsFor(i)).toBe(0)
  })

  it('locks for a minute at the limit and doubles from there', () => {
    expect(lockoutMsFor(5)).toBe(60_000)
    expect(lockoutMsFor(6)).toBe(120_000)
    expect(lockoutMsFor(7)).toBe(240_000)
  })

  it('caps the lockout at an hour so a mistyped password is never permanent', () => {
    expect(lockoutMsFor(20)).toBe(3_600_000)
    expect(lockoutMsFor(1000)).toBe(3_600_000)
    expect(Number.isFinite(lockoutMsFor(1000))).toBe(true)
  })
})

describe('email handling', () => {
  it('normalises case and surrounding space so one address is one account', () => {
    expect(normalizeEmail('  Ada@Example.EDU ')).toBe('ada@example.edu')
  })

  it('accepts ordinary addresses', () => {
    for (const e of ['a@b.co', 'ada.lovelace+cs@uni.example.edu', 'x_y@sub.domain.org']) {
      expect(looksLikeEmail(e)).toBe(true)
    }
  })

  it('rejects addresses that cannot possibly deliver', () => {
    for (const e of ['', 'nope', '@example.com', 'a@', 'a@b', 'a b@c.com', 'a@b.', 'a@.b', 'a@b@c.com']) {
      expect(looksLikeEmail(e)).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------- HTTP

describe('auth over HTTP', () => {
  let env: TestEnv
  let server: Server
  let base: string
  let sid: string
  let alice: TestAccount

  const post = (path: string, body?: unknown, token: string | null = null) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  const get = (path: string, token: string | null = null) =>
    fetch(`${base}${path}`, { headers: authHeaders(token) })
  const del = (path: string, token: string | null = null) =>
    fetch(`${base}${path}`, { method: 'DELETE', headers: authHeaders(token) })

  const login = (email: string, password: string) => post('/api/auth/login', { email, password })

  beforeEach(async () => {
    env = setupEnv()
    const target = env.repo.ensureTarget(SCHOOL_ID, TERM, 'MATH', 60_000)
    sid = env.repo.upsertSection(target, raw(), false)
    env.repo.upsertSection(target, raw({ crn: '30418', section: 'E', seats: 22 }), false)

    server = createApi({ repo: env.repo, now: () => env.clock.now })
    await new Promise<void>((r) => server.listen(0, r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    alice = await signUp(base, 'alice@classpik.test')
  })

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()))
    env.close()
  })

  describe('signup', () => {
    it('returns a usable session so the client is not asked to log in twice', async () => {
      const res = await get('/api/auth/me', alice.token)
      expect(res.status).toBe(200)
      expect((await res.json() as any).user.email).toBe('alice@classpik.test')
    })

    it('rejects an email that already has an account', async () => {
      const res = await post('/api/auth/signup', { email: 'alice@classpik.test', password: TEST_PASSWORD })
      expect(res.status).toBe(409)
    })

    it('treats a differently cased email as the same account', async () => {
      const res = await post('/api/auth/signup', { email: 'ALICE@Classpik.test', password: TEST_PASSWORD })
      expect(res.status).toBe(409)
    })

    it('lets the differently cased address log in to the original account', async () => {
      const res = await login('  ALICE@Classpik.TEST ', TEST_PASSWORD)
      expect(res.status).toBe(200)
      expect((await res.json() as any).user.id).toBe(alice.userId)
    })

    it('rejects a password shorter than the minimum', async () => {
      const res = await post('/api/auth/signup', { email: 'short@classpik.test', password: 'a'.repeat(MIN_PASSWORD_LENGTH - 1) })
      expect(res.status).toBe(400)
      expect((await res.json() as any).error).toContain(String(MIN_PASSWORD_LENGTH))
    })

    it('rejects a password long enough to be a denial of service', async () => {
      const res = await post('/api/auth/signup', { email: 'long@classpik.test', password: 'a'.repeat(5000) })
      expect(res.status).toBe(400)
    })

    it('rejects an address that is not an email', async () => {
      const res = await post('/api/auth/signup', { email: 'not-an-email', password: TEST_PASSWORD })
      expect(res.status).toBe(400)
    })

    it('requires both fields', async () => {
      expect((await post('/api/auth/signup', { email: 'x@y.co' })).status).toBe(400)
      expect((await post('/api/auth/signup', { password: TEST_PASSWORD })).status).toBe(400)
    })

    it('never returns the password hash', async () => {
      const body = await (await post('/api/auth/signup', { email: 'new@classpik.test', password: TEST_PASSWORD })).json() as any
      expect(JSON.stringify(body)).not.toContain('scrypt')
      expect(body.user.password_hash).toBeUndefined()
    })

    it('stores the password hashed, never as written', async () => {
      const row = env.repo.findUserByEmail('alice@classpik.test')!
      expect(row.password_hash).not.toContain(TEST_PASSWORD)
      expect(row.password_hash.startsWith('scrypt$')).toBe(true)
      expect(verifyPassword(TEST_PASSWORD, row.password_hash)).toBe(true)
    })

    it('stores only the digest of the session token', async () => {
      const rows = env.repo.raw.prepare('SELECT * FROM sessions').all() as Array<Record<string, unknown>>
      expect(rows).toHaveLength(1)
      // The raw token must not appear anywhere in the row we persisted.
      expect(JSON.stringify(rows[0])).not.toContain(alice.token)
      expect(rows[0]!.token_hash).toBe(hashSessionToken(alice.token))
    })
  })

  describe('login', () => {
    it('accepts the right password', async () => {
      const res = await login(alice.email, TEST_PASSWORD)
      expect(res.status).toBe(200)
      const body = await res.json() as any
      expect(body.token).toBeTypeOf('string')
      expect(body.expiresAt).toBe(env.clock.now + SESSION_TTL_MS)
    })

    it('rejects a wrong password', async () => {
      expect((await login(alice.email, 'wrong-password-entirely')).status).toBe(401)
    })

    it('answers an unknown email exactly as it answers a wrong password', async () => {
      // Any difference here is a free list of which addresses have accounts.
      const unknown = await login('nobody@classpik.test', TEST_PASSWORD)
      const wrong = await login(alice.email, 'wrong-password-entirely')
      expect(unknown.status).toBe(wrong.status)
      expect((await unknown.json() as any).error).toBe((await wrong.json() as any).error)
    })

    it('issues a second session without disturbing the first', async () => {
      const second = (await (await login(alice.email, TEST_PASSWORD)).json() as any).token
      expect(second).not.toBe(alice.token)
      expect((await get('/api/auth/me', alice.token)).status).toBe(200)
      expect((await get('/api/auth/me', second)).status).toBe(200)
    })

    it('records the login time', async () => {
      env.clock.now += 5_000
      await login(alice.email, TEST_PASSWORD)
      expect(env.repo.getUser(alice.userId)!.last_login_at).toBe(env.clock.now)
    })
  })

  describe('login rate limiting', () => {
    const failTimes = async (n: number) => {
      for (let i = 0; i < n; i++) await login(alice.email, `wrong-${i}-attempt`)
    }

    it('counts consecutive failures', async () => {
      await failTimes(3)
      expect(env.repo.getUser(alice.userId)!.failed_logins).toBe(3)
    })

    it('locks the account once the attempt limit is reached', async () => {
      await failTimes(5)
      const res = await login(alice.email, 'wrong-again')
      expect(res.status).toBe(429)
      expect((await res.json() as any).error).toContain('too many')
    })

    it('refuses even the correct password while locked', async () => {
      // The whole point: an attacker must not be able to slip a correct guess
      // through during the lockout window.
      await failTimes(5)
      expect((await login(alice.email, TEST_PASSWORD)).status).toBe(429)
    })

    it('accepts the correct password again once the lockout expires', async () => {
      await failTimes(5)
      env.clock.now += lockoutMsFor(5) + 1
      expect((await login(alice.email, TEST_PASSWORD)).status).toBe(200)
    })

    it('lengthens the lockout for each failure past the limit', async () => {
      await failTimes(5)
      env.clock.now += lockoutMsFor(5) + 1
      await login(alice.email, 'wrong-once-more')
      const user = env.repo.getUser(alice.userId)!
      expect(user.failed_logins).toBe(6)
      expect(user.locked_until).toBe(env.clock.now + lockoutMsFor(6))
    })

    it('clears the counter on a successful login', async () => {
      await failTimes(4)
      expect((await login(alice.email, TEST_PASSWORD)).status).toBe(200)
      const user = env.repo.getUser(alice.userId)!
      expect(user.failed_logins).toBe(0)
      expect(user.locked_until).toBeNull()
    })

    it('locks one account without touching another', async () => {
      const bob = await signUp(base, 'bob@classpik.test')
      await failTimes(5)
      expect((await login(alice.email, TEST_PASSWORD)).status).toBe(429)
      expect((await login(bob.email, TEST_PASSWORD)).status).toBe(200)
    })

    it('does not lock out a session that is already open', async () => {
      // Lockout is about guessing passwords, not about punishing a signed-in
      // browser that happens to share the account.
      await failTimes(5)
      expect((await get('/api/auth/me', alice.token)).status).toBe(200)
    })
  })

  describe('sessions', () => {
    it('rejects a request with no token on a private route', async () => {
      expect((await get('/api/auth/me')).status).toBe(401)
      expect((await get('/api/watches')).status).toBe(401)
      expect((await post('/api/watches', { sectionId: sid })).status).toBe(401)
      expect((await del('/api/watches/anything')).status).toBe(401)
      expect((await get('/api/events')).status).toBe(401)
    })

    it('rejects a token that was never issued', async () => {
      expect((await get('/api/auth/me', mintSessionToken())).status).toBe(401)
    })

    it('rejects a garbage token', async () => {
      for (const junk of ['nonsense', '....', 'null', hashSessionToken('anything')]) {
        expect((await get('/api/auth/me', junk)).status).toBe(401)
      }
    })

    it('rejects a token sent without the Bearer scheme', async () => {
      const res = await fetch(`${base}/api/auth/me`, { headers: { Authorization: alice.token } })
      expect(res.status).toBe(401)
    })

    it('rejects a token altered by a single character', async () => {
      const tampered = `${alice.token.slice(0, -1)}${alice.token.endsWith('A') ? 'B' : 'A'}`
      expect((await get('/api/auth/me', tampered)).status).toBe(401)
    })

    it('stays valid right up to the moment it expires', async () => {
      env.clock.now += SESSION_TTL_MS - 1
      expect((await get('/api/auth/me', alice.token)).status).toBe(200)
    })

    it('rejects an expired session', async () => {
      env.clock.now += SESSION_TTL_MS
      expect((await get('/api/auth/me', alice.token)).status).toBe(401)
    })

    it('rejects a revoked session', async () => {
      expect((await post('/api/auth/logout', undefined, alice.token)).status).toBe(200)
      expect((await get('/api/auth/me', alice.token)).status).toBe(401)
    })

    it('rejects the same token replayed after logout', async () => {
      await post('/api/auth/logout', undefined, alice.token)
      expect((await get('/api/watches', alice.token)).status).toBe(401)
      expect((await post('/api/watches', { sectionId: sid }, alice.token)).status).toBe(401)
    })

    it('logs out only the session that was presented', async () => {
      // Signing out on a laptop must not sign the same person out on a phone.
      const phone = (await (await login(alice.email, TEST_PASSWORD)).json() as any).token
      await post('/api/auth/logout', undefined, alice.token)
      expect((await get('/api/auth/me', alice.token)).status).toBe(401)
      expect((await get('/api/auth/me', phone)).status).toBe(200)
    })

    it('revoking every session for an account kills all of them at once', async () => {
      const phone = (await (await login(alice.email, TEST_PASSWORD)).json() as any).token
      expect(env.repo.revokeSessionsForUser(alice.userId)).toBe(2)
      expect((await get('/api/auth/me', alice.token)).status).toBe(401)
      expect((await get('/api/auth/me', phone)).status).toBe(401)
    })

    it('leaves catalog routes reachable without a token', async () => {
      expect((await get('/health')).status).toBe(200)
      expect((await get('/api/schools')).status).toBe(200)
      expect((await get('/api/stats')).status).toBe(200)
      expect((await get('/api/sections')).status).toBe(200)
      expect((await get(`/api/sections/${encodeURIComponent(sid)}`)).status).toBe(200)
    })

    it('ignores a valid token on a public route rather than failing', async () => {
      expect((await get('/api/sections', alice.token)).status).toBe(200)
    })

    it('purges expired sessions without touching live ones', async () => {
      const signedUpAt = env.clock.now
      env.clock.now += 60_000
      const live = (await (await login(alice.email, TEST_PASSWORD)).json() as any).token

      // Exactly alice's original expiry, which is a minute before the newer
      // session's, so the purge must take one row and leave the other.
      env.clock.now = signedUpAt + SESSION_TTL_MS
      expect(env.repo.purgeExpiredSessions(env.clock.now)).toBe(1)
      expect((await get('/api/auth/me', alice.token)).status).toBe(401)
      expect((await get('/api/auth/me', live)).status).toBe(200)
    })
  })

  describe('watch scoping', () => {
    let bob: TestAccount
    let aliceWatch: string
    let bobWatch: string

    beforeEach(async () => {
      bob = await signUp(base, 'bob@classpik.test')
      aliceWatch = (await (await post('/api/watches', { sectionId: sid }, alice.token)).json() as any).watch.id
      bobWatch = (await (await post('/api/watches', { sectionId: sid }, bob.token)).json() as any).watch.id
    })

    it('gives two accounts watching the same section separate watches', () => {
      expect(aliceWatch).not.toBe(bobWatch)
    })

    it('shows each account only its own watches', async () => {
      const a = await (await get('/api/watches', alice.token)).json() as any
      const b = await (await get('/api/watches', bob.token)).json() as any
      expect(a.watches.map((w: any) => w.id)).toEqual([aliceWatch])
      expect(b.watches.map((w: any) => w.id)).toEqual([bobWatch])
    })

    it('refuses to delete another account\'s watch', async () => {
      expect((await del(`/api/watches/${bobWatch}`, alice.token)).status).toBe(404)
    })

    it('leaves the other account\'s watch active after a refused delete', async () => {
      await del(`/api/watches/${bobWatch}`, alice.token)
      expect(env.repo.getWatch(bobWatch)!.active).toBe(1)
      expect((await (await get('/api/watches', bob.token)).json() as any).watches).toHaveLength(1)
    })

    it('answers the same for another account\'s watch as for one that does not exist', async () => {
      // A 403 here would confirm the id is real, which is an existence oracle
      // over other people's watchlists.
      const other = await del(`/api/watches/${bobWatch}`, alice.token)
      const missing = await del('/api/watches/00000000-0000-4000-8000-000000000000', alice.token)
      expect(other.status).toBe(missing.status)
      expect((await other.json() as any).error).toBe(
        (await missing.json() as any).error.replace('00000000-0000-4000-8000-000000000000', bobWatch)
      )
    })

    it('does not let one account delete its way into another account\'s data by id guessing', async () => {
      await del(`/api/watches/${bobWatch}`, alice.token)
      await del(`/api/watches/${aliceWatch}`, alice.token)
      expect((await (await get('/api/watches', alice.token)).json() as any).watches).toHaveLength(0)
      expect((await (await get('/api/watches', bob.token)).json() as any).watches).toHaveLength(1)
    })

    it('scopes events to the watching account', async () => {
      env.repo.recordEvent(sid, {
        kind: 'seat_opened', prevSeats: 0, newSeats: 1, prevWaitlist: 0, newWaitlist: 0, detail: 'x',
      })
      // Both watch this section, so both see it.
      expect((await (await get('/api/events', alice.token)).json() as any).events).toHaveLength(1)
      expect((await (await get('/api/events', bob.token)).json() as any).events).toHaveLength(1)

      await del(`/api/watches/${aliceWatch}`, alice.token)
      expect((await (await get('/api/events', alice.token)).json() as any).events).toHaveLength(0)
      expect((await (await get('/api/events', bob.token)).json() as any).events).toHaveLength(1)
    })

    it('does not let a userId parameter override the session on watches', async () => {
      const res = await get(`/api/watches?userId=${encodeURIComponent(bob.userId)}`, alice.token)
      expect((await res.json() as any).watches.map((w: any) => w.id)).toEqual([aliceWatch])
    })

    it('keeps a watch attached to the account rather than to the session', async () => {
      await post('/api/auth/logout', undefined, alice.token)
      const fresh = (await (await login(alice.email, TEST_PASSWORD)).json() as any).token
      expect((await (await get('/api/watches', fresh)).json() as any).watches).toHaveLength(1)
    })
  })
})
