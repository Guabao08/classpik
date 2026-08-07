import { describe, expect, it } from 'vitest'
import { BannerAdapter, toRawSection } from '../src/adapters/banner.js'
import { CookieJar, PoliteClient } from '../src/adapters/http.js'
import { SisError } from '../src/adapters/types.js'
import { testSchool } from './helpers.js'

/**
 * The Banner adapter is tested against recorded response shapes rather than a
 * live registrar: pointing load at a university to test our own code would be
 * rude, and a suite that depends on their uptime is a suite that fails on
 * their maintenance window. Live verification is Phase 0's job (see PHASE0.md).
 */

const SECTION_DTO = {
  courseReferenceNumber: '30412',
  subject: 'MATH',
  courseNumber: '221',
  courseTitle: 'Linear Algebra',
  sequenceNumber: 'B',
  creditHours: 3,
  campusDescription: 'Main',
  maximumEnrollment: 90,
  enrollment: 90,
  seatsAvailable: 0,
  waitCapacity: 25,
  waitCount: 14,
  waitAvailable: 11,
  levels: ['Undergraduate'],
  faculty: [{ displayName: 'Whitfield, Dana' }],
  meetingsFaculty: [
    {
      meetingTime: {
        beginTime: '1000',
        endTime: '1050',
        monday: true, tuesday: false, wednesday: true, thursday: false,
        friday: true, saturday: false, sunday: false,
      },
    },
  ],
}

interface StubCall { url: string; method: string; body?: string }

/** Minimal stand-in for a Banner install: cookie, term handshake, search. */
function stubBanner(opts: {
  sections?: unknown[]
  subjects?: unknown[]
  terms?: unknown[]
  totalCount?: number
  authorised?: boolean
  onCall?: (c: StubCall) => void
  searchOverride?: (url: string, page: number) => unknown
} = {}) {
  const calls: StubCall[] = []
  let searchPage = 0

  const fetchImpl = (async (url: string | URL, init: RequestInit = {}) => {
    const u = String(url)
    const call: StubCall = { url: u, method: init.method ?? 'GET', body: init.body as string }
    calls.push(call)
    opts.onCall?.(call)

    const headers = new Headers({ 'content-type': 'application/json' })

    if (u.includes('/classSearch/classSearch')) {
      headers.append('set-cookie', 'JSESSIONID=abc123; Path=/; HttpOnly')
      return new Response('<html>class search</html>', { status: 200, headers })
    }
    if (u.includes('/term/search')) {
      return opts.authorised === false
        ? new Response('<html>error</html>', { status: 200, headers })
        : new Response(JSON.stringify({ fwdURL: '/StudentRegistrationSsb/ssb/classSearch/classSearch' }), { status: 200, headers })
    }
    if (u.includes('/classSearch/resetDataForm')) {
      return new Response('true', { status: 200, headers })
    }
    if (u.includes('/classSearch/get_subject')) {
      return new Response(JSON.stringify(opts.subjects ?? []), { status: 200, headers })
    }
    if (u.includes('/classSearch/getTerms')) {
      return new Response(
        JSON.stringify(
          opts.terms ?? [
            { code: '202608', description: 'Fall 2026' },
            { code: '202602', description: 'Spring 2026 <span>(View only)</span>' },
          ]
        ),
        { status: 200, headers }
      )
    }
    if (u.includes('/searchResults/searchResults')) {
      if (opts.searchOverride) {
        return new Response(JSON.stringify(opts.searchOverride(u, searchPage++)), { status: 200, headers })
      }
      const data = opts.sections ?? [SECTION_DTO]
      return new Response(
        JSON.stringify({ success: true, totalCount: opts.totalCount ?? data.length, data }),
        { status: 200, headers }
      )
    }
    return new Response('not found', { status: 404 })
  }) as unknown as typeof fetch

  const client = new PoliteClient({ fetchImpl, minRequestGapMs: 0, sleep: async () => {} })
  return { adapter: new BannerAdapter(client), calls, client }
}

