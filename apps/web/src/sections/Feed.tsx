import AnimatedList from '../bits/AnimatedList'
import { SchoolTag, SectionLabel } from '../components/ui'
import { feed } from '../data/mock'

export default function Feed() {
  const items = feed.map((e) => (
    <div className="flex items-center justify-between gap-4 rounded-xl border border-line bg-white/3 px-4 py-3.5 transition hover:border-open/30 hover:bg-white/5">
      <div className="flex min-w-0 items-center gap-3">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-open dot-open" />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold">
              {e.code} <span className="text-muted">· {e.section}</span>
            </span>
            <SchoolTag school={e.school} />
          </div>
          <div className="num mt-0.5 text-xs text-muted">
            {e.seats} seat{e.seats > 1 ? 's' : ''} opened · {e.ago}
          </div>
        </div>
      </div>
      {e.claimedMs ? (
        <span className="num shrink-0 rounded-full bg-open/12 px-2.5 py-1 text-[11px] font-semibold text-open">
          claimed {e.claimedMs}ms
        </span>
      ) : (
        <span className="shrink-0 rounded-full border border-line px-2.5 py-1 text-[11px] font-medium text-muted">
          notified
        </span>
      )}
    </div>
  ))

  return (
    <div className="panel p-6">
      <div className="mb-5 flex items-center justify-between">
        <div>
          <SectionLabel>Live</SectionLabel>
          <h3 className="text-lg font-semibold">Seats opening right now</h3>
        </div>
        <span className="num rounded-full border border-line px-2.5 py-1 text-[11px] text-muted">
          last 5 min
        </span>
      </div>
      <AnimatedList
        items={items}
        maxHeight="352px"
        fadeColor="#0e1013"
        itemClassName="mb-2.5"
        enableArrowNavigation={false}
        displayScrollbar
      />
    </div>
  )
}
