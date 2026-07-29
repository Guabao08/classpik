import { SisError } from './types.js'

/**
 * A deliberately slow HTTP client.
 *
 * The realistic failure mode for this service is not legal, it is getting our
 * IP blocked by a registrar and going silently dark for every user at that
 * school. So politeness is enforced here, in one place, rather than left to
 * each adapter to remember:
 *
 *   - at most N in-flight requests per host
 *   - a hard floor on the gap between two requests to the same host
 *   - exponential backoff with jitter on 429 and 5xx, honouring Retry-After
 *   - a hard ceiling on how long one `request()` may spend in total
 *   - an identifying User-Agent so an admin can find us instead of guessing
 */

export interface PoliteClientOptions {
  maxConcurrent?: number
  minRequestGapMs?: number
  timeoutMs?: number
  maxRetries?: number
  /**
   * Ceiling on one `request()` including every retry and every wait between
   * them, so the caller has a number to reason about rather than a product of
   * limits. Without it, three retries at a 20s timeout with a 60s `Retry-After`
   * honoured each time is over four minutes for one call, which is what made
   * the poller's lease a fiction.
   */
  maxTotalMs?: number
  userAgent?: string
  fetchImpl?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  random?: () => number
  now?: () => number
}

const DEFAULT_UA =
  'ClassPikMonitor/0.1 (+https://github.com/Guabao08/classpik; course seat monitor; contact via repo issues)'

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

interface HostState {
  active: number
  lastRequestAt: number
  queue: Array<() => void>
}

export class PoliteClient {
  private readonly hosts = new Map<string, HostState>()
  private readonly jar = new CookieJar()

  readonly maxConcurrent: number
  readonly minRequestGapMs: number
  readonly timeoutMs: number
  readonly maxRetries: number
  readonly maxTotalMs: number
  private readonly userAgent: string
  private readonly fetchImpl: typeof fetch
  private readonly sleep: (ms: number) => Promise<void>
  private readonly random: () => number
  private readonly now: () => number

  constructor(opts: PoliteClientOptions = {}) {
    this.maxConcurrent = opts.maxConcurrent ?? 2
    this.minRequestGapMs = opts.minRequestGapMs ?? 350
    this.timeoutMs = opts.timeoutMs ?? 20_000
    this.maxRetries = opts.maxRetries ?? 3
    this.maxTotalMs = opts.maxTotalMs ?? 90_000
    this.userAgent = opts.userAgent ?? DEFAULT_UA
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch
    this.sleep = opts.sleep ?? defaultSleep
    this.random = opts.random ?? Math.random
    this.now = opts.now ?? Date.now
  }

  /** Cookies are per-client, which makes each poll cycle a clean session. */
  get cookies(): CookieJar {
    return this.jar
  }

  async request(url: string, init: RequestInit = {}): Promise<Response> {
    const host = new URL(url).host
    const startedAt = this.now()
    let attempt = 0

    // A retry we can already see will blow the budget is not worth waiting for,
    // so the check happens before the sleep rather than after it. That bounds
    // one request() at roughly maxTotalMs plus the timeout of the attempt that
    // is already running.
    const wouldOverrun = (delay: number): boolean =>
      this.now() - startedAt + delay > this.maxTotalMs

    for (;;) {
      await this.acquire(host)
      let res: Response
      try {
        res = await this.send(url, init)
      } catch (err) {
        this.release(host)
        const delay = this.backoffMs(attempt)
        if (attempt >= this.maxRetries || wouldOverrun(delay)) {
          throw new SisError(`request failed after ${attempt + 1} attempts: ${url}`, err, true)
        }
        await this.sleep(delay)
        attempt++
        continue
      }
      this.release(host)

      if (res.status === 429 || res.status >= 500) {
        const delay = this.retryDelayMs(res, attempt)
        if (attempt >= this.maxRetries || wouldOverrun(delay)) {
          throw new SisError(`upstream ${res.status} after ${attempt + 1} attempts: ${url}`, null, true)
        }
        await this.sleep(delay)
        attempt++
        continue
      }

      // 4xx other than 429 means we are asking wrong. Retrying will not help.
      if (!res.ok) {
        throw new SisError(`upstream ${res.status}: ${url}`, null, false)
      }

      return res
    }
  }

