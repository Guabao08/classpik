import { text } from './entities.js'
import { PoliteClient } from './http.js'
import {
  SisError,
  type FetchOptions,
  type RawSection,
  type SchoolConfig,
  type SisAdapter,
  type Subject,
  type Term,
} from './types.js'

/**
 * Ellucian Banner 9 (Student Registration Self-Service).
 *
 * The easiest of the three student systems, because its public class search is
 * a JSON API underneath rather than a page to scrape. The catch is that it is
 * stateful: you cannot just GET search results. You must first hold a session
 * cookie and POST the term you intend to search, which authorises that session
 * for that term. Search results for an unauthorised term come back empty with
 * a 200, not an error, so a missing handshake looks exactly like "no classes".
 * That is the single most likely way this adapter breaks, hence the explicit
 * empty-result check in fetchSections.
 *
 * Endpoint shapes verified against the nubanned reverse-engineering docs
 * (https://jennydaman.gitlab.io/nubanned/).
 */

const DEFAULT_PATH = '/StudentRegistrationSsb/ssb'
/** Banner caps a single page at 500 regardless of what you ask for. */
const MAX_PAGE = 500
const SESSION_TTL_MS = 10 * 60 * 1000

interface BannerSectionDto {
  courseReferenceNumber: string
  subject: string
  courseNumber: string
  subjectCourse?: string
  courseTitle: string
  sequenceNumber: string
  creditHours: number | null
  creditHourLow?: number | null
  campusDescription: string | null
  maximumEnrollment: number
  enrollment: number
  seatsAvailable: number
  waitCapacity: number
  waitCount: number
  waitAvailable: number
  /**
   * The levels the section is open to. An array because a cross-listed section
   * is genuinely open to more than one, and a scalar spelling is carried too
   * because installs differ on which of these they populate.
   */
  levels?: string[] | null
  levelDescription?: string | null
  faculty?: Array<{ displayName?: string | null }>
  meetingsFaculty?: Array<{
    meetingTime?: {
      beginTime: string | null
      endTime: string | null
      monday: boolean
      tuesday: boolean
      wednesday: boolean
      thursday: boolean
      friday: boolean
      saturday: boolean
      sunday: boolean
    }
  }>
}

interface BannerSearchResponse {
  success: boolean
  totalCount: number
  data: BannerSectionDto[] | null
  pageOffset?: number
  pageMaxSize?: number
}

interface BannerTermDto {
  code: string
  description: string
}

interface Session {
  term: string
  createdAt: number
}

export class BannerAdapter implements SisAdapter {
  readonly id = 'banner9' as const

  /** Host to the term its session is currently authorised for. One per host. */
  private readonly sessions = new Map<string, Session>()

  /** Host to a promise chain that serialises operations against it. */
  private readonly hostLocks = new Map<string, Promise<void>>()

  constructor(
    private readonly client: PoliteClient,
    private readonly now: () => number = Date.now
  ) {}

  private base(school: SchoolConfig): string {
    const root = school.baseUrl.replace(/\/+$/, '')
    const path = (school.registrationPath ?? DEFAULT_PATH).replace(/\/+$/, '')
    return `${root}${path}`
  }

  async listTerms(school: SchoolConfig, opts: FetchOptions = {}): Promise<Term[]> {
    const url = `${this.base(school)}/classSearch/getTerms?offset=1&max=50&searchTerm=`
    const dto = await this.client.json<BannerTermDto[]>(url, { signal: opts.signal })
    if (!Array.isArray(dto)) throw new SisError('getTerms did not return an array', null, true)
    return dto.map((t) => ({
      code: String(t.code),
      // Banner appends markup like "Fall 2026 (View Only)" on archived terms.
      // Tags come off before entities are decoded, never after: a literal
      // `&lt;b&gt;` in a term name is text the registrar meant to show.
      description: text(String(t.description ?? '').replace(/<[^>]*>/g, '')),
    }))
  }

