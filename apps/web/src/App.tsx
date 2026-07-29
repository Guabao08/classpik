import { useCallback, useEffect } from 'react'
import Nav from './sections/Nav'
import Hero from './sections/Hero'
import WatchExample from './sections/WatchExample'
import HowItWorks from './sections/HowItWorks'
import Watchlist from './sections/Watchlist'
import Schools from './sections/Schools'
import Footer from './sections/Footer'
import AppShell from './app/AppShell'
import SignInView from './app/SignInView'
import SignUpView from './app/SignUpView'
import Reveal from './components/Reveal'
import { SectionLabel } from './components/ui'
import { navigate, safePath, usePath } from './lib/router'
import { useSession } from './lib/session'

/**
 * Four screens on real paths: the landing page, the product, and the two ways
 * in. Everything else falls through to the landing page rather than to a blank
 * screen, since an unknown path here is a mistyped link, not a lost visitor.
 */
export default function App() {
  const path = usePath()
  const session = useSession()

  const query = path.indexOf('?')
  const route = normalize(query === -1 ? path : path.slice(0, query))
  const params = new URLSearchParams(query === -1 ? '' : path.slice(query))

  // Where signing in should land. /app is the default because that is what the
  // two ways in are for; ?next= only matters when a deep link was interrupted.
  const next = safePath(params.get('next'), '/app')

  // Destructured so this stays the same function across renders: the app polls
  // on a timer keyed to its props, and a new callback every render would tear
  // that timer down and start it again.
  const { signOut: endSession } = session
  const signOut = useCallback(async () => {
    await endSession()
    navigate('/')
  }, [endSession])

  if (route === '/app') {
    if (!session.checked) return <Loading />
    // The whole path rides along, not just "/app", so a deep link finishes
    // where it was pointed rather than at the app's front door.
    if (session.user === null) return <Redirect to={`/login?next=${encodeURIComponent(path)}`} />
    return <AppShell user={session.user} onUser={session.setUser} onSignOut={signOut} />
  }

  if (route === '/login') {
    if (!session.checked) return <Loading />
    if (session.user !== null) return <Redirect to={next} />
    return (
      <SignInView
        onSignedIn={(user) => {
          session.setUser(user)
          // Replace, so Back from the app goes where they came from rather
          // than to a sign-in form they have already used.
          navigate(next, { replace: true })
        }}
      />
    )
  }

  if (route === '/signup') {
    if (!session.checked) return <Loading />
    return (
      <SignUpView
        user={session.user}
        onUser={session.setUser}
        onDone={() => navigate(next, { replace: true })}
      />
    )
  }

  return <Landing />
}

/** `/app/` and `/app` are the same screen. Only the root keeps its slash. */
function normalize(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname
}

function Loading() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-ink text-sm text-muted">
      Loading…
    </div>
  )
}

/**
 * Navigating is a side effect, so it happens after the render that decided on
 * it. `replace` on purpose: a bounce that pushes history is a Back button that
 * bounces the visitor again, forever.
 */
function Redirect({ to }: { to: string }) {
  useEffect(() => {
    navigate(to, { replace: true })
  }, [to])
  return <Loading />
}

function Landing() {
  return (
    <div className="min-h-screen bg-ink">
      <Nav />
      <Hero />

      <section className="mx-auto max-w-6xl px-6 py-8">
        <div className="grid items-start gap-6 lg:grid-cols-[1.05fr_1fr]">
          <Reveal>
            <WatchExample />
          </Reveal>
          <Reveal delay={0.1} className="lg:pl-6 lg:pt-8">
            <SectionLabel>What a watch looks like</SectionLabel>
            <h2 className="text-[clamp(1.7rem,3.5vw,2.4rem)] font-bold leading-tight tracking-[-0.02em]">
              You ask once. We do the waiting.
            </h2>
            <p className="mt-5 text-[15px] leading-relaxed text-muted">
              Tell ClassPik which section you need. It checks continuously, for as long as it takes.
              Plenty of classes never open at all, and that is the honest answer. But when one does,
              you know within seconds, whether that is an hour later or six weeks later.
            </p>
            <p className="mt-4 text-[15px] leading-relaxed text-muted">
              The value is not speed for its own sake. It is that nobody can refresh a page for
              three weeks straight, and you should not have to.
            </p>
            <dl className="mt-8 grid grid-cols-2 gap-6 border-t border-line pt-7">
              <div>
                <dt className="text-xs text-muted">Checks per day</dt>
                <dd className="num mt-1 text-2xl font-semibold">288</dd>
              </div>
              <div>
                <dt className="text-xs text-muted">You hear back in</dt>
                <dd className="num mt-1 text-2xl font-semibold">&lt;15s</dd>
              </div>
            </dl>
          </Reveal>
        </div>
      </section>

      <HowItWorks />
      <Watchlist />
      <Schools />
      <Footer />
    </div>
  )
}
