import { API_BASE } from '../lib/api'
import { Logo } from '../components/ui'

/**
 * The frame around signing in and signing up: mark, one panel, and the address
 * of the monitor this build talks to.
 *
 * Shared because the two screens are one flow. When they drift apart visually,
 * the second one reads as a different site asking for a password, which is the
 * last thing a sign-up form should look like.
 */
export function AuthCard({ children, wide = false }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-ink px-6 py-12">
      <div className={`w-full ${wide ? 'max-w-[460px]' : 'max-w-[380px]'}`}>
        <div className="mb-8 flex justify-center">
          <a href="/" aria-label="ClassPik home">
            <Logo size={30} />
          </a>
        </div>

        <div className="panel p-6">{children}</div>

        <p className="num mt-5 text-center text-[11px] text-muted">
          {API_BASE.replace(/^https?:\/\//, '')}
        </p>
      </div>
    </div>
  )
}

/** One set of field styles, so the two forms cannot drift a border apart. */
export const authField = {
  label: 'mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.14em] text-muted',
  input:
    'w-full rounded-xl border border-line bg-white/3 px-3.5 py-2.5 text-sm outline-none transition-colors placeholder:text-muted focus:border-open/40',
  select:
    'w-full appearance-none rounded-xl border border-line bg-ink-2 px-3.5 py-2.5 text-sm text-bright outline-none transition-colors hover:border-white/25 focus:border-open/40 disabled:opacity-50',
  submit:
    'w-full rounded-xl bg-open px-4 py-2.5 text-sm font-semibold text-ink transition-opacity hover:opacity-90 disabled:opacity-50',
} as const
