import AnimatedContent from '../bits/AnimatedContent'

/**
 * One wrapper so every scroll reveal on the site shares the same motion.
 *
 * React Bits ships AnimatedContent with distance=100 and duration=0.8, which
 * reads as a slide, not a reveal. 24px over 0.65s is enough for the eye to
 * register that something arrived without making anyone wait for it.
 */
export default function Reveal({
  children,
  delay = 0,
  className,
}: {
  children: React.ReactNode
  delay?: number
  className?: string
}) {
  return (
    <AnimatedContent
      distance={24}
      duration={0.65}
      ease="power3.out"
      initialOpacity={0}
      threshold={0.15}
      delay={delay}
      className={className}
    >
      {children}
    </AnimatedContent>
  )
}
