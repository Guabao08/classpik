import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { preferencesOf, type AuthTokenRow, type Repo, type SectionRow, type SessionRow, type UserPreferences, type UserRow } from '../core/repo.js'
import { parseLevels } from '../core/levels.js'
import type { Poller } from '../core/poller.js'
import type { SubjectDiscovery } from '../core/discovery.js'
import { assertWebhookUrl, type Dispatcher } from '../core/notify.js'
import { RateLimiter } from '../core/ratelimit.js'
import { assertMailbox } from '../core/mime.js'
import {
  bearerToken,
  burnPasswordWork,
  EMAIL_VERIFY_TTL_MS,
  hashPassword,
  hashRecoveryToken,
  hashSessionToken,
  KdfBusyError,
  lockoutMsFor,
  looksLikeEmail,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  mintRecoveryToken,
  mintSessionToken,
  normalizeEmail,
  PASSWORD_RESET_TTL_MS,
  SESSION_TTL_MS,
  verifyPassword,
  type TokenPurpose,
} from '../core/auth.js'
import type { AccountMail, AccountMailKind } from '../core/accountmail.js'

/**
 * REST API over node:http. No framework, because the whole surface is a dozen
 * routes and a dependency we do not take is a dependency we do not patch.
 */

export interface RateLimitConfig {
  /** Login and signup attempts per source address per minute. */
  authPerMinute?: number
  /** Accounts one source address may create per hour. */
  signupsPerHour?: number
  /** Floor on the gap between two forced poll cycles, whoever asks. */
  pollMinIntervalMs?: number
  /** Subjects one source address may seed per hour. Each one buys an upstream fetch. */
  seedsPerHour?: number
  /** Verification and reset links one source address may ask for per hour. */
  recoveryPerHour?: number
  /**
   * Links one ACCOUNT may be mailed per hour FROM ONE SOURCE ADDRESS. The
   * address belongs to a student who did not necessarily ask for any of them,
   * so this is a limit on what we do to a stranger's inbox rather than on what
   * a caller may do to us. Exceeding it is silent: see the reset request route.
   *
   * Keyed on the source as well as the account because a cap on the account
   * alone is a denial of recovery: five requests an hour from a cron drained a
   * named victim's whole allowance, and the victim asking from their own
   * machine then got the same confident 202 and no link, forever.
   */
  recoveryPerAccountPerHour?: number
  /**
   * The mail-bomb ceiling: links one ACCOUNT may be mailed per hour from ALL
   * sources together. Deliberately looser than the per-source cap above, since
   * its job is bounding what lands in a stranger's inbox rather than deciding
   * whether any one caller is being reasonable.
   */
  recoveryPerAccountTotalPerHour?: number
}

export interface ApiDeps {
  repo: Repo
  poller?: Poller
  dispatcher?: Dispatcher
  /** Enables the subject catalogue routes. Absent means browsing cannot seed. */
  discovery?: SubjectDiscovery
  /**
   * How a verification or reset link reaches a student. Always wired by
   * `index.ts`, with or without a mail provider behind it, because a service
   * that cannot issue a reset link is a service where a forgotten password
   * means a new account.
   */
  accountMail?: AccountMail
  /** Allowed browser origins. Empty means same-origin only. */
  corsOrigins?: string[]
  /**
   * Shared secret for the operator-only routes. Unset disables them outright:
   * forcing a poll fans out to a registrar, so "has an account" is not the bar.
   */
  adminToken?: string | null
  /** Development only. Lets a watch point at a webhook on loopback. */
  allowPrivateWebhooks?: boolean
  /**
   * The header a TRUSTED proxy writes the real client address into, e.g.
   * `Fly-Client-IP` or `X-Forwarded-For`. Unset means the socket address, which
   * is correct only when this process is the thing clients connect to. Behind a
   * proxy, leaving it unset collapses every per-address rate limit into one
   * global bucket, because every request then arrives from the proxy. Opt-in
   * rather than automatic: a header any client can write is a rate limit any
   * client can walk around, so this is only safe once something in front of us
   * is known to overwrite it.
   */
  clientIpHeader?: string | null
  rateLimit?: RateLimitConfig
  /** Injectable so tests can move time without sleeping. */
  now?: () => number
}

interface Limits {
  auth: RateLimiter
  signup: RateLimiter
  seed: RateLimiter
  recovery: RateLimiter
  /** Keyed on `${userId}|${purpose}|${sourceAddress}`. See `issueRecovery`. */
  recoveryPerAccount: RateLimiter
  recoveryPerAccountTotalPerHour: number
  pollMinIntervalMs: number
  lastPollAt: number
}

/** What a handler actually receives: the deps plus whoever is making the call. */
type Ctx = ApiDeps & {
  now: () => number
  user: UserRow | null
  session: SessionRow | null
  limits: Limits
  clientIp: string
}

/**
 * `public` is opt-in. A route added later without thinking about it is
 * protected, which is the only default that fails in the safe direction.
 */
type Access = 'public' | 'private'

type Handler = (
  ctx: Ctx,
  req: IncomingMessage,
  url: URL,
  body: unknown
) => Promise<{ status: number; body: unknown }> | { status: number; body: unknown }

interface Route {
  method: string
  pattern: RegExp
  handler: Handler
  params: string[]
  access: Access
}

const routes: Route[] = []

