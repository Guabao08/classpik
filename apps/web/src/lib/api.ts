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

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
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
    throw new ApiError(detail, res.status)
  }

  return (await res.json()) as T
}

export const api = {
  health: () => call<{ ok: boolean }>('/health'),

  stats: () => call<Stats>('/api/stats'),

  sections: (params: { q?: string; status?: string; school?: string; limit?: number } = {}) => {
    const qs = new URLSearchParams()
    if (params.q) qs.set('q', params.q)
    if (params.status) qs.set('status', params.status)
    if (params.school) qs.set('school', params.school)
    qs.set('limit', String(params.limit ?? 100))
    return call<{ count: number; sections: Section[] }>(`/api/sections?${qs}`)
  },

  watches: (userId: string) =>
    call<{ watches: Watch[] }>(`/api/watches?userId=${encodeURIComponent(userId)}`),

  createWatch: (input: {
    userId: string
    sectionId: string
    mode?: 'notify' | 'claim'
    channel?: string
    target?: string
  }) => call<{ watch: { id: string } }>('/api/watches', { method: 'POST', body: JSON.stringify(input) }),

  deleteWatch: (id: string) =>
    call<{ ok: boolean }>(`/api/watches/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  events: (userId: string, limit = 50) =>
    call<{ events: EventItem[] }>(
      `/api/events?userId=${encodeURIComponent(userId)}&limit=${limit}`
    ),

  poll: () => call<{ polled: number; notificationsQueued: number }>('/api/poll', { method: 'POST' }),
}
