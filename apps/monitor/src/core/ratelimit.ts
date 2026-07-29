/**
 * A per-key token bucket, in memory.
 *
 * This exists because the expensive routes in this service are the
 * unauthenticated ones. A password hash costs ~40ms of CPU, a poll costs a real
 * request to a registrar that can get our IP blocked, and neither one has an
 * account behind it at the moment the work is committed to. Per-account limits
 * cannot help there: an attacker who supplies an address that does not exist
 * has no account to limit, and a per-account lockout an unauthenticated
 * stranger can trigger on a named victim is a denial of service rather than a
 * defence. So the first line is per source address.
 *
 * In memory and per process on purpose, and that is now a real approximation
 * rather than a free one: poll targets are leased, so several workers can share
 * a database, and each of them keeps its own buckets. An address behind N
 * workers therefore gets up to N times the budget. That is accepted because the
 * expensive thing on the other side of these limits, an upstream request, is
 * deduplicated by the target lease no matter which worker asks, and because a
 * shared store is a dependency this service does not otherwise need. A restart
 * forgives everyone, which is the failure direction that does not lock students
 * out.
 */

export interface RateLimitOptions {
  /** Burst size, and the number of tokens a fully idle key holds. */
  capacity: number
  /** How long a fully drained bucket takes to refill. */
  refillMs: number
  /** Keys tracked before the least recently used ones are dropped. */
  maxKeys?: number
}

interface Bucket {
  tokens: number
  at: number
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>()
  private readonly capacity: number
  private readonly refillMs: number
  private readonly maxKeys: number

  constructor(opts: RateLimitOptions) {
    this.capacity = Math.max(1, opts.capacity)
    this.refillMs = Math.max(1, opts.refillMs)
    this.maxKeys = opts.maxKeys ?? 10_000
  }

  /**
   * Spends one token. False means the caller is over its limit.
   *
   * Time is a parameter rather than a call to Date.now so a test can drive a
   * window without sleeping through it, the same way the rest of the service
   * takes its clock.
   */
  take(key: string, at: number): boolean {
    const bucket = this.bucketFor(key, at)
    if (bucket.tokens < 1) return false
    bucket.tokens -= 1
    return true
  }

  /** Whole seconds until one more token is available, for a Retry-After header. */
  retryAfterSeconds(key: string, at: number): number {
    const bucket = this.bucketFor(key, at)
    if (bucket.tokens >= 1) return 0
    const perToken = this.refillMs / this.capacity
    return Math.max(1, Math.ceil(((1 - bucket.tokens) * perToken) / 1000))
  }

  /** Test and operational visibility. Never used to make a decision. */
  tokens(key: string, at: number): number {
    return this.bucketFor(key, at).tokens
  }

  private bucketFor(key: string, at: number): Bucket {
    const existing = this.buckets.get(key)
    if (existing) {
      const elapsed = Math.max(0, at - existing.at)
      existing.tokens = Math.min(this.capacity, existing.tokens + (elapsed * this.capacity) / this.refillMs)
      existing.at = at
      // Reinserting keeps Map iteration order as recency, which is what the
      // eviction below relies on.
      this.buckets.delete(key)
      this.buckets.set(key, existing)
      return existing
    }

    // Bounded so a flood of forged source addresses cannot be turned into
    // unbounded memory. A dropped key starts full again, which is the same
    // position an attacker would be in after a restart.
    if (this.buckets.size >= this.maxKeys) {
      const oldest = this.buckets.keys().next()
      if (!oldest.done) this.buckets.delete(oldest.value)
    }
    const fresh: Bucket = { tokens: this.capacity, at }
    this.buckets.set(key, fresh)
    return fresh
  }
}