function route(method: string, path: string, handler: Handler, access: Access = 'private'): void {
  const params: string[] = []
  const pattern = new RegExp(
    '^' +
      path.replace(/:[a-zA-Z]+/g, (m) => {
        params.push(m.slice(1))
        return '([^/]+)'
      }) +
      '$'
  )
  routes.push({ method, pattern, handler, params, access })
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

/**
 * The authenticated account. Asserting rather than checking would be fine,
 * since `handle` 401s a private route before dispatch, but a stray `public` on
 * a handler that reads user data should fail closed rather than crash.
 */
function principal(ctx: Ctx): UserRow {
  if (!ctx.user) throw new HttpError(401, 'authentication required')
  return ctx.user
}

// ------------------------------------------------------------------- routes

route('GET', '/health', () => ({ status: 200, body: { ok: true } }), 'public')

route(
  'GET',
  '/api/stats',
  ({ repo, dispatcher, accountMail }) => ({
    // Channels are advertised so a client can offer email only where the server
    // can actually send it, instead of finding out from a rejected watch.
    status: 200,
    body: {
      ...repo.stats(),
      channels: dispatcher?.channels ?? [],
      // A separate fact from `channels`, which is about seat alerts. This one
      // says whether a verification or reset link reaches a mailbox at all. With
      // no provider configured the link is printed to the operator's log, and
      // the recovery screens used to say "check your email" anyway, which is how
      // a student who cannot sign in ends up creating a second account. The UI
      // can only tell them the truth if it can see this.
      accountMail: accountMail?.enabled ?? false,
    },
  }),
  'public'
)

route(
  'GET',
  '/api/schools',
  ({ repo }) => ({
    status: 200,
    body: repo.listSchools().map((s) => ({
      id: s.id,
      name: s.name,
      sis: s.sis,
      enabled: s.enabled,
      subjects: s.subjects,
      terms: repo.listTerms(s.id),
    })),
  }),
  'public'
)

/**
 * The browsable subject catalogue for one school and term.
 *
 * `seeded` is the honest signal a client needs: false means we know the subject
 * exists and nothing has ever asked the registrar what is in it, so its sections
 * are not searchable yet and a seed is what changes that. It covers both routes
 * to a poll target, the config's own subject list and an on-demand browse, since
 * from a student's point of view they are the same fact. Public, because reading
 * the catalogue costs nothing upstream. Seeding is not.
 */
route(
  'GET',
  '/api/subjects',
  ({ repo }, _req, url) => {
    const schoolId = url.searchParams.get('school')
    if (!schoolId) throw new HttpError(400, 'missing required parameter "school"')
    if (!repo.getSchool(schoolId)) throw new HttpError(404, `no school ${schoolId}`)
    const term = url.searchParams.get('term') ?? undefined

    const subjects = repo.listSubjects(schoolId, term)
    return {
      status: 200,
      body: {
        count: subjects.length,
        subjects: subjects.map((s) => ({
          school: s.school_id,
          term: s.term,
          code: s.code,
          description: s.description,
          // Either route to a poll target counts. A school onboarded from its
          // config list has never set seeded_at, and reporting those subjects
          // as unfetched told a client to buy a fetch it already has.
          seeded: s.seeded_at !== null || s.has_target === 1,
        })),
      },
    }
  },
  'public'
)

/**
 * Buy one subject its first fetch, which is what makes its sections watchable.
 *
 * This is the answer to the bootstrap problem discovery creates: a watch names
 * a section, sections only exist after a fetch, and we refuse to fetch subjects
 * nobody wants. Browsing is the demand signal, and it is bounded by how many
 * subjects a person opens rather than by how large the catalogue is.
 *
 * Three gates, and each one is load-bearing:
 *
 *  - It takes an account. Not because reading the catalogue is private, but
 *    because this is the only route below the operator gate that turns into a
 *    request at a registrar, and "signed in" plus a per-address budget is a
 *    real cost to walking two hundred subjects.
 *  - It only acts on a subject the school actually publishes. Otherwise it is
 *    an open instruction to make our server go and fetch things.
 *  - It queues, it does not fetch. The poll loop performs the request on its
 *    next tick under the same rate limiting as everything else, rather than an
 *    HTTP handler firing at a university while a student holds the connection.
 */
route('POST', '/api/subjects/seed', (ctx, _req, _url, body) => {
  principal(ctx)
  const { discovery } = ctx
  if (!discovery) throw new HttpError(503, 'subject discovery is not enabled on this server')

  const b = asObject(body)
  const schoolId = required(str(b.school), 'school')
  const term = required(str(b.term), 'term')
  const subject = required(str(b.subject), 'subject')

  if (!ctx.limits.seed.take(ctx.clientIp, ctx.now())) {
    const seconds = ctx.limits.seed.retryAfterSeconds(ctx.clientIp, ctx.now())
    throw new HttpError(429, `too many subjects opened from here, try again in ${seconds}s`)
  }

  const outcome = discovery.seed(schoolId, term, subject)
  if (outcome === 'unknown') {
    throw new HttpError(404, `${schoolId} does not publish subject "${subject}" in term ${term}`)
  }
  // 202 rather than 201: the sections do not exist yet, and saying they do
  // would have the client poll a URL that stays empty for a cycle.
  return {
    status: outcome === 'queued' ? 202 : 200,
    body: {
      school: schoolId,
      term,
      subject: subject.toUpperCase(),
      status: outcome,
      sections: ctx.repo.searchSections({ schoolId, term, subject, limit: 1 }).length,
    },
  }
})

// ------------------------------------------------------------------- accounts

/**
 * Signup logs you in, because a client that has to immediately turn around and
 * POST /login for the account it just created is a client that will get that
 * second call wrong.
 */
route(
  'POST',
  '/api/auth/signup',
  async (ctx, req, _url, body) => {
    const { repo } = ctx
    spendAuthAttempt(ctx)
    const b = asObject(body)
    const email = required(str(b.email), 'email')
    const password = required(str(b.password), 'password')

    if (!looksLikeEmail(email)) throw new HttpError(400, 'that does not look like an email address')
    assertPasswordLength(password)

    // Where this student is shopping, chosen here and changeable later. Read
    // and validated before the password is hashed, so a malformed school id
    // costs a 400 rather than a scrypt run and a half-configured account.
    const prefs = readPreferences(ctx, b, NO_PREFERENCES)

    // Account creation is free work we do on a stranger's behalf, and every
    // account is a key to the authenticated routes, so it gets its own slower
    // budget on top of the shared auth one.
    if (!ctx.limits.signup.take(ctx.clientIp, ctx.now())) {
      throw new HttpError(429, 'too many accounts created from here, try again later')
    }

    const user = repo.createUser({
      email,
      emailNorm: normalizeEmail(email),
      passwordHash: await hashPassword(password),
      schoolId: prefs.schoolId ?? null,
      term: prefs.term ?? null,
      levels: prefs.levels ?? [],
    })
    // Signup is the one place where confirming an address is already taken is
    // unavoidable, since the alternative is silently not creating an account.
    if (!user) throw new HttpError(409, 'that email already has an account')

    // Started, not awaited, and best effort either way. The account exists and
    // the session in the response below is real, so a provider taking fifteen
    // seconds must not make signup take fifteen seconds, and a provider having a
    // bad minute must not turn a created account into a 500 that tells the
    // student they have none. The token row is written before the first await,
    // so the link is valid the instant it goes out.
    // `POST /api/auth/verify/request` is the retry, and it is one click.
    void offerVerification(ctx, user)

    return { status: 201, body: issueSession(ctx, req, user) }
  },
  'public'
)

// -------------------------------------------------------- account recovery

/**
 * Resend the verification link, for the student who deleted it or never got it.
 *
 * Authenticated, because the address it mails is the one on the session and
 * there is nothing here for a stranger to aim. Rate limited twice over anyway:
 * per source address, which is what stops a script, and per account, which is
 * what stops one address being mailed two hundred times by someone who signed
 * up as it.
 */
route('POST', '/api/auth/verify/request', async (ctx) => {
  const user = principal(ctx)
  spendRecoveryAttempt(ctx)

  if (user.email_verified_at !== null) {
    // Not an error. A second tab, a double click, or a link opened on the phone
    // while the laptop still shows the button all land here, and telling
    // somebody their address is already confirmed is the useful answer.
    return { status: 200, body: { ok: true, verified: true, sent: false } }
  }

  const sent = await offerVerification(ctx, user)
  return { status: 200, body: { ok: true, verified: false, sent } }
})

/**
 * Consume a verification link.
 *
 * Public, because the person opening it is on whatever device their mail is on
 * and may never have signed in there. The token is the whole credential, which
 * is exactly why it is 256 random bits, single use and 24 hours old at most.
 */
route(
  'POST',
  '/api/auth/verify',
  (ctx, _req, _url, body) => {
    spendAuthAttempt(ctx)
    const token = required(str(asObject(body).token), 'token')
    const consumed = consumeFor(ctx, token, 'verify_email')

    const user = ctx.repo.getUser(consumed.user_id)
    if (!user) throw new HttpError(400, VERIFY_REFUSAL)
    // The token proves control of the mailbox it was sent to, and of nothing
    // else. An address changed between issuing and opening the link is a
    // different mailbox, so the proof does not travel with the account.
    if (consumed.email_norm !== user.email_norm) throw new HttpError(400, VERIFY_REFUSAL)

    ctx.repo.markEmailVerified(user.id, ctx.now())
    return { status: 200, body: { ok: true, email: user.email } }
  },
  'public'
)

/**
 * Ask for a password reset link.
 *
 * The one rule that matters here: **this route answers identically whether or
 * not the address has an account.** Same status, same body, and the same
 * latency, because all three are oracles. `POST /api/auth/login` already goes to
 * the trouble of burning scrypt time on an unknown address so that its timing
 * matches, and there is a test pinning it; an enumeration hole here would undo
 * that work with one endpoint that needs no password at all.
 *
 * So three things are true of the code below, and each is load-bearing:
 *
 *  - Nothing about the outcome reaches the response. The body is a constant.
 *  - NO work whose existence depends on the lookup happens before the response
 *    is written. Not awaiting the send is not enough on its own: an async
 *    function body runs synchronously up to its first await, and the first await
 *    inside `issueRecovery` is the send itself, so the budget check, the
 *    randomBytes and the INSERT all used to land on the response path. Measured
 *    against 5000 rows that was a deterministic sub-millisecond difference
 *    between the two branches, which a few dozen samples separate cleanly. The
 *    whole call therefore goes behind `setImmediate`.
 *  - The per-account throttle is silent. Answering 429 to the sixth request for
 *    a real address, and 202 to the sixth for a fictional one, is the same
 *    oracle wearing a status code. Only the per-source-address limit is allowed
 *    to speak, and that one does not depend on which address was named.
 *
 * The silence has a cost, and it is a real one rather than a free win: a caller
 * cannot tell a throttled request from a delivered one, so a student whose
 * allowance somebody else has drained gets a confident 202 and no mail, with no
 * way to tell that from a delivery problem. That is why the tight budget in
 * `issueRecovery` is keyed on the source address as well as the account. See
 * the note there for what each half of that budget is for.
 *
 * The deferral costs the exactness of the per-account budget: two simultaneous
 * requests can both read the token count before either writes a row, so the
 * ceiling is approximate. That is the right trade. An off-by-one on how many
 * links reach a mailbox in an hour is a nuisance; an enumeration oracle over
 * which addresses at a university have accounts is the thing this route exists
 * to prevent.
 */
route(
  'POST',
  '/api/auth/reset/request',
  (ctx, _req, _url, body) => {
    spendRecoveryAttempt(ctx)
    const email = required(str(asObject(body).email), 'email')

    const user = looksLikeEmail(email) ? ctx.repo.findUserByEmail(normalizeEmail(email)) : null
    if (user) {
      // Deferred a whole turn of the event loop, not merely un-awaited, and the
      // rejection is swallowed rather than logged with the address attached. See
      // the note above: what we know about this address is the thing the
      // endpoint exists not to disclose, and that includes how long we took.
      setImmediate(() => {
        void issueRecovery(ctx, user, 'reset_password').catch(() => {})
      })
    }

    return { status: 202, body: { ok: true, message: RESET_REQUESTED } }
  },
  'public'
)

/**
 * Consume a reset link and set a new password.
 *
 * Every live session dies with the old password. A reset is what somebody does
 * after losing control of their account, and a reset that leaves the intruder's
 * thirty-day bearer token working has changed nothing they would notice.
 */
route(
  'POST',
  '/api/auth/reset',
  async (ctx, _req, _url, body) => {
    spendAuthAttempt(ctx)
    const b = asObject(body)
    const token = required(str(b.token), 'token')
    const password = required(str(b.password), 'password')
    assertPasswordLength(password)

    // Hashed BEFORE the link is spent, never after.
    //
    // `hashPassword` throws KdfBusyError once the KDF queue is full, and that
    // queue is reachable from the unauthenticated login route by design, so a
    // burst of logins used to turn any reset landing in the same window into a
    // 503 with `consumed_at` already set: a dead link, an unchanged password,
    // and five such collisions exhausting the account's whole hourly allowance.
    // Hashing first makes consume-then-write the last thing that can fail.
    //
    // It costs nothing new. The work is bounded above by assertPasswordLength
    // and by spendAuthAttempt, and it is exactly the scrypt time
    // POST /api/auth/login already pays for an address it has never seen.
    const passwordHash = await hashPassword(password)

    const consumed = consumeFor(ctx, token, 'reset_password')
    const user = ctx.repo.getUser(consumed.user_id)
    if (!user) throw new HttpError(400, RESET_REFUSAL)
    // As on verification: the link is proof about the mailbox it was mailed to.
    if (consumed.email_norm !== user.email_norm) throw new HttpError(400, RESET_REFUSAL)

    ctx.repo.completePasswordReset(user.id, passwordHash, ctx.now())
    // No session in the response. Signing in with the password they have just
    // chosen is one step, and it is the step that proves the reset worked; a
    // token handed back here would instead be the second thing in this flow
    // that grants access without one.
    return { status: 200, body: { ok: true } }
  },
  'public'
)

/**
 * Change the password of an account somebody is signed in to.
 *
 * The current password is required even though the session already
 * authenticates the caller, because those authenticate different things. The
 * session says this browser was signed in at some point; the password says the
 * person at the keyboard right now is the account holder. A borrowed laptop or
 * a stolen token should not be enough to lock the owner out of their own
 * account.
 *
 * Every OTHER session is revoked and the caller keeps theirs. That is the whole
 * point of the route: it is how a leaked token becomes recoverable in one
 * request, rather than by waiting out a thirty day TTL on a session you have no
 * way to name.
 */
route('POST', '/api/auth/password', async (ctx, _req, _url, body) => {
  const user = principal(ctx)
  const session = ctx.session
  if (!session) throw new HttpError(401, 'authentication required')

  const b = asObject(body)
  const current = required(str(b.currentPassword), 'currentPassword')
  const next = required(str(b.password), 'password')
  assertPasswordLength(next)

  // Spent on the way in, not only on failure. This route runs two scrypt hashes
  // and is reachable with one stolen token, so the budget is what stops it being
  // a way to spend the KDF pool.
  spendAuthAttempt(ctx)

  if (!(await verifyPassword(current, user.password_hash))) {
    // No lockout counter here. This route needs a live session, so it is not a
    // path a stranger can walk from an address alone, and incrementing the same
    // counter the login route reads would let a borrowed tab lock its owner out.
    throw new HttpError(403, 'that is not your current password')
  }

  const revoked = ctx.repo.completePasswordChange(
    user.id,
    await hashPassword(next),
    session.token_hash,
    ctx.now()
  )
  return { status: 200, body: { ok: true, sessionsRevoked: revoked } }
})

/**
 * One answer for every way a login can fail.
 *
 * An unknown address, a wrong password and a locked account all return this,
 * with the same status and the same message, and all three pay the same scrypt
 * time. The lockout used to answer 429 only when the account existed, which
 * turned six requests per address into a bulk account-existence oracle over a
 * leaked campus list. The single exception is below: a caller who supplied the
 * correct password has already proved the account is theirs, so telling them
 * they are throttled discloses nothing.
 */
const LOGIN_REFUSAL = 'email or password is incorrect'

route(
  'POST',
  '/api/auth/login',
  async (ctx, req, _url, body) => {
    const { repo, now } = ctx
    spendAuthAttempt(ctx)
    const b = asObject(body)
    const email = required(str(b.email), 'email')
    const password = required(str(b.password), 'password')

    const user = repo.findUserByEmail(normalizeEmail(email))
    if (!user) {
      // Same message and roughly the same latency as a wrong password, so the
      // endpoint cannot be used to find out which addresses have accounts.
      await burnPasswordWork(password)
      throw new HttpError(401, LOGIN_REFUSAL)
    }

    const at = now()
    const locked = user.locked_until !== null && user.locked_until > at
    if (locked) {
      // The password is still checked, for two reasons: the timing has to match
      // the unknown-email branch above, and a correct password is what earns
      // the honest 429 instead of this one.
      if (await verifyPassword(password, user.password_hash)) {
        const seconds = Math.ceil((user.locked_until! - at) / 1000)
        throw new HttpError(429, `too many failed attempts, try again in ${seconds}s`)
      }
      throw new HttpError(401, LOGIN_REFUSAL)
    }

    // A lockout that has elapsed clears the counter as well as the lock.
    // Leaving it standing let the escalation ratchet across windows until it
    // reached the one hour cap and stayed there, which hands a stranger a
    // permanent denial of service against any address they can name.
    if (user.locked_until !== null) repo.resetLoginFailures(user.id)

    if (!(await verifyPassword(password, user.password_hash))) {
      const failures = repo.countLoginFailure(user.id)
      const lockMs = lockoutMsFor(failures)
      if (lockMs > 0) repo.lockUser(user.id, at + lockMs)
      throw new HttpError(401, LOGIN_REFUSAL)
    }

    repo.recordLoginSuccess(user.id, at)
    return { status: 200, body: issueSession(ctx, req, user) }
  },
  'public'
)

/** Revokes only the presented session, so signing out of a laptop leaves a phone signed in. */
route('POST', '/api/auth/logout', (ctx) => {
  const session = ctx.session
  if (session) ctx.repo.revokeSession(session.token_hash, ctx.now())
  return { status: 200, body: { ok: true } }
})

route('GET', '/api/auth/me', (ctx) => {
  const user = principal(ctx)
  return { status: 200, body: { user: toUserDto(user) } }
})

/**
 * Change the school, term and levels this account searches in.
 *
 * A patch rather than a replacement: sending only `levels` moves the levels and
 * leaves the school alone. Clearing a field is `null`, which is how a student
 * says "show me everything" rather than "leave it as it was".
 *
 * Nothing here touches the watchlist. A transfer student changes school on
 * Monday and every watch they hold at the old one is still theirs on Tuesday.
 */
route('POST', '/api/auth/preferences', (ctx, _req, _url, body) => {
  const user = principal(ctx)
  const patch = readPreferences(ctx, asObject(body), preferencesOf(user))
  const updated = ctx.repo.setUserPreferences(user.id, patch)
  if (!updated) throw new HttpError(404, 'no such account')
  return { status: 200, body: { user: toUserDto(updated) } }
})

// -------------------------------------------------------------------- catalog

/**
 * Catalog search, scoped to one school, one term and a set of academic levels.
 *
 * For a signed-in student the scope defaults to their own account. That is a
 * default, not a suggestion: an undergraduate who searches sees undergraduate
 * classes at their own school in their own term, and widening past that is
 * something they do, by naming a school or ticking another level. Without it,
 * the first day a second university is configured, "Find classes" becomes two
 * universities' catalogs shuffled together, and no query a student can type
 * separates them.
 *
 * Still public, because reading a catalog needs no account. A caller with no
 * session gets everything, exactly as before.
 */
route('GET', '/api/sections', (ctx, _req, url) => {
  const { repo } = ctx
  const limit = clampInt(url.searchParams.get('limit'), 1, 500, 100)
  const status = url.searchParams.get('status')
  if (status && !['open', 'waitlist', 'full'].includes(status)) {
    throw new HttpError(400, 'status must be one of open, waitlist, full')
  }

  const prefs = ctx.user ? preferencesOf(ctx.user) : NO_PREFERENCES
  const school = chosen(scopeParam(url, 'school'), prefs.schoolId)
  // The account's term and levels are dropped when the search has been pointed
  // at a school other than the account's own. Both codes are
  // institution-defined: 1232 is Spring 2023 at one school and nothing at all
  // at the next, and UGRD at a PeopleSoft school is UG at a Banner one. Carried
  // across, they filter the other school's catalog on codes that do not exist
  // there, which returns almost nothing and reads as a school we failed to load
  // rather than as a filter.
  //
  // An account that named levels but no school is not that case. It asked for
  // undergraduate classes wherever they are, so the levels still apply.
  const elsewhere = prefs.schoolId !== null && school !== prefs.schoolId
  const defaults = elsewhere ? NO_PREFERENCES : prefs
  const term = chosen(scopeParam(url, 'term'), defaults.term)
  const levels = chosen(levelParam(url), defaults.levels) ?? []

  const sections = repo.searchSections({
    schoolId: school ?? undefined,
    term: term ?? undefined,
    subject: url.searchParams.get('subject') ?? undefined,
    levels,
    query: url.searchParams.get('q') ?? undefined,
    status: (status as 'open' | 'waitlist' | 'full' | null) ?? undefined,
    limit,
  })
  return {
    status: 200,
    body: {
      count: sections.length,
      // Reported back so a client can say "undergraduate classes at Demo
      // University" and offer a way out of it. A filter the user cannot see is
      // indistinguishable from a catalog that is missing classes.
      scope: { school, term, levels },
      sections: sections.map(toSectionDto),
    },
  }
}, 'public')

/**
 * The academic levels a school's catalog actually contains, which is where a
 * client gets the boxes to tick. Read off the sections we hold rather than from
 * a list in our code, because the codes are per institution: UG and GR at one
 * Banner school, UGRD, GRAD and LAW at a PeopleSoft one.
 */
route(
  'GET',
  '/api/levels',
  ({ repo }, _req, url) => {
    const schoolId = required(str(url.searchParams.get('school')), 'school')
    if (!repo.getSchool(schoolId)) throw new HttpError(404, `no school ${schoolId}`)
    const term = str(url.searchParams.get('term')) ?? undefined
    const levels = repo.listLevels(schoolId, term)
    return { status: 200, body: { school: schoolId, term: term ?? null, levels } }
  },
  'public'
)

route(
  'GET',
  '/api/sections/:id',
  ({ repo }, _req, url) => {
    const id = decodeURIComponent(url.pathname.split('/').pop()!)
    const section = repo.getSection(id)
    if (!section) throw new HttpError(404, `no section ${id}`)
    return {
      status: 200,
      body: {
        section: toSectionDto(section),
        events: repo.listEvents({ sectionId: id, limit: 50 }),
      },
    }
  },
  'public'
)

// --------------------------------------------------------------------- watches

route('GET', '/api/watches', (ctx) => {
  const { repo } = ctx
  const user = principal(ctx)
  return {
    status: 200,
    body: {
      watches: repo.listWatches(user.id).map((w) => ({
        id: w.id,
        mode: w.mode,
        channel: w.channel,
        target: w.target,
        createdAt: w.created_at,
        lastNotifiedAt: w.last_notified_at,
        section: toSectionDto(w.section),
      })),
    },
  }
})

route('POST', '/api/watches', (ctx, _req, _url, body) => {
  const { repo } = ctx
  const user = principal(ctx)
  const b = asObject(body)
  const sectionId = required(str(b.sectionId), 'sectionId')

  const section = repo.getSection(sectionId)
  if (!section) throw new HttpError(404, `no section ${sectionId}`)

  const mode = str(b.mode) ?? 'notify'
  if (mode !== 'notify' && mode !== 'claim') {
    throw new HttpError(400, 'mode must be "notify" or "claim"')
  }
  const channel = str(b.channel) ?? 'console'
  const requested = str(b.target)
  // An email watch goes to the address on the account, and only there.
  const target = channel === 'email' ? user.email : requested
  if (channel === 'webhook' && !target) {
    throw new HttpError(400, 'channel "webhook" requires a target URL')
  }
  if (channel === 'webhook') {
    // Validated here rather than only at send time, so a target we will never
    // POST to is a 400 the caller can act on instead of a notification that
    // sits in the queue failing. This is also the SSRF gate: the server is the
    // one making the request, and loopback and RFC1918 are reachable from it.
    try {
      assertWebhookUrl(target!, ctx.allowPrivateWebhooks ?? false)
    } catch (err) {
      throw new HttpError(400, err instanceof Error ? err.message : 'invalid webhook URL')
    }
  }
  if (channel === 'email') {
    // Refused up front rather than queued: without a transport the notification
    // would sit in the queue retrying a channel nobody is listening on, and the
    // student would never learn that.
    if (!ctx.dispatcher?.supports('email')) {
      throw new HttpError(400, 'email delivery is not configured on this server')
    }
    // A caller-supplied address made this endpoint a mail bomb: any account
    // could aim every seat change on any section at a stranger, from our own
    // sending domain, with no way for the stranger to stop it. An address is
    // only usable once the account has proved it controls it, and the only such
    // address today is the one on the account.
    if (requested !== null && normalizeEmail(requested) !== normalizeEmail(user.email)) {
      throw new HttpError(
        403,
        'ClassPik only sends alerts to the address on your account, not to an address you name here'
      )
    }
    try {
      assertMailbox(target!)
    } catch (err) {
      throw new HttpError(400, err instanceof Error ? err.message : 'invalid email address')
    }
    // What being unverified actually costs, and it is the only thing it costs.
    //
    // Signup takes an address on trust, so without this anybody can sign up as
    // somebody else's address and have ClassPik mail alerts to it from our own
    // sending domain, indefinitely, with no route the recipient can use to stop
    // it. That is the same abuse the caller-supplied `target` above was closed
    // for, reached by a different door. Proving the mailbox is what closes it.
    //
    // It is checked after the target rule so that aiming a watch at a stranger
    // still answers the refusal about aiming, which is the more specific fact.
    // Everything else on the account keeps working: an unverified student can
    // search, watch, and read every alert in the app. Only the channel that
    // reaches a mailbox is withheld, because the mailbox is the unproved part.
    if (user.email_verified_at === null) {
      throw new HttpError(
        403,
        'confirm your email address before sending alerts to it; ' +
          'POST /api/auth/verify/request will send the link again'
      )
    }
  }

  const watch = repo.createWatch({ userId: user.id, sectionId, mode, channel, target })
  return {
    status: 201,
    body: { watch: { id: watch.id, mode: watch.mode, channel: watch.channel }, section: toSectionDto(section) },
  }
})

route('DELETE', '/api/watches/:id', (ctx, _req, url) => {
  const { repo } = ctx
  const user = principal(ctx)
  const id = decodeURIComponent(url.pathname.split('/').pop()!)
  const watch = repo.getWatch(id)
  // 404 rather than 403 for someone else's watch. A 403 would confirm the id
  // exists, which turns this endpoint into a free oracle over other people's
  // watchlists for anyone willing to guess ids.
  if (!watch || watch.user_id !== user.id) throw new HttpError(404, `no watch ${id}`)
  repo.deactivateWatch(id)
  return { status: 200, body: { ok: true, id } }
})

route('GET', '/api/events', (ctx, _req, url) => {
  const { repo } = ctx
  const user = principal(ctx)
  const limit = clampInt(url.searchParams.get('limit'), 1, 200, 50)
  // A section's history is already public at /api/sections/:id, so narrowing to
  // one is allowed. Everything else is scoped to the caller's own watches, and
  // the caller is the session, never a query parameter.
  const sectionId = url.searchParams.get('sectionId')
  return {
    status: 200,
    body: {
      events: sectionId
        ? repo.listEventsDetailed({ sectionId, limit })
        : repo.listEventsDetailed({ userId: user.id, limit }),
    },
  }
})

/**
 * Force a poll cycle. Useful in development and for operators.
 *
 * Operator-only, not merely authenticated. A tick fans out to Banner or
 * PeopleSoft with no cooldown, so an account is not the right bar: signup is
 * free, which made "log in, then hammer this" a one-line way for a stranger to
 * get our IP blocked at a registrar, which is the exact outcome this route's
 * old comment claimed to prevent. The interval floor below applies to the
 * operator too, since a shell loop is as good at that as an attacker is.
 */
route(
  'POST',
  '/api/poll',
  async (ctx, req) => {
    requireAdmin(ctx, req)
    const { poller, dispatcher } = ctx
    if (!poller) throw new HttpError(503, 'poller not attached')

    const at = ctx.now()
    const since = at - ctx.limits.lastPollAt
    if (ctx.limits.lastPollAt > 0 && since < ctx.limits.pollMinIntervalMs) {
      throw new HttpError(
        429,
        `a poll ran ${Math.round(since / 1000)}s ago, wait ${Math.ceil(
          (ctx.limits.pollMinIntervalMs - since) / 1000
        )}s`
      )
    }
    ctx.limits.lastPollAt = at

    const result = await poller.tick()
    const sent = dispatcher ? await dispatcher.flush() : null
    return { status: 200, body: { ...result, dispatch: sent } }
  },
  'public'
)

// ------------------------------------------------------------------ plumbing

export function createApi(deps: ApiDeps): Server {
  // One set of buckets per server, held here rather than at module scope so two
  // servers in one test process cannot throttle each other.
  const limits: Limits = {
    auth: new RateLimiter({
      capacity: deps.rateLimit?.authPerMinute ?? 20,
      refillMs: 60_000,
    }),
    signup: new RateLimiter({
      capacity: deps.rateLimit?.signupsPerHour ?? 10,
      refillMs: 60 * 60_000,
    }),
    // A seed is the one authenticated route that turns into an upstream
    // request, so it gets its own budget rather than sharing the auth one.
    // Twenty subjects an hour is far more than a person browsing a catalogue
    // will ever open, and far less than what it takes to walk one.
    seed: new RateLimiter({
      capacity: deps.rateLimit?.seedsPerHour ?? 20,
      refillMs: 60 * 60_000,
    }),
    // Asking us to mail somebody costs a message in a mailbox we do not own, so
    // it gets a slower budget than logging in does. Ten an hour is more than a
    // person who lost a link ever needs and far less than a mail flood.
    recovery: new RateLimiter({
      capacity: deps.rateLimit?.recoveryPerHour ?? 10,
      refillMs: 60 * 60_000,
    }),
    // The tight half of the per-account budget, and the reason it is a bucket
    // rather than a COUNT over auth_tokens: the key carries the source address,
    // and auth_tokens has no column for one. See `issueRecovery`.
    recoveryPerAccount: new RateLimiter({
      capacity: deps.rateLimit?.recoveryPerAccountPerHour ?? 5,
      refillMs: 60 * 60_000,
    }),
    recoveryPerAccountTotalPerHour: deps.rateLimit?.recoveryPerAccountTotalPerHour ?? 20,
    pollMinIntervalMs: deps.rateLimit?.pollMinIntervalMs ?? 30_000,
    lastPollAt: 0,
  }
  return createServer((req, res) => {
    void handle(deps, limits, req, res)
  })
}

async function handle(
  deps: ApiDeps,
  limits: Limits,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const origin = req.headers.origin
  // Both parts go out on every response, before any branch that might return
  // early. Origin, because the CORS header below depends on it and setting Vary
  // only in the allowed branch lets a cache serve one origin a response
  // carrying another origin's Access-Control-Allow-Origin. Authorization,
  // because the credential decides what a response contains: obviously on the
  // private routes, and now on public /api/sections too, whose school, term and
  // level scope defaults to the account. Two students behind one cache must
  // never be handed each other's catalog.
  res.setHeader('Vary', origin ? 'Origin, Authorization' : 'Authorization')
  if (origin && (deps.corsOrigins ?? []).includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS')
    // Authorization matters here: without it every authenticated cross-origin
    // request dies at preflight, and no Node-based test would ever notice
    // because fetch from Node does not preflight.
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204).end()
    return
  }

  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  const match = routes.find((r) => r.method === req.method && r.pattern.test(url.pathname))

  if (!match) {
    send(res, 404, { error: `no route for ${req.method} ${url.pathname}` })
    return
  }

  // Before the body is read, so an unauthenticated POST never gets to spend the
  // 1 MB body budget below.
  const now = deps.now ?? Date.now
  const found = resolvePrincipal(deps, req, now())
  if (!found && match.access === 'private') {
    send(res, 401, { error: 'authentication required' })
    return
  }
  const ctx: Ctx = {
    ...deps,
    now,
    user: found?.user ?? null,
    session: found?.session ?? null,
    limits,
    clientIp: clientIpOf(req, deps.clientIpHeader ?? null),
  }

  let body: unknown = null
  if (req.method === 'POST' || req.method === 'PUT') {
    try {
      body = await readJson(req)
    } catch (err) {
      send(res, 400, { error: err instanceof Error ? err.message : 'invalid JSON body' })
      return
    }
  }

  try {
    const out = await match.handler(ctx, req, url, body)
    send(res, out.status, out.body)
  } catch (err) {
    if (err instanceof HttpError) {
      send(res, err.status, { error: err.message })
      return
    }
    if (err instanceof KdfBusyError) {
      // Shedding load, not refusing a password. 503 says come back, which is
      // true, where a 401 would tell a legitimate user their password is wrong.
      send(res, 503, { error: err.message })
      return
    }
    send(res, 500, { error: err instanceof Error ? err.message : 'internal error' })
  }
}

