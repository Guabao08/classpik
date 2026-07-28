import { SectionLabel } from '../components/ui'

const schools = [
  { name: 'Georgia Tech', sis: 'Banner 9 · OSCAR', state: 'live' },
  { name: 'Duke', sis: 'PeopleSoft · DukeHub', state: 'live' },
  { name: 'Your school', sis: 'Banner · PeopleSoft · Workday', state: 'soon' },
]

export default function Schools() {
  return (
    <section id="schools" className="mx-auto max-w-6xl px-6 pb-24">
      <div className="panel p-8 sm:p-12">
        <div className="grid gap-10 lg:grid-cols-[1fr_1.1fr] lg:gap-16">
          <div>
            <SectionLabel>Schools</SectionLabel>
            <h2 className="text-[clamp(1.7rem,3.5vw,2.4rem)] font-bold leading-tight tracking-[-0.02em]">
              Three integrations cover most of US higher ed.
            </h2>
            <p className="mt-4 text-[15px] leading-relaxed text-muted">
              Nearly every university runs one of three student systems. We build the adapter once,
              then each new campus is a config file — not a rewrite. Adding your school takes days,
              not months.
            </p>
            <a
              href="#waitlist"
              className="mt-7 inline-flex rounded-full border border-line px-5 py-2.5 text-sm font-medium transition hover:border-open/40 hover:text-open"
            >
              Request your school →
            </a>
          </div>

          <div className="space-y-3">
            {schools.map((s) => (
              <div
                key={s.name}
                className="flex items-center justify-between rounded-xl border border-line bg-white/3 px-5 py-4"
              >
                <div>
                  <div className="text-sm font-semibold">{s.name}</div>
                  <div className="mt-0.5 text-xs text-muted">{s.sis}</div>
                </div>
                {s.state === 'live' ? (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-open/12 px-2.5 py-1 text-[11px] font-semibold text-open">
                    <span className="h-1.5 w-1.5 rounded-full bg-open dot-open" />
                    Live
                  </span>
                ) : (
                  <span className="rounded-full border border-line px-2.5 py-1 text-[11px] font-medium text-muted">
                    Request it
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}
