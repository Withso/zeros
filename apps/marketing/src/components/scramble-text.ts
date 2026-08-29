import gsap from 'gsap'

export const SCRAMBLE_MS = 1500

const svg = (inner: string) =>
  `<svg class="hero-scramble-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">${inner}</svg>`

const stroke = (d: string) =>
  `<path d="${d}" fill="none" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round"/>`

const oval = (rx: number, ry: number) =>
  `<ellipse cx="8" cy="8" rx="${rx}" ry="${ry}" fill="none" stroke="currentColor" stroke-width="1.55"/>`

/**
 * Frame, instance, align, rectangle, oval, and triangle.
 * Cycled across scramble cells so one mark does not dominate.
 */
export const DESIGN_ICONS = [
  svg(stroke('M2.3 5.4V2.3h3.1 M10.6 2.3h3.1v3.1 M13.7 10.6v3.1h-3.1 M5.4 13.7H2.3v-3.1')),
  svg(stroke('M8 1.6l2 2-2 2-2-2z M12.4 6l2 2-2 2-2-2z M8 10.4l2 2-2 2-2-2z M3.6 6l2 2-2 2-2-2z')),
  svg(stroke('M2.4 2.4v11.2 M5.4 4.2h8.4 M5.4 8h5.4 M5.4 11.8h8.4')),
  svg(stroke('M3 4.2h10v7.6H3z')),
  svg(oval(6.2, 4.1)),
  svg(stroke('M8 2.5L13.8 13.4H2.2z')),
] as const

export type ScrambleSet = {
  chars: string
  icons?: readonly string[]
}

/** builders → developers */
export const CODE_SCRAMBLE: ScrambleSet = {
  chars: '{}[]</>;:=()*&|#$@!?\\^~`01',
}

/** developers → designers — letter-sized marks, sparse #|+. */
export const DESIGN_SCRAMBLE: ScrambleSet = {
  chars: '#|+',
  icons: DESIGN_ICONS,
}

/** designers → builders: matrix digits, no CJK. */
export const MATRIX_SCRAMBLE: ScrambleSet = {
  chars: '01',
}

export const SCRAMBLE_FROM: Record<string, ScrambleSet> = {
  builders: CODE_SCRAMBLE,
  developers: DESIGN_SCRAMBLE,
  designers: MATRIX_SCRAMBLE,
}

export type GlyphKind = 'from' | 'scramble' | 'to' | 'icon'

export type Glyph =
  | { kind: 'from' | 'to' | 'scramble'; ch: string }
  | { kind: 'icon'; html: string }

export type ScrambleCell =
  | { kind: 'char'; ch: string }
  | { kind: 'icon'; html: string }

function pickChar(chars: string): string {
  return chars[Math.floor(Math.random() * chars.length)] ?? '0'
}

function shuffle<T>(items: readonly T[]): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    const a = out[i]!
    out[i] = out[j]!
    out[j] = a
  }
  return out
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/** Random glyphs of a fixed length. Character-level only — no planted words. */
export function scrambleFill(length: number, chars: string): string {
  if (length <= 0) return ''
  return Array.from({ length }, () => pickChar(chars)).join('')
}

/**
 * Left-to-right dissolve: keep the outgoing letter, flicker through the
 * charset, then lock the incoming letter. Staggered so the whole word
 * never pops in as one block.
 */
export function scrambleGlyphKind(i: number, t: number, count: number): 'from' | 'scramble' | 'to' {
  const n = Math.max(1, count)
  const start = (i / n) * 0.12
  const lock = 0.42 + (i / n) * 0.5
  if (t <= start) return 'from'
  if (t < lock) return 'scramble'
  return 'to'
}

export function renderGlyphRun(glyphs: readonly Glyph[]): string {
  let html = ''
  let i = 0
  while (i < glyphs.length) {
    const glyph = glyphs[i]!
    if (glyph.kind === 'icon') {
      html += glyph.html
      i += 1
      continue
    }
    const { kind } = glyph
    let run = ''
    while (i < glyphs.length && glyphs[i]!.kind === kind) {
      run += escapeHtml((glyphs[i] as { ch: string }).ch)
      i += 1
    }
    const cls =
      kind === 'scramble' ? 'hero-scramble-symbol' : 'hero-scramble-text hero-role-revealed'
    html += `<span class="${cls}">${run}</span>`
  }
  return html
}