/**
 * Who to charge a rate limit to.
 *
 * The socket address by default, because a header any client can write is a
 * rate limit any client can walk around by changing one string. But the default
 * deployment in the README puts fly-proxy in front of this, and there every
 * request arrives from the proxy: all five limiters collapse into one global
 * bucket, so twenty login attempts a minute becomes twenty for the entire user
 * base and the tenth reset link in an hour is the last one anybody gets. That
 * failure is invisible from inside the process, which is why it needed saying
 * out loud in the deployment notes rather than only here.
 *
 * So the proxy header is opt-in, by name, through `CLASSPIK_CLIENT_IP_HEADER`.
 * Setting it is a promise that something in front of us overwrites that header
 * on every request; unset behind a proxy is wrong in the direction of throttling
 * real students, and set without a proxy is wrong in the direction of throttling
 * nobody at all.
 */
function clientIpOf(req: IncomingMessage, header: string | null): string {
  const socketAddress = req.socket.remoteAddress ?? 'unknown'
  if (!header) return socketAddress

  const raw = req.headers[header.toLowerCase()]
  const value = Array.isArray(raw) ? raw[0] : raw
  if (!value) return socketAddress

  // The RIGHTMOST entry, not the first. `X-Forwarded-For` is a list each hop
  // appends to, so a caller who sends one of their own gets the proxy's view of
  // them appended after it. Reading the first entry would let any client pick
  // their own bucket key, which is the exact hole that trusting this header
  // usually opens. One trusted hop is assumed, which is what every platform in
  // the deployment notes puts in front of this; a second one needs this to count
  // back further, deliberately, rather than to guess.
  const hops = value.split(',').map((s) => s.trim()).filter((s) => s !== '')
  return hops[hops.length - 1] ?? socketAddress
}

