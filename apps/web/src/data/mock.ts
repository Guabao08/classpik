// Placeholder data for the UI preview. Replaced by the monitor API in Phase 1.

export type Status = 'open' | 'full' | 'waitlist'

export interface Watch {
  code: string
  title: string
  section: string
  crn: string
  school: 'GT' | 'DUKE'
  seats: number
  capacity: number
  waitlist: number
  status: Status
  mode: 'notify' | 'auto'
}

export const watches: Watch[] = [
  { code: 'CS 1332', title: 'Data Structures & Algorithms', section: 'B', crn: '30412', school: 'GT', seats: 0, capacity: 180, waitlist: 42, status: 'full', mode: 'auto' },
  { code: 'CS 2110', title: 'Computer Organization & Programming', section: 'A', crn: '30188', school: 'GT', seats: 3, capacity: 240, waitlist: 0, status: 'open', mode: 'auto' },
  { code: 'MATH 1554', title: 'Linear Algebra', section: 'G3', crn: '86022', school: 'GT', seats: 0, capacity: 90, waitlist: 11, status: 'waitlist', mode: 'notify' },
  { code: 'CS 4641', title: 'Machine Learning', section: 'A', crn: '91744', school: 'GT', seats: 0, capacity: 120, waitlist: 63, status: 'full', mode: 'auto' },
  { code: 'ISYE 3770', title: 'Statistics & Applications', section: 'C', crn: '24515', school: 'GT', seats: 12, capacity: 150, waitlist: 0, status: 'open', mode: 'notify' },
  { code: 'CS 2340', title: 'Objects & Design', section: 'D', crn: '30655', school: 'GT', seats: 0, capacity: 60, waitlist: 28, status: 'full', mode: 'auto' },
]

export interface FeedEvent {
  code: string
  section: string
  school: 'GT' | 'DUKE'
  seats: number
  claimedMs: number | null
  ago: string
}

export const feed: FeedEvent[] = [
  { code: 'CS 1332', section: 'B', school: 'GT', seats: 1, claimedMs: 312, ago: '2s ago' },
  { code: 'ECON 201', section: '05', school: 'DUKE', seats: 2, claimedMs: 366, ago: '14s ago' },
  { code: 'CS 4641', section: 'A', school: 'GT', seats: 1, claimedMs: 287, ago: '48s ago' },
  { code: 'MATH 212', section: '02', school: 'DUKE', seats: 1, claimedMs: null, ago: '1m ago' },
  { code: 'PHYS 2211', section: 'K', school: 'GT', seats: 4, claimedMs: 341, ago: '2m ago' },
  { code: 'CS 2110', section: 'A', school: 'GT', seats: 1, claimedMs: 298, ago: '3m ago' },
  { code: 'STA 199', section: '01', school: 'DUKE', seats: 3, claimedMs: 405, ago: '4m ago' },
  { code: 'MATH 1554', section: 'G3', school: 'GT', seats: 1, claimedMs: 271, ago: '4m ago' },
  { code: 'ISYE 3770', section: 'C', school: 'GT', seats: 2, claimedMs: null, ago: '5m ago' },
  { code: 'CS 2340', section: 'D', school: 'GT', seats: 1, claimedMs: 329, ago: '5m ago' },
]
