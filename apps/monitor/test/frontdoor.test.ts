import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resendOutcome } from '../../web/src/lib/resend.js'

/**
 * The parts of this repo a person reads before they read any code, plus the one
 * web decision that can be checked without a browser.
 *
 * These are tests because the failures they catch are exactly the kind nothing
 * else notices. A README that reports the wrong test count and the wrong value
 * of the one flag that starts real traffic at a university is wrong in the file
 * everyone reads first; an emailed reset link that 404s on the host the
 * deployment doc names is a correct token, a healthy monitor, and a student who
 * still cannot get back into their account.
 *
 * `apps/web` has no test runner of its own, and adding one would be several
 * dependencies for a three-branch decision, so the one piece of web logic worth
 * pinning lives in a plain module that this suite imports directly.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

function read(path: string): string {
  return readFileSync(join(repoRoot, path), 'utf8')
}

// -------------------------------------------------------------- the em dash gate

/**
 * The rule the owner has stated four times, enforced by something that works.
 *
 * The shell one-liner this replaces did not work. A grep pattern written as a
 * backslash-u escape inside double quotes is not expanded by Git Bash, so grep
 * searches for those six ASCII characters, matches nothing, exits 1, and looks
 * exactly like an all-clear; the byte-pattern form refuses outright with
 * "grep: -P supports only unibyte and UTF-8 locales". A scan in the language
 * this repo is already written in has neither problem, and unlike ripgrep it
 * does not skip dotfiles such as .gitignore and .dockerignore.
 *
 * Written as an escape rather than as the character, so that this file is not
 * itself the first thing the scan finds.
 */
const EM_DASH = '\u2014'

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.vite'])
/** Not text, or machine-generated and not ours to write. */
const SKIP_FILES = new Set(['package-lock.json'])
const BINARY_EXT = /\.(png|jpe?g|gif|ico|webp|woff2?|ttf|eot|pdf|zip|db|db-shm|db-wal)$/i

function textFilesUnder(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(entry)) textFilesUnder(full, found)
      continue
    }
    if (SKIP_FILES.has(entry) || BINARY_EXT.test(entry)) continue
    found.push(full)
  }
  return found
}

describe('the no em dash rule', () => {
  it('holds across every committed text file, dotfiles included', () => {
    const offenders = textFilesUnder(repoRoot)
      .filter((file) => readFileSync(file, 'utf8').includes(EM_DASH))
      .map((file) => relative(repoRoot, file).replace(/\\/g, '/'))
    expect(offenders).toEqual([])
  })

  it('scans a surface wide enough to be worth trusting', () => {
    // A check that silently matched nothing is what this replaced, so the scan
    // asserts it actually looked at the files it claims to cover.
    const scanned = textFilesUnder(repoRoot).map((f) => relative(repoRoot, f).replace(/\\/g, '/'))
    expect(scanned.length).toBeGreaterThan(80)
    expect(scanned).toContain('.gitignore')
    expect(scanned).toContain('README.md')
    expect(scanned).toContain('apps/monitor/fly.toml')
  })
})

// ------------------------------------------------------------ the root README

describe('what the front door says', () => {
  it('reports the same test count the monitor README does', () => {
    // It said 625 while the suite ran 748. The monitor README had it right, so
    // the two are pinned to each other rather than to a number in a third place.
    const root = /\*\*Built, ([\d,]+) tests\*\*/.exec(read('README.md'))
    const monitor = /^([\d,]+) tests across/m.exec(read('apps/monitor/README.md'))
    expect(root).not.toBeNull()
    expect(monitor).not.toBeNull()
    expect(root![1]).toBe(monitor![1])
  })

  it('reports the value gatech.yaml actually ships', () => {
    // The single most consequential state change in the repo was documented as
    // not having happened: the README and PHASE0 both said `enabled: false`
    // "because turning it on starts continuous traffic at a real university",
    // while the file says true.
    const shipped = /^enabled:\s*(true|false)/m.exec(read('apps/monitor/schools/gatech.yaml'))
    expect(shipped).not.toBeNull()

    for (const doc of ['README.md', 'PHASE0.md']) {
      const claims = [...read(doc).matchAll(/enabled:\s*(true|false)/g)].map((m) => m[1])
      // Both of these documents mention the flag only in reference to gatech.
      expect(claims.length).toBeGreaterThan(0)
      for (const claim of claims) expect(claim).toBe(shipped![1])
    }
  })

  it('says what enabled alone does and does not start', () => {
    // "Flipping that one flag starts real polling of Georgia Tech" stopped being
    // true when registerSchool began seeding targets only for schools with
    // configured terms. A Banner school with enabled: true makes zero requests
    // until somebody runs the CLI.
    for (const doc of ['README.md', 'PHASE0.md']) {
      const text = read(doc)
      expect(text).toContain('cli -- terms gatech')
      expect(text).toMatch(/zero (upstream )?requests/)
    }
  })
})

