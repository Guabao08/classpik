import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { buildAdapters } from './adapters/registry.js'
import { DEMO_SECTIONS, FixtureAdapter } from './adapters/fixture.js'
import { PoliteClient } from './adapters/http.js'
import type { SchoolConfig, SisAdapter, SisId } from './adapters/types.js'
import { loadSchoolsFromDir, parseSchoolConfig } from './config/schools.js'
import { migrate, openDb } from './core/db.js'
import { Repo } from './core/repo.js'
import { Poller, Runner } from './core/poller.js'
import { SubjectDiscovery } from './core/discovery.js'
import { ConsoleTransport, Dispatcher, WebhookTransport, type Transport } from './core/notify.js'
import { emailFromEnv } from './config/email.js'
import { AccountMail } from './core/accountmail.js'
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
    for (const school of schools) registerSchool(repo, school, log)
  }

  // Off unless an operator says otherwise. With it on, a watch may point at a
  // webhook on loopback or an RFC1918 host, which is useful against a local
  // sink and is an SSRF primitive anywhere else.
  const allowPrivateWebhooks = process.env.CLASSPIK_ALLOW_PRIVATE_WEBHOOKS === '1'
  if (allowPrivateWebhooks) {
    log('private webhook targets are allowed, which is a development setting only')
  }

  const transports: Transport[] = [
    new ConsoleTransport(),
    new WebhookTransport(undefined, undefined, { allowPrivateTargets: allowPrivateWebhooks }),
  ]
  const email = emailFromEnv()
  if (email) {
    transports.push(email.transport)
    log('email transport ready', { provider: email.provider, detail: email.detail })
  } else {
    log('email is not configured, that channel is not offered', {
      hint: 'set CLASSPIK_EMAIL_PROVIDER to resend or smtp',
    })
  }

  // Always constructed, with or without a provider behind it. Account recovery
  // is not an optional feature: a service that cannot issue a reset link is one
  // where a forgotten password means a new account. With no provider it prints
  // the link instead of mailing it, which keeps signup and reset working on a
  // development machine and is stated out loud below, because a link in a log is
  // a link anyone reading the log can use.
  const appUrl = (process.env.CLASSPIK_APP_URL ?? '').trim() || 'http://localhost:5173'
  const accountMail = new AccountMail({
    appUrl,
    delivery: email ? { mailer: email.mailer, identity: email.identity } : null,
    log,
  })
  if (!accountMail.enabled) {
    log('verification and password reset links will be PRINTED HERE, not mailed', {
      hint: 'treat this log as sensitive until CLASSPIK_EMAIL_PROVIDER is set',
    })
    // Louder when the app URL is not a laptop, because then the people opening
    // those links are students who cannot read this log. A forgotten password
    // with no reachable reset link is how somebody ends up with a second
    // account and their watches stranded on the first.
    if (!isLoopback(appUrl)) {
      log('WARNING: no email provider, and this instance is not on localhost', {
        appUrl,
        consequence: 'students cannot verify an address or complete a password reset',
        fix: 'set CLASSPIK_EMAIL_PROVIDER before letting anybody sign up',
      })
    }
  }
  log('account links point at the web app', { appUrl })

  // Which address every per-source rate limit is charged to. Stated at startup
  // because getting it wrong is invisible from the outside: behind a proxy with
  // this unset, all five limiters share one bucket for the whole user base, and
  // the symptom is students being throttled for somebody else's traffic.
  const clientIpHeader = (process.env.CLASSPIK_CLIENT_IP_HEADER ?? '').trim() || null
  if (clientIpHeader) {
    log('rate limits key on a proxy header', {
      header: clientIpHeader,
      note: 'only correct if the proxy in front overwrites this header on every request',
    })
  } else {
    log('rate limits key on the socket address', {
      hint: 'behind a proxy set CLASSPIK_CLIENT_IP_HEADER, or every per-address limit becomes one global bucket',
    })
  }

  const dispatcher = new Dispatcher(repo, transports)
  const poller = new Poller(repo, adapters, dispatcher, { log })
  const discovery = new SubjectDiscovery(repo, adapters, { log })
  const runner = new Runner(poller, dispatcher, {
    tickIntervalMs: opts.tickIntervalMs ?? 15_000,
    // Passed so the loop can prune expired sessions; nothing else called that.
    repo,
    discovery,
    log,
  })
  // Targets are leased, so this is safe to run alongside other copies of itself
  // against the same database. The id is what tells them apart in the lease.
  log('poller ready', { worker: poller.workerId })

  const adminToken = (process.env.CLASSPIK_ADMIN_TOKEN ?? '').trim() || null
  if (adminToken === null) {
    log('no CLASSPIK_ADMIN_TOKEN, so POST /api/poll is disabled', {
      hint: 'the loop polls on its own schedule either way',
    })
  }

  const server = createApi({
    repo,
    poller,
    dispatcher,
    discovery,
    accountMail,
    adminToken,
    allowPrivateWebhooks,
    clientIpHeader,
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

/**
 * Store a school and give it something to poll.
 *
 * Loading the config used to be the whole of this, which meant a school could
 * be enabled, log "school loaded", and then poll nothing at all forever:
 * `poll_targets` stayed empty, so `claimTargets` returned nothing and the
 * service ran with zero requests and zero errors and no line anywhere saying
 * so. Terms the config already knows are seeded here, and a school we cannot
 * seed says so out loud rather than looking healthy.
 *
 * Subject discovery does not replace this. It fills the browsable catalogue,
 * and a catalogue with nothing seeded still polls nothing, so the warning below
 * stays true and stays useful.
 */
export function registerSchool(
  repo: Repo,
  school: SchoolConfig,
  log: (msg: string, meta?: Record<string, unknown>) => void
): number {
  repo.upsertSchool(school)
  log('school loaded', { id: school.id, sis: school.sis, subjects: school.subjects.length })

  const terms = school.peoplesoft?.terms ?? []
  if (terms.length > 0) {
    repo.replaceTerms(school.id, terms)
    for (const term of terms) {
      for (const subject of school.subjects) {
        repo.ensureTarget(school.id, term.code, subject, school.polling.baseIntervalMs)
      }
    }
  }

  const targets = repo.countTargetsForSchool(school.id)
  if (targets === 0) {
    // Banner carries no term list in config, so its terms and targets come from
    // the CLI. Naming the exact command is the difference between a warning and
    // a shrug. Discovery does not remove this warning: it fills the browsable
    // catalogue, and a catalogue with nothing seeded still polls nothing, which
    // is the state this line exists to make visible.
    log('school has no poll targets, so nothing about it will be polled', {
      id: school.id,
      fix: `npm run cli -- seed ${school.id} <term>`,
      alternative: 'let discovery fill the catalogue, then browse a subject to seed it',
    })
  } else {
    log('poll targets ready', { id: school.id, targets })
  }
  return targets
}

/**
 * Whether the web app is somebody's own machine. Parsed rather than matched as
 * a substring, so a real host called `localhost.example.com` is not mistaken for
 * a laptop.
 */
function isLoopback(appUrl: string): boolean {
  let host: string
  try {
    host = new URL(appUrl).hostname
  } catch {
    return false
  }
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'
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
