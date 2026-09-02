import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { playScramble, SCRAMBLE_FROM, SCRAMBLE_MS } from './scramble-text'
import './hero-role.css?v=scramble-52'

const ROLES = ['builders', 'developers', 'designers'] as const

const HOLD_MS = 2800

type Role = (typeof ROLES)[number]

/**
 * Cycles the hero audience word with a scramble decode: code glyphs,
 * design-tool marks, then matrix digits. Code and matrix follow word length;
 * developers → designers is a compact 6-icon scramble, then a left-to-right
 * decode into the word. Settled letters stay headline size; scramble glyphs
 * are 60px, except design icons at 50px.
 */
export function HeroRoleCycle() {
  const textRef = useRef<HTMLSpanElement>(null)
  const [index, setIndex] = useState(0)
  const [reduce, setReduce] = useState(() =>
    window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  )

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const sync = () => setReduce(mq.matches)
    sync()
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  }, [])

  useLayoutEffect(() => {
    if (reduce) return
    const el = textRef.current
    if (!el) return
    const ids: number[] = []
    let cancelled = false
    let tween: ReturnType<typeof playScramble> | undefined
    let i = 0

    const loop = () => {
      ids.push(
        window.setTimeout(() => {
          if (cancelled || !el) return
          const from = ROLES[i]
          const to = ROLES[(i + 1) % ROLES.length]
          const set = SCRAMBLE_FROM[from] ?? SCRAMBLE_FROM.builders
          el.classList.add('is-scrambling', `scramble-${from}`)
          tween = playScramble(el, { text: to, set })
          ids.push(
            window.setTimeout(() => {
              if (cancelled) return
              el.classList.remove('is-scrambling', `scramble-${from}`)
              i = (i + 1) % ROLES.length
              setIndex(i)
              loop()
            }, SCRAMBLE_MS),
          )
        }, HOLD_MS),
      )
    }
    loop()
    return () => {
      cancelled = true
      tween?.kill()
      el.classList.remove(
        'is-scrambling',
        'scramble-builders',
        'scramble-developers',
        'scramble-designers',
      )
      el.textContent = ROLES[i]
      for (const id of ids) window.clearTimeout(id)
    }
  }, [reduce])

  const role: Role = reduce ? 'builders' : ROLES[index]

  return (
    <span className="hero-role">
      <span className="hero-role-sizer" aria-hidden>
        developers
      </span>
      <span ref={textRef} className="hero-role-word" aria-hidden>
        {role}
      </span>
    </span>
  )
}
