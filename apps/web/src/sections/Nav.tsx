import { Logo } from '../components/ui'

export default function Nav() {
  return (
    <header className="fixed inset-x-0 top-0 z-50 border-b border-line/60 bg-ink/70 backdrop-blur-xl">
      <nav className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
        <Logo />
        <div className="hidden items-center gap-8 text-sm text-muted md:flex">
          <a className="transition hover:text-bright" href="#how">How it works</a>
          <a className="transition hover:text-bright" href="#watchlist">Watchlist</a>
          <a className="transition hover:text-bright" href="#schools">Schools</a>
        </div>
        {/* The two real doors: one for people who already have an account, one
            for everyone else. Both used to be href="#app", which was a screen
            that showed a sign-in form to a visitor who had not been asked to
            make an account yet. */}
        <div className="flex items-center gap-3">
          <a href="/login" className="text-sm text-muted transition hover:text-bright">
            Sign in
          </a>
          <a
            href="/signup"
            className="rounded-full bg-open px-4 py-2 text-sm font-semibold text-ink transition hover:brightness-110"
          >
            Get early access
          </a>
        </div>
      </nav>
    </header>
  )
}
