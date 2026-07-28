import { LOGO_OPTIONS } from '../components/logos'

/**
 * Scratch page for picking a mark. Reachable at #logos.
 * Delete once we've settled on one.
 */
export default function LogoLab() {
  return (
    <div className="min-h-screen bg-ink px-6 py-16">
      <div className="mx-auto max-w-5xl">
        <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-open">
          Logo options
        </p>
        <h1 className="text-4xl font-extrabold tracking-[-0.03em]">Pick a mark.</h1>
        <p className="mt-4 max-w-xl text-[15px] leading-relaxed text-muted">
          Each one is shown at hero size, nav size, and favicon size, because the favicon is where
          most marks fall apart. Tell me a number and I will wire it in everywhere.
        </p>
        <a
          href="#"
          className="mt-6 inline-block text-sm text-muted underline underline-offset-4 transition hover:text-bright"
        >
          Back to the site
        </a>

        <div className="mt-12 grid gap-5 sm:grid-cols-2">
          {LOGO_OPTIONS.map((opt, i) => (
            <div key={opt.id} className="panel p-7">
              <div className="mb-6 flex items-baseline justify-between">
                <div className="flex items-baseline gap-2.5">
                  <span className="num text-xs text-open">0{i + 1}</span>
                  <h2 className="text-base font-semibold">{opt.name}</h2>
                </div>
              </div>

              <div className="flex items-end gap-8 rounded-xl bg-white/3 px-6 py-7">
                <opt.Mark size={56} className="text-bright" />
                <div className="flex items-center gap-2">
                  <opt.Mark size={26} className="text-bright" />
                  <span className="text-[17px] font-bold tracking-tight">
                    class<span className="text-open">pik</span>
                  </span>
                </div>
                <div className="flex flex-col items-center gap-1.5">
                  <opt.Mark size={16} className="text-bright" />
                  <span className="text-[9px] text-muted">16px</span>
                </div>
              </div>

              <p className="mt-5 text-sm leading-relaxed text-muted">{opt.pitch}</p>
            </div>
          ))}
        </div>

        <div className="panel mt-10 p-7">
          <h2 className="mb-5 text-base font-semibold">All six at favicon size</h2>
          <div className="flex flex-wrap items-center gap-7">
            {LOGO_OPTIONS.map((opt, i) => (
              <div key={opt.id} className="flex flex-col items-center gap-2">
                <div className="grid h-9 w-9 place-items-center rounded-lg bg-white/6">
                  <opt.Mark size={18} className="text-bright" />
                </div>
                <span className="num text-[10px] text-muted">0{i + 1}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
