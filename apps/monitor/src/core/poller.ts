import { SisError, type SchoolConfig, type SisAdapter } from '../adapters/types.js'
import { diffSection, NOTIFIABLE, reconcile, toState, type DetectedEvent } from './diff.js'
import { nextIntervalMs, type ScheduleConfig } from './schedule.js'
import type { Repo, TargetRow } from './repo.js'
import type { Dispatcher } from './notify.js'

/**
 * The poll loop. Takes a due target, fetches it, diffs it, records events, and
 * queues notifications for anyone watching an affected section.
 *
 * One target at a time by design. Concurrency and rate limiting live in
 * PoliteClient, so this file stays about correctness and the HTTP layer stays
 * about not getting us blocked.
 */

export interface PollerOptions {
  now?: () => number
  random?: () => number
  /** Targets fetched per tick. The client still throttles the actual requests. */
  batchSize?: number
  log?: (msg: string, meta?: Record<string, unknown>) => void
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
  }

  /**
   * One pass. Unseeded targets come first: they have no sections yet, so no
   * watch can point at them, so they would otherwise never become "due".
   */
  async tick(signal?: AbortSignal): Promise<TickResult> {
    const at = this.now()
    const seed = this.repo.unseededTargets(this.batchSize, at)
    const due = this.repo.dueTargets(Math.max(0, this.batchSize - seed.length), at)

    const targets = [...seed, ...due.filter((d) => !seed.some((s) => s.id === d.id))]
    const outcomes: PollOutcome[] = []

    for (const target of targets) {
      if (signal?.aborted) break
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
      if (this.repo.enqueueNotification(watch, eventId) !== null) queued++
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
}

/** Wraps Poller and Dispatcher in a loop that can be started and stopped cleanly. */
export class Runner {
  private timer: NodeJS.Timeout | null = null
  private running = false
  private readonly controller = new AbortController()
  private readonly tickIntervalMs: number
  private readonly log: (msg: string, meta?: Record<string, unknown>) => void

  constructor(
    private readonly poller: Poller,
    private readonly dispatcher: Dispatcher,
    opts: RunnerOptions = {}
  ) {
    this.tickIntervalMs = opts.tickIntervalMs ?? 15_000
    this.log = opts.log ?? (() => {})
  }

  start(): void {
    if (this.timer) return
    const loop = async (): Promise<void> => {
      if (this.running) return
      this.running = true
      try {
        const result = await this.poller.tick(this.controller.signal)
        if (result.polled > 0) {
          this.log('tick', { polled: result.polled, queued: result.notificationsQueued })
        }
        const sent = await this.dispatcher.flush()
        if (sent.delivered + sent.failed + sent.retrying > 0) {
          this.log('dispatch', { ...sent })
        }
      } catch (err) {
        this.log('tick error', { error: err instanceof Error ? err.message : String(err) })
      } finally {
        this.running = false
      }
    }
    this.timer = setInterval(() => void loop(), this.tickIntervalMs)
    void loop()
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
