import { SectionLabel } from '../components/ui'

/**
 * Shows one watch, start to finish: the request a student makes, and the
 * notification they get if the seat ever frees up.
 *
 * Deliberately static. This is a thing that takes weeks, so animating it into
 * a live ticker misrepresented the product.
 */
export default function WatchExample() {
  return (
    <div className="space-y-4">
      <div className="panel">
        <div className="flex items-start justify-between gap-4 border-b border-rule px-5 py-4">
          <div>
            <SectionLabel>Your request</SectionLabel>
            <h3 className="num text-[17px] font-medium">
              MATH 221 <span className="text-ink-soft">B</span>
            </h3>
            <p className="mt-1 text-sm text-ink-soft">Linear Algebra / MWF 10:00a</p>
          </div>
          <span className="label shrink-0 border border-rule px-2.5 py-1 text-ink-soft">Notify me</span>
        </div>

        <dl className="grid grid-cols-3 divide-x divide-rule">
          {[
            ['Seats', '0 / 90', 'text-full'],
            ['Waitlist', '14', 'text-wait'],
            ['Watching', '11 days', ''],
          ].map(([label, value, tone]) => (
            <div key={label} className="px-5 py-4">
              <dt className="label text-ink-soft">{label}</dt>
              <dd className={`num mt-1.5 text-lg font-medium ${tone}`}>{value}</dd>
            </div>
          ))}
        </dl>

        <p className="num border-t border-rule px-5 py-3 text-[11px] text-ink-soft">
          Checked 3,142 times since you asked. You have checked it zero times.
        </p>
      </div>

      {/* The payoff. Weeks of nothing, then this. The only place on the page
          that gets a fill rather than a rule, because it is the only place
          something actually happened. */}
      <div className="border border-open bg-open/8 px-5 py-4">
        <div className="mb-2.5 flex items-center gap-2">
          <span className="label text-open">Notification</span>
          <span className="num ml-auto text-[11px] text-ink-soft">4s after it opened</span>
        </div>
        <p className="text-[15px] font-medium">MATH 221 B has 1 seat open.</p>
        <p className="mt-1.5 text-[13px] leading-relaxed text-ink-soft">
          Someone dropped at 2:14 AM. Register now, or turn on auto-claim and we take it for you
          next time.
        </p>
      </div>
    </div>
  )
}
