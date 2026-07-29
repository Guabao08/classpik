import { describe, expect, it } from 'vitest'
import {
  clamp,
  isHighDemandWindow,
  jitter,
  MAX_BACKOFF_MS,
  nextIntervalMs,
  type ScheduleConfig,
} from '../src/core/schedule.js'

const config: ScheduleConfig = {
  baseIntervalMs: 300_000, // 5 min
  minIntervalMs: 60_000, // 1 min
  maxIntervalMs: 1_800_000, // 30 min
  hotWindowMs: 900_000, // 15 min
}

/** Pin jitter to the midpoint so assertions are about policy, not randomness. */
const mid = () => 0.5

const input = (over: Partial<Parameters<typeof nextIntervalMs>[0]> = {}) => ({
  config,
  consecutiveErrors: 0,
  msSinceLastChange: null,
  msSinceFirstPoll: 0,
  watcherCount: 1,
  ...over,
})

describe('nextIntervalMs', () => {
  it('polls at the floor when the target just changed', () => {
    const ms = nextIntervalMs(input({ msSinceLastChange: 60_000 }), mid)
    expect(ms).toBe(config.minIntervalMs)
  })

  it('stays at the floor anywhere inside the hot window', () => {
    const ms = nextIntervalMs(input({ msSinceLastChange: config.hotWindowMs }), mid)
    expect(ms).toBe(config.minIntervalMs)
  })

  it('falls back to base once the target goes cold', () => {
    const ms = nextIntervalMs(input({ msSinceLastChange: config.hotWindowMs + 1 }), mid)
    expect(ms).toBe(config.baseIntervalMs)
  })

  it('decays toward the ceiling the longer nothing happens', () => {
    const quiet = (n: number) =>
      nextIntervalMs(input({ msSinceLastChange: config.hotWindowMs * n }), mid)

    expect(quiet(2)).toBeGreaterThan(quiet(1.5))
    expect(quiet(4)).toBeGreaterThan(quiet(2))
    // and never past the ceiling
    expect(quiet(1000)).toBe(config.maxIntervalMs)
  })

  it('never returns less than the floor or more than the ceiling', () => {
    for (const since of [0, 1, 5_000, 900_000, 10_000_000, 1e12]) {
      for (const r of [0, 0.25, 0.5, 0.75, 0.999]) {
        const ms = nextIntervalMs(input({ msSinceLastChange: since }), () => r)
        expect(ms).toBeGreaterThanOrEqual(Math.floor(config.minIntervalMs * 0.85))
        expect(ms).toBeLessThanOrEqual(Math.ceil(config.maxIntervalMs * 1.15))
      }
    }
  })

  it('backs off exponentially on consecutive errors', () => {
    const one = nextIntervalMs(input({ consecutiveErrors: 1 }), mid)
    const two = nextIntervalMs(input({ consecutiveErrors: 2 }), mid)
    const three = nextIntervalMs(input({ consecutiveErrors: 3 }), mid)

    expect(two).toBeGreaterThan(one)
    expect(three).toBeGreaterThan(two)
    expect(two / one).toBeCloseTo(2, 1)
  })

  it('caps backoff at one hour no matter how many failures', () => {
    for (const errors of [10, 25, 100, 1000]) {
      expect(nextIntervalMs(input({ consecutiveErrors: errors }), mid)).toBeLessThanOrEqual(
        MAX_BACKOFF_MS
      )
    }
  })

  it('prioritises error backoff over a recent change', () => {
    // A target that is both hot and failing must back off. Hammering a server
    // that is already returning errors is exactly how we get blocked.
    const ms = nextIntervalMs(input({ consecutiveErrors: 3, msSinceLastChange: 1000 }), mid)
    expect(ms).toBeGreaterThan(config.minIntervalMs)
  })

  it('uses time since first poll when nothing has ever changed', () => {
    const fresh = nextIntervalMs(input({ msSinceLastChange: null, msSinceFirstPoll: 0 }), mid)
    const stale = nextIntervalMs(
      input({ msSinceLastChange: null, msSinceFirstPoll: config.hotWindowMs * 3 }),
      mid
    )
    expect(stale).toBeGreaterThan(fresh)
  })

  it('spreads intervals across random draws so workers do not resynchronise', () => {
    const values = new Set(
      [0.01, 0.2, 0.4, 0.6, 0.8, 0.99].map((r) =>
        nextIntervalMs(input({ msSinceLastChange: config.hotWindowMs + 1 }), () => r)
      )
    )
    expect(values.size).toBeGreaterThan(3)
  })
})

describe('jitter', () => {
  it('returns the input at the midpoint draw', () => {
    expect(jitter(1000, 0.5, () => 0.5)).toBe(1000)
  })

  it('spans the full band across the draw range', () => {
    expect(jitter(1000, 0.2, () => 0)).toBe(800)
    expect(jitter(1000, 0.2, () => 1)).toBe(1200)
  })

  it('never returns a negative delay', () => {
    expect(jitter(10, 5, () => 0)).toBe(0)
  })
})

describe('clamp', () => {
  it('bounds on both sides', () => {
    expect(clamp(5, 1, 10)).toBe(5)
    expect(clamp(-5, 1, 10)).toBe(1)
    expect(clamp(50, 1, 10)).toBe(10)
  })
})

describe('isHighDemandWindow', () => {
  it('detects a time inside a registration window', () => {
    expect(isHighDemandWindow(150, [{ startsAt: 100, endsAt: 200 }])).toBe(true)
  })

  it('is inclusive at both edges', () => {
    expect(isHighDemandWindow(100, [{ startsAt: 100, endsAt: 200 }])).toBe(true)
    expect(isHighDemandWindow(200, [{ startsAt: 100, endsAt: 200 }])).toBe(true)
  })

  it('is false outside every window', () => {
    expect(isHighDemandWindow(99, [{ startsAt: 100, endsAt: 200 }])).toBe(false)
    expect(isHighDemandWindow(150, [])).toBe(false)
  })
})
