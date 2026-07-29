import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { buildAdapters, detectSis } from './adapters/registry.js'
import { PoliteClient } from './adapters/http.js'
import { loadSchoolsFromDir } from './config/schools.js'
import { migrate, openDb } from './core/db.js'
import { Repo } from './core/repo.js'

/**
 * Operator CLI. Everything here is read-only against a registrar except
 * `seed`, which performs one fetch per subject.
 */

const here = dirname(fileURLToPath(import.meta.url))
const DB = process.env.CLASSPIK_DB ?? join(process.cwd(), 'classpik.db')
const SCHOOLS = join(here, '..', 'schools')

const USAGE = `
classpik monitor cli

  schools                       list configured schools
  terms <schoolId>              fetch available terms from the SIS
  subjects <schoolId> <term>    fetch available subjects from the SIS
  seed <schoolId> <term>        create poll targets for the school's subjects
  targets                       show poll targets and their state
  stats                         counts across the service
  detect <url>                  guess which SIS a portal URL belongs to

env: CLASSPIK_DB (default ./classpik.db)
`.trim()

async function main(argv: string[]): Promise<number> {
  const [cmd, ...args] = argv

  if (!cmd || cmd === 'help' || cmd === '--help') {
    console.log(USAGE)
    return 0
  }

  if (cmd === 'detect') {
    const url = args[0]
    if (!url) return fail('detect needs a URL')
    const sis = detectSis(url)
    console.log(sis ?? 'unknown (inspect the portal by hand)')
    return sis ? 0 : 1
  }

  const db = openDb(DB)
  migrate(db)
  const repo = new Repo(db)
  for (const s of loadSchoolsFromDir(SCHOOLS)) repo.upsertSchool(s)

  try {
    switch (cmd) {
      case 'schools': {
        const schools = repo.listSchools()
        if (schools.length === 0) {
          console.log(`no schools in ${SCHOOLS}`)
          return 0
        }
        for (const s of schools) {
          console.log(
            `${s.enabled ? 'on ' : 'off'}  ${s.id.padEnd(24)} ${s.sis.padEnd(12)} ${s.baseUrl}`
          )
        }
        return 0
      }

      case 'targets': {
        const targets = repo.listTargets()
        if (targets.length === 0) {
          console.log('no poll targets; run `seed <schoolId> <term>`')
          return 0
        }
        for (const t of targets) {
          const due = t.next_poll_at ? new Date(t.next_poll_at).toISOString() : 'never'
          console.log(
            `${t.active ? 'on ' : 'off'}  ${t.id.padEnd(34)} polls=${String(t.poll_count).padStart(4)} ` +
              `changes=${String(t.change_count).padStart(3)} errors=${t.consecutive_errors} ` +
              `every=${Math.round(t.interval_ms / 1000)}s next=${due}` +
              (t.last_error ? `\n     last error: ${t.last_error}` : '')
          )
        }
        return 0
      }

      case 'stats':
        console.log(JSON.stringify(repo.stats(), null, 2))
        return 0

      case 'terms': {
        const schoolId = args[0]
        if (!schoolId) return fail('terms needs a schoolId')
        const school = repo.getSchool(schoolId)
        if (!school) return fail(`unknown school "${schoolId}"`)

        const adapter = buildAdapters(new PoliteClient()).get(school.sis)
        if (!adapter) return fail(`no adapter for ${school.sis}`)

        const terms = await adapter.listTerms(school)
        repo.replaceTerms(school.id, terms)
        for (const t of terms) console.log(`${t.code}  ${t.description}`)
        return 0
      }

      case 'subjects': {
        const [schoolId, term] = args
        if (!schoolId || !term) return fail('subjects needs a schoolId and a term')
        const school = repo.getSchool(schoolId)
        if (!school) return fail(`unknown school "${schoolId}"`)

        const adapter = buildAdapters(new PoliteClient()).get(school.sis)
        if (!adapter) return fail(`no adapter for ${school.sis}`)

        for (const s of await adapter.listSubjects(school, term)) {
          console.log(`${s.code.padEnd(8)} ${s.description}`)
        }
        return 0
      }

      case 'seed': {
        const [schoolId, term] = args
        if (!schoolId || !term) return fail('seed needs a schoolId and a term')
        const school = repo.getSchool(schoolId)
        if (!school) return fail(`unknown school "${schoolId}"`)
        if (school.subjects.length === 0) {
          return fail(`${schoolId} lists no subjects; add them to its config first`)
        }

        for (const subject of school.subjects) {
          const t = repo.ensureTarget(school.id, term, subject, school.polling.baseIntervalMs)
          console.log(`target ready: ${t.id}`)
        }
        console.log(`\n${school.subjects.length} target(s). Start the service to begin polling.`)
        return 0
      }

      default:
        console.error(`unknown command "${cmd}"\n`)
        console.log(USAGE)
        return 1
    }
  } finally {
    db.close()
  }
}

function fail(msg: string): number {
  console.error(`error: ${msg}`)
  return 1
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error('error:', err instanceof Error ? err.message : err)
      process.exit(1)
    })
}

export { main }
