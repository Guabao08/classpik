import { alerts, type Alert } from '../data/catalog'

const badge: Record<Alert['action'], { label: string; cls: string }> = {
  claimed: { label: 'Claimed', cls: 'bg-open/12 text-open border-open/25' },
  notified: { label: 'Notified', cls: 'border-line text-muted' },
  missed: { label: 'Missed', cls: 'bg-full/10 text-full border-full/25' },
}

export default function AlertsView() {
  const missed = alerts.filter((a) => a.action === 'missed').length

  return (
    <div className="px-9 py-8">
      <header className="mb-7">
        <h1 className="text-2xl font-bold tracking-[-0.02em]">Alerts</h1>
        <p className="mt-1.5 text-sm text-muted">
          Every seat that opened on a section you watch, and what we did about it.
        </p>
      </header>

      {missed > 0 && (
        <div className="mb-5 flex items-start gap-3 rounded-xl border border-full/25 bg-full/8 px-4 py-3.5">
          <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-full" />
          <div>
            <p className="text-sm font-semibold">
              {missed} seat went by while the agent was offline.
            </p>
            <p className="mt-1 text-xs leading-relaxed text-muted">
              Auto-claim needs your machine awake. Turn on scheduled wake in settings so ClassPik
              powers the laptop on before your window.
            </p>
          </div>
        </div>
      )}

      <div className="panel overflow-hidden">
        {alerts.map((a) => (
          <div
            key={a.crn + a.at}
            className="flex items-center justify-between gap-5 border-b border-line px-5 py-4 transition-colors last:border-0 hover:bg-white/2"
          >
            <div className="flex min-w-0 items-center gap-3.5">
              <span
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                  a.action === 'claimed'
                    ? 'bg-open'
                    : a.action === 'missed'
                      ? 'bg-full'
                      : 'bg-white/25'
                }`}
              />
              <div className="min-w-0">
                <div className="text-sm font-semibold">
                  {a.code} <span className="text-muted">· {a.section}</span>
                </div>
                <div className="mt-0.5 text-xs text-muted">
                  {a.seats} seat{a.seats > 1 ? 's' : ''} opened · {a.detail}
                </div>
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-3">
              <span className="num text-xs text-muted">{a.at}</span>
              <span
                className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold ${badge[a.action].cls}`}
              >
                {badge[a.action].label}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
