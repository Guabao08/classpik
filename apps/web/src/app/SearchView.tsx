import { useEffect, useMemo, useRef, useState } from 'react'
import { api, ApiError, type Section, type User, type Watch } from '../lib/api'
import { useLevels } from '../lib/catalog'
import { SeatBar, StatusPill } from '../components/ui'

const FILTERS = [
  { id: '', label: 'All sections' },
  { id: 'open', label: 'Open now' },
  { id: 'waitlist', label: 'Waitlist open' },
  { id: 'full', label: 'Full' },
] as const

export default function SearchView({
  watched,
  onToggle,
  user,
  onUser,
}: {
  watched: Map<string, Watch>
  onToggle: (sectionId: string) => void
  user: User
  /** The scope lives on the account, so changing it hands back a new user. */
  onUser: (user: User) => void
}) {
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<string>('')
  const [sections, setSections] = useState<Section[]>([])
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

  return (
    <div className="px-9 py-8">
      <header className="mb-5">
        <h1 className="text-2xl font-bold tracking-[-0.02em]">Find classes</h1>
        <p className="mt-1.5 text-sm text-muted">
          Seat counts from your school’s public schedule. Your school login is never involved.
        </p>
      </header>

      <div className="mb-5 flex flex-wrap items-center gap-3">
        <label className="flex min-w-[300px] flex-1 items-center gap-2.5 rounded-xl border border-line bg-white/3 px-3.5 py-2.5 transition-colors focus-within:border-open/40">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="shrink-0 text-muted">
            <circle cx="10.5" cy="10.5" r="6.5" stroke="currentColor" strokeWidth="1.8" />
            <path d="m15.5 15.5 4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Course code, title, CRN, or instructor"
            aria-label="Search the course catalog"
            className="w-full bg-transparent text-sm outline-none placeholder:text-muted/70"
          />
        </label>

        <div className="flex gap-1.5 rounded-xl border border-line bg-white/3 p-1">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              onClick={() => setStatus(f.id)}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                status === f.id ? 'bg-white/10 text-bright' : 'text-muted hover:text-bright'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <LevelFilter user={user} onUser={onUser} />

      <div className="mb-3 flex items-baseline justify-between">
        <span className="num text-xs text-muted">
          {loading ? 'searching…' : `${sections.length} section${sections.length === 1 ? '' : 's'}`}
        </span>
      </div>

      <div className="panel overflow-hidden">
        <div className="grid grid-cols-[1.7fr_0.9fr_1fr_0.85fr_auto] gap-4 border-b border-line px-5 py-3 text-[11px] font-semibold uppercase tracking-wider text-muted">
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
          <div className="px-5 py-14 text-center">
            <p className="text-sm font-medium">
              {query ? `No sections match “${query}”.` : 'No sections indexed yet.'}
            </p>
            <p className="mt-1.5 text-xs text-muted">
              {query
                ? 'Try a course code like MATH 221, or clear the filter.'
                : 'The monitor seeds sections on its first poll. Give it a moment.'}
            </p>
          </div>
        ) : (
          sections.map((s) => {
            const isWatched = watched.has(s.id)
            return (
              <div
                key={s.id}
                className="grid grid-cols-[1.7fr_0.9fr_1fr_0.85fr_auto] items-center gap-4 border-b border-line px-5 py-3.5 transition-colors last:border-0 hover:bg-white/2"
              >
                <div className="min-w-0">
                  <div className="flex items-baseline gap-2">
                    <span className="text-sm font-semibold">
                      {s.code} <span className="text-muted">· {s.section}</span>
                    </span>
                    <span className="num text-[11px] text-muted">{s.crn}</span>
                  </div>
                  <div className="mt-0.5 truncate text-xs text-muted">
                    {s.title}
                    {s.instructor ? ` · ${s.instructor}` : ''}
                    {/* The registrar's own code, never a word we invented for it. */}
                    {s.level ? ` · ${s.level}` : ''}
                  </div>
                </div>

                <div className="num text-xs text-muted">
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

                <div>
                  <StatusPill status={s.status} />
                </div>

                <button
                  onClick={() => void handleToggle(s.id)}
                  disabled={pending === s.id}
                  className={`rounded-full px-3.5 py-1.5 text-xs font-semibold transition disabled:opacity-50 ${
                    isWatched
                      ? 'border border-open/30 bg-open/12 text-open'
                      : 'border border-line text-muted hover:border-white/25 hover:text-bright'
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
      <span className="text-xs text-muted">Levels</span>

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
                : 'border border-line text-muted hover:border-white/25 hover:text-bright'
            }`}
          >
            {/* The registrar's own code, never a word we invented for it. */}
            {l.level}
            <span className="num ml-1.5 text-[10px] opacity-70">{l.sections}</span>
          </button>
        )
      })}

      {user.levels.length === 0 && <span className="text-[11px] text-muted">every level</span>}

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
