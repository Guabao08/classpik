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
  /**
   * Academic level, in the registrar's own code: Banner's UG or GR, PeopleSoft's
   * Academic Career of UGRD or GRAD, or whatever else an install uses. This is a
   * property of the section rather than of the student, which is why it lives
   * here and not only on an account.
   *
   * Null when the install does not report one. Absent is not "undergraduate":
   * a section we could not classify is shown to everybody, since hiding a class
   * because our mapping missed a field is the worse of the two failures.
   */
  level: string | null

  seats: number
  capacity: number
  enrollment: number
  waitlist: number
  waitlistCap: number
  waitlistAvailable: number
}

/**
 * The per-install variation a PeopleSoft (HighPoint CX) school needs.
 *
 * Almost everything that differs between these installs sits in the URL prefix
 * and the institution code, which is what makes one adapter viable at all. What
 * does not vary is the /psc/ servlet, the EMPLOYEE portal segment and the
 * script names, so those live in the adapter rather than here.
 */
export interface PeopleSoftConfig {
  /**
   * Everything up to and including the /s/ segment, copied verbatim from a
   * working class search URL. Not composed from parts: the site and node
   * segments vary per install and, at one school seen, per load balancer
   * member.
   */
  scriptPath: string
  /** PeopleSoft's business unit. One shared host can serve many colleges, and this is what separates them. */
  institution: string
  /** Institution-defined term codes. Configured, never derived: see PeopleSoftAdapter.listTerms. */
  terms: Term[]
}

export interface SchoolConfig {
  id: string
  name: string
  sis: SisId
  baseUrl: string
  /** Some Banner installs mount the app somewhere other than the default. */
  registrationPath?: string
  /** Required when sis is peoplesoft, rejected otherwise. */
  peoplesoft?: PeopleSoftConfig
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