  async listSubjects(
    school: SchoolConfig,
    term: string,
    opts: FetchOptions = {}
  ): Promise<Subject[]> {
    const url = `${this.base(school)}/classSearch/get_subject?searchTerm=&term=${encodeURIComponent(
      term
    )}&offset=1&max=500`
    const dto = await this.withSession(school, term, opts, () =>
      this.client.json<BannerTermDto[]>(url, { signal: opts.signal })
    )
    if (!Array.isArray(dto)) throw new SisError('get_subject did not return an array', null, true)
    // Banner escapes subject names: Georgia Tech sends `Chemical &amp;
    // Biomolecular Engr`, and storing that raw breaks both search and display.
    return dto.map((s) => ({ code: String(s.code), description: text(s.description) }))
  }

  async fetchSections(
    school: SchoolConfig,
    term: string,
    subject: string,
    opts: FetchOptions = {}
  ): Promise<RawSection[]> {
    // The whole paged read runs under the session lock. Paging is stateful too:
    // a term re-authorised between page one and page two would silently
    // truncate the result, and a short read looks exactly like sections
    // disappearing.
    return this.withSession(school, term, opts, () =>
      this.readAllPages(school, term, subject, opts)
    )
  }

  private async readAllPages(
    school: SchoolConfig,
    term: string,
    subject: string,
    opts: FetchOptions
  ): Promise<RawSection[]> {
    const out: RawSection[] = []
    let offset = 0
    // What the registrar said it was going to give us, re-read every page so a
    // catalog that legitimately changes mid-read moves the target with it.
    let expected = 0

    for (;;) {
      // Banner keeps the previous search in session state; without this reset
      // the second subject you ask for silently returns the first one's rows.
      await this.resetSearch(school, opts)

      const url =
        `${this.base(school)}/searchResults/searchResults` +
        `?txt_subject=${encodeURIComponent(subject)}` +
        `&txt_term=${encodeURIComponent(term)}` +
        `&startDatepicker=&endDatepicker=` +
        `&pageOffset=${offset}&pageMaxSize=${MAX_PAGE}` +
        `&sortColumn=subjectDescription&sortDirection=asc`

      const body = await this.client.json<BannerSearchResponse>(url, { signal: opts.signal })

      if (body.success === false) {
        throw new SisError(`searchResults returned success=false for ${subject} ${term}`, null, true)
      }

      const rows = body.data ?? []

      // An unauthorised term yields totalCount 0 with a 200. Treat a zero-row
      // first page as suspicious rather than as "this subject has no classes",
      // because the difference matters: one is a broken session, the other is
      // a legitimately empty subject, and silently accepting the former means
      // we would report every section as vanished.
      if (offset === 0 && rows.length === 0 && body.totalCount === 0) {
        this.sessions.delete(this.host(school))
        throw new SisError(
          `no rows for ${subject} in ${term}; session likely not authorised for this term`,
          null,
          true
        )
      }

      for (const row of rows) out.push(toRawSection(row))

      expected = body.totalCount
      offset += rows.length
      if (offset >= expected) break

      /*
       * A page that comes back empty before we have read everything the
       * registrar promised is a truncated read, and it must not be returned as
       * a result.
       *
       * This used to `break` and hand back what it had. The caller has no way
       * to tell a short list from a complete one, so it did the only thing it
       * could and concluded that every section it did not see had vanished.
       * Observed at Georgia Tech on 2026-08-07: a session that lapsed between
       * page one and page two returned 500 of 1751 CS sections, and 1268
       * sections were marked absent. Absent sections are excluded from search,
       * so most of the CS catalog disappeared for a student until the next
       * good poll put it back.
       *
       * Transient, and the session goes with it: the next attempt starts from a
       * fresh handshake, which is the thing that was wrong.
       */
      if (rows.length === 0) {
        this.sessions.delete(this.host(school))
        throw new SisError(
          `truncated read for ${subject} in ${term}: got ${out.length} of ${expected} sections`,
          null,
          true
        )
      }

      if (out.length > 20_000) {
        throw new SisError(`refusing to page past 20000 sections for ${subject}`, null, false)
      }
    }

    return out
  }