describe('toRawSection', () => {
  it('maps Banner field names onto our shape', () => {
    const s = toRawSection(SECTION_DTO as never)
    expect(s).toMatchObject({
      crn: '30412',
      subject: 'MATH',
      courseNumber: '221',
      code: 'MATH 221',
      title: 'Linear Algebra',
      section: 'B',
      seats: 0,
      capacity: 90,
      enrollment: 90,
      waitlist: 14,
      waitlistCap: 25,
      waitlistAvailable: 11,
    })
  })

  it('decodes escaped text, because Banner escapes free text in its JSON', () => {
    const escaped = {
      ...SECTION_DTO,
      courseTitle: 'Data Structures &amp; Algorithms',
      campusDescription: 'Main &amp; Midtown',
      faculty: [{ displayName: 'O&#39;Brien, Dana' }],
    }
    const s = toRawSection(escaped as never)
    expect(s.title).toBe('Data Structures & Algorithms')
    expect(s.campus).toBe('Main & Midtown')
    expect(s.instructor).toBe("O'Brien, Dana")
  })

  it('reports blank display text as absent rather than empty', () => {
    // Null is our "this install does not report it"; an empty string would
    // render as a field the registrar filled in with nothing.
    const blank = { ...SECTION_DTO, campusDescription: '   ', faculty: [{ displayName: '  ' }] }
    const s = toRawSection(blank as never)
    expect(s.campus).toBeNull()
    expect(s.instructor).toBeNull()
  })

  it('maps the section level, which is a registrar fact and not a preference', () => {
    expect(toRawSection(SECTION_DTO as never).level).toBe('Undergraduate')
  })

  it('falls back to the scalar spelling installs differ on', () => {
    const scalar = { ...SECTION_DTO, levels: [], levelDescription: 'Graduate' }
    expect(toRawSection(scalar as never).level).toBe('Graduate')
  })

  it('keeps the first level of a cross-listed section', () => {
    const both = { ...SECTION_DTO, levels: ['Graduate', 'Undergraduate'] }
    expect(toRawSection(both as never).level).toBe('Graduate')
  })

  it('leaves a section unclassified rather than guessing a level for it', () => {
    // Unclassified is shown to every level, so an install that reports nothing
    // here loses no classes. Guessing "Undergraduate" would hide a graduate
    // student's entire catalog behind a field we never saw.
    const { levels: _levels, ...bare } = SECTION_DTO
    expect(toRawSection(bare as never).level).toBeNull()
  })

  it('encodes meeting days as registrar letters, with R for Thursday', () => {
    expect(toRawSection(SECTION_DTO as never).meetingDays).toBe('MWF')

    const tr = {
      ...SECTION_DTO,
      meetingsFaculty: [
        {
          meetingTime: {
            beginTime: '0930', endTime: '1045',
            monday: false, tuesday: true, wednesday: false, thursday: true,
            friday: false, saturday: false, sunday: false,
          },
        },
      ],
    }
    expect(toRawSection(tr as never).meetingDays).toBe('TR')
  })

  it('converts 24-hour military times into something a student reads', () => {
    expect(toRawSection(SECTION_DTO as never).meetingTime).toBe('10:00a-10:50a')

    const afternoon = {
      ...SECTION_DTO,
      meetingsFaculty: [
        { meetingTime: { ...SECTION_DTO.meetingsFaculty[0]!.meetingTime, beginTime: '1300', endTime: '1415' } },
      ],
    }
    expect(toRawSection(afternoon as never).meetingTime).toBe('1:00p-2:15p')
  })

  it('renders midnight and noon without producing a zero hour', () => {
    const noon = {
      ...SECTION_DTO,
      meetingsFaculty: [
        { meetingTime: { ...SECTION_DTO.meetingsFaculty[0]!.meetingTime, beginTime: '1200', endTime: '1250' } },
      ],
    }
    expect(toRawSection(noon as never).meetingTime).toBe('12:00p-12:50p')

    const midnight = {
      ...SECTION_DTO,
      meetingsFaculty: [
        { meetingTime: { ...SECTION_DTO.meetingsFaculty[0]!.meetingTime, beginTime: '0000', endTime: '0050' } },
      ],
    }
    expect(toRawSection(midnight as never).meetingTime).toBe('12:00a-12:50a')
  })

  it('survives async sections with no meeting time and no faculty', () => {
    const online = { ...SECTION_DTO, meetingsFaculty: [], faculty: [] }
    const s = toRawSection(online as never)
    expect(s.meetingDays).toBeNull()
    expect(s.meetingTime).toBeNull()
    expect(s.instructor).toBeNull()
  })

  it('coerces missing or non-numeric counts to zero rather than NaN', () => {
    const broken = {
      ...SECTION_DTO,
      seatsAvailable: null, maximumEnrollment: undefined, waitCount: 'x',
    }
    const s = toRawSection(broken as never)
    expect(s.seats).toBe(0)
    expect(s.capacity).toBe(0)
    expect(s.waitlist).toBe(0)
    expect(Number.isNaN(s.seats)).toBe(false)
  })

  it('preserves a negative seat count from an over-enrolled section', () => {
    const over = { ...SECTION_DTO, seatsAvailable: -4 }
    expect(toRawSection(over as never).seats).toBe(-4)
  })
})

