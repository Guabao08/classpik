import { useMemo, useState } from 'react'
import { catalog, statusOf, type CatalogSection } from '../data/catalog'
import { SeatBar, StatusPill } from '../components/ui'
import type { Mode } from './AppShell'

const FILTERS = [
  { id: 'all', label: 'All sections' },
  { id: 'open', label: 'Open now' },
  { id: 'watchable', label: 'Full or waitlisted' },
] as const

export default function SearchView({
  watched,
  onToggle,
}: {
  watched: Record<string, Mode>
  onToggle: (crn: string) => void
}) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<(typeof FILTERS)[number]['id']>('all')

  const results = useMemo(() => {
    const q = query.trim().toLowerCase().replace(/\s+/g, '')
    let out: CatalogSection[] = catalog
    if (q) {
      out = out.filter(
        (s) =>
          s.code.toLowerCase().replace(/\s+/g, '').includes(q) ||
          s.title.toLowerCase().includes(query.trim().toLowerCase()) ||
          s.crn.includes(q) ||
          s.instructor.toLowerCase().includes(query.trim().toLowerCase())
      )
    }
    if (filter === 'open') out = out.filter((s) => s.seats > 0)
    if (filter === 'watchable') out = out.filter((s) => s.seats === 0)
    return out
  }, [query, filter])

  return (
    <div className="px-9 py-8">
      <header className="mb-7">
        <h1 className="text-2xl font-bold tracking-[-0.02em]">Find classes</h1>
        <p className="mt-1.5 text-sm text-muted">
          Live seat counts from the OSCAR schedule of classes. No login needed to watch.
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
              onClick={() => setFilter(f.id)}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                filter === f.id ? 'bg-white/10 text-bright' : 'text-muted hover:text-bright'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div className="mb-3 flex items-baseline justify-between">
        <span className="num text-xs text-muted">
          {results.length} section{results.length === 1 ? '' : 's'}
        </span>
        <span className="num text-xs text-muted">Updated 8s ago</span>
      </div>

      <div className="panel overflow-hidden">
        <div className="grid grid-cols-[1.7fr_0.9fr_1fr_0.85fr_auto] gap-4 border-b border-line px-5 py-3 text-[11px] font-semibold uppercase tracking-wider text-muted">
          <span>Course</span>
          <span>Meets</span>
          <span>Seats</span>
          <span>Status</span>
          <span />
        </div>

        {results.length === 0 ? (
          <div className="px-5 py-14 text-center">
            <p className="text-sm font-medium">No sections match “{query}”.</p>
            <p className="mt-1.5 text-xs text-muted">
              Try a course code like CS 1332, or clear the filter.
            </p>
          </div>
        ) : (
          results.map((s) => {
            const isWatched = Boolean(watched[s.crn])
            return (
              <div
                key={s.crn}
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
                    {s.title} · {s.instructor}
                  </div>
                </div>

                <div className="num text-xs text-muted">
                  {s.days} {s.time}
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
                  <StatusPill status={statusOf(s)} />
                </div>

                <button
                  onClick={() => onToggle(s.crn)}
                  className={`rounded-full px-3.5 py-1.5 text-xs font-semibold transition ${
                    isWatched
                      ? 'border border-open/30 bg-open/12 text-open'
                      : 'border border-line text-muted hover:border-white/25 hover:text-bright'
                  }`}
                >
                  {isWatched ? 'Watching' : 'Watch'}
                </button>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
