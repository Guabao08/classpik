/**
 * The ClassPik mark: a chair in profile, drawn on a 24x24 grid and legible at
 * 16px, so no thin strokes and no detail smaller than 1.5 units.
 *
 * `DIM` is the muted structural color, `ACCENT` is the seat itself, in the one
 * green the product uses. One accent element only, so the eye lands in one
 * place, and it lands on the seat.
 *
 * Five other candidates and the gallery that compared them lived here. The mark
 * was chosen, so they are gone: a lab that outlives its decision is a second
 * logo the product does not use.
 */

interface MarkProps {
  size?: number
  className?: string
}

const DIM = 'currentColor'
const ACCENT = 'var(--color-open, #1a6b3c)'

export function MarkSeat({ size = 24, className }: MarkProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
      <rect x="3.5" y="2.5" width="4" height="12" rx="2" fill={DIM} opacity="0.3" />
      <rect x="16.5" y="15" width="4" height="6.5" rx="2" fill={DIM} opacity="0.3" />
      <rect x="3.5" y="11.5" width="17" height="4.5" rx="2.25" fill={ACCENT} />
    </svg>
  )
}
