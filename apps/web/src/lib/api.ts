/**
 * Client for @classpik/monitor.
 *
 * Every call can fail, because the monitor is a separate process that may
 * simply not be running. The UI treats that as a first-class state rather than
 * an exception, so `ApiError` carries enough to tell the user what to do.
 */

export const API_BASE: string =
  (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:8787'

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly offline = false
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export interface Section {
  id: string
  schoolId: string
  term: string
  crn: string
  code: string
  title: string
  section: string
  subject: string
  credits: number | null
  instructor: string | null
  meetingDays: string | null
  meetingTime: string | null
  /**
   * Academic level in the registrar's own code, e.g. `UGRD`. Null where the
   * school publishes none, which is why nothing here may treat null as
   * undergraduate: an unclassified section belongs to every level.
   */
  level: string | null
  seats: number
  capacity: number
  enrollment: number
  waitlist: number
  waitlistCap: number
  status: 'open' | 'waitlist' | 'full'
  lastPolledAt: number
  lastChangedAt: number | null
}

/** `console` is the in-app record. `email` needs the monitor to have a provider. */
export type Channel = 'console' | 'email'

export interface Watch {
  id: string
  mode: 'notify' | 'claim'
  channel: string
  target: string | null
  createdAt: number
  lastNotifiedAt: number | null
  section: Section
}

export interface EventItem {
  id: number
  section_id: string
  kind: string
  prev_seats: number | null
  new_seats: number
  prev_waitlist: number | null
  new_waitlist: number
  detail: string
  at: number
  code: string
  section_label: string
  crn: string
  title: string
}

export interface Stats {
  schools: number
  targets: number
  activeTargets: number
  sections: number
  watches: number
  events: number
  pollCount: number
  pendingNotifications: number
  /**
   * Delivery channels this monitor can actually use, e.g. `['console',
   * 'email']`. The server advertises them so the UI can offer email only where
   * it will be sent, rather than finding out from a rejected watch.
   */
  channels: string[]
}

export interface User {
  id: string
  email: string
  createdAt: number
  /**
   * Where this account is shopping. The monitor applies these to catalog search
   * on its own, so a signed-in student sees their own school, term and levels
   * without the client asking for them.
   *
   * Search only. The watchlist and the alerts ignore all three, which is what
   * lets a transfer student keep every watch from their old school.
   */
  school: string | null
  term: string | null
  levels: string[]
}

export interface Term {
  code: string
  description: string
}

export interface School {
  id: string
  name: string
  sis: string
  enabled: boolean
  subjects: string[]
  terms: Term[]
}

/** A level a school actually publishes, with how many sections carry it. */
export interface Level {
  level: string
  sections: number
}

/** What the monitor narrowed a search to, echoed back so the UI can show it. */
export interface SearchScope {
  school: string | null
  term: string | null
  levels: string[]
}

/**
 * A subject the school publishes in a term.
 *
 * `seeded` is the whole reason this list is worth showing. False means the
 * monitor knows the subject exists and has never asked the registrar what is in
 * it, so no amount of waiting will fill it in: somebody has to ask. Discovery
 * deliberately creates no polling work, which is what keeps a two hundred
 * subject catalogue from becoming two hundred requests at a registrar.
 */
export interface Subject {
  school: string
  term: string
  code: string
  description: string
  seeded: boolean
}

/** What a seed did. `queued` bought a fetch, `already` means one is queued or done. */
export interface SeedResult {
  school: string
  term: string
  subject: string
  status: 'queued' | 'already'
  sections: number
}

export interface Session {
  token: string
  expiresAt: number
  user: User
}

const TOKEN_KEY = 'classpik.token'

/**
 * Held in memory as well as localStorage so a call made before the first render
 * still carries the header, and so a private-mode browser that refuses storage
 * degrades to a session that ends with the tab rather than not working at all.
 */
let token: string | null = readStoredToken()

function readStoredToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

export function getToken(): string | null {
  return token
}

export function setToken(next: string | null): void {
  token = next
  try {
    if (next === null) localStorage.removeItem(TOKEN_KEY)
    else localStorage.setItem(TOKEN_KEY, next)
  } catch {
    /* storage blocked; the in-memory copy still works for this tab */
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
        ...(init?.headers ?? {}),
      },
    })
  } catch {
    // A network-level failure here almost always means the monitor is not
    // running, which is a normal state in development and worth saying plainly.
    throw new ApiError(`Cannot reach the monitor at ${API_BASE}`, null, true)
  }

  if (!res.ok) {
    let detail = `${res.status}`
    try {
      const body = (await res.json()) as { error?: string }
      if (body.error) detail = body.error
    } catch {
      /* response was not JSON; the status alone will do */
    }
    // A stale or revoked token is worth clearing here rather than letting every
    // subsequent call fail the same way while the UI still looks signed in.
    if (res.status === 401) setToken(null)
    throw new ApiError(detail, res.status)
  }

  return (await res.json()) as T
}