/** Spends one token from the shared login and signup budget for this address. */
function spendAuthAttempt(ctx: Ctx): void {
  if (ctx.limits.auth.take(ctx.clientIp, ctx.now())) return
  const seconds = ctx.limits.auth.retryAfterSeconds(ctx.clientIp, ctx.now())
  throw new HttpError(429, `too many attempts from this address, try again in ${seconds}s`)
}

/**
 * The budget for asking us to mail somebody a link.
 *
 * Separate from the auth budget and slower than it, because the cost of this
 * one lands in a mailbox rather than on our CPU. It depends on the source
 * address and on nothing about the account named, which is what lets the public
 * reset route spend it without answering the question it exists not to answer.
 */
function spendRecoveryAttempt(ctx: Ctx): void {
  if (ctx.limits.recovery.take(ctx.clientIp, ctx.now())) return
  const seconds = ctx.limits.recovery.retryAfterSeconds(ctx.clientIp, ctx.now())
  throw new HttpError(429, `too many link requests from this address, try again in ${seconds}s`)
}

/** One message for every way a link can be refused: unknown, spent, expired, wrong purpose. */
const VERIFY_REFUSAL = 'that verification link is not valid; ask for a new one'
const RESET_REFUSAL = 'that reset link is not valid; ask for a new one'
const RESET_REQUESTED =
  'if that address has a ClassPik account, a reset link is on its way to it'

