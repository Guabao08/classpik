import { describe, expect, it } from 'vitest'
import { PoliteClient } from '../src/adapters/http.js'
import { PeopleSoftAdapter, toRawSection } from '../src/adapters/peoplesoft.js'
import type { SchoolConfig } from '../src/adapters/types.js'
import { ConfigError, loadSchoolsFromDir, parseSchoolConfig } from '../src/config/schools.js'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/**
 * Tested against recorded response shapes, never a live install, for the same
 * reason the Banner suite is: pointing load at a university to check our own
 * code would be rude, and a suite that depends on their uptime fails during
 * their maintenance window.
 *
 * The two row shapes below are the ones this contract was reconstructed from.
 * SEARCH_ROW carries numbers with wait_tot and wait_cap. DETAIL_ROW carries the
 * same quantities as strings, with a different spelling of the waitlist keys
 * and one number left as a number in the middle of them. That mismatch is a
 * fixture on purpose rather than an accident that happens to pass.
 */

const here = dirname(fileURLToPath(import.meta.url))

const SEARCH_ROW = {
  class_nbr: 30412,
  subject: 'MATH',
  catalog_nbr: '221',
  descr: 'Linear Algebra',
  class_section: 'B',
  units: '3.00',
  campus: 'MAIN',
  campus_descr: 'Main Campus',
  enrl_stat: 'C',
  class_capacity: 90,
  enrollment_total: 90,
  enrollment_available: 0,
  wait_cap: 25,
  wait_tot: 14,
  instructors: [{ name: 'Whitfield, Dana' }],
  meetings: [{ days: 'MoWeFr', start_time: '10.00.00.000000', end_time: '10.50.00.000000' }],
}

const DETAIL_ROW = {
  class_nbr: '31324',
  subject: 'MATH',
  catalog_nbr: '310',
  descr: 'Real Analysis',
  class_section: '1010',
  class_capacity: '28',
  enrollment_total: '24',
  enrollment_available: 4,
  wait_list_capacity: '50',
  wait_list_total: '7',
}

const CLASS_SEARCH = 'IScript_ClassSearch'
const CATALOG_SUBJECTS = 'IScript_CatalogSubjects'

const SCHOOL_YAML = {
  id: 'test-peoplesoft',
  name: 'Test PeopleSoft University',
  sis: 'peoplesoft',
  baseUrl: 'https://sis.test.invalid',
  peoplesoft: {
    scriptPath: '/psc/exprd/EMPLOYEE/SA/s/',
    institution: 'EX001',
    terms: [{ code: '1252', description: 'Spring 2025' }],
  },
  subjects: ['MATH', 'CS'],
  enabled: true,
}

function psSchool(over: Record<string, unknown> = {}): SchoolConfig {
  return parseSchoolConfig({ ...SCHOOL_YAML, ...over }, 'test')
}