describe('BannerAdapter', () => {
  it('performs the cookie then term handshake before searching', async () => {
    const { adapter, calls } = stubBanner()
    await adapter.fetchSections(testSchool(), '202608', 'MATH')

    const order = calls.map((c) => {
      if (c.url.includes('classSearch/classSearch')) return 'cookie'
      if (c.url.includes('term/search')) return 'term'
      if (c.url.includes('resetDataForm')) return 'reset'
      if (c.url.includes('searchResults')) return 'search'
      return 'other'
    })
    expect(order.indexOf('cookie')).toBeLessThan(order.indexOf('term'))
    expect(order.indexOf('term')).toBeLessThan(order.indexOf('search'))
  })

  it('POSTs the term it intends to search', async () => {
    const { adapter, calls } = stubBanner()
    await adapter.fetchSections(testSchool(), '202608', 'MATH')
    const termCall = calls.find((c) => c.url.includes('term/search'))!
    expect(termCall.method).toBe('POST')
    expect(termCall.body).toContain('term=202608')
  })

  it('resets search state before each subject, or Banner replays the last one', async () => {
    const { adapter, calls } = stubBanner()
    await adapter.fetchSections(testSchool(), '202608', 'MATH')
    const resetIdx = calls.findIndex((c) => c.url.includes('resetDataForm'))
    const searchIdx = calls.findIndex((c) => c.url.includes('searchResults'))
    expect(resetIdx).toBeGreaterThanOrEqual(0)
    expect(resetIdx).toBeLessThan(searchIdx)
  })

  it('reuses the session across subjects instead of re-handshaking', async () => {
    const { adapter, calls } = stubBanner()
    const school = testSchool()
    await adapter.fetchSections(school, '202608', 'MATH')
    const afterFirst = calls.filter((c) => c.url.includes('term/search')).length
    await adapter.fetchSections(school, '202608', 'CS')
    const afterSecond = calls.filter((c) => c.url.includes('term/search')).length
    expect(afterFirst).toBe(1)
    expect(afterSecond).toBe(1)
  })

  it('sends the session cookie on the search request', async () => {
    let sawCookie: string | null = null
    const fetchImpl = (async (url: string | URL, init: RequestInit = {}) => {
      const u = String(url)
      const headers = new Headers({ 'content-type': 'application/json' })
      if (u.includes('/classSearch/classSearch')) {
        headers.append('set-cookie', 'JSESSIONID=sess-42; Path=/')
        return new Response('ok', { status: 200, headers })
      }
      if (u.includes('/term/search')) return new Response('{"fwdURL":"/x"}', { status: 200, headers })
      if (u.includes('resetDataForm')) return new Response('true', { status: 200, headers })
      if (u.includes('searchResults')) {
        sawCookie = new Headers(init.headers).get('cookie')
        return new Response(JSON.stringify({ success: true, totalCount: 1, data: [SECTION_DTO] }), { status: 200, headers })
      }
      return new Response('x', { status: 404 })
    }) as unknown as typeof fetch

    const adapter = new BannerAdapter(new PoliteClient({ fetchImpl, minRequestGapMs: 0, sleep: async () => {} }))
    await adapter.fetchSections(testSchool(), '202608', 'MATH')
    expect(sawCookie).toContain('JSESSIONID=sess-42')
  })

  it('treats an empty first page as a broken session, not an empty subject', async () => {
    // Banner answers an unauthorised term with 200 and zero rows. Accepting
    // that as "no classes" would make us report every section as vanished.
    const { adapter } = stubBanner({ sections: [], totalCount: 0 })
    await expect(adapter.fetchSections(testSchool(), '202608', 'MATH')).rejects.toThrow(
      /not authorised/i
    )
  })

  it('invalidates the cached session after that failure so the next try re-handshakes', async () => {
    const { adapter, calls } = stubBanner({ sections: [], totalCount: 0 })
    const school = testSchool()
    await adapter.fetchSections(school, '202608', 'MATH').catch(() => {})
    await adapter.fetchSections(school, '202608', 'MATH').catch(() => {})
    expect(calls.filter((c) => c.url.includes('term/search')).length).toBe(2)
  })

  it('raises a transient error when the term handshake is rejected', async () => {
    const { adapter } = stubBanner({ authorised: false })
    await expect(adapter.fetchSections(testSchool(), '202608', 'MATH')).rejects.toMatchObject({
      name: 'SisError',
      transient: true,
    })
  })

  it('raises when the API reports success=false', async () => {
    const { adapter } = stubBanner({
      searchOverride: () => ({ success: false, totalCount: 0, data: [] }),
    })
    await expect(adapter.fetchSections(testSchool(), '202608', 'MATH')).rejects.toThrow(
      /success=false/
    )
  })

  it('pages until it has every section', async () => {
    // Banner caps a page at 500, so a 700-section subject needs two requests.
    const page = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ ...SECTION_DTO, courseReferenceNumber: `c${i}` }))
    const { adapter } = stubBanner({
      searchOverride: (_url, p) =>
        p === 0
          ? { success: true, totalCount: 700, data: page(500) }
          : { success: true, totalCount: 700, data: page(200).map((s, i) => ({ ...s, courseReferenceNumber: `d${i}` })) },
    })
    const out = await adapter.fetchSections(testSchool(), '202608', 'MATH')
    expect(out).toHaveLength(700)
  })

  it('stops paging when a page comes back empty', async () => {
    // This exists so an empty page cannot spin the pager forever, and it still
    // does. What changed is the verdict: it used to assert that the short list
    // was returned, which is the behaviour that made 1268 live sections vanish
    // from search. Terminating by refusing is still terminating.
    const { adapter } = stubBanner({
      searchOverride: (_url, p) =>
        p === 0
          ? { success: true, totalCount: 9999, data: [SECTION_DTO] }
          : { success: true, totalCount: 9999, data: [] },
    })
    await expect(adapter.fetchSections(testSchool(), '202608', 'MATH')).rejects.toThrow(
      /truncated read/
    )
  })

  it('lists terms and strips the markup Banner puts in descriptions', async () => {
    const { adapter } = stubBanner()
    const terms = await adapter.listTerms(testSchool())
    expect(terms[0]).toEqual({ code: '202608', description: 'Fall 2026' })
    expect(terms[1]!.description).toBe('Spring 2026 (View only)')
  })

  it('refuses a truncated read instead of returning a short list', async () => {
    /*
     * Observed live at Georgia Tech: a session that lapsed between page one and
     * page two returned 500 of 1751 CS sections. The loop broke on the empty
     * page and handed back what it had, the caller could not tell a short list
     * from a complete one, and 1268 sections were marked absent and vanished
     * from search. A short read has to be an error, not a result.
     */
    const row = (crn: string) => ({ ...SECTION_DTO, courseReferenceNumber: crn })
    const { adapter } = stubBanner({
      searchOverride: (_url, page) =>
        page === 0
          ? { success: true, totalCount: 3, data: [row('1'), row('2')] }
          : { success: true, totalCount: 3, data: [] },
    })

    await expect(adapter.fetchSections(testSchool(), '202608', 'CS')).rejects.toThrow(
      /truncated read for CS in 202608: got 2 of 3/
    )
  })

  it('re-handshakes after a truncated read rather than reusing the bad session', async () => {
    const row = (crn: string) => ({ ...SECTION_DTO, courseReferenceNumber: crn })
    const { adapter, calls } = stubBanner({
      searchOverride: (_url, page) =>
        page === 0
          ? { success: true, totalCount: 3, data: [row('1'), row('2')] }
          : { success: true, totalCount: 3, data: [] },
    })
    const school = testSchool()

    await adapter.fetchSections(school, '202608', 'CS').catch(() => {})
    await adapter.fetchSections(school, '202608', 'CS').catch(() => {})

    // Two attempts, two handshakes. The session that produced the short read is
    // the thing that was wrong, so keeping it cached would repeat the failure
    // for the whole session TTL.
    const handshakes = calls.filter((c) => c.url.includes('/term/search')).length
    expect(handshakes).toBe(2)
  })

  it('still reads a complete multi-page result', async () => {
    const row = (crn: string) => ({ ...SECTION_DTO, courseReferenceNumber: crn })
    const { adapter } = stubBanner({
      searchOverride: (_url, page) =>
        page === 0
          ? { success: true, totalCount: 3, data: [row('1'), row('2')] }
          : { success: true, totalCount: 3, data: [row('3')] },
    })

    const sections = await adapter.fetchSections(testSchool(), '202608', 'CS')
    expect(sections.map((s) => s.crn)).toEqual(['1', '2', '3'])
  })

  it('follows a catalog that shrinks between pages rather than failing on it', async () => {
    // totalCount is re-read every page on purpose. A registrar that removes a
    // section mid-read is not a truncated response, and treating it as one
    // would retry forever against a catalog that is simply changing.
    const row = (crn: string) => ({ ...SECTION_DTO, courseReferenceNumber: crn })
    const { adapter } = stubBanner({
      searchOverride: (_url, page) =>
        page === 0
          ? { success: true, totalCount: 4, data: [row('1'), row('2')] }
          : { success: true, totalCount: 2, data: [] },
    })

    const sections = await adapter.fetchSections(testSchool(), '202608', 'CS')
    expect(sections.map((s) => s.crn)).toEqual(['1', '2'])
  })

  it('does not let one term de-authorise another mid-flight', async () => {
    // Observed live at Georgia Tech: subject discovery walked the Language
    // Institute terms while the Fall MATH poll was running, and because Banner
    // holds the authorised term per cookie, MATH searched a session authorised
    // for another term. The answer is an empty 200, which the adapter can only
    // read as "no rows", so MATH failed every single tick.
    let authorised: string | null = null
    const termsSeenBySearch: Array<string | null> = []

    const fetchImpl = (async (url: string | URL, init: RequestInit = {}) => {
      const u = String(url)
      const headers = new Headers({ 'content-type': 'application/json' })

      if (u.includes('/classSearch/classSearch')) {
        headers.append('set-cookie', 'JSESSIONID=abc123; Path=/; HttpOnly')
        return new Response('<html/>', { status: 200, headers })
      }
      if (u.includes('/term/search')) {
        // One authorised term per host, exactly as the registrar behaves.
        authorised = new URLSearchParams(init.body as string).get('term')
        return new Response(JSON.stringify({ fwdURL: '/x' }), { status: 200, headers })
      }
      if (u.includes('/classSearch/resetDataForm')) {
        return new Response('true', { status: 200, headers })
      }
      if (u.includes('/classSearch/get_subject')) {
        return new Response(JSON.stringify([{ code: 'CS', description: 'CS' }]), { status: 200, headers })
      }
      if (u.includes('/searchResults/searchResults')) {
        const wanted = new URL(u, 'http://x').searchParams.get('txt_term')
        termsSeenBySearch.push(authorised)
        // An unauthorised term is a 200 with nothing in it, never an error.
        const ok = wanted === authorised
        return new Response(
          JSON.stringify({ success: true, totalCount: ok ? 1 : 0, data: ok ? [SECTION_DTO] : [] }),
          { status: 200, headers }
        )
      }
      return new Response('not found', { status: 404 })
    }) as unknown as typeof fetch

    const adapter = new BannerAdapter(
      new PoliteClient({ fetchImpl, minRequestGapMs: 0, sleep: async () => {} })
    )
    const school = testSchool()

    // Concurrent, on the same host, on different terms: the live shape.
    const [sections] = await Promise.all([
      adapter.fetchSections(school, '202608', 'MATH'),
      adapter.listSubjects(school, '202623'),
      adapter.listSubjects(school, '202622'),
    ])

    expect(sections).toHaveLength(1)
    // Every search ran against a session authorised for the term it asked for.
    expect(termsSeenBySearch).toEqual(['202608'])
  })

  it('re-runs the handshake when the cached session is for another term', async () => {
    const { adapter, calls } = stubBanner()
    const school = testSchool()

    await adapter.fetchSections(school, '202608', 'MATH')
    await adapter.fetchSections(school, '202602', 'MATH')
    await adapter.fetchSections(school, '202602', 'CS')

    const authorised = calls
      .filter((c) => c.url.includes('/term/search'))
      .map((c) => new URLSearchParams(c.body).get('term'))

    // Three reads, two terms: re-authorise on the switch, and only then. The
    // second 202602 read reuses the session rather than paying for it again.
    expect(authorised).toEqual(['202608', '202602'])
  })

  it('decodes escaped subject names', async () => {
    // Verbatim from Georgia Tech's get_subject response on 2026-07-31. Stored
    // raw, this both displays wrong and stops "Chemical &" from matching.
    const { adapter } = stubBanner({
      subjects: [
        { code: 'CHBE', description: 'Chemical &amp; Biomolecular Engr' },
        { code: 'CS', description: 'Computer Science' },
      ],
    })
    const subjects = await adapter.listSubjects(testSchool(), '202608')
    expect(subjects).toEqual([
      { code: 'CHBE', description: 'Chemical & Biomolecular Engr' },
      { code: 'CS', description: 'Computer Science' },
    ])
  })

  it('strips term markup before decoding entities, not after', async () => {
    // Order matters: decoding first would turn a literal `&lt;b&gt;` into a
    // tag that the stripper then eats, losing text the registrar meant to show.
    const { adapter } = stubBanner({
      terms: [{ code: '202608', description: 'Fall &amp; Winter <b>2026</b>' }],
    })
    const terms = await adapter.listTerms(testSchool())
    expect(terms[0]!.description).toBe('Fall & Winter 2026')
  })

  it('surfaces an HTML error page as a readable error, not a JSON parse crash', async () => {
    const fetchImpl = (async (url: string | URL) => {
      const u = String(url)
      if (u.includes('getTerms')) {
        return new Response('<!DOCTYPE html><html><body>Service unavailable</body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        })
      }
      return new Response('x', { status: 404 })
    }) as unknown as typeof fetch

    const adapter = new BannerAdapter(new PoliteClient({ fetchImpl, minRequestGapMs: 0, sleep: async () => {} }))
    await expect(adapter.listTerms(testSchool())).rejects.toThrow(/expected JSON/)
  })

  it('honours a custom registrationPath', async () => {
    const { adapter, calls } = stubBanner()
    await adapter
      .fetchSections(testSchool({ registrationPath: '/custom/ssb' }), '202608', 'MATH')
      .catch(() => {})
    expect(calls.every((c) => c.url.includes('/custom/ssb/'))).toBe(true)
  })
})

