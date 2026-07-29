import { PoliteClient } from './http.js'
import {
  SisError,
  type FetchOptions,
  type PeopleSoftConfig,
  type RawSection,
  type SchoolConfig,
  type SisAdapter,
  type Subject,
  type Term,
} from './types.js'

/**
 * PeopleSoft Campus Solutions, HighPoint CX flavour only.
 *
 * The clean JSON class search this adapter speaks is not an Oracle feature. The
 * `WEBLIB_HCX_*` scripts belong to HighPoint Campus Experience, a licensed
 * third party add on, so this works at the schools that bought it and 404s at
 * the ones that did not. Stock installs expose the old `ICAction` HTML search
 * instead, which costs one stateful POST chain per subject plus a further POST
 * per section to read seat counts. That is a different cost model and a
 * different concurrency model, so it belongs in its own adapter rather than in
 * a branch here. See the supported systems table in README.md.
 *
 * Two differences from Banner are worth holding in mind while reading this:
 *
 *   1. There is no handshake. No cookie, no term authorisation POST, no CSRF
 *      token. `fetchSections` is a plain GET loop, which is why this class has
 *      no session map and nothing to invalidate.
 *   2. An empty first page is legitimate. Banner treats zero rows as a broken
 *      session, because for Banner it usually is. Here an empty `classes` array
 *      is the documented way pagination ends, so it cannot also be the alarm.
 *      The failure this adapter guards instead is a 200 whose body is HTML,
 *      which is what these installs answer with when something is wrong.
 *
 * Field names and the request shape are reconstructed from two independent open
 * source consumers of the API at two different schools rather than from a
 * captured response, so anything unverified is called out at the point of use.
 * This has never run against a live install.
 */

/** Class search. Returns every section for a subject, one page at a time. */
const CLASS_SEARCH = 'WEBLIB_HCX_CM.H_CLASS_SEARCH.FieldFormula.IScript_ClassSearch'
/** Subject list for the whole catalog. Needs no term and no session. */
const CATALOG_SUBJECTS = 'WEBLIB_HCX_CM.H_COURSE_CATALOG.FieldFormula.IScript_CatalogSubjects'

/**
 * One class row from IScript_ClassSearch.
 *
 * Every number here is typed as `string | number` on purpose. The per section
 * detail endpoint returns `class_capacity` and `enrollment_total` as JSON
 * strings while returning `enrollment_available` as a JSON number, in the same
 * object, so nothing about these types can be assumed from one install.
 */
interface PsClassDto {
  class_nbr?: string | number
  subject?: string
  catalog_nbr?: string
  descr?: string
  class_section?: string
  units?: string | number
  campus?: string
  campus_descr?: string
  location?: string
  location_descr?: string

  class_capacity?: string | number
  enrollment_total?: string | number
  enrollment_available?: string | number
  wait_tot?: string | number
  wait_cap?: string | number
  /** The detail endpoint spells the same two waitlist fields this way. */
  wait_list_total?: string | number
  wait_list_capacity?: string | number
  /** Advisory single letter, "O" for open. Diffing runs off the numbers. */
  enrl_stat?: string

  /**
   * Academic Career, which is PeopleSoft's name for academic level: UGRD,
   * GRAD, LAW, MEDS and whatever else an institution has defined. The code is
   * what we want; the description is a fallback for an install that only sends
   * the human-readable one.
   */
  acad_career?: string
  acad_career_descr?: string

  instructors?: unknown
  meetings?: unknown
}

interface PsSearchResponse {
  classes?: unknown
}

interface PsSubjectDto {
  subject?: string
  descr?: string
  descrformal?: string
}

export class PeopleSoftAdapter implements SisAdapter {
  readonly id = 'peoplesoft' as const

  constructor(
    private readonly client: PoliteClient,
    /** Where skipped rows are reported. Injectable so a test can stay quiet. */
    private readonly log: (msg: string) => void = (msg) => console.warn(msg)
  ) {}

