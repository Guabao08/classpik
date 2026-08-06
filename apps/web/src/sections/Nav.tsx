import { Logo } from '../components/ui'

/**
 * The landing page header, which has to know whether anybody is signed in.
 *
 * It did not, and unconditionally offered "Sign in" and "Get early access". So
 * a signed-in student who clicked the logo inside the product landed on a
 * marketing page aimed at people who do not have an account, with no link back
 * to the app anywhere on it and no route home but the address bar.
 */
export default function Nav({ signedIn = false }: { signedIn?: boolean }) {
  return (
    <header className="fixed inset-x-0 top-0 z-50 border-b border-rule bg-paper/92 backdrop-blur-sm">
      <nav className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-8 px-6">
        <a href="/" aria-label="ClassPik home">
          <Logo />
        </a>

        <div className="hidden items-center gap-7 md:flex">
          <a className="label text-ink-soft transition-colors hover:text-ink" href="#how">How it works</a>
          <a className="label text-ink-soft transition-colors hover:text-ink" href="#watchlist">Watchlist</a>
          <a className="label text-ink-soft transition-colors hover:text-ink" href="#schools">Schools</a>
        </div>

        {/* The two real doors: one for people who already have an account, one
            for everyone else. Both used to be href="#app", which was a screen
            that showed a sign-in form to a visitor who had not been asked to
            make an account yet. Somebody who is already signed in needs neither
            of them, only the way back in. */}
        <div className="flex items-center gap-5">
          {signedIn ? (
            <a
              href="/app"
              className="bg-ink px-4 py-2 text-sm font-medium text-paper transition-opacity hover:opacity-85"
            >
              Open app
            </a>
          ) : (
            <>
              <a href="/login" className="text-sm text-ink-soft transition-colors hover:text-ink">
                Sign in
              </a>
              <a
                href="/signup"
                className="bg-ink px-4 py-2 text-sm font-medium text-paper transition-opacity hover:opacity-85"
              >
                Start watching
              </a>
            </>
          )}
        </div>
      </nav>
    </header>
  )
}
