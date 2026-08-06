import { useCallback, useEffect, useState } from 'react'
import { Logo } from '../components/ui'
import SearchView from './SearchView'
import WatchlistView from './WatchlistView'
import AlertsView from './AlertsView'
import AccountView from './AccountView'
import ScopeSwitcher from './ScopeSwitcher'
import VerifyBanner from './VerifyBanner'
import { useSchools } from '../lib/catalog'
import {
  api,
  ApiError,
  API_BASE,
  type Channel,
  type EventItem,
  type Stats,
  type User,
  type Watch,
} from '../lib/api'

// Account is not in `nav` below on purpose: it is reached from the card with the
// address on it, because that card is the question it answers.
export type View = 'search' | 'watchlist' | 'alerts' | 'account'
export type Mode = 'notify' | 'claim'

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

/**
 * The product, for a student we already know. Whether anyone is signed in is
 * decided one level up, by the router, since /login has to answer the same
 * question and two copies of it would disagree exactly on the redirect.
 */
export default function AppShell({
  user,
  onUser,
  onSignOut,
}: {
  user: User
  /** The search scope lives on the account, so changing it hands back a new user. */
  onUser: (user: User) => void
  onSignOut: () => void
}) {
  const [view, setView] = useState<View>('search')
  // Below the breakpoint the sidebar is a drawer rather than a fixed column.
  // 236px of a 390px phone left the section table 154px to render five columns
  // in, on the one screen a seat alert actually leads to.
  const [menuOpen, setMenuOpen] = useState(false)
  const [watches, setWatches] = useState<Watch[]>([])
  const [events, setEvents] = useState<EventItem[]>([])
  const [stats, setStats] = useState<Stats | null>(null)
  const [offline, setOffline] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  // Only so the watchlist can name a school rather than print its id at a
  // student who has never seen one.
  const schools = useSchools()

  const refresh = useCallback(async () => {
    try {
      const [w, e, s] = await Promise.all([api.watches(), api.events(), api.stats()])
      setWatches(w.watches)
      setEvents(e.events)
      setStats(s)
      setOffline(null)
    } catch (err) {
      // A session that died while the tab was open drops back to the router,
      // which is the only thing that can send this student to /login.
      if (err instanceof ApiError && err.status === 401) {
        onSignOut()
        return
      }
      setOffline(err instanceof ApiError ? err.message : 'Something went wrong')
    } finally {
      setLoading(false)
    }
  }, [onSignOut])

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
        else await api.createWatch({ sectionId })
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
        await api.createWatch({ sectionId, mode })
        await refresh()
      } catch (err) {
        setOffline(err instanceof ApiError ? err.message : 'Could not change the mode')
      }
    },
    [refresh]
  )

  /**
   * Posting a watch that already exists updates it, so this is how a student
   * moves one between the in-app record and email. Email was reachable only by
   * curl before this: nothing here ever passed a channel, so every watch the
   * app created was a console watch whatever the server was configured to send.
   */
  const setChannel = useCallback(
    async (sectionId: string, channel: Channel) => {
      try {
        await api.createWatch({ sectionId, channel })
        await refresh()
      } catch (err) {
        setOffline(err instanceof ApiError ? err.message : 'Could not change how alerts arrive')
      }
    },
    [refresh]
  )

  // The server says what it can deliver. Offering email where no provider is
  // configured would be a button that fails at the one moment it matters.
  //
  // The second half is the account's own address. The monitor refuses an email
  // watch until somebody has opened a link sent to it, because signup takes an
  // address on trust and otherwise anyone could sign up as a stranger's address
  // and have us mail them. Both conditions have to hold, and they fail
  // differently: no provider is the operator's problem, unverified is one this
  // student can fix from the banner below.
  const emailConfigured = (stats?.channels ?? []).includes('email')
  const emailReady = emailConfigured && user.emailVerified
  const needsVerifying = emailConfigured && !user.emailVerified
  // Whether the confirmation link the button below asks for reaches a mailbox
  // at all, rather than the operator's log. Separate from `channels`, which is
  // about seat alerts, and the reason the resend button can stop claiming a
  // send that did not happen.
  const mailEnabled = stats?.accountMail ?? false

  return (
    <div className="flex min-h-screen bg-paper">
      {/* Only on narrow screens, where the sidebar is closed by default and
          there would otherwise be no way to reach the other two views. */}
      <header className="fixed inset-x-0 top-0 z-30 flex h-14 items-center justify-between border-b border-rule bg-paper/90 px-4 backdrop-blur-xl md:hidden">
        <a href="/app" aria-label="ClassPik home">
          <Logo />
        </a>
        <button
          onClick={() => setMenuOpen(true)}
          aria-label="Open the menu"
          aria-expanded={menuOpen}
          className=" border border-rule px-3 py-1.5 text-xs font-semibold text-ink-soft transition hover:text-ink"
        >
          Menu
        </button>
      </header>

      {menuOpen && (
        <button
          aria-label="Close the menu"
          onClick={() => setMenuOpen(false)}
          className="fixed inset-0 z-40 bg-paper/70 backdrop-blur-sm md:hidden"
        />
      )}

      {/* Shown or not, rather than slid in and out. A translate drawer animates
          between -100% and 0px, and interpolating a percentage against a length
          on the `translate` property leaves it stuck at the start value in at
          least one engine, which is a sidebar that never appears. */}
      <aside
        className={`fixed inset-y-0 left-0 z-50 w-[236px] flex-col overflow-y-auto border-r border-rule bg-paper-2 px-4 py-5 md:z-auto md:flex md:bg-paper-2/50 ${
          menuOpen ? 'flex' : 'hidden'
        }`}
      >
        <div className="flex items-center justify-between px-2 pb-6">
          {/* Inside the product the logo goes to the product. It used to point
              at "/", so the most obvious click on the screen ejected a signed-in
              student into a marketing funnel aimed at people without accounts. */}
          <a href="/app" aria-label="ClassPik home">
            <Logo />
          </a>
          <button
            onClick={() => setMenuOpen(false)}
            aria-label="Close the menu"
            className="text-xs text-ink-soft transition hover:text-ink md:hidden"
          >
            Close
          </button>
        </div>

        <nav className="flex flex-col gap-1">
          {nav.map((n) => {
            const active = view === n.id
            const badge =
              n.id === 'watchlist' ? watches.length : n.id === 'alerts' ? events.length : 0
            return (
              <button
                key={n.id}
                onClick={() => {
                  setView(n.id)
                  setMenuOpen(false)
                }}
                className={`flex items-center gap-3  px-3 py-2.5 text-sm transition-colors ${
                  active
                    ? 'bg-open/10 font-semibold text-open'
                    : 'text-ink-soft hover:bg-ink/4 hover:text-ink'
                }`}
              >
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" className="shrink-0">
                  {n.icon}
                </svg>
                {n.label}
                {badge > 0 && (
                  <span className="num ml-auto rounded-full bg-ink/8 px-1.5 py-0.5 text-[10px] text-ink-soft">
                    {badge}
                  </span>
                )}
              </button>
            )
          })}
        </nav>

        <ScopeSwitcher user={user} onUser={onUser} />

        <div className="mt-auto space-y-3 pt-6">
          <div
            className={` border p-3.5 transition-colors ${
              view === 'account' ? 'border-open/30 bg-open/8' : 'border-rule bg-ink/3'
            }`}
          >
            <p className="truncate text-xs font-semibold" title={user.email}>
              {user.email}
            </p>
            {/* Unconfirmed is worth saying here too. The banner is dismissed by
                scrolling, and this card is the one place the address is always
                visible. */}
            {needsVerifying && <p className="mt-1 text-[11px] text-wait">Not confirmed</p>}
            <div className="mt-1.5 flex items-center gap-3">
              <button
                onClick={() => {
                  setView('account')
                  setMenuOpen(false)
                }}
                className={`text-[11px] transition-colors hover:text-ink ${
                  view === 'account' ? 'font-semibold text-open' : 'text-ink-soft'
                }`}
              >
                Account
              </button>
              <button
                onClick={onSignOut}
                className="text-[11px] text-ink-soft transition-colors hover:text-ink"
              >
                Sign out
              </button>
            </div>
          </div>

          <div className=" border border-rule bg-ink/3 p-3.5">
            <div className="flex items-center gap-2">
              <span
                className={`h-1.5 w-1.5 rounded-full ${offline ? 'bg-full' : 'bg-open'}`}
              />
              <span className="text-xs font-semibold">
                {offline ? 'Monitor offline' : 'Monitor online'}
              </span>
            </div>
            <p className="num mt-1.5 text-[11px] leading-relaxed text-ink-soft">
              {offline
                ? API_BASE.replace(/^https?:\/\//, '')
                : stats
                  ? `${stats.sections} sections · ${stats.pollCount} checks`
                  : 'connecting'}
            </p>
          </div>
        </div>
      </aside>

      <main className="min-w-0 flex-1 pt-14 md:ml-[236px] md:pt-0">
        {offline && (
          <div className="border-b border-full/25 bg-full/8 px-5 py-3.5 md:px-9">
            <p className="text-sm font-semibold">{offline}</p>
            <p className="mt-1 text-xs leading-relaxed text-ink-soft">
              Start it with{' '}
              <code className="num  bg-ink/8 px-1.5 py-0.5">
                npm run serve -- --demo
              </code>{' '}
              in apps/monitor.
            </p>
          </div>
        )}

        {/* Not on the account screen, which says the same thing in more detail
            and owns its own copy of the resend. Two buttons for one errand, each
            with its own idea of whether it has been pressed, is a screen that
            can contradict itself. */}
        {needsVerifying && view !== 'account' && (
          <VerifyBanner email={user.email} mailEnabled={mailEnabled} />
        )}

        {loading ? (
          <div className="px-5 py-16 text-sm text-ink-soft md:px-9">Loading…</div>
        ) : (
          <>
            {view === 'search' && (
              <SearchView
                watched={watchedIds}
                onToggle={toggleWatch}
                user={user}
                onUser={onUser}
                schools={schools}
              />
            )}
            {view === 'watchlist' && (
              <WatchlistView
                watches={watches}
                onToggle={toggleWatch}
                onSetMode={setMode}
                onSetChannel={setChannel}
                emailReady={emailReady}
                email={user.email}
                currentSchool={user.school}
                schools={schools}
              />
            )}
            {view === 'alerts' && <AlertsView events={events} />}
            {view === 'account' && (
              <AccountView
                user={user}
                emailConfigured={emailConfigured}
                mailEnabled={mailEnabled}
              />
            )}
          </>
        )}
      </main>
    </div>
  )
}

