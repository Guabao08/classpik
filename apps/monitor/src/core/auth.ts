import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'

/**
 * ClassPik's own accounts. These are OUR users, not school logins: nothing in
 * this file is ever sent to an SIS, and nothing here is importable from
 * `src/adapters`, so the "there is nowhere to put a school password" guarantee
 * in the README still holds.
 *
 * Nothing here touches a database or a socket, so the whole policy is testable
 * on its own. Storage lives in the repo, HTTP lives in the server.
 *
 * The KDF is async, and that is not a style preference. `scryptSync` holds the
 * event loop for the whole ~40ms of the hash, and it is reachable from the
 * unauthenticated login and signup routes, so a few dozen concurrent requests
 * for addresses that do not even exist stall polling, notification dispatch and
 * every other route in this single-process service.
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
 * libuv runs four threadpool threads by default, so five concurrent hashes buy
 * nothing but a longer queue. The queue itself is capped because an unbounded
 * one turns a flood of logins into unbounded memory instead of a fast refusal.
 */
const MAX_KDF_IN_FLIGHT = 4
const MAX_KDF_QUEUED = 64

/** Raised when the KDF queue is full. The caller should answer 503, not 401. */
export class KdfBusyError extends Error {
  constructor() {
    super('too many password hashes in flight, try again shortly')
    this.name = 'KdfBusyError'
  }
}

let kdfActive = 0
const kdfWaiters: Array<() => void> = []

async function acquireKdfSlot(): Promise<void> {
  if (kdfActive < MAX_KDF_IN_FLIGHT) {
    kdfActive++
    return
  }
  if (kdfWaiters.length >= MAX_KDF_QUEUED) throw new KdfBusyError()
  await new Promise<void>((resolve) => kdfWaiters.push(resolve))
  // The slot was handed over rather than released, so kdfActive already counts
  // this caller. Decrementing and re-incrementing would leave a window where a
  // fresh caller could push the count past the cap.
}

function releaseKdfSlot(): void {
  const next = kdfWaiters.shift()
  if (next) next()
  else kdfActive--
}

/**
 * Encoded as `scrypt$N$r$p$salt$key`, all base64. The parameters travel with
 * the hash so they can be raised later without a flag day: old rows keep
 * verifying against the parameters they were written with.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES)
  const key = await derive(password, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P)
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
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
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
    actual = await derive(password, salt, n, r, p)
  } catch (err) {
    // A full KDF queue is a load signal, not a wrong password, so it has to
    // travel rather than be flattened into "incorrect".
    if (err instanceof KdfBusyError) throw err
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
let decoyHash: Promise<string> | null = null
export async function burnPasswordWork(password: string): Promise<void> {
  // Held as the promise rather than the resolved string so two concurrent
  // unknown-email logins share one decoy instead of racing to build two.
  decoyHash ??= hashPassword(randomBytes(24).toString('base64'))
  await verifyPassword(password, await decoyHash)
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
  return sha256Hex(token)
}

/**
 * What consuming a recovery token buys. Two errands, one mechanism.
 *
 * The purpose is always part of the lookup rather than something read off a row
 * and trusted afterwards. Otherwise the 24 hour verification link mailed to an
 * address at signup would also be a password reset for that account, which is a
 * strictly longer-lived and strictly more powerful secret than the one hour
 * reset flow deliberately issues.
 */
export type TokenPurpose = 'verify_email' | 'reset_password'

/**
 * A day, because a verification mail lands in a phone at 2 AM and gets opened
 * on a laptop the next evening, and an expired link there means a support
 * request rather than a locked account.
 */
export const EMAIL_VERIFY_TTL_MS = 24 * 60 * 60 * 1000

/**
 * An hour, and deliberately far shorter than verification's day. This token is
 * a live password: whoever holds it owns the account until it is consumed. The
 * legitimate user reads their mail and clicks within minutes; the exposure a
 * longer window buys is a forwarded mailbox, a shared machine, or a mail
 * archive holding an account takeover for a day.
 */
export const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000

/**
 * The same 256 random bits a session token carries, and opaque for the same
 * reason. Base64url specifically, so it survives being pasted into a URL query
 * string and back out of one without any encoding step in between deciding to
 * mangle a `+` into a space.
 */
export function mintRecoveryToken(): string {
  return randomBytes(32).toString('base64url')
}

/**
 * Stored hashed, exactly like a session token. A recovery token in the clear in
 * the database is a password reset for every account in it, so the row is worth
 * nothing to whoever steals the file: they can see that a reset was requested,
 * never perform one.
 *
 * Separate from `hashSessionToken` despite the identical body, because these are
 * different secrets in different tables and collapsing them would make a future
 * change to one silently a change to the other.
 */
export function hashRecoveryToken(token: string): string {
  return sha256Hex(token)
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
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

/**
 * The callback form, which runs on the libuv threadpool, behind a slot so the
 * pool cannot be swamped. `scryptSync` would do the same work on the event loop
 * thread and stop the poller for its whole duration.
 */
async function derive(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  await acquireKdfSlot()
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      scrypt(
        password,
        salt,
        KEY_BYTES,
        { N: n, r, p, maxmem: Math.max(SCRYPT_MAXMEM, 128 * n * r * 2) },
        (err, key) => (err ? reject(err) : resolve(key))
      )
    })
  } finally {
    releaseKdfSlot()
  }
}
