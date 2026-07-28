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
            Start with a free watch on any section. Auto-claim when you’re ready.
          </p>
          <div className="mt-8 flex justify-center">
            <StarBorder as="a" href="#" color="#c8ff4d" speed="4s" thickness={1.5}>
              <span className="text-sm font-semibold">Get early access</span>
            </StarBorder>
          </div>
        </Reveal>
      </section>

      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-5 px-6 py-9 sm:flex-row">
          <Logo />
          <p className="max-w-md text-center text-xs leading-relaxed text-muted sm:text-right">
            ClassPik registers on your behalf using your own account. Check your school’s
            registration policy before enabling auto-claim.
          </p>
        </div>
      </footer>
    </>
  )
}
