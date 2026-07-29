/**
 * Adaptive polling intervals.
 *
 * Two competing pressures: a seat that opens at 2 AM should be caught in
 * seconds, and we must not hammer a registrar's server. The compromise is to
 * poll fast only where something is actually happening.
 *
 * Pure and deterministic given a `random` function, so the behaviour is
 * testable rather than a thing we hope works in production.
 */

export interface ScheduleConfig {
  baseIntervalMs: number
  minIntervalMs: number
  maxIntervalMs: number
  /** A target that changed within this window counts as hot. */
  hotWindowMs: number
}

export interface ScheduleInput {
  config: ScheduleConfig
  /** Consecutive failed polls. Zero on success. */
  consecutiveErrors: number
  /** Time since this target last produced a change, or null if never. */
  msSinceLastChange: number | null
  /** How long this target has been polled without producing any change. */
  msSinceFirstPoll: number
  /** Watchers depending on this target. Zero means it should not be polled. */
  watcherCount: number
}

export const MAX_BACKOFF_MS = 60 * 60 * 1000

/**
 * Milliseconds until this target should next be polled.
 *
 * Ordering matters:
 *   1. errors back off hard, regardless of how interesting the target is
 *   2. recent change means something is moving, so poll at the floor
 *   3. otherwise decay from base toward max as the target stays boring
 * Jitter is applied last so that a fleet of workers never resynchronises into
 * a thundering herd against one registrar.
 */
export function nextIntervalMs(input: ScheduleInput, random: () => number = Math.random): number {
  const { config, consecutiveErrors, msSinceLastChange, msSinceFirstPoll } = input

  if (consecutiveErrors > 0) {
    const backoff = Math.min(
      MAX_BACKOFF_MS,
      config.baseIntervalMs * 2 ** Math.min(consecutiveErrors, 10)
    )
    return jitter(backoff, 0.2, random)
  }

  if (msSinceLastChange !== null && msSinceLastChange <= config.hotWindowMs) {
    return jitter(config.minIntervalMs, 0.1, random)
  }

  // Boring targets decay toward the ceiling. Doubling every hotWindow keeps a
  // section that nobody has dropped in a week from costing what a live one does.
  //
  // The first window past hot must land exactly on base, not on double it, so
  // the step count is offset by one: falling out of the hot window is not
  // itself evidence of being boring, it is just the normal state.
  const quietFor = msSinceLastChange ?? msSinceFirstPoll
  const windows = Math.floor(quietFor / Math.max(1, config.hotWindowMs))
  const steps = Math.max(0, windows - 1)
  const decayed = config.baseIntervalMs * 2 ** Math.min(steps, 8)

  return jitter(clamp(decayed, config.minIntervalMs, config.maxIntervalMs), 0.15, random)
}

/**
 * Registration windows are the one time a slow poll is unacceptable, so a
 * target can be pinned to the floor for a bounded period around them.
 */
export function isHighDemandWindow(
  now: number,
  windows: ReadonlyArray<{ startsAt: number; endsAt: number }>
): boolean {
  return windows.some((w) => now >= w.startsAt && now <= w.endsAt)
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** Symmetric multiplicative jitter: `ms` +/- `ratio`. */
export function jitter(ms: number, ratio: number, random: () => number = Math.random): number {
  const delta = ms * ratio
  return Math.max(0, Math.round(ms - delta + random() * delta * 2))
}
