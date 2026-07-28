import SpotlightCard from '../bits/SpotlightCard'
import Reveal from '../components/Reveal'
import { SectionLabel } from '../components/ui'

const steps = [
  {
    n: '01',
    title: 'Add the sections you want',
    body: 'Search your school’s course catalog and star the sections you need. No login required, because seat counts come from the public schedule.',
  },
  {
    n: '02',
    title: 'We watch them around the clock',
    body: 'Our monitor polls every section continuously and detects the moment a seat frees up. You get a push notification within seconds.',
  },
  {
    n: '03',
    title: 'Or let it claim the seat for you',
    body: 'Turn on auto-claim and the ClassPik agent registers you the instant a seat opens, or the second your registration window does.',
  },
]

export default function HowItWorks() {
  return (
    <section id="how" className="mx-auto max-w-6xl px-6 py-24">
      <Reveal className="mb-12 max-w-2xl">
        <SectionLabel>How it works</SectionLabel>
        <h2 className="text-[clamp(1.9rem,4vw,2.75rem)] font-bold leading-tight tracking-[-0.02em]">
          Two jobs. One of them runs while you sleep.
        </h2>
      </Reveal>

      <div className="grid gap-5 md:grid-cols-3">
        {steps.map((s, i) => (
          <Reveal key={s.n} delay={i * 0.09}>
            <SpotlightCard
              className="!border-line !bg-white/3 !rounded-2xl h-full p-7"
              spotlightColor="rgba(200, 255, 77, 0.12)"
            >
              <div className="num mb-5 text-xs font-semibold text-open">{s.n}</div>
              <h3 className="mb-2.5 text-lg font-semibold leading-snug">{s.title}</h3>
              <p className="text-sm leading-relaxed text-muted">{s.body}</p>
            </SpotlightCard>
          </Reveal>
        ))}
      </div>
    </section>
  )
}