function pickScrambleCell(set: ScrambleSet): ScrambleCell {
  return { kind: 'char', ch: pickChar(set.chars) }
}

export function fillScrambleCells(length: number, set: ScrambleSet): ScrambleCell[] {
  if (length <= 0) return []
  const icons = set.icons
  if (!icons || icons.length === 0) {
    return Array.from({ length }, () => pickScrambleCell(set))
  }

  const punctCount = set.chars.length === 0 ? 0 : Math.max(0, Math.round(length / 6))
  const punctAt = new Set(
    shuffle(Array.from({ length }, (_, i) => i)).slice(0, Math.min(punctCount, length)),
  )
  const cycle = shuffle(icons)
  const cells: ScrambleCell[] = []
  let k = 0
  let prevIcon: string | undefined

  for (let i = 0; i < length; i += 1) {
    if (punctAt.has(i)) {
      cells.push(pickScrambleCell(set))
      prevIcon = undefined
      continue
    }
    let html = cycle[k % cycle.length]!
    k += 1
    if (prevIcon !== undefined && html === prevIcon && cycle.length > 1) {
      html = cycle[k % cycle.length]!
      k += 1
    }
    cells.push({ kind: 'icon', html })
    prevIcon = html
  }
  return cells
}

function cellToGlyph(cell: ScrambleCell): Glyph {
  if (cell.kind === 'icon') return { kind: 'icon', html: cell.html }
  return { kind: 'scramble', ch: cell.ch }
}

/** HTML tail of scramble glyphs. Each slot is one character or icon. */
export function scrambleTail(length: number, set: ScrambleSet): string {
  if (length <= 0) return ''
  return renderGlyphRun(fillScrambleCells(length, set).map(cellToGlyph))
}

function sineInOut(t: number): number {
  return 0.5 - Math.cos(Math.PI * Math.min(1, Math.max(0, t))) / 2
}

/**
 * ScrambleText-style decode: random glyphs, then a left-to-right settle.
 * Club ScrambleTextPlugin is not in the public `gsap` package; this uses
 * the documented tween shape (chars, tweenLength, revealDelay, speed).
 * https://gsap.com/docs/v3/Plugins/ScrambleTextPlugin/
 */
export function playScramble(
  el: HTMLElement,
  {
    text,
    set,
    duration = SCRAMBLE_MS / 1000,
    speed = 1.15,
  }: {
    text: string
    set: ScrambleSet
    duration?: number
    revealDelay?: number
    speed?: number
  },
): gsap.core.Tween {
  const from = el.textContent ?? ''
  const startLen = Math.max(1, from.length)
  const endLen = text.length
  const maxLen = Math.max(startLen, endLen)
  const refreshMs = Math.max(28, 40 / Math.max(0.4, speed))
  let slots = fillScrambleCells(maxLen, set)
  let lastRefresh = -Infinity
  let lastHtml = ''
  const state = { t: 0 }

  return gsap.to(state, {
    t: 1,
    duration,
    ease: 'none',
    onUpdate: () => {
      const visualT = sineInOut(state.t)
      const len = Math.max(1, Math.round(startLen + (endLen - startLen) * visualT))
      const now = performance.now()
      if (now - lastRefresh >= refreshMs) {
        lastRefresh = now
        const next = fillScrambleCells(len, set)
        for (let i = 0; i < len; i += 1) {
          if (scrambleGlyphKind(i, visualT, maxLen) === 'scramble') {
            slots[i] = next[i] ?? pickScrambleCell(set)
          }
        }
      }
      const glyphs: Glyph[] = []
      for (let i = 0; i < len; i += 1) {
        const kind = scrambleGlyphKind(i, visualT, maxLen)
        if (kind === 'from' && i < from.length) {
          glyphs.push({ kind: 'from', ch: from[i]! })
        } else if (kind === 'to' && i < text.length) {
          glyphs.push({ kind: 'to', ch: text[i]! })
        } else {
          glyphs.push(cellToGlyph(slots[i] ?? pickScrambleCell(set)))
        }
      }
      const html = renderGlyphRun(glyphs)
      if (html !== lastHtml) {
        lastHtml = html
        el.innerHTML = html
      }
    },
    onComplete: () => {
      el.textContent = text
    },
  })
}
