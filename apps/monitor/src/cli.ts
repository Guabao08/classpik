import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { buildAdapters, detectSis } from './adapters/registry.js'
import { PoliteClient } from './adapters/http.js'
import { loadSchoolsFromDir } from './config/schools.js'
import { discoverSchool, toYaml, type Discovery } from './config/discover.js'
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
  subjects <schoolId> <term>    fetch and record available subjects from the SIS
  seed <schoolId> <term>        create poll targets for the school's subjects
  targets                       show poll targets and their state
  stats                         counts across the service
  detect <url>                  guess which SIS a portal URL belongs to
  discover <domain>...          find a school's SIS and prove its catalog is
                                readable logged out. Prints a ready config for
                                every school that passes.

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

  // Reads public pages only, and never opens the database: discovery is
  // research, and nothing it learns is recorded until a person commits a config.
  if (cmd === 'discover') {
    if (args.length === 0) return fail('discover needs at least one domain, e.g. gatech.edu')

    // One client across every domain, so its per-host limits still mean
    // something when a batch touches fifty schools.
    const client = new PoliteClient({ maxRetries: 1, timeoutMs: 12_000 })
    const verified: Discovery[] = []

    for (const domain of args) {
      const d = await discoverSchool(domain.replace(/^https?:\/\//, '').replace(/\/.*$/, ''), {
        client,
      })
      if (d.publicCatalog) {
        verified.push(d)
        console.log(`ok    ${d.domain.padEnd(24)} ${d.baseUrl}`)
        console.log(`      ${d.terms.length} terms, latest ${d.terms[0]?.code} ${d.terms[0]?.description}`)
      } else {
        console.log(`no    ${d.domain.padEnd(24)} ${d.sis ?? 'unknown'}: ${d.reason}`)
      }
    }

    if (verified.length === 0) {
      console.log(`\n0 of ${args.length} verified.`)
      return 1
    }

    console.log(`\n${verified.length} of ${args.length} verified. Configs below, all disabled.`)
    for (const d of verified) {
      const id = d.domain.replace(/\.(edu|org|com)$/i, '').replace(/[^a-z0-9]+/gi, '-').toLowerCase()
      console.log(`\n${'#'.repeat(70)}\n# schools/${id}.yaml\n${'#'.repeat(70)}`)
      console.log(toYaml(d))
    }
    return 0
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

        const found = await adapter.listSubjects(school, term)
        // Stored, not just printed. This is the browsable catalogue, and
        // recording it creates no polling work: a subject earns a poll target
        // from demand, never from being in the list. See core/discovery.ts.
        const { added } = repo.recordSubjects(school.id, term, found)
        for (const s of found) console.log(`${s.code.padEnd(8)} ${s.description}`)
        console.log(`\n${found.length} subject(s) recorded, ${added} new. None of them is polled yet.`)
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

/*
 * Setting `exitCode` and returning, rather than calling `process.exit()`.
 *
 * `process.exit()` tears the process down in the same tick, while libuv may
 * still be closing handles left over from the HTTP client. On Windows that is
 * not a graceful race to lose: node aborts with
 *
 *   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c
 *
 * after the command has already done its work and printed its output, which
 * reads as a crash and is not one. Nothing here keeps the loop alive once the
 * work is done, so letting node exit on its own is both correct and prompt.
 */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code
    })
    .catch((err) => {
      console.error('error:', err instanceof Error ? err.message : err)
      process.exitCode = 1
    })
}

export { main }
