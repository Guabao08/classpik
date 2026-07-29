import { SeatBar, StatusPill } from '../components/ui'
import type { Watch } from '../lib/api'
import type { Mode } from './AppShell'

export default function WatchlistView({
  watches,
  onToggle,
  onSetMode,
}: {
  watches: Watch[]
  onToggle: (sectionId: string) => void
  onSetMode: (sectionId: string, mode: Mode) => void
}) {
  const autoCount = watches.filter((w) => w.mode === 'claim').length

  return (
    <div className="px-9 py-8">
      <header className="mb-7 flex items-start justify-between gap-6">
        <div>
          <h1 className="text-2xl font-bold tracking-[-0.02em]">Watchlist</h1>
          <p className="mt-1.5 text-sm text-muted">
            {watches.length} section{watches.length === 1 ? '' : 's'} watched, {autoCount} set to
            auto-claim.
          </p>
        </div>
        {autoCount > 0 && (
          <div className="rounded-xl border border-open/25 bg-open/8 px-4 py-3">
            <div className="text-xs font-semibold text-open">Auto-claim requested</div>
            <p className="mt-1 text-[11px] leading-relaxed text-muted">
              Needs the local agent, which is not built yet.
            </p>
          </div>
        )}
      </header>

      {watches.length === 0 ? (
        <div className="panel px-6 py-20 text-center">
          <p className="text-sm font-medium">Nothing watched yet.</p>
          <p className="mx-auto mt-2 max-w-sm text-xs leading-relaxed text-muted">
            Head to Find classes and hit Watch on any section. The monitor starts checking it on its
            next cycle.
          </p>
        </div>
      ) : (
        <div className="panel overflow-hidden">
          <div className="grid grid-cols-[1.7fr_1fr_0.85fr_1.2fr_auto] gap-4 border-b border-line px-5 py-3 text-[11px] font-semibold uppercase tracking-wider text-muted">
            <span>Course</span>
            <span>Seats</span>
            <span>Status</span>
            <span>When a seat opens</span>
            <span />
          </div>

          {watches.map((w) => {
            const s = w.section
            return (
              <div
                key={w.id}
                className="grid grid-cols-[1.7fr_1fr_0.85fr_1.2fr_auto] items-center gap-4 border-b border-line px-5 py-3.5 transition-colors last:border-0 hover:bg-white/2"
              >
                <div className="min-w-0">
                  <div className="flex items-baseline gap-2">
                    <span className="text-sm font-semibold">
                      {s.code} <span className="text-muted">· {s.section}</span>
                    </span>
                    <span className="num text-[11px] text-muted">{s.crn}</span>
                  </div>
                  <div className="mt-0.5 truncate text-xs text-muted">
                    {s.title}
                    {s.meetingDays ? ` · ${s.meetingDays} ${s.meetingTime ?? ''}` : ''}
                  </div>
                </div>

                <div>
                  <SeatBar seats={s.seats} capacity={s.capacity} />
                  {s.waitlist > 0 && (
                    <div className="num mt-1 text-[11px] text-wait">{s.waitlist} waitlisted</div>
                  )}
                </div>

                <div>
                  <StatusPill status={s.status} />
                </div>

                <div className="flex gap-1 rounded-lg border border-line bg-white/3 p-1">
                  {(['notify', 'claim'] as const).map((m) => (
                    <button
                      key={m}
                      onClick={() => onSetMode(s.id, m)}
                      className={`flex-1 rounded-md px-2.5 py-1.5 text-[11px] font-semibold transition-colors ${
                        w.mode === m
                          ? m === 'claim'
                            ? 'bg-open/15 text-open'
                            : 'bg-white/10 text-bright'
                          : 'text-muted hover:text-bright'
                      }`}
                    >
                      {m === 'notify' ? 'Notify me' : 'Claim it'}
                    </button>
                  ))}
                </div>

                <button
                  onClick={() => onToggle(s.id)}
                  aria-label={`Stop watching ${s.code}`}
                  className="rounded-lg px-2 py-1.5 text-xs text-muted transition-colors hover:text-full"
                >
                  Remove
                </button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
