import Reveal from '../components/Reveal'
import { SeatBar, SectionLabel, StatusPill } from '../components/ui'
import { watches } from '../data/mock'

export default function Watchlist() {
  return (
    <section id="watchlist" className="mx-auto max-w-6xl px-6 pb-24">
      <Reveal className="mb-10 max-w-2xl">
        <SectionLabel>Your watchlist</SectionLabel>
        <h2 className="text-[clamp(1.9rem,4vw,2.75rem)] font-bold leading-tight tracking-[-0.02em]">
          Every section you need, on one screen.
        </h2>
        <p className="mt-4 text-[15px] leading-relaxed text-muted">
          No animated backgrounds here on purpose. When you’re scanning seat counts under time
          pressure, the interface should get out of the way.
        </p>
      </Reveal>

      <Reveal className="panel overflow-hidden" delay={0.08}>
        <div className="hidden grid-cols-[1.6fr_0.7fr_1fr_0.8fr_0.7fr] gap-4 border-b border-line px-6 py-3.5 text-[11px] font-semibold uppercase tracking-wider text-muted md:grid">
          <span>Course</span>
          <span>CRN</span>
          <span>Enrollment</span>
          <span>Status</span>
          <span className="text-right">Mode</span>
        </div>

        {watches.map((w) => (
          <div
            key={w.crn}
            className="grid grid-cols-2 items-center gap-4 border-b border-line px-6 py-4 transition last:border-0 hover:bg-white/2 md:grid-cols-[1.6fr_0.7fr_1fr_0.8fr_0.7fr]"
          >
            <div className="col-span-2 min-w-0 md:col-span-1">
              <div className="flex items-baseline gap-2">
                <span className="text-sm font-semibold">
                  {w.code} <span className="text-muted">· {w.section}</span>
                </span>
                <span className="num text-[11px] text-muted">watching {w.watchingSince}</span>
              </div>
              <div className="mt-0.5 truncate text-xs text-muted">{w.title}</div>
            </div>

            <div className="num text-xs text-muted">{w.crn}</div>

            <div>
              <SeatBar seats={w.seats} capacity={w.capacity} />
              {w.waitlist > 0 && (
                <div className="num mt-1 text-[11px] text-wait">{w.waitlist} on waitlist</div>
              )}
            </div>

            <div>
              <StatusPill status={w.status} />
            </div>

            <div className="text-right">
              {w.mode === 'auto' ? (
                <span className="rounded-full bg-open/12 px-2.5 py-1 text-[11px] font-semibold text-open">
                  Auto-claim
                </span>
              ) : (
                <span className="rounded-full border border-line px-2.5 py-1 text-[11px] font-medium text-muted">
                  Notify
                </span>
              )}
            </div>
          </div>
        ))}
      </Reveal>
    </section>
  )
}