  /**
   * Term codes come from config, never from the wire and never from a formula.
   *
   * Two schools on this same vendor encode the same semester differently: UVA
   * reads 1232 as Spring 2023, CSU Fullerton reads 2227 as Fall 2022. Deriving
   * a code would therefore poll the wrong term at half our schools, silently.
   * An `IScript_ClassSearchOptions` endpoint exists and is the natural home for
   * a real term list, but its response body is unverified, so this does not
   * pretend to discover them.
   */
  async listTerms(school: SchoolConfig): Promise<Term[]> {
    return this.config(school).terms.map((t) => ({ ...t }))
  }

  /**
   * The catalog subject list. Unlike Banner's, this needs no term, hence the
   * unused parameter: the interface carries one because Banner cannot answer
   * without it.
   */
  async listSubjects(
    school: SchoolConfig,
    _term: string,
    opts: FetchOptions = {}
  ): Promise<Subject[]> {
    const url = this.url(school, CATALOG_SUBJECTS, {})
    const body = await this.json<{ subjects?: unknown }>(url, opts)

    if (!Array.isArray(body.subjects)) {
      throw new SisError(`CatalogSubjects returned no subjects array: ${preview(body)}`, null, true)
    }

    const out: Subject[] = []
    for (const raw of body.subjects as PsSubjectDto[]) {
      const code = str(raw?.subject)
      if (!code) continue
      out.push({ code, description: str(raw?.descr) || str(raw?.descrformal) || code })
    }
    return out
  }

  async fetchSections(
    school: SchoolConfig,
    term: string,
    subject: string,
    opts: FetchOptions = {}
  ): Promise<RawSection[]> {
    const out: RawSection[] = []
    // Keyed on every row the install returned, not just the ones we keep. If a
    // page happens to hold only sibling-subject rows, dropping them all would
    // otherwise read as "this page added nothing", which is the signal for a
    // page parameter that is being ignored.
    const seen = new Set<string>()
    let rowsSeen = 0
    let subjectMatches = 0

    for (let page = 1; ; page++) {
      const url = this.url(school, CLASS_SEARCH, { term, subject, page: String(page) })
      const body = await this.json<PsSearchResponse>(url, opts)

      if (!Array.isArray(body.classes)) {
        throw new SisError(
          `ClassSearch returned no classes array for ${subject} ${term}: ${preview(body)}`,
          null,
          true
        )
      }

      const rows = body.classes as PsClassDto[]
      // The documented stop condition. Unlike Banner, this is not evidence of a
      // broken session, so an empty page 1 means the subject genuinely has no
      // classes and returning nothing is the honest answer.
      if (rows.length === 0) break

      // Row by row, not `rows.map`. One unreadable row used to throw out of the
      // whole page, and because that error is transient the target retried and
      // failed forever at maxIntervalMs: every student watching any section in
      // that subject silently stopped getting alerts. A cancelled or
      // administrative row carrying no seat counts is exactly the row a
      // registrar leaves in a page, and banner.ts is the bar here, where no
      // single row can poison a page.
      const { mapped, skipped } = mapRows(rows)
      if (skipped.length > 0) {
        // Tight on purpose. A skipped row is stored as absent, and its return
        // diffs as prev = null, which yields section_added and swallows exactly
        // one seat_opened. Losing a tenth of a page that way is worse than
        // retrying the page.
        if (mapped.length === 0 || skipped.length * 10 > rows.length) {
          throw new SisError(
            `${skipped.length} of ${rows.length} rows on page ${page} for ${subject} ${term} ` +
              `could not be read: ${skipped[0]!.reason}`,
            null,
            true
          )
        }
        this.log(
          `skipped ${skipped.length} unreadable row(s) on page ${page} for ${subject} ${term}: ` +
            `class_nbr ${skipped.map((s) => s.crn).join(', ')}`
        )
      }

      rowsSeen += rows.length

      // Deduping by CRN rather than trusting the pages to be disjoint, because
      // a repeated row would otherwise be stored twice and then diffed against
      // itself.
      let added = 0
      for (const s of mapped) {
        if (seen.has(s.crn)) continue
        seen.add(s.crn)
        added++
        if (s.subject.toUpperCase() !== subject.toUpperCase()) continue
        subjectMatches++
        out.push(s)
      }

      // A page that adds nothing means the page parameter is not being
      // honoured. Stopping quietly would be defensible; raising is better,
      // because the alternative reading is that we truncated the subject, and a
      // truncated subject reports live sections as removed.
      if (added === 0) {
        throw new SisError(
          `page ${page} for ${subject} ${term} repeated sections we already had; ` +
            `the page parameter does not appear to be honoured`,
          null,
          true
        )
      }

      if (out.length > 20_000) {
        throw new SisError(`refusing to page past 20000 sections for ${subject}`, null, false)
      }
    }

    // The subject filter is documented but unverified end to end, and a sibling
    // filter named subject_like exists. If the install ignores ours we would
    // quietly pull the entire term into one subject's target, and every other
    // subject's sections would then appear and vanish as we paged.
    //
    // Judged once, over everything we fetched, rather than per page. Per page it
    // killed the whole subject whenever a page of MATHBIO rows happened to sort
    // together, which is the same silent outage as an unreadable row.
    if (rowsSeen > 0 && subjectMatches === 0) {
      throw new SisError(
        `ClassSearch returned ${rowsSeen} rows for ${subject} ${term} but none carry that subject; ` +
          `the subject filter may be ignored, or ${subject} is not this install's subject code`,
        null,
        true
      )
    }

    return out
  }

