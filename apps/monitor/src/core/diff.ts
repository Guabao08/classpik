import type { RawSection } from '../adapters/types.js'

/**
 * Change detection. Pure functions, no IO, because this is the part that must
 * not be wrong: a false positive wakes a student at 3 AM for nothing, and a
 * false negative is the entire product failing silently.
 */

export type EventKind =
  | 'section_added'
  | 'section_removed'
  | 'seat_opened'
  | 'seat_closed'
  | 'waitlist_opened'
  | 'waitlist_closed'
  | 'capacity_changed'

/** Events a watcher is actually woken for. The rest are for history and debugging. */
export const NOTIFIABLE: ReadonlySet<EventKind> = new Set<EventKind>(['seat_opened', 'waitlist_opened'])

export interface SectionState {
  seats: number
  capacity: number
  enrollment: number
  waitlist: number
  waitlistCap: number
  waitlistAvailable: number
}

export interface DetectedEvent {
  kind: EventKind
  prevSeats: number | null
  newSeats: number
  prevWaitlist: number | null
  newWaitlist: number
  /** Human-readable, stored on the event so alerts read well without a join. */
  detail: string
}

export function toState(s: RawSection): SectionState {
  return {
    seats: s.seats,
    capacity: s.capacity,
    enrollment: s.enrollment,
    waitlist: s.waitlist,
    waitlistCap: s.waitlistCap,
    waitlistAvailable: s.waitlistAvailable,
  }
}

/**
 * Compare one section against its previous observation.
 *
 * The critical rule is the first one: a section we have never seen before
 * produces `section_added` and NOTHING else, even if it has seats free right
 * now. We have no evidence that it *opened*; we just started looking. Without
 * this, bringing a new subject under watch would fire a notification for every
 * section in it that happens to be open, which is both wrong and the kind of
 * thing that gets an app uninstalled.
 */
export function diffSection(prev: SectionState | null, next: SectionState): DetectedEvent[] {
  if (prev === null) {
    return [
      {
        kind: 'section_added',
        prevSeats: null,
        newSeats: next.seats,
        prevWaitlist: null,
        newWaitlist: next.waitlist,
        detail: `First observation: ${next.seats} of ${next.capacity} seats free`,
      },
    ]
  }

  const events: DetectedEvent[] = []
  const base = {
    prevSeats: prev.seats,
    newSeats: next.seats,
    prevWaitlist: prev.waitlist,
    newWaitlist: next.waitlist,
  }

  if (prev.seats <= 0 && next.seats > 0) {
    events.push({
      ...base,
      kind: 'seat_opened',
      detail:
        next.seats === 1
          ? '1 seat opened'
          : `${next.seats} seats opened`,
    })
  } else if (prev.seats > 0 && next.seats <= 0) {
    events.push({ ...base, kind: 'seat_closed', detail: 'Section filled' })
  }

  // A full section whose waitlist also has room is still actionable: joining
  // the waitlist is the only move available, and it is time sensitive too.
  if (prev.waitlistCap > 0 && prev.waitlistAvailable <= 0 && next.waitlistAvailable > 0) {
    events.push({
      ...base,
      kind: 'waitlist_opened',
      detail: `Waitlist reopened, ${next.waitlistAvailable} spot${next.waitlistAvailable === 1 ? '' : 's'} free`,
    })
  } else if (prev.waitlistCap > 0 && prev.waitlistAvailable > 0 && next.waitlistAvailable <= 0) {
    events.push({ ...base, kind: 'waitlist_closed', detail: 'Waitlist filled' })
  }

  // Registrars do raise caps mid-registration, which frees seats without anyone
  // dropping. Recorded separately so we can tell the two apart in history.
  if (prev.capacity !== next.capacity) {
    events.push({
      ...base,
      kind: 'capacity_changed',
      detail: `Capacity changed from ${prev.capacity} to ${next.capacity}`,
    })
  }

  return events
}

export interface SectionLike {
  crn: string
}

export interface ReconcileResult<T extends SectionLike> {
  /** Sections present upstream, paired with whatever we had stored. */
  present: Array<{ incoming: T; previous: SectionState | null }>
  /** CRNs we had stored that upstream no longer reports. */
  removed: string[]
}

/**
 * Pair an upstream fetch against stored state.
 *
 * Removal is reported rather than acted on, because a section disappearing
 * from a fetch is ambiguous: it may be cancelled, or the upstream page may
 * have been truncated. The poller decides what to do with that; this function
 * only reports it.
 */
export function reconcile<T extends SectionLike>(
  incoming: T[],
  stored: Map<string, SectionState>
): ReconcileResult<T> {
  const seen = new Set<string>()
  const present = incoming.map((s) => {
    seen.add(s.crn)
    return { incoming: s, previous: stored.get(s.crn) ?? null }
  })
  const removed = [...stored.keys()].filter((crn) => !seen.has(crn))
  return { present, removed }
}
