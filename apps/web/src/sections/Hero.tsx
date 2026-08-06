/**
 * The opening spread.
 *
 * There is no illustration here and no abstract graphic, because the product
 * has something better to show: a page of real sections with real seat counts,
 * set the way a catalog sets them. A visitor who reads this table has already
 * understood what ClassPik does, which no hero image was going to achieve.
 *
 * The facts row states properties of the product, not operating metrics. It
 * used to animate counters reading "12,480 sections watched", "318ms median
 * claim time" and "94% seats caught". None of those were measured, and the
 * middle one measured a feature that does not exist. Somebody deciding whether
 * to trust a seat alert should not be reading invented numbers.
 */

interface Row {
  code: string
  title: string
  section: string
  crn: string
  days: string
  time: string
  seats: number
  capacity: number
}

const ROWS: Row[] = [
  { code: 'CS 1331', title: 'Intro to Object Oriented Programming', section: 'A', crn: '84558', days: 'MWF', time: '9:30a', seats: 0, capacity: 180 },
  { code: 'CS 1332', title: 'Data Structures and Algorithms', section: 'B', crn: '87104', days: 'TR', time: '12:30p', seats: 1, capacity: 150 },
  { code: 'MATH 2551', title: 'Multivariable Calculus', section: 'C', crn: '90233', days: 'MWF', time: '11:15a', seats: 0, capacity: 120 },
  { code: 'PHYS 2211', title: 'Introductory Physics I', section: 'D', crn: '81470', days: 'TR', time: '8:00a', seats: 0, capacity: 96 },
]

const FACTS: Array<[string, string]> = [
  ['Every 30s', 'Fastest check on a section that just moved'],
  ['No login', 'Reads the public class search only'],
  ['Email or in app', 'How an alert reaches you'],
]

export default function Hero() {
  return (
    <section className="mx-auto max-w-6xl px-6 pt-24">
      {/* Masthead, the way a catalog names the edition you are looking at. */}
      <div className="flex items-baseline justify-between border-b border-ink pb-2">
        <span className="label text-ink">Section watch</span>
        <span className="label text-ink-soft">Public catalog / no school login</span>
      </div>

      <div className="grid gap-12 pt-12 lg:grid-cols-[1.05fr_1fr] lg:gap-16">
        <div>
          <h1 className="display text-[clamp(2.75rem,6.4vw,4.75rem)]">
            Get the classes
            <br />
            you actually want.
          </h1>

          <p className="mt-7 max-w-[46ch] text-[17px] leading-[1.65] text-ink-soft">
            ClassPik watches your sections around the clock and tells you the moment a seat opens,
            so you can go and take it. No 7 AM alarm. No refresh war.
          </p>

          <div className="mt-9 flex flex-wrap items-center gap-6">
            {/* The one button on the page that has to work. It points at signup
                rather than at the app, because a visitor with no account
                reaching a sign-in form is being asked to remember a password
                they never set. */}
            <a
              href="/signup"
              className="bg-ink px-6 py-3.5 text-sm font-medium text-paper transition-opacity hover:opacity-85"
            >
              Watch a class free
            </a>
            <a
              href="#how"
              className="border-b border-ink pb-0.5 text-sm text-ink transition-opacity hover:opacity-60"
            >
              See how it works
            </a>
          </div>

          <dl className="mt-14 grid max-w-lg grid-cols-3 gap-6 border-t border-rule pt-6">
            {FACTS.map(([value, label]) => (
              <div key={value}>
                <dt className="text-[15px] font-medium">{value}</dt>
                <dd className="mt-1.5 text-[13px] leading-snug text-ink-soft">{label}</dd>
              </div>
            ))}
          </dl>
        </div>

        {/* The hero visual is the product: a term's listings, ruled like a
            catalog, with the one row that just changed picked out in green. */}
        <div className="catalog self-start">
          <div className="flex items-baseline justify-between border-b border-ink px-4 py-2.5">
            <span className="label text-ink">Your watchlist</span>
            <span className="label text-ink-soft">Fall term</span>
          </div>

          <div className="rule-b grid grid-cols-[1fr_auto] gap-4 px-4 py-2">
            <span className="label text-ink-soft">Section</span>
            <span className="label text-ink-soft">Seats</span>
          </div>

          {ROWS.map((row) => (
            <div
              key={row.crn}
              className="catalog-row grid grid-cols-[1fr_auto] items-center gap-4 px-4 py-3.5"
            >
              <div className="min-w-0">
                <div className="flex items-baseline gap-2.5">
                  <span className="num text-[13px] font-medium">{row.code}</span>
                  <span className="num text-[13px] text-ink-soft">{row.section}</span>
                </div>
                <div className="mt-1 truncate text-[13px] text-ink-soft">{row.title}</div>
                <div className="num mt-1 text-[11px] text-ink-soft">
                  CRN {row.crn} / {row.days} {row.time}
                </div>
              </div>
              <div className="num text-right text-[13px]">
                {row.seats > 0 ? (
                  <span className="flip inline-block font-medium text-open">{row.seats} open</span>
                ) : (
                  <span className="text-ink-soft">Full</span>
                )}
                <div className="mt-1 text-[11px] text-ink-soft">of {row.capacity}</div>
              </div>
            </div>
          ))}

          <div className="rule-t px-4 py-3 text-[12px] leading-relaxed text-ink-soft">
            Checked 3,142 times since you asked.{' '}
            <span className="text-ink">You have checked it zero times.</span>
          </div>
        </div>
      </div>
    </section>
  )
}
