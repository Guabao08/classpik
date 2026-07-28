import Aurora from '../bits/Aurora'
import SplitText from '../bits/SplitText'
import ShinyText from '../bits/ShinyText'
import StarBorder from '../bits/StarBorder'
import CountUp from '../bits/CountUp'

function Stat({ value, suffix, label }: { value: number; suffix?: string; label: string }) {
  return (
    <div className="text-center">
      <div className="num text-3xl font-semibold text-bright sm:text-4xl">
        <CountUp to={value} duration={1.6} separator="," />
        {suffix}
      </div>
      <div className="mt-1.5 text-xs text-muted">{label}</div>
    </div>
  )
}

export default function Hero() {
  return (
    <section className="relative overflow-hidden pt-16">
      {/* Aurora is the one WebGL flourish in the whole product. It stays here. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[560px] opacity-55">
        <Aurora colorStops={['#1d4d3a', '#c8ff4d', '#3b2a6b']} amplitude={0.9} blend={0.6} speed={0.4} />
      </div>
      <div className="pointer-events-none absolute inset-x-0 top-[440px] h-40 bg-gradient-to-b from-transparent to-ink" />

      <div className="relative mx-auto max-w-4xl px-6 pb-20 pt-24 text-center">
        <div className="mb-7 inline-flex items-center gap-2 rounded-full border border-line bg-white/4 px-3.5 py-1.5 text-xs">
          <span className="h-1.5 w-1.5 rounded-full bg-open dot-open" />
          <ShinyText text="Watching 12,480 sections across 2 schools" speed={4} className="text-muted" />
        </div>

        <SplitText
          tag="h1"
          text="Get the classes you actually want."
          className="text-[clamp(2.4rem,7vw,4.5rem)] font-extrabold leading-[1.05] tracking-[-0.03em]"
          splitType="words"
          delay={55}
          duration={0.7}
          ease="power3.out"
          from={{ opacity: 0, y: 34 }}
          to={{ opacity: 1, y: 0 }}
          textAlign="center"
        />

        <p className="mx-auto mt-6 max-w-xl text-[17px] leading-relaxed text-muted">
          ClassPik watches your sections around the clock and claims a seat the moment one opens —
          or the instant your registration window does. No 7 AM alarm. No refresh war.
        </p>

        <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <StarBorder as="a" href="#waitlist" color="#c8ff4d" speed="4s" thickness={1.5}>
            <span className="text-sm font-semibold">Watch a class free</span>
          </StarBorder>
          <a
            href="#how"
            className="rounded-full border border-line px-5 py-3 text-sm font-medium text-muted transition hover:border-white/20 hover:text-bright"
          >
            See how it works
          </a>
        </div>

        <div className="mt-16 grid grid-cols-3 gap-4 border-t border-line pt-9">
          <Stat value={12480} label="Sections watched" />
          <Stat value={318} suffix="ms" label="Median claim time" />
          <Stat value={94} suffix="%" label="Seats caught" />
        </div>
      </div>
    </section>
  )
}
