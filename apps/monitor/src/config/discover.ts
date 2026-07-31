import { PoliteClient } from '../adapters/http.js'
import { detectSis } from '../adapters/registry.js'
import type { SisId, Term } from '../adapters/types.js'

/**
 * Find a school's student system, and prove we can read its catalog.
 *
 * Two throwaway probes preceded this one and both failed the same way, so the
 * method here is deliberate rather than obvious.
 *
 * The first guessed hostnames (`banner.<domain>`, `ssb.<domain>`, and six more)
 * and found 1 school in 70. The one it found, Georgia Tech, does not match any
 * of those patterns: its Banner 9 app is at `registration.banner.gatech.edu`,
 * and `oscar.gatech.edu`, the host everyone including our own docs called the
 * registration system, 404s every StudentRegistrationSsb path. Guessing
 * hostnames does not work because there is no convention to guess.
 *
 * What did work was reading the links off a page the school publishes. Schools
 * link to their own registration system, so ask them instead of guessing.
 *
 * The second decision that matters: finding a link is not the answer. A link
 * proves a school runs Banner. Only calling the thing proves its catalog
 * answers *us*, logged out. So discovery ends with a live `getTerms`, and a
 * school that fails it is reported as found-but-gated rather than as a hit. The
 * difference is the entire premise of the credential-free half of this product.
 */

export interface Discovery {
  domain: string
  /** What the school runs, as far as their own links reveal. */
  sis: SisId | null
  /** Origin an adapter would be pointed at, once verified. */
  baseUrl: string | null
  /** Set only when a live call succeeded without credentials. */
  publicCatalog: boolean
  /** Proof of the above: what the school actually answered. */
  terms: Term[]
  /** URLs that led here, so a human can check the trail. */
  evidence: string[]
  /** Why this is not a hit, in a sentence someone can act on. */
  reason: string | null
}

export interface DiscoverOptions {
  client?: PoliteClient
  signal?: AbortSignal
  /** Pages to read. Overridable so tests do not encode a hostname convention. */
  entryPoints?: (domain: string) => string[]
  /**
   * Same-site pages to follow when an entry point does not itself link to the
   * SIS. Bounded because this is somebody's web server: four is enough for the
   * one hop schools actually use, and refuses to become a crawler.
   */
  maxFollow?: number
}

/**
 * Link text and hrefs worth one more request.
 *
 * Georgia Tech is the case this exists for. Its registrar page links to the SIS
 * on no page we would have guessed: `registrar.gatech.edu/registration` carries
 * no Banner URL at all, only a relative "Schedule of Classes" link, and the
 * Banner host appears one hop further on. Reading absolute URLs alone found
 * nothing at the one school we had already verified by hand.
 */
const PROMISING =
  /class[-_ ]?search|schedule[-_ ]?of[-_ ]?classes|browse[-_ ]?class|look[-_ ]?up[-_ ]?class|course[-_ ]?catalog|registration|register/i

/**
 * Pages a school plausibly publishes about registering. Cheap to try and the
 * order matters: a registrar's own site links to the real system, while a
 * university homepage links to a hundred other things first.
 */
export function defaultEntryPoints(domain: string): string[] {
  return [
    `https://registrar.${domain}/`,
    `https://registrar.${domain}/registration`,
    `https://${domain}/registrar`,
    `https://${domain}/`,
  ]
}

const BANNER_PATH = /\/StudentRegistrationSsb\//i

export async function discoverSchool(
  domain: string,
  opts: DiscoverOptions = {}
): Promise<Discovery> {
  const client = opts.client ?? new PoliteClient({ maxRetries: 1, timeoutMs: 12_000 })
  const entries = (opts.entryPoints ?? defaultEntryPoints)(domain)

  const result: Discovery = {
    domain,
    sis: null,
    baseUrl: null,
    publicCatalog: false,
    terms: [],
    evidence: [],
    reason: null,
  }

  const origins = new Set<string>()
  const maxFollow = opts.maxFollow ?? 4
  const queue = [...entries]
  const visited = new Set<string>()
  let followed = 0

  while (queue.length > 0 && origins.size === 0) {
    if (opts.signal?.aborted) break
    const page = queue.shift()!
    if (visited.has(page)) continue
    visited.add(page)

    const html = await fetchText(client, page, opts.signal)
    if (html === null) continue
    result.evidence.push(page)

    for (const url of absoluteUrls(html)) {
      const sis = detectSis(url)
      if (sis === null) continue
      // First one wins for reporting, but keep collecting Banner origins: a
      // page often carries several links to the same app under different paths.
      result.sis ??= sis
      if (sis === 'banner9' && BANNER_PATH.test(url)) {
        try {
          origins.add(new URL(url).origin)
        } catch {
          /* a malformed href on someone's CMS is not our problem */
        }
      }
    }

    if (origins.size > 0) break

    // Nothing here, so follow the links that sound like they lead to it. One
    // hop only: the budget is shared across the whole run, not per page.
    for (const link of followable(html, page)) {
      if (followed >= maxFollow) break
      if (visited.has(link) || queue.includes(link)) continue
      queue.push(link)
      followed++
    }
  }

  if (result.sis === null) {
    result.reason = 'no link to a known student system on any page we read'
    return result
  }
  if (origins.size === 0) {
    result.reason = `looks like ${result.sis}, which discovery does not verify yet`
    return result
  }

  // Verification. A link is a claim; this is the check.
  const failures: string[] = []
  for (const origin of origins) {
    if (opts.signal?.aborted) break
    const url = `${origin}/StudentRegistrationSsb/ssb/classSearch/getTerms?offset=1&max=10&searchTerm=`
    result.evidence.push(url)

    const terms = await fetchTerms(client, url, opts.signal)
    if (terms === null) {
      failures.push(origin)
      continue
    }
    result.sis = 'banner9'
    result.baseUrl = origin
    result.publicCatalog = true
    result.terms = terms
    return result
  }

  result.baseUrl = [...origins][0] ?? null
  result.reason =
    `found Banner at ${failures.join(', ')} but its term list did not answer ` +
    `without a login, so the catalog is gated`
  return result
}

