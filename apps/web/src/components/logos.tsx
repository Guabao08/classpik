/**
 * Logo candidates. Each mark is drawn on a 24x24 grid and must stay legible at
 * 16px, so no thin strokes and no detail smaller than 1.5 units.
 *
 * `dim` is the muted structural color, `accent` is the one lime highlight.
 * Every mark uses exactly one accent element so the eye lands in one place.
 */

interface MarkProps {
  size?: number
  className?: string
}

const DIM = 'currentColor'
const ACCENT = 'var(--color-open, #c8ff4d)'

function Svg({ size = 24, className, children }: MarkProps & { children: React.ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
      {children}
    </svg>
  )
}

/** 1. Open Seat: a seat map that is full except for one. Literally the product. */
export function MarkOpenSeat(p: MarkProps) {
  const pos = [1, 9, 17]
  return (
    <Svg {...p}>
      {pos.map((y) =>
        pos.map((x) => {
          const isOpen = x === 17 && y === 1
          return (
            <rect
              key={`${x}-${y}`}
              x={x}
              y={y}
              width="6"
              height="6"
              rx="1.6"
              fill={isOpen ? ACCENT : DIM}
              opacity={isOpen ? 1 : 0.22}
            />
          )
        })
      )}
    </Svg>
  )
}

/** 2. Checkgrid: the same seat grid, with the filled cells tracing a check. */
export function MarkCheckGrid(p: MarkProps) {
  const pos = [1, 9, 17]
  const on = new Set(['1-9', '9-17', '17-1'])
  return (
    <Svg {...p}>
      {pos.map((y) =>
        pos.map((x) => {
          const isOn = on.has(`${x}-${y}`)
          return (
            <rect
              key={`${x}-${y}`}
              x={x}
              y={y}
              width="6"
              height="6"
              rx="1.6"
              fill={isOn ? ACCENT : DIM}
              opacity={isOn ? 1 : 0.18}
            />
          )
        })
      )}
    </Svg>
  )
}

/** 3. Snap: an open slot with the seat dropping into it. The moment of claiming. */
export function MarkSnap(p: MarkProps) {
  return (
    <Svg {...p}>
      <path
        d="M14.5 2.5H5.5A3 3 0 0 0 2.5 5.5v13a3 3 0 0 0 3 3h9"
        stroke={DIM}
        strokeOpacity="0.35"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
      <rect x="10" y="7.5" width="11.5" height="9" rx="2.5" fill={ACCENT} />
    </Svg>
  )
}

/** 4. Time Ticket: Banner's own term for a registration window. Insider nod. */
export function MarkTicket(p: MarkProps) {
  return (
    <Svg {...p}>
      <mask id="ticket-notch">
        <rect x="0" y="0" width="24" height="24" fill="white" />
        <circle cx="14.5" cy="3.5" r="2.6" fill="black" />
        <circle cx="14.5" cy="20.5" r="2.6" fill="black" />
      </mask>
      <g mask="url(#ticket-notch)">
        <rect x="2" y="4" width="20" height="16" rx="3" fill={DIM} opacity="0.22" />
        <rect x="14.5" y="4" width="7.5" height="16" rx="3" fill={ACCENT} />
        <rect x="13.9" y="4" width="1.2" height="16" fill={ACCENT} opacity="0.35" />
      </g>
    </Svg>
  )
}

/** 5. Pik: a cursor landing in a seat grid. The "pick" in the name. */
export function MarkPik(p: MarkProps) {
  return (
    <Svg {...p}>
      <rect x="2" y="2" width="8" height="8" rx="2" fill={DIM} opacity="0.22" />
      <rect x="14" y="2" width="8" height="8" rx="2" fill={DIM} opacity="0.22" />
      <rect x="2" y="14" width="8" height="8" rx="2" fill={DIM} opacity="0.22" />
      <path
        d="M13.4 11.2 21.4 14.6a.6.6 0 0 1-.05 1.12l-3.16 1.03 1.62 3.2a.7.7 0 0 1-.32.94l-1.3.63a.7.7 0 0 1-.93-.34l-1.6-3.18-2.4 2.3a.6.6 0 0 1-1.02-.43V11.8a.6.6 0 0 1 .86-.55Z"
        fill={ACCENT}
      />
    </Svg>
  )
}

/** 6. Seat: a chair in profile. The most literal option, and the warmest. */
export function MarkSeat(p: MarkProps) {
  return (
    <Svg {...p}>
      <rect x="3.5" y="2.5" width="4" height="12" rx="2" fill={DIM} opacity="0.3" />
      <rect x="16.5" y="15" width="4" height="6.5" rx="2" fill={DIM} opacity="0.3" />
      <rect x="3.5" y="11.5" width="17" height="4.5" rx="2.25" fill={ACCENT} />
    </Svg>
  )
}

export const LOGO_OPTIONS = [
  {
    id: 'open-seat',
    name: 'Open Seat',
    Mark: MarkOpenSeat,
    pitch: 'A full seat map with exactly one seat left. It is the product, drawn.',
  },
  {
    id: 'checkgrid',
    name: 'Checkgrid',
    Mark: MarkCheckGrid,
    pitch: 'Same grid, but the lit cells trace a checkmark. Reads as "got it".',
  },
  {
    id: 'snap',
    name: 'Snap',
    Mark: MarkSnap,
    pitch: 'An open slot with the seat dropping in. Captures the instant of the claim.',
  },
  {
    id: 'ticket',
    name: 'Time Ticket',
    Mark: MarkTicket,
    pitch: '"Time ticket" is Banner\'s actual term for a registration window. Students will get it.',
  },
  {
    id: 'pik',
    name: 'Pik',
    Mark: MarkPik,
    pitch: 'A cursor landing in the empty cell. Puts the "pik" in the name to work.',
  },
  {
    id: 'seat',
    name: 'Seat',
    Mark: MarkSeat,
    pitch: 'A chair in profile. Most literal, most human, least tech-startup.',
  },
] as const