  /**
   * The cookie scope, which is also the scope of Banner's term authorisation.
   *
   * Not the school id: two configs pointing at one host share a cookie jar and
   * therefore share a session, and the session is the thing being tracked.
   */
  private host(school: SchoolConfig): string {
    try {
      return new URL(school.baseUrl).host
    } catch {
      return school.baseUrl
    }
  }

  /**
   * Run an operation with the session authorised for `term`, and with no other
   * operation allowed to re-authorise the host underneath it.
   *
   * Banner holds the authorised term as server-side session state, one per
   * cookie, so authorising a term is a side effect on every other in-flight
   * operation against that host. Discovering subjects for one term while
   * polling sections for another is enough to break the poll: the search comes
   * back with zero rows and a 200, which is indistinguishable from a subject
   * that genuinely has no classes. Observed live at Georgia Tech, where the
   * MATH poll failed every time subject discovery walked the other terms.
   *
   * So the handshake and the requests that depend on it are one critical
   * section. This costs nothing in throughput: the client already holds a
   * minimum gap between requests to a host, so these were never running in
   * parallel, only interleaving.
   */
  private async withSession<T>(
    school: SchoolConfig,
    term: string,
    opts: FetchOptions,
    fn: () => Promise<T>
  ): Promise<T> {
    const host = this.host(school)
    const previous = this.hostLocks.get(host) ?? Promise.resolve()

    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    // `held` only ever resolves, so a failed operation cannot poison the queue.
    const chained = previous.then(() => held)
    this.hostLocks.set(host, chained)

    await previous
    try {
      await this.ensureSession(school, term, opts)
      return await fn()
    } finally {
      release()
      // Nobody queued behind us, so stop tracking this host.
      if (this.hostLocks.get(host) === chained) this.hostLocks.delete(host)
    }
  }

  /**
   * Establish a cookie, then POST the term. Cached briefly, because doing this
   * handshake before every subject would triple our request count against the
   * registrar for no benefit.
   */
  private async ensureSession(
    school: SchoolConfig,
    term: string,
    opts: FetchOptions
  ): Promise<void> {
    const key = this.host(school)
    const existing = this.sessions.get(key)
    // The term has to match. A cached session authorised for another term is
    // worse than no session, because it answers searches with an empty 200.
    if (
      existing &&
      existing.term === term &&
      this.now() - existing.createdAt < SESSION_TTL_MS
    ) {
      return
    }

    const base = this.base(school)

    // Landing on class search is what mints the JSESSIONID.
    await this.client.request(`${base}/classSearch/classSearch`, { signal: opts.signal })

    const res = await this.client.request(`${base}/term/search?mode=search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        term,
        studyPath: '',
        studyPathText: '',
        startDatepicker: '',
        endDatepicker: '',
      }).toString(),
      signal: opts.signal,
    })
    // The body is {"fwdURL": "..."} on success. We do not need the value, but a
    // non-JSON body here means we got an error page and the session is no good.
    const text = await res.text()
    if (!text.includes('fwdURL')) {
      throw new SisError(
        `term/search did not authorise term ${term}: ${text.slice(0, 120).replace(/\s+/g, ' ')}`,
        null,
        true
      )
    }

    this.sessions.set(key, { term, createdAt: this.now() })
  }

  private async resetSearch(school: SchoolConfig, opts: FetchOptions): Promise<void> {
    await this.client.request(`${this.base(school)}/classSearch/resetDataForm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: '',
      signal: opts.signal,
    })
  }

  /** Exposed for tests and for the agent, which re-authorises after a session drop. */
  invalidateSession(school: SchoolConfig, _term?: string): void {
    // Host-scoped, because the session is: there is only one to drop.
    this.sessions.delete(this.host(school))
  }
}