// ------------------------------------------------- serving the built web app

describe('the last mile of an emailed link', () => {
  it('ships the rewrite that keeps /reset from 404ing', () => {
    // /reset, /verify and /app are history-API paths, not files in dist/. Vite
    // serves them in development because vite.config.ts sets appType: 'spa',
    // which is dev and preview only, so a static host has to be told.
    const rules = read('apps/web/public/_redirects')
    expect(rules).toMatch(/^\/\*\s+\/index\.html\s+200\s*$/m)
  })

  it('tells an operator the rule for a host that does not read _redirects', () => {
    const readme = read('apps/monitor/README.md')
    expect(readme).toContain('Serving the web app')
    expect(readme).toContain('try_files')
    // The consequence, not just the config, because the config alone reads as
    // optional tuning.
    expect(readme).toMatch(/404/)
  })
})

// ------------------------------------------- the deployment the doc describes

describe('the deployment notes', () => {
  it('names the header that keeps rate limits per student behind a proxy', () => {
    // fly.toml declares [http_service], so fly-proxy is in front and every
    // request arrives from one address. Unset, all five limiters collapse into
    // one global bucket for the whole user base.
    expect(read('apps/monitor/fly.toml')).toContain('CLASSPIK_CLIENT_IP_HEADER')
    const readme = read('apps/monitor/README.md')
    expect(readme).toContain('CLASSPIK_CLIENT_IP_HEADER')
    expect(readme).toMatch(/per source address[\s\S]{0,600}proxy/i)
  })

  it('lists email as something a real deployment must set, not may set', () => {
    // Without a provider the reset link is printed to the operator's log, which
    // is not a place a student can read. That is a launch blocker rather than a
    // thing to get around to.
    const table = read('apps/monitor/README.md').split('### The environment variables that matter')[1]
    expect(table).toBeDefined()
    expect(table!.split('###')[0]).toContain('CLASSPIK_EMAIL_PROVIDER')
  })
})

// ------------------------------------------------------- what the app says back

describe('asking for another verification link', () => {
  /**
   * `POST /api/auth/verify/request` answers `{ok, verified, sent}` and the
   * monitor works to make `sent` honest: false when the per-account budget is
   * spent, false when no provider is wired, false when the provider refused.
   * The banner read only `verified` and reported a send for all three.
   */
  it('reports a send only when one happened', () => {
    expect(resendOutcome({ verified: false, sent: true }, true)).toEqual({ state: 'sent', detail: '' })
  })

  it('says nothing was sent when the hourly budget is spent', () => {
    const out = resendOutcome({ verified: false, sent: false }, true)
    expect(out.state).toBe('throttled')
    expect(out.detail).toContain('Nothing was sent')
    expect(out.detail).toContain('last hour')
  })

  it('blames the missing provider rather than the student when there is none', () => {
    // Two honest answers to the same false, and they need different words: a
    // spent budget is fixed by waiting, an unconfigured provider never is.
    const out = resendOutcome({ verified: false, sent: false }, false)
    expect(out.state).toBe('throttled')
    expect(out.detail).toContain('no mail provider')
    expect(out.detail).not.toContain('last hour')
  })

  it('still treats an already-confirmed address as the useful answer it is', () => {
    // The link opened on a phone while this tab still showed the button.
    const out = resendOutcome({ verified: true, sent: false }, true)
    expect(out.state).toBe('sent')
    expect(out.detail).toContain('already confirmed')
  })
})
