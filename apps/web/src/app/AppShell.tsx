import { useState } from 'react'
import { Logo } from '../components/ui'
import SearchView from './SearchView'
import WatchlistView from './WatchlistView'
import AlertsView from './AlertsView'
import { alerts } from '../data/catalog'

export type View = 'search' | 'watchlist' | 'alerts'
export type Mode = 'notify' | 'auto'

const nav: { id: View; label: string; icon: React.ReactNode }[] = [
  {
    id: 'search',
    label: 'Find classes',
    icon: (
      <>
        <circle cx="10.5" cy="10.5" r="6.5" stroke="currentColor" strokeWidth="1.8" />
        <path d="m15.5 15.5 4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </>
    ),
  },
  {
    id: 'watchlist',
    label: 'Watchlist',
    icon: (
      <>
        <path
          d="M4 6h16M4 12h16M4 18h10"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      </>
    ),
  },
  {
    id: 'alerts',
    label: 'Alerts',
    icon: (
      <>
        <path
          d="M12 3a6 6 0 0 0-6 6v4l-1.5 3h15L18 13V9a6 6 0 0 0-6-6Z"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinejoin="round"
        />
        <path d="M10 19a2 2 0 0 0 4 0" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      </>
    ),
  },
]

export default function AppShell() {
  const [view, setView] = useState<View>('search')
  // CRN -> mode. This is the whole app state for now.
  const [watched, setWatched] = useState<Record<string, Mode>>({
    '30412': 'auto',
    '91744': 'auto',
    '86022': 'notify',
    '30655': 'auto',
  })

  const toggleWatch = (crn: string) =>
    setWatched((w) => {
      if (w[crn]) {
        const next = { ...w }
        delete next[crn]
        return next
      }
      return { ...w, [crn]: 'notify' }
    })

  const setMode = (crn: string, mode: Mode) => setWatched((w) => ({ ...w, [crn]: mode }))

  const watchCount = Object.keys(watched).length

  return (
    <div className="flex min-h-screen bg-ink">
      <aside className="fixed inset-y-0 left-0 flex w-[236px] flex-col border-r border-line bg-ink-2/50 px-4 py-5">
        <div className="px-2 pb-6">
          <Logo />
        </div>

        <nav className="flex flex-col gap-1">
          {nav.map((n) => {
            const active = view === n.id
            return (
              <button
                key={n.id}
                onClick={() => setView(n.id)}
                className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors ${
                  active
                    ? 'bg-open/10 font-semibold text-open'
                    : 'text-muted hover:bg-white/4 hover:text-bright'
                }`}
              >
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" className="shrink-0">
                  {n.icon}
                </svg>
                {n.label}
                {n.id === 'watchlist' && watchCount > 0 && (
                  <span className="num ml-auto rounded-full bg-white/8 px-1.5 py-0.5 text-[10px] text-muted">
                    {watchCount}
                  </span>
                )}
                {n.id === 'alerts' && (
                  <span className="num ml-auto rounded-full bg-white/8 px-1.5 py-0.5 text-[10px] text-muted">
                    {alerts.length}
                  </span>
                )}
              </button>
            )
          })}
        </nav>

        <div className="mt-auto space-y-3">
          <div className="rounded-xl border border-line bg-white/3 p-3.5">
            <div className="flex items-center gap-2">
              <span className="h-1.5 w-1.5 rounded-full bg-open dot-open" />
              <span className="text-xs font-semibold">Agent online</span>
            </div>
            <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
              Session valid for 26 days. Next wake 7:55 AM.
            </p>
          </div>

          <button className="w-full rounded-xl border border-line px-3.5 py-3 text-left transition-colors hover:border-white/20">
            <div className="text-xs font-semibold">Georgia Tech</div>
            <div className="mt-0.5 text-[11px] text-muted">Fall 2026 · OSCAR</div>
          </button>
        </div>
      </aside>

      <main className="ml-[236px] flex-1">
        {view === 'search' && (
          <SearchView watched={watched} onToggle={toggleWatch} />
        )}
        {view === 'watchlist' && (
          <WatchlistView watched={watched} onToggle={toggleWatch} onSetMode={setMode} />
        )}
        {view === 'alerts' && <AlertsView />}
      </main>
    </div>
  )
}
