import type { Status } from '../data/mock'

export function Logo({ className = '' }: { className?: string }) {
  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <div className="relative grid h-7 w-7 place-items-center rounded-lg bg-open">
        <div className="h-2.5 w-2.5 rounded-sm bg-ink" />
      </div>
      <span className="text-[17px] font-bold tracking-tight">
        class<span className="text-open">pik</span>
      </span>
    </div>
  )
}

const statusStyles: Record<Status, string> = {
  open: 'bg-open/12 text-open border-open/25',
  full: 'bg-full/10 text-full border-full/25',
  waitlist: 'bg-wait/10 text-wait border-wait/25',
}

const statusLabel: Record<Status, string> = {
  open: 'Open',
  full: 'Full',
  waitlist: 'Waitlist',
}

export function StatusPill({ status }: { status: Status }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold ${statusStyles[status]}`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full bg-current ${status === 'open' ? 'dot-open' : ''}`}
      />
      {statusLabel[status]}
    </span>
  )
}

export function SchoolTag({ school }: { school: 'GT' | 'DUKE' }) {
  return (
    <span className="rounded border border-line px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-muted">
      {school}
    </span>
  )
}

/** Fill bar showing how full a section is. Reads red as it saturates. */
export function SeatBar({ seats, capacity }: { seats: number; capacity: number }) {
  const taken = capacity - seats
  const pct = Math.min(100, Math.round((taken / capacity) * 100))
  return (
    <div className="flex items-center gap-2.5">
      <div className="h-1.5 w-20 overflow-hidden rounded-full bg-white/8">
        <div
          className="h-full rounded-full transition-all duration-700"
          style={{
            width: `${pct}%`,
            background: seats > 0 ? 'var(--color-open-dim)' : 'var(--color-full)',
          }}
        />
      </div>
      <span className="num text-xs text-muted">
        {taken}/{capacity}
      </span>
    </div>
  )
}

export function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-open">{children}</p>
  )
}