function assertPasswordLength(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new HttpError(400, `password must be at least ${MIN_PASSWORD_LENGTH} characters`)
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new HttpError(400, `password must be at most ${MAX_PASSWORD_LENGTH} characters`)
  }
}

/**
 * Spend a link, or refuse in the one way every refusal is spelled.
 *
 * A token that never existed, one already used, one that expired and one minted
 * for the other purpose all produce the identical 400. Distinguishing them tells
 * a caller feeding us guesses which of their guesses had the right shape, and
 * "already used" in particular would confirm that an account exists and that
 * somebody recently reset it.
 */
function consumeFor(ctx: Ctx, token: string, purpose: TokenPurpose): AuthTokenRow {
  const consumed = ctx.repo.consumeAuthToken(hashRecoveryToken(token), purpose, ctx.now())
  if (!consumed) {
    throw new HttpError(400, purpose === 'verify_email' ? VERIFY_REFUSAL : RESET_REFUSAL)
  }
  return consumed
}

/**
 * Mint a link and send it, subject to the per-account budget.
 *
 * The budget is on the account rather than on the caller because the harm it
 * prevents lands on the mailbox: without it, one address plus a rotating source
 * address is a way to have ClassPik mail a stranger all afternoon from its own
 * sending domain, which is the same shape as the watch-target mail bomb the
 * README describes closing. Over budget returns false and sends nothing, and
 * every caller treats that exactly as it treats a successful send.
 *
 * It is TWO budgets, and the split is the whole point. A single cap keyed on the
 * account alone made this an indefinite, undetectable denial of recovery: five
 * requests an hour from one cron drained a named victim's allowance forever, and
 * because the reset route is deliberately silent about the throttle the victim
 * got a confident 202, no link, and no way to tell that from a mail problem.
 *
 *  - The TIGHT cap is per (account, errand, source address), and it is what one
 *    caller can spend. A stranger draining it takes nothing from the student
 *    asking from their own machine, who has their own key.
 *  - The LOOSE backstop is per (account, errand), whoever asks, and it is the
 *    mail-bomb ceiling: it bounds what lands in an inbox that never asked for
 *    any of this, which is the harm the original budget was written for.
 *
 * The tight one is a token bucket rather than a COUNT over `auth_tokens`,
 * because the key needs the source address and that table has no column for one.
 * A bucket lives in memory and per process, so several workers each hold their
 * own, which is the same approximation every other limiter here already makes.
 */
