// Placeholder catalog. In Phase 1 this comes from the monitor API, which reads
// the school's public schedule of classes. Shape mirrors what Banner returns.

export interface CatalogSection {
  crn: string
  code: string
  title: string
  section: string
  credits: number
  instructor: string
  days: string
  time: string
  seats: number
  capacity: number
  waitlist: number
  waitlistCap: number
}

export const catalog: CatalogSection[] = [
  { crn: '30412', code: 'CS 1332', title: 'Data Structures & Algorithms', section: 'B', credits: 3, instructor: 'Faulkner', days: 'MWF', time: '11:00a', seats: 0, capacity: 180, waitlist: 42, waitlistCap: 50 },
  { crn: '30413', code: 'CS 1332', title: 'Data Structures & Algorithms', section: 'C', credits: 3, instructor: 'Sharp', days: 'TR', time: '2:00p', seats: 0, capacity: 180, waitlist: 18, waitlistCap: 50 },
  { crn: '30418', code: 'CS 1332', title: 'Data Structures & Algorithms', section: 'E', credits: 3, instructor: 'Ferri', days: 'MWF', time: '9:30a', seats: 7, capacity: 150, waitlist: 0, waitlistCap: 50 },
  { crn: '30188', code: 'CS 2110', title: 'Computer Organization & Programming', section: 'A', credits: 4, instructor: 'Leahy', days: 'MWF', time: '1:00p', seats: 3, capacity: 240, waitlist: 0, waitlistCap: 40 },
  { crn: '30190', code: 'CS 2110', title: 'Computer Organization & Programming', section: 'B', credits: 4, instructor: 'Kim', days: 'TR', time: '9:30a', seats: 0, capacity: 200, waitlist: 24, waitlistCap: 40 },
  { crn: '30655', code: 'CS 2340', title: 'Objects & Design', section: 'D', credits: 3, instructor: 'Simpkins', days: 'TR', time: '12:30p', seats: 0, capacity: 60, waitlist: 28, waitlistCap: 30 },
  { crn: '91744', code: 'CS 4641', title: 'Machine Learning', section: 'A', credits: 3, instructor: 'Isbell', days: 'MW', time: '3:30p', seats: 0, capacity: 120, waitlist: 63, waitlistCap: 75 },
  { crn: '91750', code: 'CS 4641', title: 'Machine Learning', section: 'B', credits: 3, instructor: 'Riedl', days: 'TR', time: '11:00a', seats: 2, capacity: 90, waitlist: 0, waitlistCap: 75 },
  { crn: '86022', code: 'MATH 1554', title: 'Linear Algebra', section: 'G3', credits: 4, instructor: 'Barone', days: 'MTWR', time: '10:00a', seats: 0, capacity: 90, waitlist: 11, waitlistCap: 20 },
  { crn: '86031', code: 'MATH 1554', title: 'Linear Algebra', section: 'H1', credits: 4, instructor: 'Yu', days: 'MTWR', time: '8:00a', seats: 22, capacity: 90, waitlist: 0, waitlistCap: 20 },
  { crn: '24515', code: 'ISYE 3770', title: 'Statistics & Applications', section: 'C', credits: 3, instructor: 'Shapiro', days: 'TR', time: '3:30p', seats: 12, capacity: 150, waitlist: 0, waitlistCap: 25 },
  { crn: '11209', code: 'PHYS 2211', title: 'Intro Physics I', section: 'K', credits: 4, instructor: 'Greco', days: 'MWF', time: '8:00a', seats: 4, capacity: 120, waitlist: 0, waitlistCap: 30 },
  { crn: '11214', code: 'PHYS 2211', title: 'Intro Physics I', section: 'M', credits: 4, instructor: 'Schatz', days: 'MWF', time: '2:00p', seats: 0, capacity: 120, waitlist: 30, waitlistCap: 30 },
  { crn: '20114', code: 'ACCT 2101', title: 'Accounting I', section: 'A', credits: 3, instructor: 'Cheng', days: 'TR', time: '9:30a', seats: 31, capacity: 200, waitlist: 0, waitlistCap: 25 },
  { crn: '45021', code: 'ECE 2031', title: 'Digital Design Lab', section: 'L01', credits: 2, instructor: 'Hertling', days: 'W', time: '1:00p', seats: 0, capacity: 32, waitlist: 9, waitlistCap: 15 },
]

export function statusOf(s: CatalogSection) {
  if (s.seats > 0) return 'open' as const
  if (s.waitlist < s.waitlistCap) return 'waitlist' as const
  return 'full' as const
}

export interface Alert {
  crn: string
  code: string
  section: string
  seats: number
  at: string
  action: 'claimed' | 'notified' | 'missed'
  detail: string
}

export const alerts: Alert[] = [
  { crn: '30412', code: 'CS 1332', section: 'B', seats: 1, at: '2 min ago', action: 'claimed', detail: 'Registered in 312ms' },
  { crn: '91744', code: 'CS 4641', section: 'A', seats: 1, at: '48 min ago', action: 'notified', detail: 'Push sent, seat taken in 6s' },
  { crn: '86022', code: 'MATH 1554', section: 'G3', seats: 2, at: '3 hr ago', action: 'claimed', detail: 'Registered in 271ms' },
  { crn: '30655', code: 'CS 2340', section: 'D', seats: 1, at: '5 hr ago', action: 'missed', detail: 'Agent offline, laptop asleep' },
  { crn: '11209', code: 'PHYS 2211', section: 'K', seats: 4, at: 'Yesterday', action: 'notified', detail: 'Push sent' },
]