export const api = {
  health: () => call<{ ok: boolean }>('/health'),

  signup: (email: string, password: string) =>
    call<Session>('/api/auth/signup', { method: 'POST', body: JSON.stringify({ email, password }) }),

  login: (email: string, password: string) =>
    call<Session>('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),

  logout: () => call<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),

  me: () => call<{ user: User }>('/api/auth/me'),

  stats: () => call<Stats>('/api/stats'),

  // No school, term or level here on purpose. The monitor takes those from the
  // account, the same way it takes the identity from the session, so the only
  // way to change what a search covers is to change the account. That keeps one
  // answer to "why am I seeing these classes" instead of two that can disagree.
  sections: (params: { q?: string; status?: string; limit?: number } = {}) => {
    const qs = new URLSearchParams()
    if (params.q) qs.set('q', params.q)
    if (params.status) qs.set('status', params.status)
    qs.set('limit', String(params.limit ?? 100))
    return call<{ count: number; scope: SearchScope; sections: Section[] }>(`/api/sections?${qs}`)
  },

  schools: () => call<School[]>('/api/schools'),

  // The browsable catalogue. Reading it costs nothing upstream, which is why it
  // is public and why it is safe to list in full.
  subjects: (school: string, term?: string | null) => {
    const qs = new URLSearchParams({ school })
    if (term) qs.set('term', term)
    return call<{ count: number; subjects: Subject[] }>(`/api/subjects?${qs}`)
  },

  // The other half, and the one that costs something: this buys a subject its
  // one bootstrap fetch. It queues rather than fetching, so the answer is
  // "queued", not sections. Without this the app could show a school onboarded
  // with `subjects: []` a permanently empty Find classes and nothing a student
  // did would ever change it.
  seedSubject: (input: { school: string; term: string; subject: string }) =>
    call<SeedResult>('/api/subjects/seed', { method: 'POST', body: JSON.stringify(input) }),

  // The levels a school publishes, which is where the boxes to tick come from.
  // Asking the catalog rather than hardcoding a pair of them is the point: the
  // codes are per institution, and a law or medical student is neither.
  levels: (school: string, term?: string | null) => {
    const qs = new URLSearchParams({ school })
    if (term) qs.set('term', term)
    return call<{ school: string; term: string | null; levels: Level[] }>(`/api/levels?${qs}`)
  },

  // A patch: send only what changed. null clears a field, which is how a
  // student says "every school" rather than "leave it alone".
  updatePreferences: (patch: { school?: string | null; term?: string | null; levels?: string[] | null }) =>
    call<{ user: User }>('/api/auth/preferences', { method: 'POST', body: JSON.stringify(patch) }),

  // No userId on any of these: the monitor takes the account from the session,
  // so a client that passed one would only be guessing at its own identity.
  watches: () => call<{ watches: Watch[] }>('/api/watches'),

  // No `target`: the monitor sends email to the address on the account and
  // nowhere else, so there is nothing for a client to supply. Creating a watch
  // that already exists updates it, which is how the channel gets changed.
  createWatch: (input: { sectionId: string; mode?: 'notify' | 'claim'; channel?: Channel }) =>
    call<{ watch: { id: string } }>('/api/watches', { method: 'POST', body: JSON.stringify(input) }),

  deleteWatch: (id: string) =>
    call<{ ok: boolean }>(`/api/watches/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  events: (limit = 50) => call<{ events: EventItem[] }>(`/api/events?limit=${limit}`),
}

// There is deliberately no `poll` here. Forcing a cycle fans out to a
// registrar, so the monitor gates it on an operator token that a browser has no
// business holding, and the loop polls on its own schedule anyway.
