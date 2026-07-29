// Invented rows, for the landing page illustration only. Nothing here is a
// measurement, and the section that renders them says so on the page. The real
// watchlist lives at /#app and comes from GET /api/watches.

export type Status = 'open' | 'full' | 'waitlist'

export interface Watch {
  code: string
  title: string
  section: string
  crn: string
  seats: number
  capacity: number
  waitlist: number
  status: Status
  mode: 'notify' | 'auto'
  watchingSince: string
  checks: number
}

export const watches: Watch[] = [
  { code: 'MATH 221', title: 'Linear Algebra', section: 'B', crn: '30412', seats: 0, capacity: 90, waitlist: 14, status: 'waitlist', mode: 'notify', watchingSince: '11 days', checks: 3142 },
  { code: 'CS 260', title: 'Data Structures', section: 'A', crn: '30188', seats: 3, capacity: 240, waitlist: 0, status: 'open', mode: 'auto', watchingSince: '6 days', checks: 1724 },
  { code: 'CHEM 101', title: 'General Chemistry I', section: 'G3', crn: '86022', seats: 0, capacity: 180, waitlist: 41, status: 'full', mode: 'auto', watchingSince: '23 days', checks: 6580 },
  { code: 'ECON 201', title: 'Microeconomics', section: 'C', crn: '24515', seats: 12, capacity: 150, waitlist: 0, status: 'open', mode: 'notify', watchingSince: '2 days', checks: 574 },
  { code: 'BIOL 210', title: 'Genetics', section: 'D', crn: '30655', seats: 0, capacity: 60, waitlist: 28, status: 'full', mode: 'auto', watchingSince: '17 days', checks: 4863 },
]
