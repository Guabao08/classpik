import { SeatBar, StatusPill } from '../components/ui'
import type { Channel, School, Watch } from '../lib/api'
import type { Mode } from './AppShell'

/** The one place the watchlist table's columns are written down. */
const COLUMNS = 'md:grid md:grid-cols-[1.6fr_0.9fr_0.8fr_1.1fr_1.1fr_auto] md:gap-4'

/**
 * Every watch this account holds, in full.
 *
 * Deliberately not filtered by the school and term in the sidebar. A transfer
 * student changes school on Monday, and a watchlist that hid Tuesday's watches
 * would look exactly like a watchlist that lost them. Anything outside the
 * current selection is labelled with the school it belongs to instead.
 */
export default function WatchlistView({
  watches,
  onToggle,
  onSetMode,
  onSetChannel,
  emailReady,
  email,
  currentSchool,
  schools,
}: {
  watches: Watch[]
  onToggle: (sectionId: string) => void
  onSetMode: (sectionId: string, mode: Mode) => void
  onSetChannel: (sectionId: string, channel: Channel) => void
  /** Whether the monitor has an email provider configured. */
  emailReady: boolean
  /** The account address, which is the only one alerts are ever sent to. */
  email: string
  /** What the sidebar is pointed at, used to label rather than to filter. */
  currentSchool: string | null
  /** Only to turn a school id into the name a student would recognise. */
  schools: School[]
}) {
  const autoCount = watches.filter((w) => w.mode === 'claim').length
  const elsewhere = (schoolId: string) => currentSchool !== null && schoolId !== currentSchool
  const nameOf = (schoolId: string) => schools.find((s) => s.id === schoolId)?.name ?? schoolId
  const strayCount = watches.filter((w) => elsewhere(w.section.schoolId)).length

  return (
    <div className="px-5 py-6 md:px-9 md:py-8">
      <header className="mb-7 flex flex-col items-start justify-between gap-4 sm:flex-row sm:gap-6">
        <div>
          <h1 className="display text-[2rem]">Watchlist</h1>
          <p className="mt-1.5 text-sm text-ink-soft">
            {watches.length} section{watches.length === 1 ? '' : 's'} watched, {autoCount} set to
            auto-claim.
            {strayCount > 0 &&
              ` ${strayCount} from another school, still being checked.`}
          </p>
        </div>
        {autoCount > 0 && (
          <div className=" border border-open/25 bg-open/8 px-4 py-3">
            <div className="text-xs font-semibold text-open">Auto-claim requested</div>
            <p className="mt-1 text-[11px] leading-relaxed text-ink-soft">
              Needs the local agent, which is not built yet.
            </p>
          </div>
        )}
      </header>

      {watches.length === 0 ? (
        <div className="panel px-6 py-20 text-center">
          <p className="text-sm font-medium">Nothing watched yet.</p>
          <p className="mx-auto mt-2 max-w-sm text-xs leading-relaxed text-ink-soft">
            Head to Find classes and hit Watch on any section. The monitor starts checking it on its
            next cycle.
            {emailReady
              ? ` Alerts can go to ${email}, the address on your account.`
              : ' Alerts appear here in the app; this monitor has no email provider configured.'}
          </p>
        </div>
      ) : (
        <div className="panel overflow-hidden">
          {/* Hidden below the breakpoint, where each row becomes a labelled
              card. Six columns in a phone's width is unreadable, and a phone is
              where a seat alert is read. */}
          <div className={`label hidden border-b border-ink px-5 py-3 text-ink-soft ${COLUMNS}`}>
            <span>Course</span>
            <span>Seats</span>
            <span>Status</span>
            <span>When a seat opens</span>
            <span>Alert me</span>
            <span />
          </div>

          {watches.map((w) => {
            const s = w.section
            return (
              <div
                key={w.id}
                className={`flex flex-col gap-2.5 border-b border-rule px-5 py-3.5 transition-colors last:border-0 hover:bg-ink/2 md:items-center ${COLUMNS}`}
              >
                <div className="min-w-0">
                  <div className="flex items-baseline gap-2">
                    <span className="text-sm font-semibold">
                      {s.code} <span className="text-ink-soft">· {s.section}</span>
                    </span>
                    <span className="num text-[11px] text-ink-soft">{s.crn}</span>
                  </div>
                  <div className="mt-0.5 truncate text-xs text-ink-soft">
                    {s.title}
                    {s.meetingDays ? ` · ${s.meetingDays} ${s.meetingTime ?? ''}` : ''}
                  </div>
                  {/* Named, not hidden. A watch from the school you left is
                      still a watch, and it keeps being checked. */}
                  {elsewhere(s.schoolId) && (
                    <span className="mt-1.5 inline-flex items-center gap-1.5 rounded-full border border-rule bg-ink/4 px-2 py-0.5 text-[10px] text-ink-soft">
                      <span className="h-1 w-1 rounded-full bg-wait" />
                      {nameOf(s.schoolId)}
                    </span>
                  )}
                </div>

                <div>
                  <SeatBar seats={s.seats} capacity={s.capacity} />
                  {s.waitlist > 0 && (
                    <div className="num mt-1 text-[11px] text-wait">{s.waitlist} waitlisted</div>
                  )}
                </div>

                <div>
                  <StatusPill status={s.status} />
                </div>

                <div className="flex gap-1  border border-rule bg-ink/3 p-1">
                  {(['notify', 'claim'] as const).map((m) => (
                    <button
                      key={m}
                      onClick={() => onSetMode(s.id, m)}
                      className={`flex-1  px-2.5 py-1.5 text-[11px] font-semibold transition-colors ${
                        w.mode === m
                          ? m === 'claim'
                            ? 'bg-open/15 text-open'
                            : 'bg-ink/10 text-ink'
                          : 'text-ink-soft hover:text-ink'
                      }`}
                    >
                      {m === 'notify' ? 'Notify me' : 'Claim it'}
                    </button>
                  ))}
                </div>

                <div className="flex gap-1  border border-rule bg-ink/3 p-1">
                  {(['console', 'email'] as const).map((c) => {
                    const disabled = c === 'email' && !emailReady
                    return (
                      <button
                        key={c}
                        onClick={() => onSetChannel(s.id, c)}
                        disabled={disabled}
                        title={
                          disabled
                            ? 'This monitor has no email provider configured'
                            : c === 'email'
                              ? `Sent to ${email}, the address on your account`
                              : 'Shown in Alerts'
                        }
                        className={`flex-1  px-2.5 py-1.5 text-[11px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                          w.channel === c ? 'bg-ink/10 text-ink' : 'text-ink-soft hover:text-ink'
                        }`}
                      >
                        {c === 'console' ? 'In app' : 'Email'}
                      </button>
                    )
                  })}
                </div>

                <button
                  onClick={() => onToggle(s.id)}
                  aria-label={`Stop watching ${s.code}`}
                  className="self-start  px-2 py-1.5 text-xs text-ink-soft transition-colors hover:text-full md:self-auto"
                >
                  Remove
                </button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
