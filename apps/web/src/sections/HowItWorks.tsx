import Reveal from '../components/Reveal'
import { SectionLabel } from '../components/ui'

/**
 * Three steps, set as numbered columns divided by rules.
 *
 * These were spotlight cards that lit up under the cursor. The effect drew the
 * eye to whichever step the mouse happened to be near, which is not the order
 * they should be read in, and it made three sequential steps look like three
 * interchangeable features.
 */
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
      <Reveal className="mb-14 max-w-2xl">
        <SectionLabel>How it works</SectionLabel>
        <h2 className="display text-[clamp(2.1rem,4.5vw,3.2rem)]">
          Two jobs. One of them runs while you sleep.
        </h2>
      </Reveal>

      <div className="grid border-t border-ink md:grid-cols-3">
        {steps.map((s, i) => (
          <Reveal
            key={s.n}
            delay={i * 0.09}
            className="border-b border-rule px-0 py-8 md:border-b-0 md:border-l md:px-7 md:first:border-l-0 md:first:pl-0"
          >
            <div className="num mb-6 text-xs font-medium text-open">{s.n}</div>
            <h3 className="mb-3 text-[17px] font-medium leading-snug">{s.title}</h3>
            <p className="text-[14px] leading-[1.65] text-ink-soft">{s.body}</p>
          </Reveal>
        ))}
      </div>
    </section>
  )
}