interface StubCall {
  url: URL
  method: string
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

/** Minimal stand-in for a HighPoint CX install: two GET endpoints, no session. */
function stubHighPoint(
  opts: {
    search?: (page: number, url: URL) => Response
    subjects?: () => Response
  } = {}
) {
  const calls: StubCall[] = []

  const fetchImpl = (async (url: string | URL, init: RequestInit = {}) => {
    const u = new URL(String(url))
    calls.push({ url: u, method: init.method ?? 'GET' })

    if (u.pathname.endsWith(CATALOG_SUBJECTS)) {
      return opts.subjects
        ? opts.subjects()
        : jsonResponse({
            subjects: [
              { subject: 'MATH', descr: 'Mathematics' },
              { subject: 'CS', descrformal: 'Computer Science' },
            ],
          })
    }

    if (u.pathname.endsWith(CLASS_SEARCH)) {
      const page = Number(u.searchParams.get('page'))
      if (opts.search) return opts.search(page, u)
      return jsonResponse({ classes: page === 1 ? [SEARCH_ROW] : [] })
    }

    return new Response('not found', { status: 404 })
  }) as unknown as typeof fetch

  const client = new PoliteClient({ fetchImpl, minRequestGapMs: 0, sleep: async () => {} })
  return { adapter: new PeopleSoftAdapter(client), calls }
}

describe('toRawSection', () => {
  it('maps a class search row onto our shape', () => {
    expect(toRawSection(SEARCH_ROW)).toEqual({
      crn: '30412',
      subject: 'MATH',
      courseNumber: '221',
      code: 'MATH 221',
      title: 'Linear Algebra',
      section: 'B',
      credits: 3,
      instructor: 'Whitfield, Dana',
      meetingDays: 'MWF',
      meetingTime: '10:00a-10:50a',
      campus: 'Main Campus',
      seats: 0,
      capacity: 90,
      enrollment: 90,
      waitlist: 14,
      waitlistCap: 25,
      waitlistAvailable: 11,
    })
  })

  it('reads counts that arrive as strings alongside ones that arrive as numbers', () => {
    const s = toRawSection(DETAIL_ROW)
    expect(s).toMatchObject({ seats: 4, capacity: 28, enrollment: 24 })
    expect(typeof s.capacity).toBe('number')
  })

  it('accepts the detail endpoint spelling of the waitlist fields', () => {
    const s = toRawSection(DETAIL_ROW)
    expect(s.waitlist).toBe(7)
    expect(s.waitlistCap).toBe(50)
    expect(s.waitlistAvailable).toBe(43)
  })

  it('prefers the registrar available count over capacity minus enrolment', () => {
    // They disagree wherever seats are held back for a cohort, and the number
    // the student sees on the class search is the one they act on.
    const reserved = { ...SEARCH_ROW, class_capacity: 90, enrollment_total: 80, enrollment_available: 2 }
    expect(toRawSection(reserved).seats).toBe(2)
  })

  it('derives seats from capacity and enrolment when no available count is sent', () => {
    const { enrollment_available: _drop, ...row } = SEARCH_ROW
    expect(toRawSection({ ...row, class_capacity: 30, enrollment_total: 28 }).seats).toBe(2)
  })

  it('preserves a negative seat count from an over-enrolled section', () => {
    expect(toRawSection({ ...SEARCH_ROW, enrollment_available: -4 }).seats).toBe(-4)
  })

  it('treats an empty string count as absent rather than as zero seats', () => {
    // Number('') is 0, which would read an unfilled field as a full section.
    const s = toRawSection({
      ...SEARCH_ROW,
      enrollment_available: '',
      class_capacity: 30,
      enrollment_total: 28,
    })
    expect(s.seats).toBe(2)
  })

  it('raises rather than reporting a row with no readable seat counts as full', () => {
    // Zero seats would mark the section permanently full and the student
    // watching it would never be told a seat opened.
    const blind = { class_nbr: 40001, subject: 'MATH', catalog_nbr: '221' }
    expect(() => toRawSection(blind)).toThrow(/no readable seat counts/)
    expect(() => toRawSection({ ...blind, class_capacity: 30 })).toThrow(/no readable seat counts/)
    expect(() => toRawSection({ ...blind, enrollment_total: 28 })).toThrow(/no readable seat counts/)
  })

  it('raises on a row with no class number, because we could not key it', () => {
    const { class_nbr: _drop, ...row } = SEARCH_ROW
    expect(() => toRawSection(row)).toThrow(/class_nbr/)
  })

  it('raises on a non-numeric seat count instead of coercing it to zero', () => {
    expect(() =>
      toRawSection({ ...SEARCH_ROW, enrollment_available: 'N/A', class_capacity: 'N/A', enrollment_total: 'N/A' })
    ).toThrow(/no readable seat counts/)
  })

  it('clamps an over-subscribed waitlist at zero spots free', () => {
    const s = toRawSection({ ...SEARCH_ROW, wait_cap: 25, wait_tot: 30 })
    expect(s.waitlistAvailable).toBe(0)
  })

  it('reports a section with no waitlist as zeros rather than failing', () => {
    const { wait_cap: _c, wait_tot: _t, ...row } = SEARCH_ROW
    const s = toRawSection(row)
    expect(s.waitlist).toBe(0)
    expect(s.waitlistCap).toBe(0)
    expect(s.waitlistAvailable).toBe(0)
  })

  it('reads credits from a units string and takes the low end of a range', () => {
    expect(toRawSection({ ...SEARCH_ROW, units: '4.00' }).credits).toBe(4)
    expect(toRawSection({ ...SEARCH_ROW, units: '1.00 - 3.00' }).credits).toBe(1)
    expect(toRawSection({ ...SEARCH_ROW, units: 3 }).credits).toBe(3)
  })

  it('returns no credits rather than a guess when units are unreadable', () => {
    expect(toRawSection({ ...SEARCH_ROW, units: 'Var' }).credits).toBeNull()
  })

  it('converts PeopleSoft day tokens to registrar letters, with R for Thursday', () => {
    const days = (d: string) =>
      toRawSection({ ...SEARCH_ROW, meetings: [{ days: d, start_time: '10:00' }] }).meetingDays
    expect(days('MoWeFr')).toBe('MWF')
    expect(days('TuTh')).toBe('TR')
    expect(days('SaSu')).toBe('SU')
    expect(days('Mo, We, Fr')).toBe('MWF')
  })

  it('hands back an unrecognised day string instead of mangling it', () => {
    expect(
      toRawSection({ ...SEARCH_ROW, meetings: [{ days: 'M-F', start_time: '10:00' }] }).meetingDays
    ).toBe('M-F')
  })

  it('renders the internal time format as something a student reads', () => {
    expect(toRawSection(SEARCH_ROW).meetingTime).toBe('10:00a-10:50a')
    expect(
      toRawSection({
        ...SEARCH_ROW,
        meetings: [{ days: 'TuTh', start_time: '13.00.00.000000', end_time: '14.15.00.000000' }],
      }).meetingTime
    ).toBe('1:00p-2:15p')
  })

  it('renders display times that carry a meridiem', () => {
    expect(
      toRawSection({
        ...SEARCH_ROW,
        meetings: [{ days: 'TuTh', start_time: '1:00 PM', end_time: '2:15PM' }],
      }).meetingTime
    ).toBe('1:00p-2:15p')
  })

  it('renders noon and midnight without producing a zero hour', () => {
    const at = (start: string, end: string) =>
      toRawSection({ ...SEARCH_ROW, meetings: [{ days: 'Mo', start_time: start, end_time: end }] })
        .meetingTime
    expect(at('12:00', '12:50')).toBe('12:00p-12:50p')
    expect(at('00:00', '00:50')).toBe('12:00a-12:50a')
    expect(at('12:00 AM', '12:50 AM')).toBe('12:00a-12:50a')
  })

  it('survives an async section with no meetings and no instructors', () => {
    const online = { ...SEARCH_ROW, meetings: [], instructors: [] }
    const s = toRawSection(online)
    expect(s.meetingDays).toBeNull()
    expect(s.meetingTime).toBeNull()
    expect(s.instructor).toBeNull()
  })

  it('survives meetings and instructors arriving in an unexpected shape', () => {
    // The nesting of these two is the least verified part of the contract, and
    // a display field must never cost us a seat count.
    const odd = { ...SEARCH_ROW, meetings: 'MWF 10:00', instructors: { name: 'Whitfield' } }
    const s = toRawSection(odd)
    expect(s.meetingTime).toBeNull()
    expect(s.instructor).toBeNull()
    expect(s.seats).toBe(0)
  })

  it('reads an instructor whether the entry is a string or an object', () => {
    expect(toRawSection({ ...SEARCH_ROW, instructors: ['Okonkwo, A'] }).instructor).toBe('Okonkwo, A')
    expect(
      toRawSection({ ...SEARCH_ROW, instructors: [{ name: '' }, { name: 'Bhatt, R' }] }).instructor
    ).toBe('Bhatt, R')
  })

  it('falls back through the campus and location labels', () => {
    const { campus_descr: _drop, ...row } = SEARCH_ROW
    expect(toRawSection(row).campus).toBe('MAIN')
    const { campus: _also, ...bare } = row
    expect(toRawSection({ ...bare, location_descr: 'Online' }).campus).toBe('Online')
    expect(toRawSection(bare).campus).toBeNull()
  })
})

describe('PeopleSoftAdapter', () => {
  it('asks for institution, term, subject and page on the class search script', async () => {
    const { adapter, calls } = stubHighPoint()
    await adapter.fetchSections(psSchool(), '1252', 'MATH')

    const first = calls[0]!.url
    expect(first.host).toBe('sis.test.invalid')
    expect(first.pathname).toBe(
      `/psc/exprd/EMPLOYEE/SA/s/WEBLIB_HCX_CM.H_CLASS_SEARCH.FieldFormula.${CLASS_SEARCH}`
    )
    expect(first.searchParams.get('institution')).toBe('EX001')
    expect(first.searchParams.get('term')).toBe('1252')
    expect(first.searchParams.get('subject')).toBe('MATH')
    expect(first.searchParams.get('page')).toBe('1')
  })

  it('never asks for an enrolment status filter, which would hide closing sections', async () => {
    // enrl_stat is a server side filter. An open-only search would drop a
    // section the moment it filled, and that reads as section_removed.
    const { adapter, calls } = stubHighPoint()
    await adapter.fetchSections(psSchool(), '1252', 'MATH')
    expect(calls.every((c) => c.url.searchParams.get('enrl_stat') === null)).toBe(true)
  })

  it('establishes no session, because this API has none to establish', async () => {
    // The whole Banner handshake, a cookie page then a term authorisation POST,
    // has no equivalent here. Every request is a plain class search GET.
    const { adapter, calls } = stubHighPoint()
    await adapter.fetchSections(psSchool(), '1252', 'MATH')
    expect(calls.every((c) => c.method === 'GET')).toBe(true)
    expect(calls.every((c) => c.url.pathname.endsWith(CLASS_SEARCH))).toBe(true)
    expect(calls).toHaveLength(2) // one page of rows, then the empty page that ends it
  })

  it('re-handshakes nothing between subjects, so a second subject costs one page', async () => {
    const { adapter, calls } = stubHighPoint()
    const school = psSchool()
    await adapter.fetchSections(school, '1252', 'MATH')
    const afterFirst = calls.length
    await adapter.fetchSections(school, '1252', 'MATH')
    expect(calls.length - afterFirst).toBe(afterFirst)
  })

  it('pages until a page comes back empty', async () => {
    const page = (prefix: string, n: number) =>
      Array.from({ length: n }, (_, i) => ({ ...SEARCH_ROW, class_nbr: `${prefix}${i}` }))
    const { adapter, calls } = stubHighPoint({
      search: (p) =>
        jsonResponse({
          classes: p === 1 ? page('a', 25) : p === 2 ? page('b', 12) : [],
        }),
    })

    const out = await adapter.fetchSections(psSchool(), '1252', 'MATH')
    expect(out).toHaveLength(37)
    expect(calls.map((c) => c.url.searchParams.get('page'))).toEqual(['1', '2', '3'])
  })

  it('returns nothing for a subject with no classes rather than raising', async () => {
    // The opposite of Banner, where an empty first page means a broken session.
    // Here it is the documented way pagination ends, so it cannot be the alarm.
    const { adapter } = stubHighPoint({ search: () => jsonResponse({ classes: [] }) })
    await expect(adapter.fetchSections(psSchool(), '1252', 'BASKETWEAVING')).resolves.toEqual([])
  })

  it('raises transiently on an HTML page served with a 200', async () => {
    // The failure this adapter exists to guard. Accepting it as zero sections
    // would report every section at the school as vanished.
    const { adapter } = stubHighPoint({
      search: () =>
        new Response('<!DOCTYPE html><html><body>Signon</body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html; charset=UTF-8' },
        }),
    })
    await expect(adapter.fetchSections(psSchool(), '1252', 'MATH')).rejects.toMatchObject({
      name: 'SisError',
      transient: true,
    })
    await expect(adapter.fetchSections(psSchool(), '1252', 'MATH')).rejects.toThrow(/expected JSON/)
  })

