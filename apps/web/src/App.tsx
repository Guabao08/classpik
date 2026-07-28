import Nav from './sections/Nav'
import Hero from './sections/Hero'
import Feed from './sections/Feed'
import HowItWorks from './sections/HowItWorks'
import Watchlist from './sections/Watchlist'
import Schools from './sections/Schools'
import Footer from './sections/Footer'
import { SectionLabel } from './components/ui'

export default function App() {
  return (
    <div className="min-h-screen bg-ink">
      <Nav />
      <Hero />

      <section className="mx-auto max-w-6xl px-6 py-8">
        <div className="grid items-start gap-6 lg:grid-cols-[1.05fr_1fr]">
          <Feed />
          <div className="lg:pl-6 lg:pt-8">
            <SectionLabel>The core loop</SectionLabel>
            <h2 className="text-[clamp(1.7rem,3.5vw,2.4rem)] font-bold leading-tight tracking-[-0.02em]">
              A seat opens. You’re in it before anyone refreshes.
            </h2>
            <p className="mt-5 text-[15px] leading-relaxed text-muted">
              Most students find out a seat opened by checking. By then it’s gone. ClassPik detects
              the drop within seconds of it happening and either pings your phone or claims the seat
              outright — the whole round trip usually lands in under half a second.
            </p>
            <dl className="mt-8 grid grid-cols-2 gap-6 border-t border-line pt-7">
              <div>
                <dt className="text-xs text-muted">Detection</dt>
                <dd className="num mt-1 text-2xl font-semibold">&lt;15s</dd>
              </div>
              <div>
                <dt className="text-xs text-muted">Claim</dt>
                <dd className="num mt-1 text-2xl font-semibold">~318ms</dd>
              </div>
            </dl>
          </div>
        </div>
      </section>

      <HowItWorks />
      <Watchlist />
      <Schools />
      <Footer />
    </div>
  )
}
