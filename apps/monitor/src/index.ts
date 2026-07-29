import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { buildAdapters } from './adapters/registry.js'
import { DEMO_SECTIONS, FixtureAdapter } from './adapters/fixture.js'
import { PoliteClient } from './adapters/http.js'
import type { SisAdapter, SisId } from './adapters/types.js'
import { loadSchoolsFromDir, parseSchoolConfig } from './config/schools.js'
import { migrate, openDb } from './core/db.js'
import { Repo } from './core/repo.js'
import { Poller, Runner } from './core/poller.js'
import { ConsoleTransport, Dispatcher, WebhookTransport } from './core/notify.js'
import { createApi } from './api/server.js'

const here = dirname(fileURLToPath(import.meta.url))

export interface StartOptions {
  dbPath?: string
  schoolsDir?: string
  port?: number
  tickIntervalMs?: number
  /** Runs against a simulated SIS so nothing touches a real registrar. */
  demo?: boolean
  corsOrigins?: string[]
}

export async function start(opts: StartOptions = {}) {
  const dbPath = opts.dbPath ?? process.env.CLASSPIK_DB ?? join(process.cwd(), 'classpik.db')
  const schoolsDir = opts.schoolsDir ?? join(here, '..', 'schools')
  const port = opts.port ?? Number(process.env.PORT ?? 8787)
  const demo = opts.demo ?? process.env.CLASSPIK_DEMO === '1'

  const db = openDb(dbPath)
  const migration = migrate(db)
  const repo = new Repo(db)

  log('database ready', { path: dbPath, schema: migration.to, applied: migration.applied })

  const adapters = new Map<SisId, SisAdapter>()
  if (demo) {
    const fixture = new FixtureAdapter(DEMO_SECTIONS, {
      // Poll 2 frees a seat in the section everyone is waiting on.
      2: { '30412': { seats: 1 } },
      // Poll 4 takes it away again, so the history shows both directions.
      4: { '30412': { seats: 0 } },
    })
    adapters.set('banner9', fixture)
    repo.upsertSchool(
      parseSchoolConfig(
        {
          id: 'demo-university',
          name: 'Demo University',
          sis: 'banner9',
          baseUrl: 'https://banner.demo.invalid',
          subjects: ['MATH', 'CS'],
          polling: { baseIntervalMs: 60_000, minIntervalMs: 30_000, maxIntervalMs: 120_000, hotWindowMs: 60_000 },
          enabled: true,
        },
        'demo'
      )
    )
    repo.replaceTerms('demo-university', [{ code: '202608', description: 'Fall 2026' }])
    for (const subject of ['MATH', 'CS']) {
      repo.ensureTarget('demo-university', '202608', subject, 60_000)
    }
    log('demo mode: simulated SIS, no real registrar is contacted')
  } else {
    const client = new PoliteClient()
    for (const [id, adapter] of buildAdapters(client)) adapters.set(id, adapter)

    const schools = loadSchoolsFromDir(schoolsDir).filter((s) => s.enabled)
    if (schools.length === 0) {
      log('no enabled schools found', { schoolsDir, hint: 'set enabled: true in a schools/*.yaml, or run with --demo' })
    }
    for (const school of schools) {
      repo.upsertSchool(school)
      log('school loaded', { id: school.id, sis: school.sis, subjects: school.subjects.length })
    }
  }

  const dispatcher = new Dispatcher(repo, [new ConsoleTransport(), new WebhookTransport()])
  const poller = new Poller(repo, adapters, dispatcher, { log })
  const runner = new Runner(poller, dispatcher, {
    tickIntervalMs: opts.tickIntervalMs ?? 15_000,
    log,
  })

  const server = createApi({
    repo,
    poller,
    dispatcher,
    corsOrigins: opts.corsOrigins ?? corsFromEnv(),
  })

  await new Promise<void>((resolve) => server.listen(port, resolve))
  runner.start()
  log('monitor listening', { port, url: `http://localhost:${port}` })

  const shutdown = async (): Promise<void> => {
    log('shutting down')
    await runner.stop()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    db.close()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())

  return { db, repo, poller, dispatcher, runner, server, shutdown }
}

function corsFromEnv(): string[] {
  const raw = process.env.CLASSPIK_CORS_ORIGINS
  if (raw) return raw.split(',').map((s) => s.trim()).filter(Boolean)
  // The web app in this repo, in development.
  return ['http://localhost:5173', 'http://localhost:57608']
}

export function log(msg: string, meta?: Record<string, unknown>): void {
  const line = meta && Object.keys(meta).length > 0 ? `${msg} ${JSON.stringify(meta)}` : msg
  console.log(`${new Date().toISOString()} ${line}`)
}

// pathToFileURL, not string concatenation: on Windows a path becomes
// file:///C:/... with three slashes, so a hand-built file:// prefix never
// matches and the server silently refuses to start.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly || process.env.CLASSPIK_START === '1') {
  start({ demo: process.argv.includes('--demo') }).catch((err) => {
    console.error('failed to start:', err)
    process.exit(1)
  })
}