async function fetchText(
  client: PoliteClient,
  url: string,
  signal?: AbortSignal
): Promise<string | null> {
  try {
    const res = await client.request(url, { signal })
    const type = res.headers.get('content-type') ?? ''
    if (!/html|text/i.test(type)) return null
    return await res.text()
  } catch {
    // A registrar with no site at the guessed path is the normal case, not an
    // error worth surfacing. The reason field carries the outcome instead.
    return null
  }
}

async function fetchTerms(
  client: PoliteClient,
  url: string,
  signal?: AbortSignal
): Promise<Term[] | null> {
  try {
    const dto = await client.json<Array<{ code?: unknown; description?: unknown }>>(url, { signal })
    if (!Array.isArray(dto) || dto.length === 0) return null
    const terms = dto
      .filter((t) => t !== null && typeof t === 'object' && t.code !== undefined)
      .map((t) => ({
        code: String(t.code),
        // Banner marks archived terms with markup, e.g. "Fall 2026 (View Only)".
        description: String(t.description ?? '').replace(/<[^>]*>/g, '').trim(),
      }))
    return terms.length > 0 ? terms : null
  } catch {
    return null
  }
}

/** Absolute URLs only. A relative /psc/ on a marketing page is noise. */
function absoluteUrls(html: string): string[] {
  return html.match(/https?:\/\/[^\s"'<>)]+/g) ?? []
}

/**
 * Same-site links whose href or anchor text suggests a class search, resolved
 * against the page they were found on so relative hrefs work.
 *
 * Same-site on purpose. Following a promising link off-site turns this into a
 * crawler of the open web, and the thing we are looking for is always published
 * by the school.
 */
export function followable(html: string, pageUrl: string): string[] {
  let origin: string
  try {
    origin = new URL(pageUrl).origin
  } catch {
    return []
  }

  const out = new Set<string>()
  const anchor = /<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]{0,150}?)<\/a>/gi
  for (const m of html.matchAll(anchor)) {
    const href = m[1] ?? ''
    const text = (m[2] ?? '').replace(/<[^>]*>/g, ' ')
    if (!PROMISING.test(href) && !PROMISING.test(text)) continue
    try {
      const u = new URL(href, pageUrl)
      if (u.origin !== origin) continue
      if (u.protocol !== 'https:' && u.protocol !== 'http:') continue
      u.hash = ''
      out.add(u.href)
    } catch {
      /* unparseable href */
    }
  }
  return [...out]
}

/**
 * A config file for a verified school, ready to drop in `schools/`.
 *
 * Written disabled, always. Discovery proves a catalog is readable; it does not
 * decide that we should start reading it every five minutes. Someone owns that
 * choice, and it should cost them a deliberate edit.
 */
export function toYaml(d: Discovery, opts: { subjects?: string[] } = {}): string {
  if (!d.publicCatalog || d.baseUrl === null) {
    throw new Error(`refusing to write a config for ${d.domain}: catalog not verified`)
  }
  const id = d.domain.replace(/\.(edu|org|com)$/i, '').replace(/[^a-z0-9]+/gi, '-').toLowerCase()
  const subjects = opts.subjects ?? []
  const termLines = d.terms
    .slice(0, 6)
    .map((t) => `#   ${t.code}  ${t.description}`)
    .join('\n')

  return `# Discovered and verified on ${new Date().toISOString().slice(0, 10)}.
# The term list below came back from a live, logged-out call:
${termLines}
#
# Seed poll targets before this school polls anything:
#   npm run cli -- seed ${id} <term>

id: ${id}
name: ${d.domain}
sis: banner9
baseUrl: ${d.baseUrl}

# One request returns every section for a subject, so this list is the whole
# polling cost. Keep it to subjects students actually watch.
subjects:${subjects.length === 0 ? ' []' : '\n' + subjects.map((s) => `  - ${s.toUpperCase()}`).join('\n')}

polling:
  baseIntervalMs: 300000
  minIntervalMs: 60000
  maxIntervalMs: 1800000
  hotWindowMs: 900000
  maxConcurrentRequests: 2
  minRequestGapMs: 500

# Discovery does not enable a school. Turning this on starts continuous traffic
# at a real university, and that is a decision a person makes.
enabled: false
`
}
