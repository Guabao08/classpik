import { hostname } from 'node:os'
import { randomBytes } from 'node:crypto'
import { SisError, type SchoolConfig, type SisAdapter } from '../adapters/types.js'
import { diffSection, NOTIFIABLE, reconcile, toState, type DetectedEvent } from './diff.js'
import { nextIntervalMs, type ScheduleConfig } from './schedule.js'
import type { Repo, TargetRow } from './repo.js'
import type { Dispatcher } from './notify.js'
import type { SubjectDiscovery } from './discovery.js'

/**
 * The poll loop. Takes a due target, fetches it, diffs it, records events, and
 * queues notifications for anyone watching an affected section.
 *
 * One target at a time by design. Concurrency and rate limiting live in
 * PoliteClient, so this file stays about correctness and the HTTP layer stays
 * about not getting us blocked.
 *
 * Several of these may run at once, in one process or in several, against one
 * database. Work is divided by leasing each target before it is fetched, so two
 * workers never spend two upstream requests on the same subject. See
 * Repo.claimTargets.
 */

/**
 * How long a claim is good for. Comfortably longer than one fetch, including
 * the retries and the inter-request gap PoliteClient imposes, and short enough
 * that a worker killed mid-poll costs one delayed cycle rather than a target
 * nobody polls again.
 */
export const DEFAULT_LEASE_MS = 120_000

/** Distinct per process, and per Poller within a process, which is what leases are keyed on. */
export function newWorkerId(): string {
  return `${hostname()}:${process.pid}:${randomBytes(4).toString('hex')}`
}

export interface PollerOptions {
  now?: () => number
  random?: () => number
  /** Targets fetched per tick. The client still throttles the actual requests. */
  batchSize?: number
  log?: (msg: string, meta?: Record<string, unknown>) => void
  /** Lease identity. Defaults to something unique per process, which is what you want. */
  workerId?: string
  /** How long a claimed target stays claimed if this worker never comes back. */
  leaseMs?: number
}

export interface PollOutcome {
  targetId: string
  ok: boolean
  sectionsSeen: number
  eventsRecorded: number
  notificationsQueued: number
  removed: number
  error?: string
  nextPollAt: number
}

export interface TickResult {
  polled: number
  outcomes: PollOutcome[]
  notificationsQueued: number
}

export class Poller {
  private readonly now: () => number
  private readonly random: () => number
  private readonly batchSize: number
  private readonly log: (msg: string, meta?: Record<string, unknown>) => void
  readonly workerId: string
  private readonly leaseMs: number

  constructor(
    private readonly repo: Repo,
    private readonly adapters: Map<string, SisAdapter>,
    private readonly dispatcher: Dispatcher | null = null,
    opts: PollerOptions = {}
  ) {
    this.now = opts.now ?? Date.now
    this.random = opts.random ?? Math.random
    this.batchSize = opts.batchSize ?? 10
    this.log = opts.log ?? (() => {})
    this.workerId = opts.workerId ?? newWorkerId()
    this.leaseMs = opts.leaseMs ?? DEFAULT_LEASE_MS
  }

  /**
   * One pass, up to `batchSize` targets.
   *
   * Claimed one at a time rather than as a batch, on purpose. A batch claim
   * would have to cover the whole batch with one lease, so the lease would need
   * to outlast the slowest possible drain of the batch, and every crash would
   * strand that much work for that long. Claiming per target keeps the lease
   * the length of one fetch, and it lets two workers interleave through the
   * same due list instead of one taking ten and the other finding nothing.
   *
   * Ordering is inside the claim: a target nobody has ever polled comes first,
   * since it has no sections yet, so no watch can point at it, so it would
   * otherwise never become due at all.
   */
  async tick(signal?: AbortSignal): Promise<TickResult> {
    const outcomes: PollOutcome[] = []

    for (let i = 0; i < this.batchSize; i++) {
      if (signal?.aborted) break
      const [target] = this.repo.claimTargets(this.workerId, 1, this.now(), this.leaseMs)
      if (!target) break
      if (signal?.aborted) {
        // Claimed and then abandoned. Handing it back beats making the rest of
        // the fleet wait out a lease on work that is ready now.
        this.repo.releaseTargets([target.id], this.workerId)
        break
      }
      outcomes.push(await this.pollTarget(target, signal))
    }

    return {
      polled: outcomes.length,
      outcomes,
      notificationsQueued: outcomes.reduce((n, o) => n + o.notificationsQueued, 0),
    }
  }

