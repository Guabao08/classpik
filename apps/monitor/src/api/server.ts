import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Repo, SectionRow, SessionRow, UserRow } from '../core/repo.js'
import type { Poller } from '../core/poller.js'
import type { Dispatcher } from '../core/notify.js'
import { assertMailbox } from '../core/mime.js'
import {
  bearerToken,
  burnPasswordWork,
  hashPassword,
  hashSessionToken,
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

export interface ApiDeps {
  repo: Repo
  poller?: Poller
  dispatcher?: Dispatcher
  /** Allowed browser origins. Empty means same-origin only. */
  corsOrigins?: string[]
  /** Injectable so tests can move time without sleeping. */
  now?: () => number
}

/** What a handler actually receives: the deps plus whoever is making the call. */
type Ctx = ApiDeps & {
  now: () => number
  user: UserRow | null
  session: SessionRow | null
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

// ------------------------------------------------------------------- accounts

/**
 * Signup logs you in, because a client that has to immediately turn around and
 * POST /login for the account it just created is a client that will get that
 * second call wrong.
 */
route(
  'POST',
  '/api/auth/signup',
  (ctx, req, _url, body) => {
    const { repo } = ctx
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

    const user = repo.createUser({
      email,
      emailNorm: normalizeEmail(email),
      passwordHash: hashPassword(password),
    })
    // Signup is the one place where confirming an address is already taken is
    // unavoidable, since the alternative is silently not creating an account.
    if (!user) throw new HttpError(409, 'that email already has an account')

    return { status: 201, body: issueSession(ctx, req, user) }
  },
  'public'
)

route(
  'POST',
  '/api/auth/login',
  (ctx, req, _url, body) => {
    const { repo, now } = ctx
    const b = asObject(body)
    const email = required(str(b.email), 'email')
    const password = required(str(b.password), 'password')

    const user = repo.findUserByEmail(normalizeEmail(email))
    if (!user) {
      // Same message and roughly the same latency as a wrong password, so the
      // endpoint cannot be used to find out which addresses have accounts.
      burnPasswordWork(password)
      throw new HttpError(401, 'email or password is incorrect')
    }

    const at = now()
    if (user.locked_until !== null && user.locked_until > at) {
      const seconds = Math.ceil((user.locked_until - at) / 1000)
      throw new HttpError(429, `too many failed attempts, try again in ${seconds}s`)
    }

    if (!verifyPassword(password, user.password_hash)) {
      const failures = repo.countLoginFailure(user.id)
      const lockMs = lockoutMsFor(failures)
      if (lockMs > 0) repo.lockUser(user.id, at + lockMs)
      throw new HttpError(401, 'email or password is incorrect')
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

// -------------------------------------------------------------------- catalog

route('GET', '/api/sections', ({ repo }, _req, url) => {
  const limit = clampInt(url.searchParams.get('limit'), 1, 500, 100)
  const status = url.searchParams.get('status')
  if (status && !['open', 'waitlist', 'full'].includes(status)) {
    throw new HttpError(400, 'status must be one of open, waitlist, full')
  }
  const sections = repo.searchSections({
    schoolId: url.searchParams.get('school') ?? undefined,
    term: url.searchParams.get('term') ?? undefined,
    subject: url.searchParams.get('subject') ?? undefined,
    query: url.searchParams.get('q') ?? undefined,
    status: (status as 'open' | 'waitlist' | 'full' | null) ?? undefined,
    limit,
  })
  return { status: 200, body: { count: sections.length, sections: sections.map(toSectionDto) } }
}, 'public')

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
  // An email watch defaults to the address the account signed up with, which is
  // what a caller almost always means and one fewer field to get wrong.
  const target = str(b.target) ?? (channel === 'email' ? user.email : null)
  if (channel === 'webhook' && !target) {
    throw new HttpError(400, 'channel "webhook" requires a target URL')
  }
  if (channel === 'email') {
    // Refused up front rather than queued: without a transport the notification
    // would sit in the queue retrying a channel nobody is listening on, and the
    // student would never learn that.
    if (!ctx.dispatcher?.supports('email')) {
      throw new HttpError(400, 'email delivery is not configured on this server')
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
 * Force a poll cycle. Useful in development and for tests. Authenticated
 * because it makes us fetch upstream on demand, and an anonymous caller who can
 * do that can get our IP blocked at a registrar.
 */
route('POST', '/api/poll', async ({ poller, dispatcher }) => {
  if (!poller) throw new HttpError(503, 'poller not attached')
  const result = await poller.tick()
  const sent = dispatcher ? await dispatcher.flush() : null
  return { status: 200, body: { ...result, dispatch: sent } }
})

// ------------------------------------------------------------------ plumbing

export function createApi(deps: ApiDeps): Server {
  return createServer((req, res) => {
    void handle(deps, req, res)
  })
}

async function handle(deps: ApiDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const origin = req.headers.origin
  if (origin) {
    // Vary goes out whether or not the origin is allowed. Setting it only in
    // the allowed branch lets a cache serve one origin a response that still
    // carries another origin's Access-Control-Allow-Origin.
    res.setHeader('Vary', 'Origin')
  }
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
  const ctx: Ctx = { ...deps, now, user: found?.user ?? null, session: found?.session ?? null }

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
    send(res, 500, { error: err instanceof Error ? err.message : 'internal error' })
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
  return { id: u.id, email: u.email, createdAt: u.created_at }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body, null, 2)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
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
