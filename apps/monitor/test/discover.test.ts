import { describe, expect, it } from 'vitest'
import { PoliteClient } from '../src/adapters/http.js'
import { defaultEntryPoints, discoverSchool, toYaml } from '../src/config/discover.js'

/**
 * Discovery is tested against recorded page shapes, never a live university.
 * The shapes are real: the Georgia Tech case below is the actual arrangement
 * found on 2026-07-29, where the registrar links to a Banner host that shares
 * no name with the one everybody calls the registration system.
 */

const TERMS_JSON = JSON.stringify([
  { code: '202608', description: 'Fall 2026' },
  { code: '202602', description: 'Spring 2026 <span>(View only)</span>' },
])

interface Page {
  body: string
  type?: string
  status?: number
}

function stub(pages: Record<string, Page>) {
  const seen: string[] = []
  const fetchImpl = (async (url: string | URL) => {
    const u = String(url)
    seen.push(u)
    const page = pages[u]
    if (!page) return new Response('nope', { status: 404 })
    return new Response(page.body, {
      status: page.status ?? 200,
      headers: { 'content-type': page.type ?? 'text/html' },
    })
  }) as unknown as typeof fetch

  const client = new PoliteClient({ fetchImpl, minRequestGapMs: 0, maxRetries: 0, sleep: async () => {} })
  return { client, seen }
}

const GETTERMS = (origin: string) =>
  `${origin}/StudentRegistrationSsb/ssb/classSearch/getTerms?offset=1&max=10&searchTerm=`

describe('defaultEntryPoints', () => {
  it('asks the registrar before the university homepage', () => {
    const entries = defaultEntryPoints('example.edu')
    expect(entries[0]).toContain('registrar.example.edu')
    expect(entries.at(-1)).toBe('https://example.edu/')
  })
})

