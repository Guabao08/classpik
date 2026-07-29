/**
 * The one interface every student information system implements.
 *
 * Everything here is UNAUTHENTICATED. The monitor reads public schedule-of-
 * classes data only. Anything requiring a student login belongs in the local
 * agent, not this service. Keeping that boundary at the type level is
 * deliberate: there is no place to put a credential in these signatures.
 */

export interface Term {
  code: string
  description: string
}

export interface Subject {
  code: string
  description: string
}

/** A section exactly as the upstream SIS reports it, before we store it. */
export interface RawSection {
  crn: string
  subject: string
  courseNumber: string
  /** Display code, e.g. "MATH 221". */
  code: string
  title: string
  section: string
  credits: number | null
  instructor: string | null
  meetingDays: string | null
  meetingTime: string | null
  campus: string | null

  seats: number
  capacity: number
  enrollment: number
  waitlist: number
  waitlistCap: number
  waitlistAvailable: number
}

export interface SchoolConfig {
  id: string
  name: string
  sis: SisId
  baseUrl: string
  /** Some Banner installs mount the app somewhere other than the default. */
  registrationPath?: string
  polling: {
    baseIntervalMs: number
    minIntervalMs: number
    maxIntervalMs: number
    /** A target that changed within this window is polled at minIntervalMs. */
    hotWindowMs: number
    maxConcurrentRequests: number
    /** Floor on the gap between two requests to this host. */
    minRequestGapMs: number
  }
  /** Empty means "discover from the SIS". */
  subjects: string[]
  enabled: boolean
}

export type SisId = 'banner9' | 'peoplesoft' | 'workday'

export interface FetchOptions {
  signal?: AbortSignal
}

export interface SisAdapter {
  readonly id: SisId

  listTerms(school: SchoolConfig, opts?: FetchOptions): Promise<Term[]>

  listSubjects(school: SchoolConfig, term: string, opts?: FetchOptions): Promise<Subject[]>

  /**
   * All sections for one subject in one term.
   *
   * Subject is the polling unit rather than the section: a single upstream
   * request returns every section for a subject, so N students watching
   * different CS sections cost exactly one request, not N.
   */
  fetchSections(
    school: SchoolConfig,
    term: string,
    subject: string,
    opts?: FetchOptions
  ): Promise<RawSection[]>
}

export class SisError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
    /** Transient errors are retried with backoff; permanent ones disable the target. */
    readonly transient = true
  ) {
    super(message)
    this.name = 'SisError'
  }
}
