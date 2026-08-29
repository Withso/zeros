import gsap from 'gsap'

/** Keep the role-cycle timeout at or above this. */
export const BUILDERS_EXIT_MS = 1900

/**
 * Hammer beats the "d" in builders twice. Only that letter compresses.
 * On the second hit, "l" and "e" crack at the baseline. Then the whole
 * word squeezes shut and is gone — no fade, no letter-by-letter exit.
 */
export function playBuildersExit(root: HTMLElement): gsap.core.Timeline | undefined {
  const word = root.querySelector<HTMLElement>('[data-word="out"]')
  const next = root.querySelector<HTMLElement>('[data-word="in"]')
  const hammer = root.querySelector<HTMLElement>('[data-kind="hammer"]')
  const tools = root.querySelector<HTMLElement>('.hero-role-tools')
  if (!word || !next || !hammer || !tools) return

  const dEl = word.querySelector<HTMLElement>('[data-letter="d"]')
  const dFace = dEl?.querySelector<HTMLElement>('.hero-letter-face')
  const lEl = word.querySelector<HTMLElement>('[data-letter="l"]')
  const eEl = word.querySelector<HTMLElement>('[data-letter="e"]')
  const lFace = lEl?.querySelector<HTMLElement>('.hero-letter-face')
  const eFace = eEl?.querySelector<HTMLElement>('.hero-letter-face')
  if (!dEl || !dFace || !lEl || !eEl || !lFace || !eFace) return

  const cracks = word.querySelectorAll<SVGPathElement>('.hero-crack path')
  const chips = word.querySelectorAll<HTMLElement>('.hero-letter-chip')
  const sparks = root.querySelectorAll<HTMLElement>('.hero-role-spark')

  const dBox = dEl.getBoundingClientRect()
  const toolsBox = tools.getBoundingClientRect()
  const left =
    dBox.left - toolsBox.left + dBox.width * 0.5 - hammer.offsetWidth * 0.62
  const restTop = dBox.top - toolsBox.top - hammer.offsetHeight * 0.18

  gsap.set(next, { autoAlpha: 0, scaleY: 1, x: 0, y: 0 })
  gsap.set(word, {
    transformOrigin: '50% 100%',
    scaleX: 1,
    scaleY: 1,
    autoAlpha: 1,
  })
  gsap.set(dFace, { transformOrigin: '50% 100%', scaleY: 1 })
  gsap.set(hammer, {
    left,
    top: restTop,
    x: 0,
    y: -8,
    rotate: -18,
    opacity: 0,
    transformOrigin: '30% 88%',
  })
  gsap.set(chips, { autoAlpha: 0, x: 0, y: 0, rotate: 0 })
  gsap.set(sparks, { opacity: 0, scale: 0.5 })

  sparks.forEach((spark, i) => {
    gsap.set(spark, {
      left: dBox.left - toolsBox.left + dBox.width * 0.3 + i * 4,
      top: dBox.top - toolsBox.top + dBox.height * 0.12 + (i - 1) * 2,
    })
  })

  cracks.forEach((path) => {
    const len = path.getTotalLength()
    gsap.set(path, { strokeDasharray: len, strokeDashoffset: len })
  })

  const clearHammer = () => {
    gsap.set(hammer, {
      clearProps: 'left,top,x,y,rotate,opacity,transform,transformOrigin',
    })
  }

  const tl = gsap.timeline({
    defaults: { ease: 'power2.out' },
    onComplete: clearHammer,
  })

  tl.to(hammer, { opacity: 1, y: -6, duration: 0.22, ease: 'power2.out' }, 0)

  // Beat 1 — only "d" compresses. Neighbors stay whole.
  tl.to(hammer, { y: 3, rotate: 6, duration: 0.16, ease: 'power3.in' }, 0.28)
  tl.to(dFace, { scaleY: 0.62, duration: 0.07, ease: 'power2.out' }, 0.4)
  flashSparks(tl, sparks, 0.4)
  tl.to(hammer, { y: -7, rotate: -14, duration: 0.18, ease: 'power2.out' }, 0.48)
  tl.to(dFace, { scaleY: 0.9, duration: 0.18, ease: 'power2.out' }, 0.48)

  // Beat 2 — "d" packs down again; bottom of "l" and "e" cracks.
  tl.to(hammer, { y: 4, rotate: 8, duration: 0.14, ease: 'power3.in' }, 0.68)
  tl.to(dFace, { scaleY: 0.46, duration: 0.07, ease: 'power2.out' }, 0.78)
  flashSparks(tl, sparks, 0.78)
  tl.to(cracks, { strokeDashoffset: 0, duration: 0.16, ease: 'power1.out' }, 0.78)
  tl.to([lFace, eFace], { clipPath: 'inset(0 0 38% 0)', duration: 0.08, ease: 'none' }, 0.78)
  tl.to(chips, { autoAlpha: 1, duration: 0.04 }, 0.78)
  tl.to(
    lEl.querySelector('.hero-letter-chip'),
    { x: -1.6, y: 4, rotate: -6, duration: 0.3, ease: 'power2.in' },
    0.78,
  )
  tl.to(
    eEl.querySelector('.hero-letter-chip'),
    { x: 1.8, y: 4.4, rotate: 7, duration: 0.32, ease: 'power2.in' },
    0.78,
  )
  tl.to(
    hammer,
    { opacity: 0, y: -10, rotate: 10, duration: 0.2, ease: 'power2.in' },
    0.94,
  )

  // Whole word flattens into the baseline and is gone. No fade.
  tl.to(
    word,
    {
      scaleY: 0,
      scaleX: 1.04,
      duration: 0.2,
      ease: 'power4.in',
    },
    1.18,
  )
  tl.set(word, { autoAlpha: 0 })
  tl.to(next, { autoAlpha: 1, duration: 0.16, ease: 'power1.out' })

  return tl
}

function flashSparks(
  tl: gsap.core.Timeline,
  sparks: NodeListOf<HTMLElement>,
  at: number,
) {
  if (sparks.length === 0) return
  tl.to(sparks, { opacity: 0.45, scale: 1, duration: 0.05 }, at)
  tl.to(sparks, { opacity: 0, scale: 0.35, duration: 0.14, ease: 'power2.out' }, at + 0.05)
}