  async pollTarget(target: TargetRow, signal?: AbortSignal): Promise<PollOutcome> {
    const school = this.repo.getSchool(target.school_id)
    if (!school) {
      return this.fail(target, `unknown school ${target.school_id}`, true)
    }
    const adapter = this.adapters.get(school.sis)
    if (!adapter) {
      return this.fail(target, `no adapter for sis "${school.sis}"`, true)
    }

    let fetched
    try {
      fetched = await adapter.fetchSections(school, target.term, target.subject, { signal })
    } catch (err) {
      const transient = err instanceof SisError ? err.transient : true
      const message = err instanceof Error ? err.message : String(err)
      this.log('poll failed', { target: target.id, error: message, transient })
      return this.fail(target, message, !transient)
    }

    const stored = this.repo.getSectionStates(target.id)
    const { present, removed } = reconcile(fetched, stored)

    let eventsRecorded = 0
    let notificationsQueued = 0
    let changed = false

    for (const { incoming, previous } of present) {
      const events = diffSection(previous, toState(incoming))
      const material = events.filter((e) => e.kind !== 'section_added')
      if (material.length > 0) changed = true

      const sectionId = this.repo.upsertSection(target, incoming, material.length > 0)

      for (const event of events) {
        // section_added is bookkeeping. Recording one per section on the first
        // poll of a big subject would bury the real history in noise.
        if (event.kind === 'section_added') continue
        eventsRecorded++
        notificationsQueued += this.record(sectionId, event)
      }
    }

    // A section vanishing from a fetch is ambiguous (cancelled, or an upstream
    // hiccup), so it is flagged absent rather than deleted. Nothing is lost if
    // it comes back next poll.
    if (removed.length > 0) {
      this.repo.markSectionsAbsent(target.id, removed)
      changed = true
      this.log('sections absent', { target: target.id, count: removed.length })
    }

    const interval = this.intervalFor(school, target, changed)
    const nextPollAt = this.now() + interval
    this.repo.recordPollSuccess(target.id, nextPollAt, interval, changed)

    return {
      targetId: target.id,
      ok: true,
      sectionsSeen: fetched.length,
      eventsRecorded,
      notificationsQueued,
      removed: removed.length,
      nextPollAt,
    }
  }

  /** Record an event and queue a notification for each active watcher. */
  private record(sectionId: string, event: DetectedEvent): number {
    const eventId = this.repo.recordEvent(sectionId, event)
    if (!NOTIFIABLE.has(event.kind)) return 0

