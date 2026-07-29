import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'
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

/**
 * Whether an IP literal belongs to a range that is only reachable from inside
 * our own network. A webhook is a URL a user typed, and the server fetches it,
 * so without this the API is an SSRF primitive pointed at loopback services,
 * RFC1918 hosts and the cloud metadata endpoint at 169.254.169.254.
 */
export function isPrivateAddress(ip: string): boolean {
  const kind = isIP(ip)
  if (kind === 4) return isPrivateV4(ip)
  if (kind === 6) return isPrivateV6(ip)
  // Not an address at all, which is not something to route to either.
  return true
}

function isPrivateV4(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number) as [number, number, number, number]
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 169 && b === 254) return true // link-local, and the metadata service
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 192 && b === 0) return true // 192.0.0.0/24 IETF protocol assignments
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
  if (a === 198 && (b === 18 || b === 19)) return true // benchmarking
  if (a >= 224) return true // multicast and reserved
  return false
}

function isPrivateV6(ip: string): boolean {
  const lower = ip.toLowerCase()
  // A v4-mapped address routes to v4, so it has to be judged as v4.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower)
  if (mapped) return isPrivateV4(mapped[1]!)
  if (lower === '::' || lower === '::1') return true
  if (/^f[cd]/.test(lower)) return true // unique local, fc00::/7
  if (/^fe[89ab]/.test(lower)) return true // link local, fe80::/10
  if (lower.startsWith('ff')) return true // multicast
  return false
}

/**
 * The part of webhook validation that needs no network, so the API can refuse a
 * bad target at creation with a 400 rather than queueing a notification that
 * will only ever fail. Returns the parsed URL so a caller need not parse twice.
 */
export function assertWebhookUrl(target: string, allowPrivateTargets = false): URL {
  let url: URL
  try {
    url = new URL(target)
  } catch {
    throw new Error(`invalid webhook URL: ${target}`)
  }

  // http is a development affordance and nothing else. Any other scheme is
  // refused outright: file: and data: are not things to hand to fetch.
  const insecureIsFine = allowPrivateTargets && url.protocol === 'http:'
  if (url.protocol !== 'https:' && !insecureIsFine) {
    throw new Error(`refusing to POST to non-HTTPS webhook: ${url.protocol}//${url.host}`)
  }

  if (allowPrivateTargets) return url

  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (isIP(host) !== 0) {
    if (isPrivateAddress(host)) {
      throw new Error(`refusing to POST to a private address: ${url.host}`)
    }
    return url
  }
  // Names that resolve inside the host itself never reach a real webhook, and
  // the DNS check below cannot see through a hosts file entry.
  const lower = host.toLowerCase()
  if (lower === 'localhost' || lower.endsWith('.localhost') || lower.endsWith('.local')) {
    throw new Error(`refusing to POST to a private address: ${url.host}`)
  }
  return url
}

export interface WebhookOptions {
  /**
   * Development escape hatch for a sink on loopback. Off by default and wired
   * to an environment variable rather than shipped on, because "localhost is
   * fine" is how a public API becomes a port scanner for the private network.
   */
  allowPrivateTargets?: boolean
  /** Injectable so a test can decide what a name resolves to. */
  lookup?: (hostname: string) => Promise<string[]>
}

export class WebhookTransport implements Transport {
  readonly channel = 'webhook'
  private readonly allowPrivateTargets: boolean
  private readonly lookup: (hostname: string) => Promise<string[]>

  constructor(
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
    private readonly timeoutMs = 10_000,
    opts: WebhookOptions = {}
  ) {
    this.allowPrivateTargets = opts.allowPrivateTargets ?? false
    this.lookup =
      opts.lookup ??
      (async (hostname) => (await dnsLookup(hostname, { all: true })).map((a) => a.address))
  }

  async send(payload: NotificationPayload, target: string | null): Promise<void> {
    if (!target) throw new Error('webhook transport requires a target URL')

    const url = assertWebhookUrl(target, this.allowPrivateTargets)
    await this.assertResolvesPublicly(url)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await this.fetchImpl(target, {
        method: 'POST',
        // Manual, because a redirect is a second URL nobody validated: an
        // https target that 302s to http://169.254.169.254 would otherwise walk
        // straight past every check above.
        redirect: 'manual',
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
      if (res.status >= 300 && res.status < 400) {
        throw new Error(`webhook redirected to somewhere we did not validate (${res.status})`)
      }
      if (!res.ok) throw new Error(`webhook responded ${res.status}`)
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * The syntax check cannot catch `https://internal.evil.test` resolving to
   * 10.0.0.5, so the name is resolved and every answer judged. There is a
   * rebinding window between this lookup and the one fetch does, which is why
   * the loopback exemption is off by default rather than relied on.
   */
  private async assertResolvesPublicly(url: URL): Promise<void> {
    if (this.allowPrivateTargets) return
    const host = url.hostname.replace(/^\[|\]$/g, '')
    if (isIP(host) !== 0) return

    let addresses: string[]
    try {
      addresses = await this.lookup(host)
    } catch (err) {
      throw new Error(`could not resolve webhook host ${host}: ${err instanceof Error ? err.message : err}`)
    }
    if (addresses.length === 0) throw new Error(`webhook host ${host} resolves to nothing`)
    for (const address of addresses) {
      if (isPrivateAddress(address)) {
        throw new Error(`refusing to POST to a private address: ${host} resolves to ${address}`)
      }
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

    // By primary key, not by scanning a recent window. A notification on the
    // retry ladder for a section that churns past the window would otherwise
    // fail with "no longer exists" about a row that is still there.
    const event = this.repo.getEvent(n.event_id)
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
