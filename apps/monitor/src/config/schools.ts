import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import type { PeopleSoftConfig, SchoolConfig, SisId, Term } from '../adapters/types.js'

/**
 * Schools are configuration, not code. Adding a campus is a YAML file and a
 * pull request, which is the only way two people cover many universities.
 */

const SIS_IDS: readonly SisId[] = ['banner9', 'peoplesoft', 'workday']

export const DEFAULT_POLLING: SchoolConfig['polling'] = {
  baseIntervalMs: 5 * 60_000,
  minIntervalMs: 60_000,
  maxIntervalMs: 30 * 60_000,
  hotWindowMs: 15 * 60_000,
  maxConcurrentRequests: 2,
  minRequestGapMs: 350,
}

export class ConfigError extends Error {}

export function parseSchoolConfig(raw: unknown, source: string): SchoolConfig {
  if (typeof raw !== 'object' || raw === null) {
    throw new ConfigError(`${source}: expected a mapping at the top level`)
  }
  const o = raw as Record<string, unknown>

  const id = req(o, 'id', source)
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    throw new ConfigError(`${source}: id must be lowercase kebab-case, got "${id}"`)
  }

  const sis = req(o, 'sis', source)
  if (!SIS_IDS.includes(sis as SisId)) {
    throw new ConfigError(`${source}: sis must be one of ${SIS_IDS.join(', ')}, got "${sis}"`)
  }

  const baseUrl = req(o, 'baseUrl', source)
  let parsed: URL
  try {
    parsed = new URL(baseUrl)
  } catch {
    throw new ConfigError(`${source}: baseUrl is not a valid URL: "${baseUrl}"`)
  }
  if (parsed.protocol !== 'https:') {
    throw new ConfigError(`${source}: baseUrl must be https, got "${parsed.protocol}"`)
  }

  const polling = { ...DEFAULT_POLLING, ...(asRecord(o.polling) ?? {}) } as SchoolConfig['polling']

  if (polling.minIntervalMs < 30_000) {
    throw new ConfigError(
      `${source}: minIntervalMs below 30000 is not polite to a registrar; got ${polling.minIntervalMs}`
    )
  }
  if (polling.minIntervalMs > polling.maxIntervalMs) {
    throw new ConfigError(`${source}: minIntervalMs must be <= maxIntervalMs`)
  }
  if (polling.baseIntervalMs < polling.minIntervalMs || polling.baseIntervalMs > polling.maxIntervalMs) {
    throw new ConfigError(`${source}: baseIntervalMs must sit between min and max`)
  }

  const subjects = Array.isArray(o.subjects) ? o.subjects.map((s) => String(s).toUpperCase()) : []

  return {
    id,
    name: req(o, 'name', source),
    sis: sis as SisId,
    baseUrl: baseUrl.replace(/\/+$/, ''),
    registrationPath: typeof o.registrationPath === 'string' ? o.registrationPath : undefined,
    peoplesoft: parsePeopleSoft(o, sis as SisId, source),
    polling,
    subjects,
    enabled: o.enabled === undefined ? true : Boolean(o.enabled),
  }
}

export function loadSchoolsFromDir(dir: string): SchoolConfig[] {
  let files: string[]
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
  } catch {
    return []
  }

  const out: SchoolConfig[] = []
  const seen = new Set<string>()
  for (const file of files.sort()) {
    const cfg = parseSchoolConfig(parse(readFileSync(join(dir, file), 'utf8')), file)
    if (seen.has(cfg.id)) throw new ConfigError(`${file}: duplicate school id "${cfg.id}"`)
    seen.add(cfg.id)
    out.push(cfg)
  }
  return out
}

/**
 * The peoplesoft block, validated hard because every mistake it can contain
 * fails at 3 AM rather than at load time. A wrong scriptPath returns an HTML
 * sign in page with a 200; a wrong term code returns an empty class list, which
 * is indistinguishable from a subject with no classes.
 */
function parsePeopleSoft(
  o: Record<string, unknown>,
  sis: SisId,
  source: string
): PeopleSoftConfig | undefined {
  const block = asRecord(o.peoplesoft)

  if (sis !== 'peoplesoft') {
    if (block) {
      throw new ConfigError(
        `${source}: a peoplesoft block only applies to sis: peoplesoft, but sis is "${sis}"`
      )
    }
    return undefined
  }
  if (!block) {
    throw new ConfigError(
      `${source}: sis: peoplesoft needs a peoplesoft block with scriptPath, institution and terms`
    )
  }

  const raw = req(block, 'scriptPath', `${source}: peoplesoft`)
  if (raw.includes('/psp/')) {
    throw new ConfigError(
      `${source}: peoplesoft.scriptPath uses the /psp/ portal servlet, which redirects to a sign in ` +
        `page and answers with HTML and a 200. Copy the /psc/ form of the URL instead.`
    )
  }
  if (!raw.includes('/psc/')) {
    throw new ConfigError(
      `${source}: peoplesoft.scriptPath must contain the /psc/ content servlet segment, ` +
        `for example /psc/csprd/EMPLOYEE/SA/s/`
    )
  }
  const scriptPath = `/${raw.replace(/^\/+/, '').replace(/\/+$/, '')}/`
  if (!scriptPath.endsWith('/s/')) {
    throw new ConfigError(
      `${source}: peoplesoft.scriptPath must end with the /s/ script segment; ` +
        `copy it verbatim from a working class search URL, up to and including /s/`
    )
  }

  const rawTerms = block.terms
  if (!Array.isArray(rawTerms) || rawTerms.length === 0) {
    throw new ConfigError(
      `${source}: peoplesoft.terms must list at least one term. Term codes are institution ` +
        `defined and two schools on this vendor encode the same semester differently, so they ` +
        `cannot be derived.`
    )
  }
  const terms: Term[] = rawTerms.map((entry, i) => {
    const t = asRecord(entry)
    if (!t) {
      throw new ConfigError(
        `${source}: peoplesoft.terms[${i}] must be a mapping with a code, for example ` +
          `{ code: "1252", description: Spring 2025 }`
      )
    }
    // YAML reads an unquoted 1252 as a number, and every real term code is
    // digits, so this would reject most correct configs if it insisted on a
    // string.
    const code = typeof t.code === 'number' ? String(t.code) : t.code
    if (typeof code !== 'string' || code.trim() === '') {
      throw new ConfigError(`${source}: peoplesoft.terms[${i}] is missing a code`)
    }
    const description = typeof t.description === 'string' ? t.description.trim() : ''
    return { code: code.trim(), description: description === '' ? code.trim() : description }
  })

  return {
    scriptPath,
    // Not upper-cased. Sending the code exactly as configured is safer than
    // deciding we know the convention at an install we have never seen.
    institution: req(block, 'institution', `${source}: peoplesoft`),
    terms,
  }
}

function req(o: Record<string, unknown>, key: string, source: string): string {
  const v = o[key]
  if (typeof v !== 'string' || v.trim() === '') {
    throw new ConfigError(`${source}: missing required string field "${key}"`)
  }
  return v.trim()
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null
}
