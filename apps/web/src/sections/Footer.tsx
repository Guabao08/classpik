import StarBorder from '../bits/StarBorder'
import Reveal from '../components/Reveal'
import { Logo } from '../components/ui'

export default function Footer() {
  return (
    <>
      <section id="waitlist" className="mx-auto max-w-6xl px-6 pb-28 text-center">
        <Reveal>
          <h2 className="mx-auto max-w-2xl text-[clamp(1.9rem,4.5vw,3rem)] font-bold leading-[1.1] tracking-[-0.025em]">
            Registration opens whether you’re awake or not.
          </h2>
          <p className="mx-auto mt-5 max-w-lg text-[15px] leading-relaxed text-muted">
            Make an account and watch any section for free. Auto-claim is not built yet.
          </p>
          <div className="mt-8 flex justify-center">
            {/* The sentence above this button says to make an account, so the
                button makes an account. */}
            <StarBorder as="a" href="/signup" color="#c8ff4d" speed="4s" thickness={1.5}>
              <span className="text-sm font-semibold">Make an account</span>
            </StarBorder>
          </div>
        </Reveal>
      </section>

      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-5 px-6 py-9 sm:flex-row">
          <Logo />
          <p className="max-w-md text-center text-xs leading-relaxed text-muted sm:text-right">
            ClassPik watches your school’s public class search and tells you when a seat opens. It
            never asks for your school login. Registering is still something you do yourself.
          </p>
        </div>
      </footer>
    </>
  )
}
