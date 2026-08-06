import Reveal from '../components/Reveal'
import { SectionLabel } from '../components/ui'

/**
 * Kept honest against apps/monitor/README.md's adapter table. Both adapters are
 * built and tested against recorded response shapes, and neither has been run
 * against a live install, so neither says "Live".
 */
const schools = [
  { name: 'Banner', sis: 'Ellucian · most large publics', state: 'built' },
  { name: 'PeopleSoft', sis: 'Oracle Campus Solutions, HighPoint CX only', state: 'built' },
  { name: 'Workday Student', sis: 'Newer adoptions', state: 'soon' },
]

export default function Schools() {
  return (
    <section id="schools" className="mx-auto max-w-6xl px-6 pb-24">
      <Reveal className="panel p-8 sm:p-12">
        <div className="grid gap-10 lg:grid-cols-[1fr_1.1fr] lg:gap-16">
          <div>
            <SectionLabel>Schools</SectionLabel>
            <h2 className="display text-[clamp(2rem,4vw,2.9rem)]">
              Three integrations cover most of US higher ed.
            </h2>
            <p className="mt-4 text-[15px] leading-relaxed text-ink-soft">
              Nearly every university runs one of three student systems. We build the adapter once,
              then each new campus is a config file, not a rewrite. Tell us where you go and we
              will add it.
            </p>
            <a
              href="/signup"
              className="mt-8 inline-block border-b border-ink pb-0.5 text-sm transition-opacity hover:opacity-60"
            >
              Request your school
            </a>
          </div>

          <div className="border-t border-ink">
            {schools.map((s) => (
              <div
                key={s.name}
                className="flex items-center justify-between gap-4 border-b border-rule py-4"
              >
                <div>
                  <div className="text-sm font-medium">{s.name}</div>
                  <div className="mt-1 text-xs text-ink-soft">{s.sis}</div>
                </div>
                {s.state === 'built' ? (
                  <span
                    className="label shrink-0 text-wait"
                    title="Built and tested against recorded responses, not yet run against a live install"
                  >
                    Adapter built
                  </span>
                ) : (
                  <span className="label shrink-0 text-ink-soft">Request it</span>
                )}
              </div>
            ))}
          </div>
        </div>
      </Reveal>
    </section>
  )
}
