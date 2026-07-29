import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ConfigError, DEFAULT_POLLING, loadSchoolsFromDir, parseSchoolConfig } from '../src/config/schools.js'
import { detectSis } from '../src/adapters/registry.js'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { registerSchool } from '../src/index.js'
import { setupEnv, type TestEnv } from './helpers.js'

const here = dirname(fileURLToPath(import.meta.url))

const valid = {
  id: 'example-university',
  name: 'Example University',
  sis: 'banner9',
  baseUrl: 'https://banner.example.edu',
  subjects: ['math', 'cs'],
}

describe('parseSchoolConfig', () => {
  it('accepts a minimal valid config and fills in polling defaults', () => {
    const cfg = parseSchoolConfig(valid, 'test')
    expect(cfg.id).toBe('example-university')
    expect(cfg.polling).toEqual(DEFAULT_POLLING)
    expect(cfg.enabled).toBe(true)
  })

  it('upper-cases subjects so lookups are consistent', () => {
    expect(parseSchoolConfig(valid, 'test').subjects).toEqual(['MATH', 'CS'])
  })

  it('strips a trailing slash from baseUrl', () => {
    const cfg = parseSchoolConfig({ ...valid, baseUrl: 'https://banner.example.edu/' }, 'test')
    expect(cfg.baseUrl).toBe('https://banner.example.edu')
  })

  it('merges a partial polling block over the defaults', () => {
    const cfg = parseSchoolConfig({ ...valid, polling: { baseIntervalMs: 120_000 } }, 'test')
    expect(cfg.polling.baseIntervalMs).toBe(120_000)
    expect(cfg.polling.maxIntervalMs).toBe(DEFAULT_POLLING.maxIntervalMs)
  })

  it('rejects a missing required field, naming the file', () => {
    expect(() => parseSchoolConfig({ ...valid, name: undefined }, 'bad.yaml')).toThrow(ConfigError)
    expect(() => parseSchoolConfig({ ...valid, name: undefined }, 'bad.yaml')).toThrow(/bad\.yaml.*name/)
  })

  it('rejects a non-kebab-case id', () => {
    expect(() => parseSchoolConfig({ ...valid, id: 'Example_University' }, 't')).toThrow(/kebab-case/)
  })

  it('rejects an unknown SIS', () => {
    expect(() => parseSchoolConfig({ ...valid, sis: 'blackboard' }, 't')).toThrow(/sis must be one of/)
  })

  it('rejects a malformed baseUrl', () => {
    expect(() => parseSchoolConfig({ ...valid, baseUrl: 'not a url' }, 't')).toThrow(/not a valid URL/)
  })

  it('rejects plain HTTP, because seat data should not travel in the clear', () => {
    expect(() => parseSchoolConfig({ ...valid, baseUrl: 'http://banner.example.edu' }, 't')).toThrow(/must be https/)
  })

  it('refuses a polling floor that would be rude to a registrar', () => {
    // The guard that stops someone "optimising" us into a denial of service.
    expect(() =>
      parseSchoolConfig({ ...valid, polling: { minIntervalMs: 1000, baseIntervalMs: 1000 } }, 't')
    ).toThrow(/not polite/)
  })

  it('rejects min above max', () => {
    expect(() =>
      parseSchoolConfig({ ...valid, polling: { minIntervalMs: 600_000, maxIntervalMs: 60_000 } }, 't')
    ).toThrow(/must be <= maxIntervalMs/)
  })

  it('rejects a base interval outside the min and max band', () => {
    expect(() =>
      parseSchoolConfig({ ...valid, polling: { baseIntervalMs: 5_000_000 } }, 't')
    ).toThrow(/between min and max/)
  })

  it('rejects a non-object', () => {
    expect(() => parseSchoolConfig('nope', 't')).toThrow(/expected a mapping/)
    expect(() => parseSchoolConfig(null, 't')).toThrow(/expected a mapping/)
  })

  it('defaults subjects to empty, meaning discover them', () => {
    expect(parseSchoolConfig({ ...valid, subjects: undefined }, 't').subjects).toEqual([])
  })

  it('honours enabled: false', () => {
    expect(parseSchoolConfig({ ...valid, enabled: false }, 't').enabled).toBe(false)
  })
})

describe('loadSchoolsFromDir', () => {
  it('loads the shipped example config', () => {
    const schools = loadSchoolsFromDir(join(here, '..', 'schools'))
    expect(schools.length).toBeGreaterThan(0)
    const example = schools.find((s) => s.id === 'example-university')
    expect(example).toBeDefined()
    // Ships disabled on purpose: nobody should poll a real registrar by
    // cloning this repo and running npm start.
    expect(example!.enabled).toBe(false)
  })

  it('returns empty for a directory that does not exist', () => {
    expect(loadSchoolsFromDir(join(here, 'no-such-dir'))).toEqual([])
  })
})

describe('detectSis', () => {
  it('recognises Banner 9 by its self-service path', () => {
    expect(detectSis('https://oscar.example.edu/StudentRegistrationSsb/ssb/classSearch')).toBe('banner9')
  })
  it('recognises legacy Banner 8 schedule pages', () => {
    expect(detectSis('https://x.edu/pls/prod/bwckschd.p_disp_dyn_sched')).toBe('banner9')
  })
  it('recognises PeopleSoft by its portal paths', () => {
    expect(detectSis('https://hub.example.edu/psc/CS/EMPLOYEE/HRMS/c/x')).toBe('peoplesoft')
    expect(detectSis('https://hub.example.edu/psp/CS/EMPLOYEE/HRMS/c/x')).toBe('peoplesoft')
  })
  it('recognises Workday by host', () => {
    expect(detectSis('https://wd5.myworkday.com/example/d/home.htmld')).toBe('workday')
  })
  it('returns null when it cannot tell', () => {
    expect(detectSis('https://example.edu/registration')).toBeNull()
  })
})

describe('registerSchool', () => {
  let env: TestEnv
  beforeEach(() => { env = setupEnv() })
  afterEach(() => env.close())

  const lines: Array<{ msg: string; meta?: Record<string, unknown> }> = []
  const log = (msg: string, meta?: Record<string, unknown>) => lines.push({ msg, meta })
  beforeEach(() => { lines.length = 0 })

  it('seeds a poll target per subject and term for a school whose terms are configured', () => {
    // Starting the service used to store the school and stop there, so an
    // enabled school logged "school loaded" and then polled nothing at all,
    // forever, with zero requests and zero errors to show for it.
    const school = parseSchoolConfig(
      {
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
      },
      'test'
    )

    expect(registerSchool(env.repo, school, log)).toBe(2)
    expect(env.repo.listTargets().map((t) => t.id)).toEqual([
      'test-peoplesoft:1252:CS',
      'test-peoplesoft:1252:MATH',
    ])
    // And the terms are published, so GET /api/schools is not empty either.
    expect(env.repo.listTerms('test-peoplesoft')).toEqual([{ code: '1252', description: 'Spring 2025' }])
  })

  it('says so loudly when a school ends up with nothing to poll', () => {
    // Banner carries no term list in config, so its targets come from the CLI.
    // The failure this warns about is invisible everywhere else.
    const school = parseSchoolConfig(valid, 'test')
    expect(registerSchool(env.repo, school, log)).toBe(0)

    const warning = lines.find((l) => l.msg.includes('no poll targets'))
    expect(warning).toBeDefined()
    expect(String(warning!.meta!.fix)).toContain('seed example-university')
  })
})
