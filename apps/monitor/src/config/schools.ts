import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import type { SchoolConfig, SisId } from '../adapters/types.js'

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
