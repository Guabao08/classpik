import { useEffect, useState } from 'react'
import Nav from './sections/Nav'
import Hero from './sections/Hero'
import WatchExample from './sections/WatchExample'
import HowItWorks from './sections/HowItWorks'
import Watchlist from './sections/Watchlist'
import Schools from './sections/Schools'
import Footer from './sections/Footer'
import LogoLab from './sections/LogoLab'
import AppShell from './app/AppShell'
import Reveal from './components/Reveal'
import { SectionLabel } from './components/ui'

export default function App() {
  const [hash, setHash] = useState(() => window.location.hash)

  useEffect(() => {
    const onHash = () => setHash(window.location.hash)
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  if (hash === '#logos') return <LogoLab />
  if (hash === '#app') return <AppShell />

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
