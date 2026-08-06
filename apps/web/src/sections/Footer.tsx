import Reveal from '../components/Reveal'
import { Logo } from '../components/ui'

export default function Footer() {
  return (
    <>
      <section id="waitlist" className="mx-auto max-w-6xl px-6 pb-28">
        <Reveal className="border-t border-ink pt-14">
          <h2 className="display max-w-3xl text-[clamp(2.2rem,5vw,3.6rem)]">
            Registration opens whether you’re awake or not.
          </h2>
          <p className="mt-6 max-w-lg text-[15px] leading-[1.65] text-ink-soft">
            Make an account and watch any section for free. Auto-claim is not built yet.
          </p>
          {/* The sentence above this button says to make an account, so the
              button makes an account. */}
          <a
            href="/signup"
            className="mt-8 inline-block bg-ink px-6 py-3.5 text-sm font-medium text-paper transition-opacity hover:opacity-85"
          >
            Make an account
          </a>
        </Reveal>
      </section>

      <footer className="border-t border-rule">
        <div className="mx-auto flex max-w-6xl flex-col items-start justify-between gap-5 px-6 py-9 sm:flex-row sm:items-center">
          <Logo />
          <p className="max-w-md text-xs leading-relaxed text-ink-soft sm:text-right">
            ClassPik watches your school’s public class search and tells you when a seat opens. It
            never asks for your school login. Registering is still something you do yourself.
          </p>
        </div>
      </footer>
    </>
  )
}
