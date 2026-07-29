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
      <div className="panel p-6">
        <div className="mb-5 flex items-start justify-between gap-4">
          <div>
            <SectionLabel>Your request</SectionLabel>
            <h3 className="text-lg font-semibold">
              MATH 221 <span className="text-muted">· Section B</span>
            </h3>
            <p className="mt-0.5 text-sm text-muted">Linear Algebra · MWF 10:00a</p>
          </div>
          <span className="shrink-0 rounded-full border border-line px-2.5 py-1 text-[11px] font-medium text-muted">
            Notify me
          </span>
        </div>

        <div className="grid grid-cols-3 gap-4 rounded-xl bg-white/3 px-5 py-4">
          <div>
            <div className="text-[11px] text-muted">Seats</div>
            <div className="num mt-1 text-lg font-semibold text-full">0 / 90</div>
          </div>
          <div>
            <div className="text-[11px] text-muted">Waitlist</div>
            <div className="num mt-1 text-lg font-semibold text-wait">14</div>
          </div>
          <div>
            <div className="text-[11px] text-muted">Watching</div>
            <div className="num mt-1 text-lg font-semibold">11 days</div>
          </div>
        </div>

        <p className="num mt-4 text-xs text-muted">
          Checked 3,142 times since you asked. You have checked it zero times.
        </p>
      </div>

      {/* The payoff. Weeks of nothing, then this. */}
      <div className="rounded-2xl border border-open/30 bg-open/8 p-5">
        <div className="mb-2.5 flex items-center gap-2">
          <span className="h-1.5 w-1.5 rounded-full bg-open" />
          <span className="text-[11px] font-semibold uppercase tracking-wider text-open">
            Notification
          </span>
          <span className="num ml-auto text-[11px] text-muted">4s after it opened</span>
        </div>
        <p className="text-sm font-semibold">MATH 221 B has 1 seat open.</p>
        <p className="mt-1 text-xs leading-relaxed text-muted">
          Someone dropped at 2:14 AM. Register now, or turn on auto-claim and we take it for you
          next time.
        </p>
      </div>
    </div>
  )
}
