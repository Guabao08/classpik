import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Repo, SectionRow } from '../core/repo.js'
import type { Poller } from '../core/poller.js'
import type { Dispatcher } from '../core/notify.js'

/**
 * REST API over node:http. No framework, because the whole surface is nine
 * routes and a dependency we do not take is a dependency we do not patch.
 */

export interface ApiDeps {
  repo: Repo
  poller?: Poller
  dispatcher?: Dispatcher
  /** Allowed browser origins. Empty means same-origin only. */
  corsOrigins?: string[]
}

type Handler = (
  ctx: ApiDeps,
  req: IncomingMessage,
  url: URL,
  body: unknown
) => Promise<{ status: number; body: unknown }> | { status: number; body: unknown }

interface Route {
  method: string
  pattern: RegExp
  handler: Handler
  params: string[]
}

const routes: Route[] = []

function route(method: string, path: string, handler: Handler): void {
  const params: string[] = []
  const pattern = new RegExp(
    '^' +
      path.replace(/:[a-zA-Z]+/g, (m) => {
        params.push(m.slice(1))
        return '([^/]+)'
      }) +
      '$'
  )
  routes.push({ method, pattern, handler, params })
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

// ------------------------------------------------------------------- routes

route('GET', '/health', () => ({ status: 200, body: { ok: true } }))

route('GET', '/api/stats', ({ repo }) => ({ status: 200, body: repo.stats() }))

route('GET', '/api/schools', ({ repo }) => ({
  status: 200,
  body: repo.listSchools().map((s) => ({
    id: s.id,
    name: s.name,
    sis: s.sis,
    enabled: s.enabled,
    subjects: s.subjects,
    terms: repo.listTerms(s.id),
  })),
}))

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
})

route('GET', '/api/sections/:id', ({ repo }, _req, url) => {
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
})

route('GET', '/api/watches', ({ repo }, _req, url) => {
  const userId = required(url.searchParams.get('userId'), 'userId')
  return {
    status: 200,
    body: {
      watches: repo.listWatches(userId).map((w) => ({
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

route('POST', '/api/watches', ({ repo }, _req, _url, body) => {
  const b = asObject(body)
  const userId = required(str(b.userId), 'userId')
  const sectionId = required(str(b.sectionId), 'sectionId')

  const section = repo.getSection(sectionId)
  if (!section) throw new HttpError(404, `no section ${sectionId}`)

  const mode = str(b.mode) ?? 'notify'
  if (mode !== 'notify' && mode !== 'claim') {
    throw new HttpError(400, 'mode must be "notify" or "claim"')
  }
  const channel = str(b.channel) ?? 'console'
  const target = str(b.target) ?? null
  if (channel === 'webhook' && !target) {
    throw new HttpError(400, 'channel "webhook" requires a target URL')
  }

  const watch = repo.createWatch({ userId, sectionId, mode, channel, target })
  return {
    status: 201,
    body: { watch: { id: watch.id, mode: watch.mode, channel: watch.channel }, section: toSectionDto(section) },
  }
})

route('DELETE', '/api/watches/:id', ({ repo }, _req, url) => {
  const id = decodeURIComponent(url.pathname.split('/').pop()!)
  if (!repo.deactivateWatch(id)) throw new HttpError(404, `no watch ${id}`)
  return { status: 200, body: { ok: true, id } }
})

route('GET', '/api/events', ({ repo }, _req, url) => {
  const limit = clampInt(url.searchParams.get('limit'), 1, 200, 50)
  return {
    status: 200,
    body: {
      events: repo.listEventsDetailed({
        userId: url.searchParams.get('userId') ?? undefined,
        sectionId: url.searchParams.get('sectionId') ?? undefined,
        limit,
      }),
    },
  }
})

/** Force a poll cycle. Useful in development and for tests; harmless in prod. */
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
  if (origin && (deps.corsOrigins ?? []).includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
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
    const out = await match.handler(deps, req, url, body)
    send(res, out.status, out.body)
  } catch (err) {
    if (err instanceof HttpError) {
      send(res, err.status, { error: err.message })
      return
    }
    send(res, 500, { error: err instanceof Error ? err.message : 'internal error' })
  }
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
