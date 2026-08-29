import { useEffect, useState, type CSSProperties } from 'react'
import './hero-role.css'

const ROLES = ['builders', 'developers', 'designers'] as const
const ACTS = ['smash', 'type', 'paint'] as const

const HOLD_MS = 2800
const ACT_MS = 1150

type Role = (typeof ROLES)[number]
type Act = (typeof ACTS)[number]

/**
 * Cycles the hero audience word. Developers type, designers paint.
 * Builders is a quiet swap until it has a strengthen story.
 */
export function HeroRoleCycle() {
  const [index, setIndex] = useState(0)
  const [phase, setPhase] = useState<'idle' | 'act'>('idle')
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

  useEffect(() => {
    if (reduce) return
    const ids: number[] = []
    let cancelled = false

    const loop = () => {
      ids.push(
        window.setTimeout(() => {
          if (cancelled) return
          setPhase('act')
          ids.push(
            window.setTimeout(() => {
              if (cancelled) return
              setIndex((i) => (i + 1) % ROLES.length)
              setPhase('idle')
              loop()
            }, ACT_MS),
          )
        }, HOLD_MS),
      )
    }
    loop()
    return () => {
      cancelled = true
      for (const id of ids) window.clearTimeout(id)
    }
  }, [reduce])

  const role = ROLES[index]
  const next = ROLES[(index + 1) % ROLES.length]
  const act: Act | '' = phase === 'act' ? ACTS[index] : ''

  return (
    <span
      className="hero-role"
      data-phase={reduce ? 'idle' : phase}
      data-act={reduce ? '' : act}
    >
      <span className="hero-role-sizer" aria-hidden>
        developers
      </span>
      {phase === 'act' && !reduce ? (
        <>
          <Word text={role} mode="out" />
          <Word text={next} mode="in" />
        </>
      ) : (
        <Word text={role} mode="idle" />
      )}
      {reduce ? null : <Tools act={act} />}
    </span>
  )
}

function Word({
  text,
  mode,
}: {
  text: Role
  mode: 'idle' | 'in' | 'out'
}) {
  return (
    <span
      className={`hero-role-word${mode === 'idle' ? '' : ` is-${mode}`}`}
      style={{ '--n': text.length } as CSSProperties}
    >
      {text.split('').map((ch, i) => (
        <span
          key={`${text}-${mode}-${i}`}
          className="hero-role-letter"
          style={{ '--i': i } as CSSProperties}
        >
          {ch}
        </span>
      ))}
    </span>
  )
}

function Tools({ act }: { act: Act | '' }) {
  return (
    <span className="hero-role-tools" aria-hidden>
      <span className="hero-role-tool" data-kind="hammer" aria-hidden>
        <HammerMark />
      </span>
      <span className="hero-role-tool" data-kind="laptop" aria-hidden>
        <LaptopMark />
      </span>
      <span className="hero-role-tool" data-kind="brush" aria-hidden>
        <BrushMark />
      </span>
      {act === 'paint' ? (
        <svg className="hero-role-trail" viewBox="0 0 160 16" aria-hidden>
          <path
            className="hero-stroke"
            d="M2 10 C 42 3, 92 14, 158 8"
            fill="none"
            stroke="color-mix(in srgb, var(--violet-primary) 65%, var(--fg1))"
            strokeWidth="2.4"
            strokeLinecap="round"
          />
        </svg>
      ) : null}
      <i className="hero-role-spark" />
      <i className="hero-role-spark" />
      <i className="hero-role-spark" />
    </span>
  )
}

function HammerMark() {
  return (
    <svg className="hero-role-svg" viewBox="0 0 48 48" aria-hidden>
      <ellipse className="hero-role-glow" cx="30" cy="15" rx="13" ry="10" />
      <rect
        className="hero-role-glass"
        x="16"
        y="7"
        width="24"
        height="13"
        rx="4.5"
        strokeWidth="1.3"
      />
      <rect
        className="hero-role-glass"
        x="18"
        y="9.5"
        width="8"
        height="8"
        rx="2"
        strokeWidth="0.8"
        opacity="0.7"
      />
      <path
        d="M22 20.5 15 41"
        stroke="currentColor"
        strokeWidth="3.2"
        strokeLinecap="round"
        opacity="0.88"
      />
    </svg>
  )
}

function LaptopMark() {
  return (
    <svg className="hero-role-svg" viewBox="0 0 52 40" aria-hidden>
      <ellipse className="hero-role-glow" cx="26" cy="18" rx="16" ry="12" />
      <rect
        className="hero-role-glass"
        x="9"
        y="5"
        width="34"
        height="21"
        rx="3.5"
        strokeWidth="1.3"
      />
      <rect
        x="13"
        y="9"
        width="26"
        height="13"
        rx="1.6"
        fill="color-mix(in srgb, var(--fg1) 10%, transparent)"
      />
      <path
        d="M6 30h40c1.4 0 2.2 1.6 1.2 2.6L45 35H7l-2.2-2.4C3.8 31.6 7 30 6 30Z"
        className="hero-role-glass"
        strokeWidth="1.1"
      />
      <circle
        className="hero-key"
        cx="18"
        cy="27.5"
        r="1.15"
        fill="currentColor"
        style={{ animationDelay: '0ms' }}
      />
      <circle
        className="hero-key"
        cx="23"
        cy="27.5"
        r="1.15"
        fill="currentColor"
        style={{ animationDelay: '60ms' }}
      />
      <circle
        className="hero-key"
        cx="28"
        cy="27.5"
        r="1.15"
        fill="currentColor"
        style={{ animationDelay: '120ms' }}
      />
      <rect
        className="hero-finger"
        x="31"
        y="1"
        width="5.5"
        height="9"
        rx="2.6"
        fill="color-mix(in srgb, var(--fg1) 78%, transparent)"
      />
    </svg>
  )
}

function BrushMark() {
  return (
    <svg className="hero-role-svg" viewBox="0 0 48 48" aria-hidden>
      <ellipse className="hero-role-glow" cx="14" cy="14" rx="9" ry="8" />
      <path
        className="hero-role-glass"
        d="M8 8c6-2 11 4 9 10-4 2-11-2-9-10Z"
        strokeWidth="1.2"
      />
      <path
        d="M16 17 34 39"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinecap="round"
        opacity="0.88"
      />
    </svg>
  )
}
