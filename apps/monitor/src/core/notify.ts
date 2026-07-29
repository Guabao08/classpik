import type { EventRow, NotificationRow, Repo, SectionRow } from './repo.js'

/**
 * Notification delivery.
 *
 * Queued in SQLite rather than fired inline, for one reason: a seat opening is
 * the moment the product either works or does not, and an inline send that
 * fails is a seat the student never hears about. The queue is UNIQUE on
 * (watch, event), so retries cannot double-send.
 */

export interface NotificationPayload {
  watchId: string
  userId: string
  section: SectionRow
  event: EventRow
  /** Ready-to-send strings so transports do not each reinvent the copy. */
  title: string
  body: string
}

export interface Transport {
  readonly channel: string
  send(payload: NotificationPayload, target: string | null): Promise<void>
}

/**
 * A failure that no amount of waiting will fix: an address that is not an
 * address, a relay refusing the message outright, a provider rejecting our
 * credentials. Throwing this skips the retry ladder.
 *
 * The point is not to save the four requests. It is that a mistyped address and
 * a provider outage currently look identical in `notifications.last_error`, so
 * nobody can tell a student their address is wrong. This mirrors
 * `SisError.transient` on the fetch side rather than inventing a second
 * vocabulary for the same idea.
 */
export class PermanentDeliveryError extends Error {
  constructor(message: string, override readonly cause?: unknown) {
    super(message)
    this.name = 'PermanentDeliveryError'
  }
}

export class ConsoleTransport implements Transport {
  readonly channel = 'console'
  readonly sent: NotificationPayload[] = []

  constructor(private readonly log: (msg: string) => void = console.log) {}

  async send(payload: NotificationPayload): Promise<void> {
    this.sent.push(payload)
    this.log(`[notify] ${payload.title} :: ${payload.body}`)
  }
}

export class WebhookTransport implements Transport {
  readonly channel = 'webhook'

  constructor(
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
    private readonly timeoutMs = 10_000
  ) {}

  async send(payload: NotificationPayload, target: string | null): Promise<void> {
    if (!target) throw new Error('webhook transport requires a target URL')

    let url: URL
    try {
      url = new URL(target)
    } catch {
      throw new Error(`invalid webhook URL: ${target}`)
    }
    if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
      throw new Error(`refusing to POST to non-HTTPS webhook: ${url.protocol}//${url.host}`)
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await this.fetchImpl(target, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: payload.event.kind,
          title: payload.title,
          body: payload.body,
          section: {
            id: payload.section.id,
            code: payload.section.code,
            section: payload.section.section,
            crn: payload.section.crn,
            title: payload.section.title,
            seats: payload.section.seats,
            capacity: payload.section.capacity,
            waitlist: payload.section.waitlist,
          },
          at: payload.event.at,
        }),
        signal: controller.signal,
      })
      if (!res.ok) throw new Error(`webhook responded ${res.status}`)
    } finally {
      clearTimeout(timer)
    }
  }
}

export interface DispatcherOptions {
  maxAttempts?: number
  baseRetryMs?: number
  now?: () => number
}

export interface DispatchResult {
  delivered: number
  retrying: number
  failed: number
}

export class Dispatcher {
  private readonly transports = new Map<string, Transport>()
  private readonly maxAttempts: number
  private readonly baseRetryMs: number
  private readonly now: () => number

  constructor(
    private readonly repo: Repo,
    transports: Transport[] = [],
    opts: DispatcherOptions = {}
  ) {
    for (const t of transports) this.transports.set(t.channel, t)
    this.maxAttempts = opts.maxAttempts ?? 5
    this.baseRetryMs = opts.baseRetryMs ?? 30_000
    this.now = opts.now ?? Date.now
  }

  register(t: Transport): void {
    this.transports.set(t.channel, t)
  }

  /** Which channels this process can actually deliver, so the API can refuse a
   * watch on a channel nobody is listening to instead of queueing it forever. */
  get channels(): string[] {
    return [...this.transports.keys()].sort()
  }

  supports(channel: string): boolean {
    return this.transports.has(channel)
  }

  /** Drain the pending queue once. Safe to call concurrently with polling. */
  async flush(limit = 50): Promise<DispatchResult> {
    const pending = this.repo.pendingNotifications(limit, this.now())
    const result: DispatchResult = { delivered: 0, retrying: 0, failed: 0 }

    for (const n of pending) {
      try {
        await this.deliver(n)
        this.repo.markNotificationDelivered(n.id)
        result.delivered++
      } catch (err) {
        const attempts = n.attempts + 1
        const message = err instanceof Error ? err.message : String(err)
        // Retrying a permanent rejection five times over eight minutes changes
        // nothing except how long the real reason takes to surface, and it
        // leaves four identical rows behind for whoever goes looking.
        if (err instanceof PermanentDeliveryError || attempts >= this.maxAttempts) {
          this.repo.markNotificationFailed(n.id, message, null)
          result.failed++
        } else {
          const delay = this.baseRetryMs * 2 ** (attempts - 1)
          this.repo.markNotificationFailed(n.id, message, this.now() + delay)
          result.retrying++
        }
      }
    }

    return result
  }

  private async deliver(n: NotificationRow): Promise<void> {
    const transport = this.transports.get(n.channel)
    if (!transport) throw new Error(`no transport registered for channel "${n.channel}"`)

    const watch = this.repo.getWatch(n.watch_id)
    if (!watch) throw new Error(`watch ${n.watch_id} no longer exists`)

    const events = this.repo.listEvents({ sectionId: watch.section_id, limit: 200 })
    const event = events.find((e) => e.id === n.event_id)
    if (!event) throw new Error(`event ${n.event_id} no longer exists`)

    const section = this.repo.getSection(watch.section_id)
    if (!section) throw new Error(`section ${watch.section_id} no longer exists`)

    await transport.send(
      {
        watchId: watch.id,
        userId: watch.user_id,
        section,
        event,
        ...renderMessage(section, event),
      },
      n.target
    )
  }
}

export function renderMessage(
  section: SectionRow,
  event: EventRow
): { title: string; body: string } {
  const label = `${section.code} ${section.section}`.trim()

  if (event.kind === 'seat_opened') {
    const n = event.new_seats
    return {
      title: `${label} has ${n === 1 ? 'a seat' : `${n} seats`} open`,
      body: `${section.title}. ${n} of ${section.capacity} free. Register before it goes.`,
    }
  }

  if (event.kind === 'waitlist_opened') {
    return {
      title: `${label} waitlist reopened`,
      body: `${section.title}. The section is full, but there is room on the waitlist again.`,
    }
  }

  return { title: `${label}: ${event.kind.replace(/_/g, ' ')}`, body: event.detail }
}