describe('discoverSchool', () => {
  it('finds a Banner host whose name shares nothing with the school portal', async () => {
    // The Georgia Tech arrangement, which is why hostname guessing failed: the
    // system students call OSCAR is not where Banner 9 lives.
    const { client } = stub({
      'https://registrar.gatech.edu/': {
        body: `<a href="https://oscar.gatech.edu/">OSCAR</a>
               <a href="https://registration.banner.gatech.edu/StudentRegistrationSsb/ssb/term/termSelection?mode=search">Class search</a>`,
      },
      [GETTERMS('https://registration.banner.gatech.edu')]: {
        body: TERMS_JSON,
        type: 'application/json',
      },
    })

    const d = await discoverSchool('gatech.edu', { client })
    expect(d.sis).toBe('banner9')
    expect(d.baseUrl).toBe('https://registration.banner.gatech.edu')
    expect(d.publicCatalog).toBe(true)
    expect(d.terms[0]).toEqual({ code: '202608', description: 'Fall 2026' })
  })

  it('follows a relative link one hop to reach the SIS', async () => {
    // The real Georgia Tech shape, and the reason the first version of this
    // failed on the one school already verified by hand. The registrar page
    // carries no Banner URL at all, only a relative "Schedule of Classes"
    // link, and the host appears one page further on.
    const { client } = stub({
      'https://registrar.gt.edu/': {
        body: `<a href="/registration/schedule-of-classes">Schedule of Classes</a>
               <a href="https://www.facebook.com/gt">Facebook</a>`,
      },
      'https://registrar.gt.edu/registration/schedule-of-classes': {
        body: '<a href="https://registration.banner.gt.edu/StudentRegistrationSsb/ssb/term/termSelection?mode=search">Search</a>',
      },
      [GETTERMS('https://registration.banner.gt.edu')]: {
        body: TERMS_JSON,
        type: 'application/json',
      },
    })

    const d = await discoverSchool('gt.edu', { client })
    expect(d.publicCatalog).toBe(true)
    expect(d.baseUrl).toBe('https://registration.banner.gt.edu')
  })

  it('follows only same-site links, so it cannot become a web crawler', async () => {
    const { client, seen } = stub({
      'https://registrar.stay.edu/': {
        body: '<a href="https://elsewhere.example/course-catalog">Course catalog</a>',
      },
    })
    await discoverSchool('stay.edu', { client })
    expect(seen.some((u) => u.includes('elsewhere.example'))).toBe(false)
  })

  it('bounds how many pages it will follow', async () => {
    // Someone's CMS puts "registration" in forty links. This is their web
    // server, and a budget is the difference between a probe and a crawl.
    const many = Array.from(
      { length: 40 },
      (_, i) => `<a href="/registration/${i}">Registration ${i}</a>`
    ).join('')
    const pages: Record<string, { body: string }> = { 'https://registrar.many.edu/': { body: many } }
    for (let i = 0; i < 40; i++) pages[`https://registrar.many.edu/registration/${i}`] = { body: '<p>nothing</p>' }

    const { client, seen } = stub(pages)
    await discoverSchool('many.edu', { client, maxFollow: 3 })
    expect(seen.filter((u) => u.includes('/registration/'))).toHaveLength(3)
  })

  it('does not fetch the same page twice', async () => {
    const { client, seen } = stub({
      'https://registrar.dup.edu/': {
        body: `<a href="/registration">Registration</a><a href="/registration">Registration again</a>`,
      },
      'https://registrar.dup.edu/registration': { body: '<p>nothing</p>' },
    })
    await discoverSchool('dup.edu', { client })
    // Once as an entry point, never again as a followed link.
    expect(seen.filter((u) => u === 'https://registrar.dup.edu/registration')).toHaveLength(1)
  })

  it('strips the markup Banner puts in archived term names', async () => {
    const { client } = stub({
      'https://registrar.x.edu/': {
        body: '<a href="https://b.x.edu/StudentRegistrationSsb/ssb/classSearch/classSearch">search</a>',
      },
      [GETTERMS('https://b.x.edu')]: { body: TERMS_JSON, type: 'application/json' },
    })
    const d = await discoverSchool('x.edu', { client })
    expect(d.terms[1]!.description).toBe('Spring 2026 (View only)')
  })

  it('reports a gated catalog as a miss, not a hit', async () => {
    // The distinction the whole credential-free premise rests on. A school can
    // plainly run Banner and still refuse to answer us logged out, and calling
    // that a hit would put a school in the config that can never be polled.
    const { client } = stub({
      'https://registrar.gated.edu/': {
        body: '<a href="https://ssb.gated.edu/StudentRegistrationSsb/ssb/classSearch/classSearch">Class search</a>',
      },
      [GETTERMS('https://ssb.gated.edu')]: { body: '<html>Sign in</html>', status: 200 },
    })

    const d = await discoverSchool('gated.edu', { client })
    expect(d.sis).toBe('banner9')
    expect(d.publicCatalog).toBe(false)
    expect(d.reason).toMatch(/gated/)
    expect(d.baseUrl).toBe('https://ssb.gated.edu')
  })

  it('treats an empty term list as gated rather than as success', async () => {
    const { client } = stub({
      'https://registrar.empty.edu/': {
        body: '<a href="https://b.empty.edu/StudentRegistrationSsb/ssb/classSearch/classSearch">go</a>',
      },
      [GETTERMS('https://b.empty.edu')]: { body: '[]', type: 'application/json' },
    })
    expect((await discoverSchool('empty.edu', { client })).publicCatalog).toBe(false)
  })

  it('identifies PeopleSoft without claiming it can read it', async () => {
    const { client } = stub({
      'https://registrar.ps.edu/': {
        body: '<a href="https://sis.ps.edu/psc/CSPRD/EMPLOYEE/SA/c/X.GBL">Class search</a>',
      },
    })
    const d = await discoverSchool('ps.edu', { client })
    expect(d.sis).toBe('peoplesoft')
    expect(d.publicCatalog).toBe(false)
    expect(d.reason).toMatch(/does not verify yet/)
  })

  it('identifies Workday the same way', async () => {
    const { client } = stub({
      'https://registrar.wd.edu/': {
        body: '<a href="https://wd5.myworkday.com/wd/d/home.htmld">Student</a>',
      },
    })
    expect((await discoverSchool('wd.edu', { client })).sis).toBe('workday')
  })

  it('says plainly when nothing was found', async () => {
    const { client } = stub({ 'https://registrar.void.edu/': { body: '<p>Welcome</p>' } })
    const d = await discoverSchool('void.edu', { client })
    expect(d.sis).toBeNull()
    expect(d.reason).toMatch(/no link to a known student system/)
  })

  it('falls through entry points until a page answers', async () => {
    const { client, seen } = stub({
      // registrar.* and /registrar are absent, the homepage carries the link.
      'https://late.edu/': {
        body: '<a href="https://b.late.edu/StudentRegistrationSsb/ssb/classSearch/classSearch">x</a>',
      },
      [GETTERMS('https://b.late.edu')]: { body: TERMS_JSON, type: 'application/json' },
    })
    const d = await discoverSchool('late.edu', { client })
    expect(d.publicCatalog).toBe(true)
    expect(seen.length).toBeGreaterThan(1)
  })

  it('stops reading pages once it has a Banner origin', async () => {
    const { client, seen } = stub({
      'https://registrar.quick.edu/': {
        body: '<a href="https://b.quick.edu/StudentRegistrationSsb/ssb/classSearch/classSearch">x</a>',
      },
      [GETTERMS('https://b.quick.edu')]: { body: TERMS_JSON, type: 'application/json' },
    })
    await discoverSchool('quick.edu', { client })
    expect(seen.filter((u) => !u.includes('getTerms'))).toHaveLength(1)
  })

  it('ignores a non-HTML entry point instead of parsing it', async () => {
    const { client } = stub({
      'https://registrar.pdf.edu/': { body: '%PDF-1.7 junk', type: 'application/pdf' },
    })
    expect((await discoverSchool('pdf.edu', { client })).sis).toBeNull()
  })

  it('survives a malformed href without abandoning the page', async () => {
    const { client } = stub({
      'https://registrar.messy.edu/': {
        body: `<a href="https://[not a url]/StudentRegistrationSsb/ssb/x">broken</a>
               <a href="https://ok.messy.edu/StudentRegistrationSsb/ssb/classSearch/classSearch">good</a>`,
      },
      [GETTERMS('https://ok.messy.edu')]: { body: TERMS_JSON, type: 'application/json' },
    })
    expect((await discoverSchool('messy.edu', { client })).publicCatalog).toBe(true)
  })

  it('records the trail it followed', async () => {
    const { client } = stub({
      'https://registrar.trail.edu/': {
        body: '<a href="https://b.trail.edu/StudentRegistrationSsb/ssb/classSearch/classSearch">x</a>',
      },
      [GETTERMS('https://b.trail.edu')]: { body: TERMS_JSON, type: 'application/json' },
    })
    const d = await discoverSchool('trail.edu', { client })
    expect(d.evidence[0]).toBe('https://registrar.trail.edu/')
    expect(d.evidence.at(-1)).toContain('getTerms')
  })

  it('honours an abort signal', async () => {
    const { client, seen } = stub({})
    const ctrl = new AbortController()
    ctrl.abort()
    const d = await discoverSchool('any.edu', { client, signal: ctrl.signal })
    expect(seen).toHaveLength(0)
    expect(d.sis).toBeNull()
  })
})