  async json<T>(url: string, init?: RequestInit): Promise<T> {
    const res = await this.request(url, init)
    const text = await res.text()
    try {
      return JSON.parse(text) as T
    } catch (err) {
      // Banner serves an HTML login or error page with a 200 when a session
      // has lapsed. Surfacing the first chunk makes that obvious in logs.
      throw new SisError(
        `expected JSON from ${url}, got ${text.slice(0, 120).replace(/\s+/g, ' ')}`,
        err,
        true
      )
    }
  }

  private async send(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    const signal = init.signal
      ? AbortSignal.any([init.signal as AbortSignal, controller.signal])
      : controller.signal

    const headers = new Headers(init.headers)
    headers.set('User-Agent', this.userAgent)
    headers.set('Accept-Language', 'en-US,en;q=0.9')
    const cookie = this.jar.header(url)
    if (cookie) headers.set('Cookie', cookie)

    try {
      const res = await this.fetchImpl(url, { ...init, headers, signal, redirect: 'follow' })
      this.jar.absorb(url, res)
      return res
    } finally {
      clearTimeout(timer)
    }
  }

  /** Exponential with full jitter, so parallel workers do not resynchronise. */
  private backoffMs(attempt: number): number {
    const ceiling = Math.min(30_000, 500 * 2 ** attempt)
    return Math.round(ceiling * (0.5 + this.random() * 0.5))
  }

  private retryDelayMs(res: Response, attempt: number): number {
    const header = res.headers.get('retry-after')
    if (header) {
      const seconds = Number(header)
      if (Number.isFinite(seconds) && seconds >= 0) return Math.min(60_000, seconds * 1000)
      const date = Date.parse(header)
      if (!Number.isNaN(date)) return Math.min(60_000, Math.max(0, date - this.now()))
    }
    return this.backoffMs(attempt)
  }

  private state(host: string): HostState {
    let s = this.hosts.get(host)
    if (!s) {
      s = { active: 0, lastRequestAt: 0, queue: [] }
      this.hosts.set(host, s)
    }
    return s
  }

  private async acquire(host: string): Promise<void> {
    const s = this.state(host)
    if (s.active >= this.maxConcurrent) {
      await new Promise<void>((resolve) => s.queue.push(resolve))
    }
    s.active++
    const gap = this.minRequestGapMs - (this.now() - s.lastRequestAt)
    if (gap > 0) await this.sleep(gap)
    s.lastRequestAt = this.now()
  }

  private release(host: string): void {
    const s = this.state(host)
    s.active = Math.max(0, s.active - 1)
    const next = s.queue.shift()
    if (next) next()
  }
}

/**
 * Minimal cookie jar. Node's fetch does not keep cookies, and Banner's whole
 * session model is a JSESSIONID, so we need one. Scoped by host only, which is
 * all the SIS hosts require and keeps the surface small.
 */
export class CookieJar {
  private readonly byHost = new Map<string, Map<string, string>>()

  absorb(url: string, res: Response): void {
    const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []
    if (raw.length === 0) {
      const single = res.headers.get('set-cookie')
      if (single) raw.push(single)
    }
    if (raw.length === 0) return

    const host = new URL(url).host
    let jar = this.byHost.get(host)
    if (!jar) {
      jar = new Map()
      this.byHost.set(host, jar)
    }
    for (const line of raw) {
      const pair = line.split(';', 1)[0] ?? ''
      const eq = pair.indexOf('=')
      if (eq <= 0) continue
      jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim())
    }
  }

  header(url: string): string | null {
    const jar = this.byHost.get(new URL(url).host)
    if (!jar || jar.size === 0) return null
    return [...jar].map(([k, v]) => `${k}=${v}`).join('; ')
  }

  get(url: string, name: string): string | undefined {
    return this.byHost.get(new URL(url).host)?.get(name)
  }

  clear(url?: string): void {
    if (url) this.byHost.delete(new URL(url).host)
    else this.byHost.clear()
  }
}