  it('rejects a non-JSON content type even when the body happens to parse', async () => {
    const { adapter } = stubHighPoint({
      search: () =>
        new Response(JSON.stringify({ classes: [SEARCH_ROW] }), {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    })
    await expect(adapter.fetchSections(psSchool(), '1252', 'MATH')).rejects.toThrow(
      /content-type text\/html/
    )
  })

  it('parses a body sent without a content type rather than rejecting it', async () => {
    // A wrong header value is evidence. A missing header is not, and refusing
    // it would take a working install offline over a header.
    const bytes = new TextEncoder().encode(JSON.stringify({ classes: [SEARCH_ROW] }))
    let served = false
    const { adapter } = stubHighPoint({
      search: () => {
        if (served) return jsonResponse({ classes: [] })
        served = true
        return new Response(bytes, { status: 200 })
      },
    })
    await expect(adapter.fetchSections(psSchool(), '1252', 'MATH')).resolves.toHaveLength(1)
  })

  it('raises when the envelope carries no classes array', async () => {
    const { adapter } = stubHighPoint({ search: () => jsonResponse({ error: 'no such term' }) })
    await expect(adapter.fetchSections(psSchool(), '1252', 'MATH')).rejects.toThrow(
      /no classes array/
    )
  })

  it('raises when classes is present but is not an array', async () => {
    const { adapter } = stubHighPoint({ search: () => jsonResponse({ classes: { a: 1 } }) })
    await expect(adapter.fetchSections(psSchool(), '1252', 'MATH')).rejects.toThrow(
      /no classes array/
    )
  })

  it('raises when a JSON body is a bare array instead of the envelope', async () => {
    const { adapter } = stubHighPoint({ search: () => jsonResponse([SEARCH_ROW]) })
    await expect(adapter.fetchSections(psSchool(), '1252', 'MATH')).rejects.toThrow(
      /no classes array/
    )
  })

  it('drops rows for other subjects when the filter matches loosely', async () => {
    const { adapter } = stubHighPoint({
      search: (p) =>
        jsonResponse({
          classes:
            p === 1
              ? [SEARCH_ROW, { ...SEARCH_ROW, class_nbr: 51001, subject: 'MATHBIO' }]
              : [],
        }),
    })
    const out = await adapter.fetchSections(psSchool(), '1252', 'MATH')
    expect(out.map((s) => s.crn)).toEqual(['30412'])
  })

  it('raises when no returned row carries the subject we asked for', async () => {
    // Either the filter was ignored, which would pull the whole term into one
    // subject's target, or this is not the install's code for that subject.
    const { adapter } = stubHighPoint({
      search: () => jsonResponse({ classes: [{ ...SEARCH_ROW, subject: 'HIST' }] }),
    })
    await expect(adapter.fetchSections(psSchool(), '1252', 'MATH')).rejects.toThrow(
      /none carry that subject/
    )
  })

  it('matches the requested subject without caring about case', async () => {
    const { adapter } = stubHighPoint({
      search: (p) => jsonResponse({ classes: p === 1 ? [{ ...SEARCH_ROW, subject: 'math' }] : [] }),
    })
    await expect(adapter.fetchSections(psSchool(), '1252', 'MATH')).resolves.toHaveLength(1)
  })

  it('raises when a page repeats the previous one, rather than truncating the subject', async () => {
    // If the page parameter is ignored, stopping quietly would look like a
    // shorter subject, and a truncated subject reports live sections as removed.
    const { adapter } = stubHighPoint({ search: () => jsonResponse({ classes: [SEARCH_ROW] }) })
    await expect(adapter.fetchSections(psSchool(), '1252', 'MATH')).rejects.toThrow(
      /page parameter does not appear to be honoured/
    )
  })

  it('refuses to page forever, and calls that refusal permanent', async () => {
    const page = (p: number) =>
      Array.from({ length: 1000 }, (_, i) => ({ ...SEARCH_ROW, class_nbr: `p${p}-${i}` }))
    const { adapter } = stubHighPoint({ search: (p) => jsonResponse({ classes: page(p) }) })
    await expect(adapter.fetchSections(psSchool(), '1252', 'MATH')).rejects.toMatchObject({
      name: 'SisError',
      transient: false,
    })
  })

  it('lists subjects from the catalog without needing a term or a session', async () => {
    const { adapter, calls } = stubHighPoint()
    const subjects = await adapter.listSubjects(psSchool(), '1252')

    expect(subjects).toEqual([
      { code: 'MATH', description: 'Mathematics' },
      { code: 'CS', description: 'Computer Science' },
    ])
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url.searchParams.get('institution')).toBe('EX001')
    expect(calls[0]!.url.searchParams.get('term')).toBeNull()
  })

  it('falls back to the code when a subject carries no description', async () => {
    const { adapter } = stubHighPoint({
      subjects: () => jsonResponse({ subjects: [{ subject: 'CS' }, { descr: 'no code here' }] }),
    })
    await expect(adapter.listSubjects(psSchool(), '1252')).resolves.toEqual([
      { code: 'CS', description: 'CS' },
    ])
  })

  it('raises when the subject list is missing from its envelope', async () => {
    const { adapter } = stubHighPoint({ subjects: () => jsonResponse({ classes: [] }) })
    await expect(adapter.listSubjects(psSchool(), '1252')).rejects.toThrow(/no subjects array/)
  })

  it('reads terms from config and asks the registrar nothing', async () => {
    // Term codes are institution defined: UVA reads 1232 as Spring 2023 while
    // CSU Fullerton reads 2227 as Fall 2022, so nothing here may be derived.
    const { adapter, calls } = stubHighPoint()
    await expect(adapter.listTerms(psSchool())).resolves.toEqual([
      { code: '1252', description: 'Spring 2025' },
    ])
    expect(calls).toHaveLength(0)
  })

  it('raises permanently when a peoplesoft school has no peoplesoft block', async () => {
    const { adapter } = stubHighPoint()
    const bare = { ...psSchool(), peoplesoft: undefined } as SchoolConfig
    await expect(adapter.fetchSections(bare, '1252', 'MATH')).rejects.toMatchObject({
      name: 'SisError',
      transient: false,
    })
  })

  it('does not turn a slashless scriptPath into a request to another host', async () => {
    // Config normalises this, so reaching it means a hand-built SchoolConfig.
    // "example.edu" + "psc/..." would resolve to the host "example.edupsc".
    const { adapter, calls } = stubHighPoint()
    const handBuilt = {
      ...psSchool(),
      peoplesoft: { scriptPath: 'psc/exprd/EMPLOYEE/SA/s', institution: 'EX001', terms: [] },
    } as SchoolConfig

    await adapter.fetchSections(handBuilt, '1252', 'MATH')
    expect(calls[0]!.url.host).toBe('sis.test.invalid')
    expect(calls[0]!.url.pathname.startsWith('/psc/exprd/EMPLOYEE/SA/s/')).toBe(true)
  })
})