  private config(school: SchoolConfig): PeopleSoftConfig {
    const ps = school.peoplesoft
    if (!ps) {
      // Config loading rejects this, so reaching it means a SchoolConfig was
      // built by hand or read from a row written before the block existed.
      // Permanent: retrying cannot add a missing config block.
      throw new SisError(
        `${school.id} is a peoplesoft school but its config has no peoplesoft block ` +
          `(scriptPath, institution, terms)`,
        null,
        false
      )
    }
    return ps
  }

  private url(school: SchoolConfig, script: string, params: Record<string, string>): string {
    const ps = this.config(school)
    const root = school.baseUrl.replace(/\/+$/, '')
    // Config normalises this too. Doing it again is two lines and stops a
    // hand-built config from turning "psc/..." into a request to the host
    // "example.edupsc", which would be a request to somebody else's server.
    const path = `/${ps.scriptPath.replace(/^\/+/, '').replace(/\/+$/, '')}/`
    const qs = new URLSearchParams({ institution: ps.institution, ...params })
    return `${root}${path}${script}?${qs.toString()}`
  }

  /**
   * GET and parse, refusing anything that is not JSON.
   *
   * These installs answer 200 with a sign in or error page under conditions we
   * cannot predict, and an HTML body accepted as zero sections would report
   * every section at the school as vanished. Checking the content type as well
   * as the parse catches the case where an error page happens to be valid JSON.
   *
   * Requests go through PoliteClient rather than fetch so that the per host
   * concurrency cap, the request gap and the retry ladder stay in one place.
   * Its timeout matters more here than it does for Banner: the one install we
   * have a report from punishes a fast caller with a hang rather than a 429,
   * and the timeout is what turns that hang back into a retryable error.
   */
  private async json<T>(url: string, opts: FetchOptions): Promise<T> {
    const res = await this.client.request(url, { signal: opts.signal })
    const text = await res.text()

    const type = res.headers.get('content-type')
    // Absent header: attempt the parse anyway rather than reject a working
    // install over a missing header. A wrong header value is a real signal; no
    // header at all is not.
    if (type !== null && !type.toLowerCase().includes('json')) {
      throw new SisError(
        `expected JSON from ${url}, got content-type ${type}: ${preview(text)}`,
        null,
        true
      )
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (err) {
      throw new SisError(`expected JSON from ${url}, got ${preview(text)}`, err, true)
    }
    if (typeof parsed !== 'object' || parsed === null) {
      throw new SisError(`expected a JSON object from ${url}, got ${preview(text)}`, null, true)
    }
    return parsed as T
  }
}

export interface SkippedRow {
  /** The class number if we could read one, so an operator can look the row up. */
  crn: string
  reason: string
}

/**
 * Maps a page, keeping the rows it can read and setting aside the ones it
 * cannot. The caller decides what an unreadable fraction means; this only
 * refuses to let one row decide for the other forty.
 */
export function mapRows(rows: PsClassDto[]): { mapped: RawSection[]; skipped: SkippedRow[] } {
  const mapped: RawSection[] = []
  const skipped: SkippedRow[] = []
  for (const row of rows) {
    try {
      mapped.push(toRawSection(row))
    } catch (err) {
      skipped.push({
        crn: str(row?.class_nbr) || '(no class_nbr)',
        reason: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return { mapped, skipped }
}

export function toRawSection(row: PsClassDto): RawSection {
  const crn = str(row.class_nbr)
  if (!crn) {
    throw new SisError(
      `class row has no class_nbr: ${preview(row)}`,
      null,
      true
    )
  }

  const capacity = optNum(row.class_capacity)
  const enrollment = optNum(row.enrollment_total)
  const available = optNum(row.enrollment_available)

  // Seat semantics are the one thing in this file that must not be guessed.
  //
  // Prefer the registrar's own available count over capacity minus enrolment:
  // the two disagree wherever seats are held back for a cohort, and the number
  // the student sees on the class search is the one they will act on.
  let seats: number
  if (available !== null) {
    // A registrar that says zero means zero, so this branch believes it.
    seats = available
  } else if (capacity !== null && capacity > 0 && enrollment !== null) {
    // Capacity zero is not a full section here, it is a row we cannot read.
    // PeopleSoft reports class_capacity 0 for uncapped and parent-capped
    // sections, and a catalog rebuild can zero every count while still serving
    // valid JSON. Believing it would report those sections permanently full,
    // and then flip every one of them from 0 to n on the next healthy poll,
    // firing seat_opened for every watched section at the school at once.
    seats = capacity - enrollment
  } else {
    // Defaulting to zero here would mark the section permanently full, and the
    // student watching it would never be told a seat opened. Failing the fetch
    // is the safe direction: the poller backs off and asks again.
    throw new SisError(`class ${crn} carries no readable seat counts: ${preview(row)}`, null, true)
  }

  // Absent stays distinct from zero on the waitlist too, and for the same
  // reason it does on seats. A row that carries wait_cap 25 and no readable
  // total used to become "0 of 25 taken", so the next diff after a healthy poll
  // read as a waitlist reopening with 25 spots free and emailed every watcher
  // about a spot that never opened. waitlist_opened is notifiable, so this
  // reached the student.
  const waitlistTotal = optNum(row.wait_tot) ?? optNum(row.wait_list_total)
  const waitlistCapacity = optNum(row.wait_cap) ?? optNum(row.wait_list_capacity)
  const waitlist = waitlistTotal ?? 0
  const waitlistCap = waitlistTotal === null ? 0 : (waitlistCapacity ?? 0)

  const subject = str(row.subject)
  const courseNumber = str(row.catalog_nbr)
  const meeting = firstMeeting(row.meetings)

  return {
    crn,
    subject,
    courseNumber,
    code: `${subject} ${courseNumber}`.trim(),
    title: str(row.descr),
    section: str(row.class_section),
    credits: parseUnits(row.units),
    instructor: firstInstructor(row.instructors),
    meetingDays: meeting ? formatDays(str(meeting.days)) : null,
    meetingTime: meeting ? formatTime(meeting.start_time, meeting.end_time) : null,
    campus: str(row.campus_descr) || str(row.campus) || str(row.location_descr) || str(row.location) || null,
    // Academic Career is PeopleSoft's academic level. The code is preferred
    // over the description because it is the stable half: two installs both say
    // UGRD where one says "Undergraduate" and the other "Undergrad". Neither
    // being present leaves the section unclassified, which shows it to every
    // level rather than to none, since a field this adapter has never seen on a
    // live install must not be able to hide a class.
    level: str(row.acad_career) || str(row.acad_career_descr) || null,

    seats,
    // Capacity and enrolment feed history and the alert copy, never a decision
    // to notify, so a missing one becomes zero rather than failing the fetch.
    capacity: capacity ?? 0,
    enrollment: enrollment ?? 0,
    waitlist,
    waitlistCap,
    // No field carries this, so it is derived. Clamped at zero because a
    // waitlist can be over-subscribed and "minus three spots free" is not a
    // thing a student can act on.
    waitlistAvailable: Math.max(0, waitlistCap - waitlist),
  }
}

interface PsMeetingDto {
  days?: string
  start_time?: string
  end_time?: string
}

/**
 * The nesting of `meetings` and `instructors` inside a class row is the least
 * verified part of this contract: both are confirmed to exist as row level
 * keys, but no raw body was captured. Both readers below therefore tolerate a
 * missing or unexpected shape and return null rather than throwing, because
 * these fields are display only and losing a meeting time must never cost us a
 * seat count.
 */
function firstMeeting(raw: unknown): PsMeetingDto | null {
  if (!Array.isArray(raw)) return null
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue
    const m = entry as PsMeetingDto
    if (str(m.days) || str(m.start_time) || str(m.end_time)) return m
  }
  return null
}

function firstInstructor(raw: unknown): string | null {
  if (!Array.isArray(raw)) return null
  for (const entry of raw) {
    if (typeof entry === 'string' && entry.trim()) return entry.trim()
    if (entry === null || typeof entry !== 'object') continue
    const rec = entry as Record<string, unknown>
    for (const key of ['name', 'instructor', 'displayName']) {
      const v = rec[key]
      if (typeof v === 'string' && v.trim()) return v.trim()
    }
  }
  return null
}

const DAY_TOKENS: Record<string, string> = {
  mo: 'M',
  tu: 'T',
  we: 'W',
  th: 'R',
  fr: 'F',
  sa: 'S',
  su: 'U',
}

/**
 * "MoWeFr" becomes "MWF", matching the letters Banner already produces so that
 * one section renders the same wherever it came from. R is Thursday, as every
 * registrar in the country writes it.
 */
export function formatDays(raw: string): string | null {
  const compact = raw.replace(/[\s,]/g, '')
  if (compact === '') return null

  let out = ''
  for (let i = 0; i < compact.length; i += 2) {
    const token = compact.slice(i, i + 2).toLowerCase()
    const letter = DAY_TOKENS[token]
    // Unrecognised: hand back the registrar's own string rather than a mangled
    // half-translation. The shape of this field is not verified, and a student
    // can read "M-F" even if we cannot.
    if (!letter) return compact
    out += letter
  }
  return out
}

/**
 * PeopleSoft times arrive in at least three shapes, and which one an install
 * uses is unverified: "10.00.00.000000" is the internal form, "10:00:00" the
 * ISO-ish one, and "10:00 AM" the display one. Anything unparseable becomes
 * null rather than a guess.
 */
export function formatTime(begin: unknown, end: unknown): string | null {
  const b = render(begin)
  const e = render(end)
  if (!b && !e) return null
  if (b && e) return `${b}-${e}`
  return b ?? e
}

function render(raw: unknown): string | null {
  const s = str(raw)
  if (s === '') return null

  const m = /^(\d{1,2})[.:](\d{2})/.exec(s)
  if (!m) return null
  let h = Number(m[1])
  const minutes = m[2]!
  if (!Number.isFinite(h) || h > 23) return null

  const meridiem = /([ap])\.?m/i.exec(s)?.[1]?.toLowerCase()
  if (meridiem === 'p' && h < 12) h += 12
  if (meridiem === 'a' && h === 12) h = 0

  const suffix = h < 12 ? 'a' : 'p'
  const hour12 = h % 12 === 0 ? 12 : h % 12
  return `${hour12}:${minutes}${suffix}`
}

/** "3.00", "3", and "1.00 - 3.00" all mean three credits or fewer. Take the low end, as Banner does. */
function parseUnits(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null
  const m = /-?\d+(\.\d+)?/.exec(str(raw))
  if (!m) return null
  const n = Number(m[0])
  return Number.isFinite(n) ? n : null
}

/**
 * Numeric coercion that keeps "absent" distinct from zero.
 *
 * Zero seats and unknown seats are opposite facts: one is a section a student
 * wants to watch, the other is a row we failed to read. An empty string is
 * absent rather than zero, which Number() would otherwise get backwards.
 */
function optNum(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v !== 'string') return null
  const trimmed = v.trim()
  if (trimmed === '') return null
  const n = Number(trimmed)
  return Number.isFinite(n) ? n : null
}

function str(v: unknown): string {
  if (typeof v === 'string') return v.trim()
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return ''
}

/** Short, single-line excerpt for an error message, so logs stay readable. */
function preview(v: unknown): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  return String(s ?? '').slice(0, 120).replace(/\s+/g, ' ')
}