const DAY_LETTERS: Array<[keyof NonNullable<NonNullable<BannerSectionDto['meetingsFaculty']>[number]['meetingTime']>, string]> =
  [
    ['monday', 'M'],
    ['tuesday', 'T'],
    ['wednesday', 'W'],
    ['thursday', 'R'],
    ['friday', 'F'],
    ['saturday', 'S'],
    ['sunday', 'U'],
  ]

export function toRawSection(row: BannerSectionDto): RawSection {
  const meeting = row.meetingsFaculty?.find((m) => m.meetingTime)?.meetingTime ?? null

  let days: string | null = null
  if (meeting) {
    const letters = DAY_LETTERS.filter(([k]) => meeting[k] === true).map(([, l]) => l).join('')
    days = letters.length > 0 ? letters : null
  }

  const seats = num(row.seatsAvailable)
  const capacity = num(row.maximumEnrollment)
  const enrollment = num(row.enrollment)

  return {
    crn: String(row.courseReferenceNumber),
    subject: String(row.subject),
    courseNumber: String(row.courseNumber),
    code: row.subjectCourse
      ? `${row.subject} ${row.courseNumber}`
      : `${row.subject} ${row.courseNumber}`,
    // Free text, so it is escaped on the way out of Banner. A course really
    // named "Data Structures & Algorithms" arrives as `&amp;`.
    title: text(row.courseTitle),
    section: String(row.sequenceNumber ?? ''),
    credits: row.creditHours ?? row.creditHourLow ?? null,
    instructor: orNull(text(row.faculty?.find((f) => f.displayName)?.displayName)),
    meetingDays: days,
    meetingTime: formatTime(meeting?.beginTime ?? null, meeting?.endTime ?? null),
    campus: orNull(text(row.campusDescription)),
    level: firstLevel(row),

    seats,
    capacity,
    enrollment,
    waitlist: num(row.waitCount),
    waitlistCap: num(row.waitCapacity),
    waitlistAvailable: num(row.waitAvailable),
  }
}

/**
 * The section's academic level, or null if this install does not report one.
 *
 * Two narrowings worth stating rather than discovering later:
 *
 *  - A cross-listed section carries several levels and we keep the first, since
 *    a section holds one level in our model. Banner lists the primary one
 *    first, so this is right for the common case and wrong for a graduate
 *    student searching a section whose primary level is undergraduate.
 *  - Nothing is inferred when both fields are missing. Null means unclassified,
 *    and an unclassified section is shown to every level rather than to none.
 *
 * Search has a matching filter upstream: `txt_level` on the searchResults
 * endpoint, with the valid values coming from `classSearch/get_levels`. Passing
 * it would let the registrar do this narrowing for us and cut what we page
 * through, but it also splits one subject's fetch into one per level, which is
 * the per-subject request economics this service is built on. Left unused
 * deliberately, and noted here for the day a school needs it.
 */
function firstLevel(row: BannerSectionDto): string | null {
  for (const level of row.levels ?? []) {
    if (typeof level === 'string' && level.trim() !== '') return level.trim()
  }
  const scalar = row.levelDescription?.trim()
  return scalar ? scalar : null
}

/**
 * Empty display text is absence, not a value. `RawSection` reads null as "this
 * install does not report it", and a blank instructor name means exactly that.
 */
function orNull(s: string): string | null {
  return s.length > 0 ? s : null
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

/** Banner gives "1300" for 1:00pm. Render something a human recognises. */
function formatTime(begin: string | null, end: string | null): string | null {
  const fmt = (t: string | null): string | null => {
    if (!t || t.length < 3) return null
    const padded = t.padStart(4, '0')
    const h = Number(padded.slice(0, 2))
    const m = padded.slice(2, 4)
    if (!Number.isFinite(h)) return null
    const suffix = h < 12 ? 'a' : 'p'
    const hour12 = h % 12 === 0 ? 12 : h % 12
    return `${hour12}:${m}${suffix}`
  }
  const b = fmt(begin)
  const e = fmt(end)
  if (!b && !e) return null
  if (b && e) return `${b}-${e}`
  return b ?? e
}