describe('parseSchoolConfig, peoplesoft block', () => {
  it('requires the block when sis is peoplesoft', () => {
    expect(() => parseSchoolConfig({ ...SCHOOL_YAML, peoplesoft: undefined }, 'ps.yaml')).toThrow(
      ConfigError
    )
    expect(() => parseSchoolConfig({ ...SCHOOL_YAML, peoplesoft: undefined }, 'ps.yaml')).toThrow(
      /needs a peoplesoft block/
    )
  })

  it('rejects the block on a school that is not peoplesoft', () => {
    expect(() =>
      parseSchoolConfig({ ...SCHOOL_YAML, sis: 'banner9' }, 'ps.yaml')
    ).toThrow(/only applies to sis: peoplesoft/)
  })

  it('rejects the /psp/ portal servlet and says which form to use', () => {
    // /psp/ wraps the same content in a page that redirects to sign in, so it
    // answers with HTML and a 200. That is the exact trap the adapter guards.
    const cfg = { ...SCHOOL_YAML, peoplesoft: { ...SCHOOL_YAML.peoplesoft, scriptPath: '/psp/exprd/EMPLOYEE/SA/s/' } }
    expect(() => parseSchoolConfig(cfg, 'ps.yaml')).toThrow(/\/psc\//)
  })

  it('rejects a scriptPath with no content servlet segment', () => {
    const cfg = { ...SCHOOL_YAML, peoplesoft: { ...SCHOOL_YAML.peoplesoft, scriptPath: '/EMPLOYEE/SA/s/' } }
    expect(() => parseSchoolConfig(cfg, 'ps.yaml')).toThrow(/content servlet segment/)
  })

  it('rejects a scriptPath that stops short of the script segment', () => {
    const cfg = { ...SCHOOL_YAML, peoplesoft: { ...SCHOOL_YAML.peoplesoft, scriptPath: '/psc/exprd/EMPLOYEE/SA/' } }
    expect(() => parseSchoolConfig(cfg, 'ps.yaml')).toThrow(/must end with the \/s\/ script segment/)
  })

  it('normalises the leading and trailing slashes on scriptPath', () => {
    const cfg = { ...SCHOOL_YAML, peoplesoft: { ...SCHOOL_YAML.peoplesoft, scriptPath: '/psc/exprd/EMPLOYEE/SA/s' } }
    expect(parseSchoolConfig(cfg, 'ps.yaml').peoplesoft!.scriptPath).toBe('/psc/exprd/EMPLOYEE/SA/s/')
  })

  it('requires an institution, since one host can serve many colleges', () => {
    const cfg = { ...SCHOOL_YAML, peoplesoft: { ...SCHOOL_YAML.peoplesoft, institution: '' } }
    expect(() => parseSchoolConfig(cfg, 'ps.yaml')).toThrow(/institution/)
  })

  it('accepts a term code that YAML read as a number', () => {
    // An unquoted 1252 in YAML is a number, and every real code is digits.
    const cfg = { ...SCHOOL_YAML, peoplesoft: { ...SCHOOL_YAML.peoplesoft, terms: [{ code: 1252 }] } }
    expect(parseSchoolConfig(cfg, 'ps.yaml').peoplesoft!.terms).toEqual([
      { code: '1252', description: '1252' },
    ])
  })

  it('rejects an empty term list, because term codes cannot be derived', () => {
    const cfg = { ...SCHOOL_YAML, peoplesoft: { ...SCHOOL_YAML.peoplesoft, terms: [] } }
    expect(() => parseSchoolConfig(cfg, 'ps.yaml')).toThrow(/at least one term/)
  })

  it('rejects a term entry with no code, naming its position', () => {
    const cfg = {
      ...SCHOOL_YAML,
      peoplesoft: { ...SCHOOL_YAML.peoplesoft, terms: [{ code: '1252' }, { description: 'Fall' }] },
    }
    expect(() => parseSchoolConfig(cfg, 'ps.yaml')).toThrow(/terms\[1\] is missing a code/)
  })

  it('rejects a term entry that is a bare string rather than a mapping', () => {
    const cfg = { ...SCHOOL_YAML, peoplesoft: { ...SCHOOL_YAML.peoplesoft, terms: ['1252'] } }
    expect(() => parseSchoolConfig(cfg, 'ps.yaml')).toThrow(/must be a mapping with a code/)
  })

  it('leaves the institution code exactly as written', () => {
    const cfg = { ...SCHOOL_YAML, peoplesoft: { ...SCHOOL_YAML.peoplesoft, institution: 'wa090' } }
    expect(parseSchoolConfig(cfg, 'ps.yaml').peoplesoft!.institution).toBe('wa090')
  })

  it('loads the shipped PeopleSoft example, and it ships disabled', () => {
    const schools = loadSchoolsFromDir(join(here, '..', 'schools'))
    const example = schools.find((s) => s.id === 'example-peoplesoft-university')
    expect(example).toBeDefined()
    expect(example!.sis).toBe('peoplesoft')
    expect(example!.peoplesoft!.scriptPath).toBe('/psc/exprd/EMPLOYEE/SA/s/')
    // Nobody should poll a real registrar by cloning this repo and running it.
    expect(example!.enabled).toBe(false)
  })
})