describe('CookieJar', () => {
  it('stores and replays a cookie for the same host', () => {
    const jar = new CookieJar()
    const res = new Response('', { headers: { 'set-cookie': 'JSESSIONID=xyz; Path=/; HttpOnly' } })
    jar.absorb('https://a.test/x', res)
    expect(jar.header('https://a.test/y')).toBe('JSESSIONID=xyz')
  })

  it('does not leak cookies across hosts', () => {
    const jar = new CookieJar()
    jar.absorb('https://a.test/x', new Response('', { headers: { 'set-cookie': 'S=1' } }))
    expect(jar.header('https://b.test/x')).toBeNull()
  })

  it('overwrites a cookie when the server rotates it', () => {
    const jar = new CookieJar()
    jar.absorb('https://a.test/', new Response('', { headers: { 'set-cookie': 'S=1' } }))
    jar.absorb('https://a.test/', new Response('', { headers: { 'set-cookie': 'S=2' } }))
    expect(jar.header('https://a.test/')).toBe('S=2')
  })

  it('returns null when nothing has been stored', () => {
    expect(new CookieJar().header('https://a.test/')).toBeNull()
  })

  it('clears one host without touching the others', () => {
    const jar = new CookieJar()
    jar.absorb('https://a.test/', new Response('', { headers: { 'set-cookie': 'S=1' } }))
    jar.absorb('https://b.test/', new Response('', { headers: { 'set-cookie': 'S=2' } }))
    jar.clear('https://a.test/')
    expect(jar.header('https://a.test/')).toBeNull()
    expect(jar.header('https://b.test/')).toBe('S=2')
  })
})

describe('SisError', () => {
  it('defaults to transient, because most upstream failures are', () => {
    expect(new SisError('x').transient).toBe(true)
  })
})