describe('toYaml', () => {
  const verified = {
    domain: 'gatech.edu',
    sis: 'banner9' as const,
    baseUrl: 'https://registration.banner.gatech.edu',
    publicCatalog: true,
    terms: [{ code: '202608', description: 'Fall 2026' }],
    evidence: [],
    reason: null,
  }

  it('writes a config that parses back', async () => {
    const { parseSchoolConfig } = await import('../src/config/schools.js')
    const { parse } = await import('yaml')
    const cfg = parseSchoolConfig(parse(toYaml(verified, { subjects: ['cs', 'math'] })), 'generated')
    expect(cfg.sis).toBe('banner9')
    expect(cfg.baseUrl).toBe('https://registration.banner.gatech.edu')
    expect(cfg.subjects).toEqual(['CS', 'MATH'])
  })

  it('always writes it disabled', async () => {
    const { parseSchoolConfig } = await import('../src/config/schools.js')
    const { parse } = await import('yaml')
    // Discovery proves a catalog is readable. It does not decide that we should
    // start reading it every five minutes at a real university.
    expect(parseSchoolConfig(parse(toYaml(verified)), 'generated').enabled).toBe(false)
  })

  it('parses with no subjects, which means nothing is polled yet', async () => {
    const { parseSchoolConfig } = await import('../src/config/schools.js')
    const { parse } = await import('yaml')
    expect(parseSchoolConfig(parse(toYaml(verified)), 'generated').subjects).toEqual([])
  })

  it('records the terms the school actually returned', () => {
    expect(toYaml(verified)).toContain('202608  Fall 2026')
  })

  it('refuses to write a config for an unverified school', () => {
    expect(() => toYaml({ ...verified, publicCatalog: false })).toThrow(/not verified/)
  })
})
