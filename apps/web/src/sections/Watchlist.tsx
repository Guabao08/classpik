import Reveal from '../components/Reveal'
import { SeatBar, SectionLabel, StatusPill } from '../components/ui'
import { watches } from '../data/mock'

export default function Watchlist() {
  return (
    <section id="watchlist" className="mx-auto max-w-6xl px-6 pb-24">
      <Reveal className="mb-10 max-w-2xl">
        <SectionLabel>Your watchlist</SectionLabel>
        <h2 className="display text-[clamp(2.1rem,4.5vw,3.2rem)]">
          Every section you need, on one screen.
        </h2>
        <p className="mt-4 text-[15px] leading-relaxed text-ink-soft">
          No animated backgrounds here on purpose. When you’re scanning seat counts under time
          pressure, the interface should get out of the way.
        </p>
        {/* Said plainly, because these rows read exactly like live data and are
            not. The real one is at /app, against the monitor. */}
        <p className="label mt-4 inline-flex items-center gap-2 border border-rule px-3 py-1.5 text-ink-soft">
          <span className="h-1.5 w-1.5 bg-wait" />
          Example rows. Sign in to see your own.
        </p>
      </Reveal>

      <Reveal className="panel overflow-hidden" delay={0.08}>
        <div className="[&>span]:label hidden text-ink-soft grid-cols-[1.6fr_0.7fr_1fr_0.8fr_0.7fr] gap-4 border-b border-ink px-6 py-3 md:grid">
          <span>Course</span>
          <span>CRN</span>
          <span>Enrollment</span>
          <span>Status</span>
          <span className="text-right">Mode</span>
        </div>

        {watches.map((w) => (
          <div
            key={w.crn}
            className="grid grid-cols-2 items-center gap-4 border-b border-rule px-6 py-4 transition last:border-0 hover:bg-ink/2 md:grid-cols-[1.6fr_0.7fr_1fr_0.8fr_0.7fr]"
          >
            <div className="col-span-2 min-w-0 md:col-span-1">
              <div className="flex items-baseline gap-2">
                <span className="text-sm font-semibold">
                  {w.code} <span className="text-ink-soft">· {w.section}</span>
                </span>
                <span className="num text-[11px] text-ink-soft">watching {w.watchingSince}</span>
              </div>
              <div className="mt-0.5 truncate text-xs text-ink-soft">{w.title}</div>
            </div>

            <div className="num text-xs text-ink-soft">{w.crn}</div>

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
              {/* Auto-claim needs the local agent, which is not built. Labelling
                  a row with it here read as a shipped feature. */}
              {w.mode === 'auto' ? (
                <span className="label border border-rule px-2 py-1 text-ink-soft">Auto-claim, later</span>
              ) : (
                <span className="label border border-open px-2 py-1 text-open">Notify</span>
              )}
            </div>
          </div>
        ))}
      </Reveal>
    </section>
  )
}
