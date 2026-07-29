import { describe, expect, it } from 'vitest'
import { diffSection, reconcile, toState, NOTIFIABLE, type SectionState } from '../src/core/diff.js'

const state = (over: Partial<SectionState> = {}): SectionState => ({
  seats: 0,
  capacity: 100,
  enrollment: 100,
  waitlist: 0,
  waitlistCap: 20,
  waitlistAvailable: 20,
  ...over,
})

describe('diffSection', () => {
  it('reports a first observation as section_added and nothing else', () => {
    const events = diffSection(null, state({ seats: 5 }))
    expect(events).toHaveLength(1)
    expect(events[0]!.kind).toBe('section_added')
  })

  it('does NOT emit seat_opened on first sight of an already-open section', () => {
    // This is the rule that stops a notification storm the moment a new subject
    // comes under watch. We have no evidence the seat *opened*; we just looked.
    const events = diffSection(null, state({ seats: 42 }))
    expect(events.map((e) => e.kind)).not.toContain('seat_opened')
  })

  it('emits seat_opened when a full section frees a seat', () => {
    const events = diffSection(state({ seats: 0 }), state({ seats: 1 }))
    const opened = events.find((e) => e.kind === 'seat_opened')
    expect(opened).toBeDefined()
    expect(opened!.prevSeats).toBe(0)
    expect(opened!.newSeats).toBe(1)
    expect(opened!.detail).toBe('1 seat opened')
  })

  it('pluralises correctly for multiple seats', () => {
    const events = diffSection(state({ seats: 0 }), state({ seats: 4 }))
    expect(events.find((e) => e.kind === 'seat_opened')!.detail).toBe('4 seats opened')
  })

  it('emits nothing when seat count is unchanged', () => {
    expect(diffSection(state({ seats: 3 }), state({ seats: 3 }))).toHaveLength(0)
  })

  it('does not emit seat_opened when an open section merely gains more seats', () => {
    // Going 3 -> 7 is not an opening. The student could already register.
    const events = diffSection(state({ seats: 3 }), state({ seats: 7 }))
    expect(events.map((e) => e.kind)).not.toContain('seat_opened')
  })

  it('emits seat_closed when the last seat goes', () => {
    const events = diffSection(state({ seats: 1 }), state({ seats: 0 }))
    expect(events.map((e) => e.kind)).toContain('seat_closed')
  })

  it('treats a negative seat count as full', () => {
    // Banner reports negative seatsAvailable on over-enrolled sections.
    const opened = diffSection(state({ seats: -3 }), state({ seats: 2 }))
    expect(opened.map((e) => e.kind)).toContain('seat_opened')

    const closed = diffSection(state({ seats: 2 }), state({ seats: -1 }))
    expect(closed.map((e) => e.kind)).toContain('seat_closed')
  })

  it('emits waitlist_opened when a full waitlist frees a spot', () => {
    const prev = state({ seats: 0, waitlist: 20, waitlistAvailable: 0 })
    const next = state({ seats: 0, waitlist: 19, waitlistAvailable: 1 })
    const events = diffSection(prev, next)
    expect(events.map((e) => e.kind)).toContain('waitlist_opened')
    expect(events.find((e) => e.kind === 'waitlist_opened')!.detail).toBe(
      'Waitlist reopened, 1 spot free'
    )
  })

  it('ignores waitlist movement on sections with no waitlist', () => {
    const prev = state({ waitlistCap: 0, waitlistAvailable: 0 })
    const next = state({ waitlistCap: 0, waitlistAvailable: 0 })
    expect(diffSection(prev, next)).toHaveLength(0)
  })

  it('records a capacity change separately from a seat opening', () => {
    // A registrar raising the cap frees seats without anyone dropping. Both
    // things are true and we want to be able to tell them apart later.
    const prev = state({ seats: 0, capacity: 100 })
    const next = state({ seats: 20, capacity: 120 })
    const kinds = diffSection(prev, next).map((e) => e.kind)
    expect(kinds).toContain('seat_opened')
    expect(kinds).toContain('capacity_changed')
  })

  it('only marks seat and waitlist openings as notifiable', () => {
    expect([...NOTIFIABLE].sort()).toEqual(['seat_opened', 'waitlist_opened'])
    expect(NOTIFIABLE.has('seat_closed')).toBe(false)
    expect(NOTIFIABLE.has('capacity_changed')).toBe(false)
  })
})

describe('toState', () => {
  it('carries every field the differ compares', () => {
    const s = toState({
      crn: '1', subject: 'CS', courseNumber: '260', code: 'CS 260', title: 't', section: 'A',
      credits: 3, instructor: null, meetingDays: null, meetingTime: null, campus: null,
      seats: 5, capacity: 50, enrollment: 45, waitlist: 2, waitlistCap: 10, waitlistAvailable: 8,
    })
    expect(s).toEqual({
      seats: 5, capacity: 50, enrollment: 45, waitlist: 2, waitlistCap: 10, waitlistAvailable: 8,
    })
  })
})

describe('reconcile', () => {
  it('pairs incoming sections with stored state', () => {
    const stored = new Map([['A', state({ seats: 1 })]])
    const { present } = reconcile([{ crn: 'A' }, { crn: 'B' }], stored)
    expect(present).toHaveLength(2)
    expect(present[0]!.previous?.seats).toBe(1)
    expect(present[1]!.previous).toBeNull()
  })

  it('reports stored sections missing from the fetch', () => {
    const stored = new Map([
      ['A', state()],
      ['GONE', state()],
    ])
    const { removed } = reconcile([{ crn: 'A' }], stored)
    expect(removed).toEqual(['GONE'])
  })

  it('reports nothing removed when the fetch is a superset', () => {
    const { removed } = reconcile([{ crn: 'A' }, { crn: 'B' }], new Map([['A', state()]]))
    expect(removed).toEqual([])
  })
})
