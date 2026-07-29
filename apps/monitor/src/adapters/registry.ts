import { BannerAdapter } from './banner.js'
import { PeopleSoftAdapter } from './peoplesoft.js'
import { PoliteClient } from './http.js'
import type { SchoolConfig, SisAdapter, SisId } from './types.js'

/**
 * One adapter instance per SIS, sharing one polite HTTP client so that
 * concurrency and rate limits are enforced per host across every school on
 * that platform.
 */
export function buildAdapters(client = new PoliteClient()): Map<SisId, SisAdapter> {
  const map = new Map<SisId, SisAdapter>()
  map.set('banner9', new BannerAdapter(client))
  map.set('peoplesoft', new PeopleSoftAdapter(client))
  // workday lands here as it is built. The poller does not change when it does;
  // it looks adapters up by school.sis.
  return map
}

/**
 * Guess a school's SIS from its portal URL.
 *
 * A convenience for onboarding, not a source of truth. The value that gets
 * used is whatever is written in the school's config file.
 */
export function detectSis(url: string): SisId | null {
  const u = url.toLowerCase()
  if (u.includes('/studentregistrationssb') || u.includes('bwckschd')) return 'banner9'
  if (u.includes('/psc/') || u.includes('/psp/')) return 'peoplesoft'
  if (/myworkday\.com/.test(u)) return 'workday'
  return null
}

export function clientForSchool(school: SchoolConfig): PoliteClient {
  return new PoliteClient({
    maxConcurrent: school.polling.maxConcurrentRequests,
    minRequestGapMs: school.polling.minRequestGapMs,
  })
}
