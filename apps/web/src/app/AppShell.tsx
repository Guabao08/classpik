import { useCallback, useEffect, useState } from 'react'
import { Logo } from '../components/ui'
import SearchView from './SearchView'
import WatchlistView from './WatchlistView'
import AlertsView from './AlertsView'
import { api, ApiError, API_BASE, type EventItem, type Stats, type Watch } from '../lib/api'

export type View = 'search' | 'watchlist' | 'alerts'
export type Mode = 'notify' | 'claim'

/** No auth yet, so the monitor takes this at face value. See the README. */
const USER_ID = 'roshan'

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
    icon: <path d="M4 6h16M4 12h16M4 18h10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />,
  },
  {
    id: 'alerts',
    label: 'Alerts',
    icon: (
      <>
        <path
          d="M12 3a6 6 0 0 0-6 6v4l-1.5 3h15L18 13V9a6 6 0 0 0-6-6Z"
          stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"
        />
        <path d="M10 19a2 2 0 0 0 4 0" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      </>
    ),
  },
]

export default function AppShell() {
  const [view, setView] = useState<View>('search')
  const [watches, setWatches] = useState<Watch[]>([])
  const [events, setEvents] = useState<EventItem[]>([])
  const [stats, setStats] = useState<Stats | null>(null)
  const [offline, setOffline] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      const [w, e, s] = await Promise.all([
        api.watches(USER_ID),
        api.events(USER_ID),
        api.stats(),
      ])
      setWatches(w.watches)
      setEvents(e.events)
      setStats(s)
      setOffline(null)
    } catch (err) {
      setOffline(err instanceof ApiError ? err.message : 'Something went wrong')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
    // The monitor polls on its own schedule, so the UI just re-reads
    // periodically rather than trying to hold a socket open.
    const timer = setInterval(() => void refresh(), 15_000)
    return () => clearInterval(timer)
  }, [refresh])

  const watchedIds = new Map(watches.map((w) => [w.section.id, w]))

  const toggleWatch = useCallback(
    async (sectionId: string) => {
      const existing = watches.find((w) => w.section.id === sectionId)
      try {
        if (existing) await api.deleteWatch(existing.id)
        else await api.createWatch({ userId: USER_ID, sectionId })
        await refresh()
      } catch (err) {
        setOffline(err instanceof ApiError ? err.message : 'Could not update the watch')
      }
    },
    [watches, refresh]
  )

  const setMode = useCallback(
    async (sectionId: string, mode: Mode) => {
      try {
        await api.createWatch({ userId: USER_ID, sectionId, mode })
        await refresh()
      } catch (err) {
        setOffline(err instanceof ApiError ? err.message : 'Could not change the mode')
      }
    },
    [refresh]
  )

  return (
    <div className="flex min-h-screen bg-ink">
      <aside className="fixed inset-y-0 left-0 flex w-[236px] flex-col border-r border-line bg-ink-2/50 px-4 py-5">
        <div className="px-2 pb-6">
          <Logo />
        </div>

        <nav className="flex flex-col gap-1">
          {nav.map((n) => {
            const active = view === n.id
            const badge =
              n.id === 'watchlist' ? watches.length : n.id === 'alerts' ? events.length : 0
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
                {badge > 0 && (
                  <span className="num ml-auto rounded-full bg-white/8 px-1.5 py-0.5 text-[10px] text-muted">
                    {badge}
                  </span>
                )}
              </button>
            )
          })}
        </nav>

        <div className="mt-auto space-y-3">
          <div className="rounded-xl border border-line bg-white/3 p-3.5">
            <div className="flex items-center gap-2">
              <span
                className={`h-1.5 w-1.5 rounded-full ${offline ? 'bg-full' : 'bg-open dot-open'}`}
              />
              <span className="text-xs font-semibold">
                {offline ? 'Monitor offline' : 'Monitor online'}
              </span>
            </div>
            <p className="num mt-1.5 text-[11px] leading-relaxed text-muted">
              {offline
                ? API_BASE.replace(/^https?:\/\//, '')
                : stats
                  ? `${stats.sections} sections · ${stats.pollCount} checks`
                  : 'connecting'}
            </p>
          </div>
        </div>
      </aside>

      <main className="ml-[236px] flex-1">
        {offline && (
          <div className="border-b border-full/25 bg-full/8 px-9 py-3.5">
            <p className="text-sm font-semibold">{offline}</p>
            <p className="mt-1 text-xs leading-relaxed text-muted">
              Start it with{' '}
              <code className="num rounded bg-white/8 px-1.5 py-0.5">
                npm run serve -- --demo
              </code>{' '}
              in apps/monitor.
            </p>
          </div>
        )}

        {loading ? (
          <div className="px-9 py-16 text-sm text-muted">Loading…</div>
        ) : (
          <>
            {view === 'search' && <SearchView watched={watchedIds} onToggle={toggleWatch} />}
            {view === 'watchlist' && (
              <WatchlistView watches={watches} onToggle={toggleWatch} onSetMode={setMode} />
            )}
            {view === 'alerts' && <AlertsView events={events} />}
          </>
        )}
      </main>
    </div>
  )
}
