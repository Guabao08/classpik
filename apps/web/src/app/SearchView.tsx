import { useEffect, useMemo, useRef, useState } from 'react'
import {
  api,
  ApiError,
  type School,
  type SearchScope,
  type Section,
  type User,
  type Watch,
} from '../lib/api'
import { useLevels, useSubjects } from '../lib/catalog'
import { SeatBar, StatusPill } from '../components/ui'

const FILTERS = [
  { id: '', label: 'All sections' },
  { id: 'open', label: 'Open now' },
  { id: 'waitlist', label: 'Waitlist open' },
  { id: 'full', label: 'Full' },
] as const

/** The one place the section table's columns are written down. */
const COLUMNS = 'md:grid md:grid-cols-[1.7fr_0.9fr_1fr_0.85fr_auto] md:gap-4'

export default function SearchView({
  watched,
  onToggle,
  user,
  onUser,
  schools,
}: {
  watched: Map<string, Watch>
  onToggle: (sectionId: string) => void
  user: User
  /** The scope lives on the account, so changing it hands back a new user. */
  onUser: (user: User) => void
  /** Only so the scope can be named rather than printed as an id. */
  schools: School[]
}) {
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<string>('')
  const [sections, setSections] = useState<Section[]>([])
  // What the monitor actually narrowed to. It echoes this back precisely so a
  // shorter list is explained rather than left looking like a broken catalog,
  // and it used to be thrown away here.
  const [scope, setScope] = useState<SearchScope | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState<string | null>(null)

  // Debounced so typing "MATH 221" is one request, not eight.
  const debounced = useDebounced(query, 250)

  // The school, term and levels are not sent with the search: the monitor reads
  // them off the account. They are here only so the results reload when the
  // student changes one.
  const scopeKey = `${user.school ?? ''}|${user.term ?? ''}|${user.levels.join(',')}`

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    api
      .sections({ q: debounced || undefined, status: status || undefined })
      .then((res) => {
        if (cancelled) return
        setSections(res.sections)
        setScope(res.scope)
        setError(null)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof ApiError ? err.message : 'Search failed')
        setSections([])
      })
      .finally(() => !cancelled && setLoading(false))
    return () => { cancelled = true }
  }, [debounced, status, scopeKey])

  const handleToggle = async (id: string) => {
    setPending(id)
    await onToggle(id)
    setPending(null)
  }

  const widenLevels = async () => {
    const res = await api.updatePreferences({ levels: null })
    onUser(res.user)
  }

  return (
    <div className="px-5 py-6 md:px-9 md:py-8">
      <header className="mb-5">
        <h1 className="text-2xl font-bold tracking-[-0.02em]">Find classes</h1>
        <p className="mt-1.5 text-sm text-ink-soft">
          Seat counts from your school’s public schedule. Your school login is never involved.
        </p>
      </header>

      <div className="mb-5 flex flex-wrap items-center gap-3">
        <label className="flex w-full min-w-0 items-center gap-2.5  border border-rule bg-ink/3 px-3.5 py-2.5 transition-colors focus-within:border-open/40 sm:w-auto sm:min-w-[300px] sm:flex-1">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="shrink-0 text-ink-soft">
            <circle cx="10.5" cy="10.5" r="6.5" stroke="currentColor" strokeWidth="1.8" />
            <path d="m15.5 15.5 4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Course code, title, CRN, or instructor"
            aria-label="Search the course catalog"
            className="w-full bg-transparent text-sm outline-none placeholder:text-ink-soft/70"
          />
        </label>

        <div className="flex flex-wrap gap-1.5  border border-rule bg-ink/3 p-1">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              onClick={() => setStatus(f.id)}
              className={` px-3 py-1.5 text-xs font-medium transition-colors ${
                status === f.id ? 'bg-ink/10 text-ink' : 'text-ink-soft hover:text-ink'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <LevelFilter user={user} onUser={onUser} />

      <SubjectBrowser user={user} />

      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <span className="num text-xs text-ink-soft">
          {loading ? 'searching…' : `${sections.length} section${sections.length === 1 ? '' : 's'}`}
        </span>
        <ScopeLine scope={scope} schools={schools} />
      </div>

      <div className="panel overflow-hidden">
        {/* Hidden on narrow screens, where each row becomes a labelled card
            instead. A five column table in 154px of a phone is unreadable, and
            a phone is where a seat alert is read. */}
        <div className={`hidden border-b border-rule px-5 py-3 text-[11px] font-semibold uppercase tracking-wider text-ink-soft ${COLUMNS}`}>
          <span>Course</span>
          <span>Meets</span>
          <span>Seats</span>
          <span>Status</span>
          <span />
        </div>

        {error ? (
          <div className="px-5 py-14 text-center">
            <p className="text-sm font-medium text-full">{error}</p>
          </div>
        ) : sections.length === 0 && !loading ? (
          <EmptyState
            query={query}
            status={status}
            scope={scope}
            schools={schools}
            onWidenLevels={() => void widenLevels()}
          />
        ) : (
          sections.map((s) => {
            const isWatched = watched.has(s.id)
            return (
              <div
                key={s.id}
                className={`flex flex-col gap-2 border-b border-rule px-5 py-3.5 transition-colors last:border-0 hover:bg-ink/2 md:items-center ${COLUMNS}`}
              >
                <div className="min-w-0">
                  <div className="flex items-baseline gap-2">
                    <span className="text-sm font-semibold">
                      {s.code} <span className="text-ink-soft">· {s.section}</span>
                    </span>
                    <span className="num text-[11px] text-ink-soft">{s.crn}</span>
                  </div>
                  <div className="mt-0.5 truncate text-xs text-ink-soft">
                    {s.title}
                    {s.instructor ? ` · ${s.instructor}` : ''}
                    {/* The registrar's own code, never a word we invented for it. */}
                    {s.level ? ` · ${s.level}` : ''}
                  </div>
                </div>

                <div className="num text-xs text-ink-soft">
                  <span className="md:hidden">Meets: </span>
                  {s.meetingDays ? `${s.meetingDays} ${s.meetingTime ?? ''}`.trim() : 'TBA'}
                </div>

                <div>
                  <SeatBar seats={s.seats} capacity={s.capacity} />
                  {s.waitlist > 0 && (
                    <div className="num mt-1 text-[11px] text-wait">
                      {s.waitlist}/{s.waitlistCap} waitlisted
                    </div>
                  )}
                </div>

                <div className="flex items-center justify-between gap-3 md:block">
                  <StatusPill status={s.status} />
                </div>

                <button
                  onClick={() => void handleToggle(s.id)}
                  disabled={pending === s.id}
                  className={`w-full rounded-full px-3.5 py-1.5 text-xs font-semibold transition disabled:opacity-50 md:w-auto ${
                    isWatched
                      ? 'border border-open/30 bg-open/12 text-open'
                      : 'border border-rule text-ink-soft hover:border-ink/25 hover:text-ink'
                  }`}
                >
                  {pending === s.id ? '…' : isWatched ? 'Watching' : 'Watch'}
                </button>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

/** The school's own name where we have it, since an id means nothing to a student. */
function schoolName(schools: School[], id: string | null): string | null {
  if (id === null) return null
  return schools.find((s) => s.id === id)?.name ?? id
}

/** The term's own description where we have it, for the same reason. */
function termName(schools: School[], schoolId: string | null, code: string | null): string | null {
  if (code === null) return null
  const school = schools.find((s) => s.id === schoolId)
  return school?.terms.find((t) => t.code === code)?.description ?? code
}

/**
 * What the search was narrowed to, in the student's words rather than in codes.
 *
 * The monitor sends this back on every search for exactly this purpose. A
 * filter the user cannot see is indistinguishable from a catalog that is
 * missing classes, and that was the state of things: three MATH 221 sections
 * hidden by the account's own level filter, with the UI blaming the query.
 */
function ScopeLine({ scope, schools }: { scope: SearchScope | null; schools: School[] }) {
  if (scope === null) return null
  const parts = describeScope(scope, schools)
  if (parts.length === 0) return <span className="text-xs text-ink-soft">Showing every school</span>
  return (
    <span className="text-xs text-ink-soft">
      Showing <span className="text-ink">{parts.join(' · ')}</span>
    </span>
  )
}

function describeScope(scope: SearchScope, schools: School[]): string[] {
  const parts: string[] = []
  const school = schoolName(schools, scope.school)
  if (school) parts.push(school)
  const term = termName(schools, scope.school, scope.term)
  if (term) parts.push(term)
  if (scope.levels.length > 0) parts.push(scope.levels.join(', '))
  return parts
}

/**
 * Why the list is empty, naming the thing that actually emptied it.
 *
 * The old copy guessed, and it guessed wrong in the most common case: it told a
 * student to try a course code like MATH 221 when MATH 221 was the exact string
 * they had typed and their own GRAD filter was hiding all three sections of it.
 */
function EmptyState({
  query,
  status,
  scope,
  schools,
  onWidenLevels,
}: {
  query: string
  status: string
  scope: SearchScope | null
  schools: School[]
  onWidenLevels: () => void
}) {
  const narrowed = scope !== null && describeScope(scope, schools).length > 0
  const levels = scope?.levels ?? []

  return (
    <div className="px-5 py-14 text-center">
      <p className="text-sm font-medium">
        {query ? `No sections match “${query}”.` : 'No sections here yet.'}
      </p>

      {narrowed && (
        <p className="mt-1.5 text-xs text-ink-soft">
          This search covers {describeScope(scope!, schools).join(' · ')} only. Change the school or
          term in the sidebar to look somewhere else.
        </p>
      )}

      {levels.length > 0 && (
        <p className="mt-3 text-xs text-ink-soft">
          <button
            onClick={onWidenLevels}
            className="rounded-full border border-rule px-3 py-1.5 text-xs font-semibold text-ink transition hover:border-ink/25"
          >
            Show every level
          </button>
          <span className="ml-2">
            {levels.join(', ')} {levels.length === 1 ? 'is' : 'are'} filtering these results.
          </span>
        </p>
      )}

      {status && (
        <p className="mt-2 text-xs text-ink-soft">The {status} filter is on as well.</p>
      )}

      {!narrowed && !query && (
        <p className="mt-1.5 text-xs text-ink-soft">
          Open a subject above to have the monitor fetch it.
        </p>
      )}
    </div>
  )
}

/**
 * The subjects a school publishes, and the one thing a student can do about a
 * subject nobody has fetched yet.
 *
 * Discovery deliberately creates no polling work: a two hundred subject
 * catalogue would otherwise become two hundred requests at a registrar to serve
 * students watching three or four of them. The cost of that decision is a
 * bootstrap problem, and browsing is how it is paid: opening a subject buys it
 * exactly one fetch. Until this existed the app had no way to perform that,
 * so a school onboarded the way the monitor recommends, with `subjects: []`,
 * showed a permanently empty Find classes and told the student to wait for a
 * poll that could never happen.
 */
function SubjectBrowser({ user }: { user: User }) {
  const { subjects, reload } = useSubjects(user.school, user.term)
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const unseeded = subjects.filter((s) => !s.seeded)

  // Nothing honest to show without a school and term to name in the seed, and
  // nothing to browse at a school whose catalogue has not been discovered.
  if (user.school === null || user.term === null || subjects.length === 0) return null

  const seed = async (code: string) => {
    setPending(code)
    setError(null)
    try {
      const res = await api.seedSubject({ school: user.school!, term: user.term!, subject: code })
      // Deliberately not "here are your classes". The seed queues a target and
      // the poll loop performs the fetch on its next cycle, under the same rate
      // limiting as everything else.
      setNote(
        res.status === 'queued'
          ? `${code} is queued. The first check runs on the next cycle.`
          : `${code} is already queued.`
      )
      reload()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : `Could not open ${code}`)
    } finally {
      setPending(null)
    }
  }

  return (
    <div className="mb-5  border border-rule bg-ink/3">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
      >
        <span className="text-xs font-semibold">
          Subjects
          <span className="ml-2 font-normal text-ink-soft">
            {unseeded.length === 0
              ? `all ${subjects.length} fetched`
              : `${unseeded.length} of ${subjects.length} not fetched yet`}
          </span>
        </span>
        <span className="text-xs text-ink-soft">{open ? 'Hide' : 'Browse'}</span>
      </button>

      {open && (
        <div className="border-t border-rule px-4 py-3">
          <p className="mb-3 text-[11px] leading-relaxed text-ink-soft">
            A subject is only fetched once somebody opens it. That is what keeps this from
            being hundreds of requests at your registrar for classes nobody is watching.
          </p>

          <div className="flex flex-wrap gap-1.5">
            {subjects.map((s) => (
              <button
                key={s.code}
                title={s.description}
                disabled={s.seeded || pending === s.code}
                onClick={() => void seed(s.code)}
                className={`rounded-full px-3 py-1.5 text-xs font-medium transition disabled:cursor-default ${
                  s.seeded
                    ? 'border border-open/30 bg-open/12 text-open'
                    : 'border border-rule text-ink-soft hover:border-ink/25 hover:text-ink'
                }`}
              >
                {s.code}
                {pending === s.code && <span className="ml-1.5">…</span>}
              </button>
            ))}
          </div>

          {note && <p className="mt-3 text-[11px] text-open">{note}</p>}
          {error && <p className="mt-3 text-[11px] text-full">{error}</p>}
        </div>
      )}
    </div>
  )
}

/**
 * The academic levels this search covers, starting from the ones on the
 * account, which is where onboarding put them.
 *
 * Ticking one edits the account rather than the query string, because the
 * monitor scopes search off the account and two sources for the same thing
 * eventually disagree. It is also the only place the scope widens: an
 * undergraduate gets undergraduate classes by default, and a graduate seminar
 * is a box they tick rather than something we guess at.
 *
 * The school and the term are not here. They are in the sidebar, because they
 * are true everywhere in the app, and this one is a filter over the list
 * directly below it.
 */
function LevelFilter({ user, onUser }: { user: User; onUser: (user: User) => void }) {
  const levels = useLevels(user.school, user.term)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // No school means no published list of levels to tick, so there is nothing
  // honest to show. An empty row of buttons would read as a school with no
  // levels rather than as a question we cannot ask yet.
  if (levels.length === 0) return null

  const toggle = async (level: string) => {
    setSaving(true)
    try {
      const res = await api.updatePreferences({
        levels: user.levels.includes(level)
          ? user.levels.filter((x) => x !== level)
          : [...user.levels, level],
      })
      onUser(res.user)
      setError(null)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not change the levels')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mb-5 flex flex-wrap items-center gap-2">
      <span className="text-xs text-ink-soft">Levels</span>

      {levels.map((l) => {
        const on = user.levels.includes(l.level)
        return (
          <button
            key={l.level}
            aria-pressed={on}
            disabled={saving}
            onClick={() => void toggle(l.level)}
            className={`rounded-full px-3 py-1.5 text-xs font-medium transition disabled:opacity-50 ${
              on
                ? 'border border-open/30 bg-open/12 text-open'
                : 'border border-rule text-ink-soft hover:border-ink/25 hover:text-ink'
            }`}
          >
            {/* The registrar's own code, never a word we invented for it. */}
            {l.level}
            <span className="num ml-1.5 text-[10px] opacity-70">{l.sections}</span>
          </button>
        )
      })}

      {user.levels.length === 0 && <span className="text-[11px] text-ink-soft">every level</span>}

      {error && <span className="text-[11px] text-full">{error}</span>}
    </div>
  )
}

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setDebounced(value), ms)
    return () => { if (timer.current) clearTimeout(timer.current) }
  }, [value, ms])
  return useMemo(() => debounced, [debounced])
}
