import type {
  FetchOptions,
  RawSection,
  SchoolConfig,
  SisAdapter,
  Subject,
  Term,
} from './types.js'

/**
 * A simulated student system.
 *
 * Exists so the whole service can be run and tested end to end without
 * touching a real registrar. That matters for two reasons: pointing load at a
 * university to check our own code is rude, and a test suite that depends on
 * a third party is a test suite that fails on their maintenance window.
 *
 * The simulation is deterministic given a seed, so "a seat opened on poll 3"
 * is reproducible rather than something you wait around for.
 */

export interface FixtureSection {
  crn: string
  subject: string
  courseNumber: string
  title: string
  section: string
  credits?: number
  instructor?: string
  meetingDays?: string
  meetingTime?: string
  /** Registrar level code. Absent means the install reports none, which is a real case. */
  level?: string
  seats: number
  capacity: number
  waitlist?: number
  waitlistCap?: number
}

export interface FixtureScript {
  /** Poll number (1-based) to a set of CRN -> seat count overrides. */
  [pollNumber: number]: Record<string, { seats?: number; waitlist?: number }>
}

export class FixtureAdapter implements SisAdapter {
  readonly id = 'banner9' as const

  private pollCounts = new Map<string, number>()

  constructor(
    private readonly sections: FixtureSection[],
    private readonly script: FixtureScript = {},
    private readonly terms: Term[] = [{ code: '202608', description: 'Fall 2026' }]
  ) {}

  async listTerms(): Promise<Term[]> {
    return this.terms
  }

  async listSubjects(): Promise<Subject[]> {
    const codes = [...new Set(this.sections.map((s) => s.subject))]
    return codes.map((code) => ({ code, description: code }))
  }

  async fetchSections(
    _school: SchoolConfig,
    _term: string,
    subject: string,
    opts: FetchOptions = {}
  ): Promise<RawSection[]> {
    if (opts.signal?.aborted) throw new Error('aborted')

    const n = (this.pollCounts.get(subject) ?? 0) + 1
    this.pollCounts.set(subject, n)
    const overrides = this.script[n] ?? {}

    return this.sections
      .filter((s) => s.subject === subject)
      .map((s) => {
        const o = overrides[s.crn] ?? {}
        const seats = o.seats ?? s.seats
        const waitlist = o.waitlist ?? s.waitlist ?? 0
        const waitlistCap = s.waitlistCap ?? 0
        return {
          crn: s.crn,
          subject: s.subject,
          courseNumber: s.courseNumber,
          code: `${s.subject} ${s.courseNumber}`,
          title: s.title,
          section: s.section,
          credits: s.credits ?? null,
          instructor: s.instructor ?? null,
          meetingDays: s.meetingDays ?? null,
          meetingTime: s.meetingTime ?? null,
          campus: null,
          level: s.level ?? null,
          seats,
          capacity: s.capacity,
          enrollment: Math.max(0, s.capacity - seats),
          waitlist,
          waitlistCap,
          waitlistAvailable: Math.max(0, waitlistCap - waitlist),
        }
      })
  }

  /** Test helper: how many times a subject has been fetched. */
  pollCount(subject: string): number {
    return this.pollCounts.get(subject) ?? 0
  }

  reset(): void {
    this.pollCounts.clear()
  }
}

/**
 * A small, realistic catalog used by the demo and by tests.
 *
 * Two levels on purpose. With one, level scoping looks like it works when it is
 * doing nothing at all, and the demo would never show a student a catalog
 * narrowed to their own.
 */
export const DEMO_SECTIONS: FixtureSection[] = [
  { crn: '30412', subject: 'MATH', courseNumber: '221', title: 'Linear Algebra', section: 'B', credits: 3, instructor: 'Whitfield', meetingDays: 'MWF', meetingTime: '10:00a-10:50a', level: 'UGRD', seats: 0, capacity: 90, waitlist: 14, waitlistCap: 25 },
  { crn: '30413', subject: 'MATH', courseNumber: '221', title: 'Linear Algebra', section: 'C', credits: 3, instructor: 'Okonkwo', meetingDays: 'TR', meetingTime: '2:00p-3:15p', level: 'UGRD', seats: 0, capacity: 90, waitlist: 25, waitlistCap: 25 },
  { crn: '30418', subject: 'MATH', courseNumber: '221', title: 'Linear Algebra', section: 'E', credits: 3, instructor: 'Bhatt', meetingDays: 'MWF', meetingTime: '8:00a-8:50a', level: 'UGRD', seats: 22, capacity: 90, waitlist: 0, waitlistCap: 25 },
  { crn: '30500', subject: 'MATH', courseNumber: '310', title: 'Real Analysis', section: 'A', credits: 3, instructor: 'Ferreira', meetingDays: 'TR', meetingTime: '9:30a-10:45a', level: 'UGRD', seats: 0, capacity: 45, waitlist: 6, waitlistCap: 15 },
  { crn: '30188', subject: 'CS', courseNumber: '260', title: 'Data Structures', section: 'A', credits: 4, instructor: 'Alvarez', meetingDays: 'MWF', meetingTime: '1:00p-1:50p', level: 'UGRD', seats: 3, capacity: 240, waitlist: 0, waitlistCap: 40 },
  { crn: '30190', subject: 'CS', courseNumber: '260', title: 'Data Structures', section: 'B', credits: 4, instructor: 'Lindqvist', meetingDays: 'TR', meetingTime: '9:30a-10:45a', level: 'UGRD', seats: 0, capacity: 200, waitlist: 24, waitlistCap: 40 },
  { crn: '30655', subject: 'CS', courseNumber: '340', title: 'Operating Systems', section: 'D', credits: 3, instructor: 'Moreau', meetingDays: 'TR', meetingTime: '12:30p-1:45p', level: 'UGRD', seats: 0, capacity: 60, waitlist: 28, waitlistCap: 30 },
  { crn: '30720', subject: 'CS', courseNumber: '610', title: 'Distributed Systems', section: 'A', credits: 3, instructor: 'Ferreira', meetingDays: 'W', meetingTime: '4:00p-6:45p', level: 'GRAD', seats: 0, capacity: 30, waitlist: 9, waitlistCap: 20 },
]
