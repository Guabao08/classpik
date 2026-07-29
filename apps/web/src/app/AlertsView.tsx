import type { EventItem } from '../lib/api'

const LABELS: Record<string, { label: string; cls: string; dot: string }> = {
  seat_opened: { label: 'Seat opened', cls: 'bg-open/12 text-open border-open/25', dot: 'bg-open' },
  waitlist_opened: { label: 'Waitlist opened', cls: 'bg-wait/10 text-wait border-wait/25', dot: 'bg-wait' },
  seat_closed: { label: 'Filled', cls: 'border-line text-muted', dot: 'bg-white/25' },
  waitlist_closed: { label: 'Waitlist full', cls: 'border-line text-muted', dot: 'bg-white/25' },
  capacity_changed: { label: 'Capacity changed', cls: 'border-line text-muted', dot: 'bg-white/25' },
  section_removed: { label: 'Section gone', cls: 'bg-full/10 text-full border-full/25', dot: 'bg-full' },
}

function ago(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86_400)}d ago`
}

export default function AlertsView({ events }: { events: EventItem[] }) {
  return (
    <div className="px-9 py-8">
      <header className="mb-7">
        <h1 className="text-2xl font-bold tracking-[-0.02em]">Alerts</h1>
        <p className="mt-1.5 text-sm text-muted">
          Every change on a section you watch, and what we did about it.
        </p>
      </header>

      {events.length === 0 ? (
        <div className="panel px-6 py-20 text-center">
          <p className="text-sm font-medium">Nothing has happened yet.</p>
          <p className="mx-auto mt-2 max-w-sm text-xs leading-relaxed text-muted">
            That is the normal state. Most sections sit unchanged for weeks, which is exactly why
            watching them by hand does not work.
          </p>
        </div>
      ) : (
        <div className="panel overflow-hidden">
          {events.map((e) => {
            const meta = LABELS[e.kind] ?? {
              label: e.kind.replace(/_/g, ' '),
              cls: 'border-line text-muted',
              dot: 'bg-white/25',
            }
            return (
              <div
                key={e.id}
                className="flex items-center justify-between gap-5 border-b border-line px-5 py-4 transition-colors last:border-0 hover:bg-white/2"
              >
                <div className="flex min-w-0 items-center gap-3.5">
                  <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${meta.dot}`} />
                  <div className="min-w-0">
                    <div className="text-sm font-semibold">
                      {e.code} <span className="text-muted">· {e.section_label}</span>
                    </div>
                    <div className="mt-0.5 truncate text-xs text-muted">
                      {e.title} · {e.detail}
                    </div>
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-3">
                  <span className="num text-xs text-muted">{ago(e.at)}</span>
                  <span className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold ${meta.cls}`}>
                    {meta.label}
                  </span>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
