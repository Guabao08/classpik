import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { preferencesOf, type Repo, type SectionRow, type SessionRow, type UserPreferences, type UserRow } from '../core/repo.js'
import { parseLevels } from '../core/levels.js'
import type { Poller } from '../core/poller.js'
import type { SubjectDiscovery } from '../core/discovery.js'
import { assertWebhookUrl, type Dispatcher } from '../core/notify.js'
import { RateLimiter } from '../core/ratelimit.js'
import { assertMailbox } from '../core/mime.js'
import {
  bearerToken,
  burnPasswordWork,
  hashPassword,
  hashSessionToken,
  KdfBusyError,
  lockoutMsFor,
  looksLikeEmail,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  mintSessionToken,
  normalizeEmail,
  SESSION_TTL_MS,
  verifyPassword,
} from '../core/auth.js'

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
}

export interface ApiDeps {
  repo: Repo
  poller?: Poller
  dispatcher?: Dispatcher
  /** Enables the subject catalogue routes. Absent means browsing cannot seed. */
  discovery?: SubjectDiscovery
  /** Allowed browser origins. Empty means same-origin only. */
  corsOrigins?: string[]
  /**
   * Shared secret for the operator-only routes. Unset disables them outright:
   * forcing a poll fans out to a registrar, so "has an account" is not the bar.
   */
  adminToken?: string | null
  /** Development only. Lets a watch point at a webhook on loopback. */
  allowPrivateWebhooks?: boolean
  rateLimit?: RateLimitConfig
  /** Injectable so tests can move time without sleeping. */
  now?: () => number
}

interface Limits {
  auth: RateLimiter
  signup: RateLimiter
  seed: RateLimiter
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
  ({ repo, dispatcher }) => ({
    // Channels are advertised so a client can offer email only where the server
    // can actually send it, instead of finding out from a rejected watch.
    status: 200,
    body: { ...repo.stats(), channels: dispatcher?.channels ?? [] },
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
    if (password.length < MIN_PASSWORD_LENGTH) {
      throw new HttpError(400, `password must be at least ${MIN_PASSWORD_LENGTH} characters`)
    }
    if (password.length > MAX_PASSWORD_LENGTH) {
      throw new HttpError(400, `password must be at most ${MAX_PASSWORD_LENGTH} characters`)
    }

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

    return { status: 201, body: issueSession(ctx, req, user) }
  },
  'public'
)

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
    clientIp: clientIpOf(req),
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
 * The source address as the kernel sees it.
 *
 * Deliberately not `X-Forwarded-For`: this process listens directly today, so a
 * header any client can write would be a rate limit any client can walk around
 * by changing one string. Behind a proxy this needs a trusted-hop count, and
 * that decision belongs to whoever configures the proxy.
 */
function clientIpOf(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? 'unknown'
}

/** Spends one token from the shared login and signup budget for this address. */
function spendAuthAttempt(ctx: Ctx): void {
  if (ctx.limits.auth.take(ctx.clientIp, ctx.now())) return
  const seconds = ctx.limits.auth.retryAfterSeconds(ctx.clientIp, ctx.now())
  throw new HttpError(429, `too many attempts from this address, try again in ${seconds}s`)
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
