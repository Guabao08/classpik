import type { Status } from '../data/mock'
import { MarkSeat } from './logos'

export function Logo({ className = '', size = 26 }: { className?: string; size?: number }) {
  return (
    <div className={`flex items-center gap-2.5 ${className}`}>
      <MarkSeat size={size} className="shrink-0 text-ink" />
      <span className="text-[17px] font-bold tracking-tight">
        class<span className="text-open">pik</span>
      </span>
    </div>
  )
}

const statusStyles: Record<Status, string> = {
  open: 'text-open border-open',
  full: 'text-full border-full',
  waitlist: 'text-wait border-wait',
}

const statusLabel: Record<Status, string> = {
  open: 'Open',
  full: 'Full',
  waitlist: 'Waitlist',
}

export function StatusPill({ status }: { status: Status }) {
  return (
    <span
      className={`label inline-flex items-center gap-1.5 border px-2 py-1 ${statusStyles[status]}`}
    >
      <span className="h-1.5 w-1.5 bg-current" />
      {statusLabel[status]}
    </span>
  )
}

/** Fill bar showing how full a section is. Reads red as it saturates. */
export function SeatBar({ seats, capacity }: { seats: number; capacity: number }) {
  const taken = capacity - seats
  const pct = Math.min(100, Math.round((taken / capacity) * 100))
  return (
    <div className="flex items-center gap-2.5">
      <div className="h-1.5 w-20 overflow-hidden rounded-full bg-ink/8">
        <div
          className="h-full rounded-full transition-all duration-700"
          style={{
            width: `${pct}%`,
            background: seats > 0 ? 'var(--color-open-dim)' : 'var(--color-full)',
          }}
        />
      </div>
      <span className="num text-xs text-ink-soft">
        {taken}/{capacity}
      </span>
    </div>
  )
}

export function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="label mb-4 text-open">{children}</p>
  )
}