async function issueRecovery(ctx: Ctx, user: UserRow, purpose: TokenPurpose): Promise<boolean> {
  const mail = ctx.accountMail
  if (!mail) return false

  const at = ctx.now()
  if (!ctx.limits.recoveryPerAccount.take(`${user.id}|${purpose}|${ctx.clientIp}`, at)) return false
  if (
    ctx.repo.countAuthTokensSince(user.id, purpose, at - 60 * 60_000) >=
    ctx.limits.recoveryPerAccountTotalPerHour
  ) {
    return false
  }

  const token = mintRecoveryToken()
  ctx.repo.createAuthToken({
    userId: user.id,
    purpose,
    // Only the digest is stored, exactly as with a session token, so the table
    // is worth nothing to whoever steals the file.
    tokenHash: hashRecoveryToken(token),
    emailNorm: user.email_norm,
    expiresAt: at + (purpose === 'verify_email' ? EMAIL_VERIFY_TTL_MS : PASSWORD_RESET_TTL_MS),
  })

  const kind: AccountMailKind = purpose === 'verify_email' ? 'verify' : 'reset'
  await mail.send(kind, user.email, token)
  return true
}

/**
 * Try to get a verification link to a newly created or unverified account.
 *
 * Never throws. Signup already succeeded by the time this runs, and a mail
 * provider having a bad minute must not turn a created account into a 500 that
 * tells the student they have none.
 */
