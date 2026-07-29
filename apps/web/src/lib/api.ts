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
  seats: number
  capacity: number
  enrollment: number
  waitlist: number
  waitlistCap: number
  status: 'open' | 'waitlist' | 'full'
  lastPolledAt: number
  lastChangedAt: number | null
}

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
}

export interface User {
  id: string
  email: string
  createdAt: number
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

  sections: (params: { q?: string; status?: string; school?: string; limit?: number } = {}) => {
    const qs = new URLSearchParams()
    if (params.q) qs.set('q', params.q)
    if (params.status) qs.set('status', params.status)
    if (params.school) qs.set('school', params.school)
    qs.set('limit', String(params.limit ?? 100))
    return call<{ count: number; sections: Section[] }>(`/api/sections?${qs}`)
  },

  // No userId on any of these: the monitor takes the account from the session,
  // so a client that passed one would only be guessing at its own identity.
  watches: () => call<{ watches: Watch[] }>('/api/watches'),

  createWatch: (input: {
    sectionId: string
    mode?: 'notify' | 'claim'
    channel?: string
    target?: string
  }) => call<{ watch: { id: string } }>('/api/watches', { method: 'POST', body: JSON.stringify(input) }),

  deleteWatch: (id: string) =>
    call<{ ok: boolean }>(`/api/watches/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  events: (limit = 50) => call<{ events: EventItem[] }>(`/api/events?limit=${limit}`),

  poll: () => call<{ polled: number; notificationsQueued: number }>('/api/poll', { method: 'POST' }),
}
