import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

/**
 * ClassPik's own accounts. These are OUR users, not school logins: nothing in
 * this file is ever sent to an SIS, and nothing here is importable from
 * `src/adapters`, so the "there is nowhere to put a school password" guarantee
 * in the README still holds.
 *
 * Everything is pure and synchronous so the policy can be tested without a
 * database or a socket. Storage lives in the repo, HTTP lives in the server.
 */

// scrypt over PBKDF2 because it is memory-hard, and over bcrypt because it is
// in node:crypto and therefore costs us no dependency. N = 16384 is roughly
// 35ms per hash on a laptop, which is slow enough to hurt an offline cracker
// and fast enough that a login does not feel broken.
const SCRYPT_N = 16_384
const SCRYPT_R = 8
const SCRYPT_P = 1
const KEY_BYTES = 32
const SALT_BYTES = 16

// scrypt needs 128 * N * r bytes, which exceeds node's default cap at this N.
const SCRYPT_MAXMEM = 128 * SCRYPT_N * SCRYPT_R * 2

export const MIN_PASSWORD_LENGTH = 10
/** We pay the scrypt cost, not the caller, so the input length is bounded. */
export const MAX_PASSWORD_LENGTH = 256

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000

export const LOGIN_ATTEMPT_LIMIT = 5
const LOCKOUT_BASE_MS = 60_000
const LOCKOUT_MAX_MS = 60 * 60_000

/**
 * Encoded as `scrypt$N$r$p$salt$key`, all base64. The parameters travel with
 * the hash so they can be raised later without a flag day: old rows keep
 * verifying against the parameters they were written with.
 */
export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_BYTES)
  const key = derive(password, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P)
  return [
    'scrypt',
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('base64'),
    key.toString('base64'),
  ].join('$')
}

/** False for a wrong password and false for a stored hash we cannot parse. */
export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false

  const n = Number(parts[1])
  const r = Number(parts[2])
  const p = Number(parts[3])
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false
  if (n <= 0 || r <= 0 || p <= 0) return false

  const salt = Buffer.from(parts[4]!, 'base64')
  const expected = Buffer.from(parts[5]!, 'base64')
  // The key length is fixed rather than read from the row. Deriving to
  // whatever length the stored digest happens to be would mean a truncated
  // digest still verifies, since scrypt output is a prefix of a longer one.
  if (salt.length === 0 || expected.length !== KEY_BYTES) return false

  let actual: Buffer
  try {
    actual = derive(password, salt, n, r, p)
  } catch {
    // Absurd parameters in a corrupted row must not take the process down.
    return false
  }

  // timingSafeEqual throws on a length mismatch, so the guard comes first.
  if (actual.length !== expected.length) return false
  return timingSafeEqual(actual, expected)
}

/**
 * Spends the same scrypt time a real verification would. Called when the email
 * is unknown: without it, a login for a non-existent account answers in a
 * microsecond and a login for a real one takes 35ms, which turns response time
 * into a free account-enumeration oracle.
 */
let decoyHash: string | null = null
export function burnPasswordWork(password: string): void {
  decoyHash ??= hashPassword(randomBytes(24).toString('base64'))
  verifyPassword(password, decoyHash)
}

/**
 * Opaque, not a JWT. A random token means revocation is a DELETE rather than a
 * blocklist, and it carries no claims a client could be tempted to trust.
 */
export function mintSessionToken(): string {
  return randomBytes(32).toString('base64url')
}

/**
 * Only the digest is stored. A leaked database must not hand out live sessions,
 * and unlike a password there is no need for a slow KDF here: the token has 256
 * bits of entropy, so there is nothing to guess.
 */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/** Extracts the token from an `Authorization` header, or null if absent. */
export function bearerToken(header: string | undefined): string | null {
  if (!header) return null
  const [scheme, ...rest] = header.trim().split(/\s+/)
  if (scheme?.toLowerCase() !== 'bearer') return null
  const token = rest.join('')
  return token === '' ? null : token
}

/**
 * How long an account is locked after `failures` consecutive bad passwords.
 * Doubling from one minute, capped at an hour: an attacker gets a handful of
 * guesses per hour instead of thousands per second, while a legitimate user who
 * mistyped their password a few times is never locked out permanently.
 */
export function lockoutMsFor(failures: number): number {
  if (failures < LOGIN_ATTEMPT_LIMIT) return 0
  const steps = failures - LOGIN_ATTEMPT_LIMIT
  // 2 ** steps overflows to Infinity long before Math.min saves us otherwise.
  if (steps > 32) return LOCKOUT_MAX_MS
  return Math.min(LOCKOUT_BASE_MS * 2 ** steps, LOCKOUT_MAX_MS)
}

/** Uniqueness is enforced on this value, so casing and stray spaces cannot fork an account. */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase()
}

/**
 * Deliberately loose. The only address that truly validates is one that
 * receives mail, so this rejects obvious nonsense and leaves the rest to
 * delivery rather than pretending a regex can decide.
 */
export function looksLikeEmail(raw: string): boolean {
  const value = raw.trim()
  if (value.length < 3 || value.length > 254) return false
  if (/\s/.test(value)) return false
  const at = value.indexOf('@')
  if (at <= 0 || at !== value.lastIndexOf('@')) return false
  const domain = value.slice(at + 1)
  return domain.length >= 3 && domain.includes('.') && !domain.startsWith('.') && !domain.endsWith('.')
}

function derive(password: string, salt: Buffer, n: number, r: number, p: number): Buffer {
  return scryptSync(password, salt, KEY_BYTES, {
    N: n,
    r,
    p,
    maxmem: Math.max(SCRYPT_MAXMEM, 128 * n * r * 2),
  })
}