async function offerVerification(ctx: Ctx, user: UserRow): Promise<boolean> {
  try {
    return await issueRecovery(ctx, user, 'verify_email')
  } catch {
    // Silently, and without the address: the failure is ours, the retry is one
    // click on /api/auth/verify/request, and a log line naming who signed up
    // when is a record we have no reason to keep.
    return false
  }
}

/**
 * The operator gate. Compared in constant time and length-checked first, since
 * timingSafeEqual throws on a length mismatch and a throw is itself a signal.
 */
function requireAdmin(ctx: Ctx, req: IncomingMessage): void {
  const expected = ctx.adminToken ?? null
  if (expected === null || expected === '') {
    throw new HttpError(403, 'this endpoint is disabled; set CLASSPIK_ADMIN_TOKEN to enable it')
  }
  const raw = req.headers['x-admin-token']
  const offered = Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '')
  const a = Buffer.from(offered, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new HttpError(403, 'this endpoint needs the operator token')
  }
}

/**
 * A garbled, expired, or revoked token is indistinguishable from no token at
 * all. Saying which it was would tell an attacker their guess had the right
 * shape.
 */
function resolvePrincipal(
  deps: ApiDeps,
  req: IncomingMessage,
  at: number
): { user: UserRow; session: SessionRow } | null {
  const token = bearerToken(req.headers.authorization)
  if (!token) return null
  return deps.repo.resolveSession(hashSessionToken(token), at)
}

/** Mints a session and returns the only response body that ever carries the raw token. */
function issueSession(
  ctx: Ctx,
  req: IncomingMessage,
  user: UserRow
): { token: string; expiresAt: number; user: ReturnType<typeof toUserDto> } {
  const token = mintSessionToken()
  const expiresAt = ctx.now() + SESSION_TTL_MS
  ctx.repo.createSession({
    userId: user.id,
    tokenHash: hashSessionToken(token),
    expiresAt,
    userAgent: req.headers['user-agent'] ?? null,
  })
  return { token, expiresAt, user: toUserDto(user) }
}

/** Never includes password_hash, and there is no route that would want it to. */
function toUserDto(u: UserRow) {
  const prefs = preferencesOf(u)
  return {
    id: u.id,
    email: u.email,
    createdAt: u.created_at,
    // Sent because it changes what the account can do, and a UI that cannot see
    // it can only explain the refused email watch after the fact.
    emailVerified: u.email_verified_at !== null,
    // The scope the client will get on search unless it says otherwise, sent
    // so the UI can show it rather than having to guess what the server did.
    school: prefs.schoolId,
    term: prefs.term,
    levels: prefs.levels,
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body, null, 2)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
    // On every response, including the public ones. The signup and login bodies
    // carry the raw bearer token, the authenticated ones carry one account's
    // data, and the catalog is fresher than any intermediary would guess. There
    // is nothing here worth letting a CDN keep.
    'Cache-Control': 'no-store',
  })
  res.end(json)
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > 1_000_000) throw new Error('request body too large')
    chunks.push(chunk as Buffer)
  }
  if (chunks.length === 0) return null
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return null
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('invalid JSON body')
  }
}

