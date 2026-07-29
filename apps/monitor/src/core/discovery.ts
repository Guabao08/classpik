import { SisError, type SisAdapter } from '../adapters/types.js'
import type { Repo } from './repo.js'

/**
 * Subject discovery, and the deliberate decision not to poll what it finds.
 *
 * A school used to be onboarded by hand-enumerating its subject codes in YAML.
 * That works for a pilot and does not survive a second campus: a large
 * university publishes two hundred or more codes, they change between terms,
 * and nobody is going to keep that list right. `listSubjects` on the adapter
 * already knows the answer, so this asks it.
 *
 * The trap is what to do with the answer. Turning two hundred discovered
 * subjects into two hundred poll targets would multiply our request rate at
 * that registrar by two orders of magnitude to serve, typically, students
 * watching sections in three or four of them. That is the exact impoliteness
 * the per-subject polling unit exists to avoid, and it is how a school blocks
 * us and every student there goes dark. So discovery writes to the `subjects`
 * table, which is a browsing catalogue and costs nothing, and a subject becomes
 * a poll target only when demand appears.
 *
 * ## The bootstrap problem, and how it is solved
 *
 * "Poll it once somebody watches it" is circular on its own. A watch names a
 * section, sections only exist after a fetch, and the fetch is what we are
 * refusing to do. Left there, a discovered subject could never become watchable
 * and the feature would be decorative.
 *
 * The cut is an on-demand seed: browsing a subject buys it exactly one fetch.
 * See `POST /api/subjects/seed`. That is bounded by how many subjects a person
 * actually opens, which is a handful, rather than by how many subjects the
 * catalogue contains, which is unbounded from our point of view. Three things
 * keep it honest:
 *
 *  - `subjects.seeded_at` is claimed by the UPDATE itself, so a subject buys
 *    one fetch ever, however many people browse it or how often they refresh.
 *  - The seed only queues a poll target. The existing bootstrap path in the
 *    poller performs the fetch on its next tick, under the same rate limiting
 *    as everything else, rather than an HTTP handler firing at a registrar
 *    while a student holds the connection open.
 *  - A seeded target that nobody ends up watching is polled once and then goes
 *    quiet, because `claimTargets` requires a live watch for anything already
 *    polled. Curiosity costs one request, not a subscription.
 */

export interface DiscoveryOptions {
  now?: () => number
  log?: (msg: string, meta?: Record<string, unknown>) => void
}

export interface DiscoveryResult {
  /** (school, term) pairs asked about. One upstream request each, not one per subject. */
  queried: number
  subjects: number
  added: number
  errors: number
}

export class SubjectDiscovery {
  private readonly now: () => number
  private readonly log: (msg: string, meta?: Record<string, unknown>) => void

  constructor(
    private readonly repo: Repo,
    private readonly adapters: Map<string, SisAdapter>,
    opts: DiscoveryOptions = {}
  ) {
    this.now = opts.now ?? Date.now
    this.log = opts.log ?? (() => {})
  }

  /**
   * Refresh the catalogue for every enabled school and known term.
   *
   * The cost is one request per (school, term), which is why this can run on a
   * slow timer and be forgotten about. A school whose terms are not known yet
   * is skipped rather than guessed at: Banner discovers terms upstream and
   * PeopleSoft reads them from config, and inventing one would mean asking a
   * registrar about a term that does not exist.
   */
  async run(signal?: AbortSignal): Promise<DiscoveryResult> {
    const out: DiscoveryResult = { queried: 0, subjects: 0, added: 0, errors: 0 }

    for (const school of this.repo.listSchools()) {
      if (!school.enabled) continue
      const adapter = this.adapters.get(school.sis)
      if (!adapter) continue

      for (const term of this.repo.listTerms(school.id)) {
        if (signal?.aborted) return out
        out.queried++
        try {
          const found = await adapter.listSubjects(school, term.code, { signal })
          const { recorded, added } = this.repo.recordSubjects(school.id, term.code, found)
          out.subjects += recorded
          out.added += added
          if (added > 0) {
            this.log('subjects discovered', {
              school: school.id,
              term: term.code,
              total: recorded,
              new: added,
            })
          }
        } catch (err) {
          // Never fatal. Discovery is a convenience on top of the configured
          // subject list, and a registrar that will not answer this must not
          // stop the poll loop that is already serving watches.
          out.errors++
          const transient = err instanceof SisError ? err.transient : true
          this.log('subject discovery failed', {
            school: school.id,
            term: term.code,
            transient,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
    }

    return out
  }

  /**
   * Grant a subject the one bootstrap fetch that makes its sections watchable.
   *
   * Returns what happened so a caller can say something true to the person
   * waiting: `queued` bought a fetch, `already` means one is queued or done, and
   * `unknown` means the subject is not in this school's catalogue and no
   * request will be made for it. That last one is the guard that matters. A
   * seed that acted on any string a caller sent would be an open instruction to
   * make our server go and fetch things at a university, so the discovered
   * catalogue and the school's own configured subject list are the only two
   * things it will act on.
   *
   * The poll target is the deduplication, not a check-then-act in here.
   * `ensureTarget` is an upsert on `(school, term, subject)`, so any number of
   * students opening the same subject at the same moment converge on one row
   * and therefore one fetch. `seeded_at` records that this subject arrived by
   * browsing rather than from config, which is worth knowing when reading the
   * catalogue later.
   */
  seed(schoolId: string, term: string, subject: string): 'queued' | 'already' | 'unknown' {
    const school = this.repo.getSchool(schoolId)
    if (!school || !school.enabled) return 'unknown'
    if (!this.repo.listTerms(schoolId).some((t) => t.code === term)) return 'unknown'

    const code = subject.trim().toUpperCase()
    const discovered = this.repo.getSubject(schoolId, term, code)
    if (discovered === null && !school.subjects.includes(code)) return 'unknown'

    // An inactive target is one a permanent error switched off. Browsing must
    // not re-arm it, or a subject that 404s becomes a request every time
    // somebody clicks it.
    if (this.repo.getTarget(`${schoolId}:${term}:${code}`) !== null) return 'already'

    if (discovered !== null) this.repo.markSubjectSeeded(schoolId, term, code, this.now())
    this.repo.ensureTarget(schoolId, term, code, school.polling.baseIntervalMs)
    this.log('subject seeded on demand', { school: schoolId, term, subject: code })
    return 'queued'
  }
}