    let queued = 0
    for (const watch of this.repo.activeWatchesForSection(sectionId)) {
      try {
        if (this.repo.enqueueNotification(watch, eventId) !== null) queued++
      } catch (err) {
        // The queue insert is the one write this whole service exists to make,
        // so a failed one is loud and does not stop the rest of the poll. It
        // used to be swallowed and read back as "already queued", which meant a
        // full disk lost the alert with no row and no log line anywhere.
        this.log('could not queue a notification', {
          watch: watch.id,
          event: eventId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    return queued
  }

  private intervalFor(school: SchoolConfig, target: TargetRow, changed: boolean): number {
    const config: ScheduleConfig = {
      baseIntervalMs: school.polling.baseIntervalMs,
      minIntervalMs: school.polling.minIntervalMs,
      maxIntervalMs: school.polling.maxIntervalMs,
      hotWindowMs: school.polling.hotWindowMs,
    }
    const now = this.now()
    const lastChange = changed ? now : target.last_changed_at
    return nextIntervalMs(
      {
        config,
        consecutiveErrors: 0,
        msSinceLastChange: lastChange === null ? null : now - lastChange,
        msSinceFirstPoll: target.first_polled_at === null ? 0 : now - target.first_polled_at,
        watcherCount: this.repo.countWatchersForTarget(target.id),
      },
      this.random
    )
  }

  private fail(target: TargetRow, message: string, permanent: boolean): PollOutcome {
    const school = this.repo.getSchool(target.school_id)
    const config: ScheduleConfig = school
      ? {
          baseIntervalMs: school.polling.baseIntervalMs,
          minIntervalMs: school.polling.minIntervalMs,
          maxIntervalMs: school.polling.maxIntervalMs,
          hotWindowMs: school.polling.hotWindowMs,
        }
      : { baseIntervalMs: 300_000, minIntervalMs: 60_000, maxIntervalMs: 1_800_000, hotWindowMs: 900_000 }

    const interval = nextIntervalMs(
      {
        config,
        consecutiveErrors: target.consecutive_errors + 1,
        msSinceLastChange: null,
        msSinceFirstPoll: 0,
        watcherCount: 0,
      },
      this.random
    )
    const nextPollAt = this.now() + interval
    this.repo.recordPollError(target.id, nextPollAt, message, permanent)

    return {
      targetId: target.id,
      ok: false,
      sectionsSeen: 0,
      eventsRecorded: 0,
      notificationsQueued: 0,
      removed: 0,
      error: message,
      nextPollAt,
    }
  }
}

export interface RunnerOptions {
  tickIntervalMs?: number
  now?: () => number
  log?: (msg: string, meta?: Record<string, unknown>) => void
  /**
   * Ceiling on one tick. A transport that never settles must not be able to
   * hold the loop closed forever, whatever future transports get written.
   */
  tickBudgetMs?: number
  /** Injectable so a test can prune sessions without waiting a day. */
  purgeIntervalMs?: number
  repo?: Repo
  /** Refreshes the browsable subject catalogue. Absent means the loop does not discover. */
  discovery?: SubjectDiscovery
  /**
   * How often to re-ask each school for its subject list. Daily by default: a
   * catalogue changes between terms, not between ticks, and this is one request
   * per (school, term) every time it runs.
   */
  discoveryIntervalMs?: number
}

/** Wraps Poller and Dispatcher in a loop that can be started and stopped cleanly. */
export class Runner {
  private timer: NodeJS.Timeout | null = null
  private running = false
  /** When the in-flight tick started, so a wedged one can be abandoned. */
  private runningSince = 0
  private lastPurgeAt = 0
  private lastDiscoveryAt = 0
  private readonly controller = new AbortController()
  private readonly tickIntervalMs: number
  private readonly tickBudgetMs: number
  private readonly purgeIntervalMs: number
  private readonly discovery: SubjectDiscovery | null
  private readonly discoveryIntervalMs: number
  private readonly repo: Repo | null
  private readonly now: () => number
  private readonly log: (msg: string, meta?: Record<string, unknown>) => void

  constructor(
    private readonly poller: Poller,
    private readonly dispatcher: Dispatcher,
    opts: RunnerOptions = {}
  ) {
    this.tickIntervalMs = opts.tickIntervalMs ?? 15_000
    this.tickBudgetMs = opts.tickBudgetMs ?? Math.max(60_000, this.tickIntervalMs * 4)
    this.purgeIntervalMs = opts.purgeIntervalMs ?? 60 * 60_000
    this.discovery = opts.discovery ?? null
    this.discoveryIntervalMs = opts.discoveryIntervalMs ?? 24 * 60 * 60_000
    this.repo = opts.repo ?? null
    this.now = opts.now ?? Date.now
    this.log = opts.log ?? (() => {})
  }

  start(): void {
    if (this.timer) return
    const loop = async (): Promise<void> => {
      // The latch is time-bounded rather than absolute. It used to be a plain
      // boolean, so a single flush that never settled left it true and every
      // later tick returned at this line: the process stayed up, /api/stats
      // looked healthy, and the service quietly stopped polling forever.
      if (this.running) {
        const stuckFor = this.now() - this.runningSince
        if (stuckFor < this.tickBudgetMs) return
        this.log('abandoning a tick that never finished', { stuckFor })
      }
      this.running = true
      this.runningSince = this.now()
      try {
        await this.refreshSubjects()
        const result = await this.poller.tick(this.controller.signal)
        if (result.polled > 0) {
          this.log('tick', { polled: result.polled, queued: result.notificationsQueued })
        }
        // Bounded independently, because delivery talks to a relay or a
        // provider and those are the parts that hang rather than fail.
        const sent = await this.withBudget(this.dispatcher.flush(), 'dispatch')
        if (sent.delivered + sent.failed + sent.retrying > 0) {
          this.log('dispatch', { ...sent })
        }
        this.purgeSessions()
      } catch (err) {
        this.log('tick error', { error: err instanceof Error ? err.message : String(err) })
      } finally {
        this.running = false
      }
    }
    this.timer = setInterval(() => void loop(), this.tickIntervalMs)
    void loop()
  }

  /**
   * Sessions are never otherwise pruned, so the table grows one row per login
   * for the life of the database. Hourly, and only when the Runner was given a
   * repo, so nothing about the existing constructor call sites has to change.
   */
  private purgeSessions(): void {
    if (!this.repo) return
    const at = this.now()
    if (this.lastPurgeAt !== 0 && at - this.lastPurgeAt < this.purgeIntervalMs) return
    this.lastPurgeAt = at
    const removed = this.repo.purgeExpiredSessions(at)
    if (removed > 0) this.log('purged expired sessions', { removed })
  }

  /**
   * Re-read each school's subject list on a slow timer.
   *
   * Bounded twice over: one upstream request per (school, term) rather than per
   * subject, and daily rather than per tick. Finding a subject creates no
   * polling work by itself, so this is cheap in both directions. See
   * discovery.ts for why that separation is the whole point.
   *
   * Budgeted like delivery is, because it talks to a registrar and a registrar
   * that accepts a connection and then says nothing is what wedges a loop.
   */
  private async refreshSubjects(): Promise<void> {
    if (!this.discovery) return
    const at = this.now()
    if (this.lastDiscoveryAt !== 0 && at - this.lastDiscoveryAt < this.discoveryIntervalMs) return
    this.lastDiscoveryAt = at
    try {
      const found = await this.withBudget(this.discovery.run(this.controller.signal), 'discovery')
      if (found.queried > 0) this.log('subject discovery', { ...found })
    } catch (err) {
      // Never fatal, for the same reason it is never fatal inside run(): the
      // watches we already have are worth more than the catalogue is.
      this.log('subject discovery did not finish', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  private async withBudget<T>(work: Promise<T>, label: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined
    try {
      return await Promise.race([
        work,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`${label} did not finish within ${this.tickBudgetMs}ms`)),
            this.tickBudgetMs
          )
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.controller.abort()
    // Let an in-flight tick unwind before the caller closes the database.
    for (let i = 0; i < 100 && this.running; i++) {
      await new Promise((r) => setTimeout(r, 20))
    }
  }
}
