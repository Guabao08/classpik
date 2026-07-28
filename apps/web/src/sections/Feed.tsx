import { useMemo, useState } from 'react'
import AnimatedList from '../bits/AnimatedList'
import { SchoolTag, SectionLabel } from '../components/ui'
import { feed } from '../data/mock'

function SearchIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" className="shrink-0">
      <circle cx="10.5" cy="10.5" r="6.5" stroke="currentColor" strokeWidth="2" />
      <path d="m15.5 15.5 4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

export default function Feed() {
  const [query, setQuery] = useState('')

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return feed
    return feed.filter(
      (e) =>
        e.code.toLowerCase().includes(q) ||
        e.code.replace(/\s+/g, '').toLowerCase().includes(q.replace(/\s+/g, '')) ||
        e.school.toLowerCase().includes(q)
    )
  }, [query])

  const items = results.map((e, i) => (
    <div className="flex items-center justify-between gap-4 rounded-xl border border-line bg-white/3 px-4 py-3.5 transition-colors duration-200 hover:bg-white/5">
      <div className="flex min-w-0 items-center gap-3">
        {/* Only the newest event pulses. Seven blinking dots was noise. */}
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${
            i === 0 && !query ? 'bg-open dot-open' : 'bg-white/25'
          }`}
        />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold">
              {e.code} <span className="text-muted">· {e.section}</span>
            </span>
            <SchoolTag school={e.school} />
          </div>
          <div className="num mt-0.5 text-xs text-muted">
            {e.seats} seat{e.seats > 1 ? 's' : ''} opened · {e.ago}
          </div>
        </div>
      </div>
      {e.claimedMs ? (
        <span className="num shrink-0 rounded-full bg-open/12 px-2.5 py-1 text-[11px] font-semibold text-open">
          claimed {e.claimedMs}ms
        </span>
      ) : (
        <span className="shrink-0 rounded-full border border-line px-2.5 py-1 text-[11px] font-medium text-muted">
          notified
        </span>
      )}
    </div>
  ))

  return (
    <div className="panel p-6">
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <SectionLabel>Live</SectionLabel>
          <h3 className="text-lg font-semibold">Seats opening right now</h3>
        </div>
        <span className="num shrink-0 rounded-full border border-line px-2.5 py-1 text-[11px] text-muted">
          last 5 min
        </span>
      </div>

      <label className="mb-4 flex items-center gap-2.5 rounded-xl border border-line bg-white/3 px-3.5 py-2.5 transition-colors focus-within:border-open/40">
        <span className="text-muted">
          <SearchIcon />
        </span>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search a course, e.g. CS 1332"
          aria-label="Search seat activity by course"
          className="w-full bg-transparent text-sm text-bright outline-none placeholder:text-muted/70"
        />
        {query && (
          <button
            onClick={() => setQuery('')}
            aria-label="Clear search"
            className="shrink-0 text-xs text-muted transition-colors hover:text-bright"
          >
            Clear
          </button>
        )}
      </label>

      {results.length > 0 ? (
        <AnimatedList
          key={query}
          items={items}
          maxHeight="300px"
          fadeColor="#0e1013"
          itemClassName="mb-2.5"
          enableArrowNavigation={false}
          displayScrollbar
        />
      ) : (
        <div className="rounded-xl border border-dashed border-line px-5 py-9 text-center">
          <p className="text-sm font-medium">No seats opened for “{query}” in the last 5 minutes.</p>
          <p className="mx-auto mt-2 max-w-xs text-xs leading-relaxed text-muted">
            That is exactly what a watch is for. We will ping you the second one frees up.
          </p>
          <button className="mt-5 rounded-full bg-open px-4 py-2 text-xs font-semibold text-ink transition hover:brightness-110">
            Watch {query.toUpperCase()}
          </button>
        </div>
      )}
    </div>
  )
}