export function toSectionDto(s: SectionRow) {
  return {
    id: s.id,
    schoolId: s.school_id,
    term: s.term,
    crn: s.crn,
    code: s.code,
    title: s.title,
    section: s.section,
    subject: s.subject,
    credits: s.credits,
    instructor: s.instructor,
    meetingDays: s.meeting_days,
    meetingTime: s.meeting_time,
    // The registrar's own spelling, never the normalised one. A student
    // recognises "UGRD" because it is what their school prints.
    level: s.level,
    seats: s.seats,
    capacity: s.capacity,
    enrollment: s.enrollment,
    waitlist: s.waitlist,
    waitlistCap: s.waitlist_cap,
    status: s.status,
    lastPolledAt: s.last_polled_at,
    lastChangedAt: s.last_changed_at,
  }
}

/** A signed-out caller has no defaults, so nothing narrows and the whole catalog answers. */
const NO_PREFERENCES: UserPreferences = { schoolId: null, term: null, levels: [] }

/**
 * How a caller says "no scope on this dimension at all", as opposed to naming
 * one. Spelled out rather than left as an empty parameter so that a client
 * building a query string cannot widen a student's search by accident.
 */
const ANY_SCOPE = 'any'

/**
 * One scope parameter, read as three answers rather than two.
 *
 * Absent is `undefined` and means "use the account's own setting", which is
 * what makes an undergraduate's search undergraduate. A value overrides it.
 * `any` is `null` and clears the dimension entirely. Without that third answer
 * a signed-in student could never look outside their own school, which turns a
 * default into a cage, and a transfer student browsing their next school would
 * be the first to hit it.
 */
function scopeParam(url: URL, name: string): string | null | undefined {
  if (!url.searchParams.has(name)) return undefined
  const raw = (url.searchParams.get(name) ?? '').trim()
  if (raw === '' || raw.toLowerCase() === ANY_SCOPE) return null
  return raw
}

/**
 * The same three answers for levels, which arrive as a list: `?level=UGRD&level=GRAD`
 * or `?level=UGRD,GRAD`. Both spellings, because a checkbox group and a
 * hand-written URL each naturally produce one of them.
 */
function levelParam(url: URL): string[] | null | undefined {
  if (!url.searchParams.has('level')) return undefined
  const parts = url.searchParams
    .getAll('level')
    .flatMap((v) => v.split(','))
    .map((v) => v.trim())
    .filter((v) => v !== '')
  if (parts.length === 0 || parts.some((p) => p.toLowerCase() === ANY_SCOPE)) return null
  return parts
}

/** Absent means fall back to the account. Cleared means cleared, and is not a fallback. */
function chosen<T>(explicit: T | null | undefined, fallback: T | null): T | null {
  return explicit === undefined ? fallback : explicit
}

/**
 * Reads a preferences patch off a request body, leaving out what the caller did
 * not mention.
 *
 * `null` clears a field and an absent key leaves it alone, because those are
 * different requests and collapsing them would make "I changed term" quietly
 * drop the levels a student had ticked.
 */
function readPreferences(
  ctx: Ctx,
  b: Record<string, unknown>,
  current: UserPreferences
): { schoolId?: string | null; term?: string | null; levels?: string[] } {
  const patch: { schoolId?: string | null; term?: string | null; levels?: string[] } = {}

  const school = scopeField(b, 'school')
  if (school !== undefined) {
    // A school that does not exist would scope every future search to nothing
    // and look like a catalog that never loaded, so a typo is refused here
    // rather than discovered later as an empty Find classes.
    if (school !== null && !ctx.repo.getSchool(school)) throw new HttpError(400, `no school ${school}`)
    patch.schoolId = school
  }

  const term = scopeField(b, 'term')
  if (term !== undefined) {
    if (term !== null) {
      const schoolId = patch.schoolId ?? current.schoolId
      if (schoolId === null) {
        throw new HttpError(400, 'choose a school before a term, since term codes only mean something inside one')
      }
      const known = ctx.repo.listTerms(schoolId)
      // A school whose terms have not been discovered yet cannot validate one,
      // and refusing every term there would lock its students out of choosing
      // at all. Once we know the terms, a code that is not among them is a
      // typo worth catching.
      if (known.length > 0 && !known.some((t) => t.code === term)) {
        throw new HttpError(400, `${schoolId} has no term ${term}`)
      }
    }
    patch.term = term
  }

  /**
   * A move to a different named school. Clearing the school to null is
   * deliberately not one, exactly as in `GET /api/sections`: an account with
   * levels and no school asked for undergraduate classes wherever they are.
   */
  const moved =
    patch.schoolId !== undefined &&
    patch.schoolId !== null &&
    patch.schoolId !== current.schoolId

  if (moved && !('term' in b) && current.term !== null) {
    // The stored term is another school's code and 202608 is Fall 2026 at one
    // school and nothing at all at the next. Only dropped where we can prove it
    // is meaningless, though: a school whose terms are not discovered yet
    // proves nothing, and guessing there would clear a term the student may
    // still want once discovery catches up.
    const known = ctx.repo.listTerms(patch.schoolId!)
    if (known.length > 0 && !known.some((t) => t.code === current.term)) patch.term = null
  }

  if ('levels' in b) {
    const raw = b.levels
    if (raw === null) patch.levels = []
    else {
      try {
        patch.levels = parseLevels(raw)
      } catch (err) {
        throw new HttpError(400, err instanceof Error ? err.message : 'invalid levels')
      }
    }
  } else if (moved) {
    // Moving school with nothing said about levels clears them, for the same
    // reason `GET /api/sections` drops them when a search is pointed at another
    // school: the codes are institution-defined, and UGRD at a PeopleSoft
    // school is UG at a Banner one. Carried across, they filter the new
    // school's catalog on a code it has never published, so Find classes comes
    // back empty and reads as a school we failed to load rather than as a
    // filter the student can undo.
    //
    // This used to be defended only on the per-request path, so the guarantee
    // rested on both UI call sites happening to send `levels: null`. A transfer
    // student on any other client, a mobile app or curl, got the empty catalog.
    patch.levels = []
  }

  return patch
}

/** Absent, explicitly cleared, or a non-empty string. Anything else is a 400 rather than a silent skip. */
function scopeField(b: Record<string, unknown>, key: string): string | null | undefined {
  if (!(key in b)) return undefined
  const v = b[key]
  if (v === null) return null
  const s = str(v)
  if (s === null) throw new HttpError(400, `"${key}" must be a non-empty string, or null to clear it`)
  return s
}

function asObject(v: unknown): Record<string, unknown> {
  if (typeof v !== 'object' || v === null) throw new HttpError(400, 'expected a JSON object body')
  return v as Record<string, unknown>
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null
}

function required<T>(v: T | null | undefined, name: string): T {
  if (v === null || v === undefined) throw new HttpError(400, `missing required parameter "${name}"`)
  return v
}

function clampInt(raw: string | null, min: number, max: number, fallback: number): number {
  if (raw === null) return fallback
  const n = Number(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.floor(n)))
}
