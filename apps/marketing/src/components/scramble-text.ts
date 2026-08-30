import gsap from 'gsap'

export const SCRAMBLE_MS = 1500

export const DESIGN_MARKS = [
  'frame',
  'component',
  'align',
  'rect',
  'circle',
  'triangle',
] as const

export type DesignMark = (typeof DESIGN_MARKS)[number]

const mark = (name: DesignMark, inner: string) =>
  `<svg class="hero-scramble-icon" data-hero-scramble-icon="${name}" viewBox="0 0 16 16" aria-hidden="true" focusable="false">${inner}</svg>`

const path = (d: string) =>
  `<path d="${d}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`

/**
 * Six Figma-like marks: frame, component diamond, align-left, rectangle,
 * circle, triangle. Named so the scramble can cycle them instead of
 * reprinting one stroke.
 */
export const DESIGN_ICONS = [
  mark('frame', path('M2.2 5.5V2.2h3.3M10.5 2.2h3.3v3.3M13.8 10.5v3.3h-3.3M5.5 13.8H2.2v-3.3')),
  mark(
    'component',
    path(
      'M8 1.5l1.85 5.15L8 8 6.15 6.65zM14.5 8l-5.15 1.85L8 8l1.35-1.85zM8 14.5l-1.85-5.15L8 8l1.85 1.35zM1.5 8l5.15-1.85L8 8 6.65 9.85z',
    ),
  ),
  mark('align', path('M2.3 2.2v11.6M5.1 3.5h8.6M5.1 7.4h5.5M5.1 11.3h8.6')),
  mark(
    'rect',
    '<rect x="2.5" y="3.4" width="10.9" height="9.2" rx="1.55" fill="none" stroke="currentColor" stroke-width="1.5"/>',
  ),
  mark(
    'circle',
    '<circle cx="8" cy="8" r="5.35" fill="none" stroke="currentColor" stroke-width="1.5"/>',
  ),
  mark('triangle', path('M8 2.35L13.75 13.55H2.25z')),
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

/** Deal `count` icons from shuffled decks so neighbors never match. */
function dealDistinct(icons: readonly string[], count: number): string[] {
  const out: string[] = []
  let deck: string[] = []
  while (out.length < count) {
    if (deck.length === 0) {
      deck = shuffle(icons)
      const prev = out[out.length - 1]
      if (prev !== undefined && deck[0] === prev && deck.length > 1) {
        const swap = deck.findIndex((html) => html !== prev)
        if (swap > 0) {
          const a = deck[0]!
          deck[0] = deck[swap]!
          deck[swap] = a
        }
      }
    }
    const next = deck.shift()!
    const prev = out[out.length - 1]
    if (prev === next && icons.length > 1) {
      const alt = deck.find((html) => html !== prev) ?? icons.find((html) => html !== prev)
      if (alt && alt !== prev) {
        out.push(alt)
        deck.push(next)
        continue
      }
    }
    out.push(next)
  }
  return out
}

export function fillScrambleCells(length: number, set: ScrambleSet): ScrambleCell[] {
  if (length <= 0) return []
  const icons = set.icons
  if (!icons || icons.length === 0) {
    return Array.from({ length }, () => pickScrambleCell(set))
  }

  const punctCount =
    set.chars.length === 0 ? 0 : Math.min(Math.floor(length / 5), Math.round(length / 8))
  const punctAt = new Set(
    shuffle(Array.from({ length }, (_, i) => i)).slice(0, Math.min(punctCount, length)),
  )
  const sequence = dealDistinct(icons, length - punctAt.size)
  const cells: ScrambleCell[] = []
  let k = 0
  for (let i = 0; i < length; i += 1) {
    if (punctAt.has(i)) {
      cells.push(pickScrambleCell(set))
      continue
    }
    cells.push({ kind: 'icon', html: sequence[k]! })
    k += 1
  }
  return cells
}

function hasAdjacentRepeat(htmls: readonly string[]): boolean {
  for (let i = 1; i < htmls.length; i += 1) {
    if (htmls[i] === htmls[i - 1]) return true
  }
  return false
}

function shiftHtmls(htmls: readonly string[], by: number): string[] {
  const n = htmls.length
  const shift = ((by % n) + n) % n
  return htmls.map((_, i) => htmls[(i + shift) % n]!)
}

function repairAdjacentRepeats(htmls: readonly string[]): string[] {
  const out = [...htmls]
  for (let pass = 0; pass < out.length; pass += 1) {
    let dirty = false
    for (let i = 1; i < out.length; i += 1) {
      if (out[i] !== out[i - 1]) continue
      dirty = true
      for (let j = 0; j < out.length; j += 1) {
        if (j === i) continue
        if (out[j] === out[i - 1]) continue
        const tmp = out[i]!
        out[i] = out[j]!
        out[j] = tmp
        break
      }
    }
    if (!dirty) break
  }
  return out
}

/** Rotate only icon cells so the tool set slides instead of reprinting. */
export function rotateScrambleIcons(cells: ScrambleCell[], by = 1): ScrambleCell[] {
  const indexes: number[] = []
  for (let i = 0; i < cells.length; i += 1) {
    if (cells[i]!.kind === 'icon') indexes.push(i)
  }
  if (indexes.length < 2) return cells
  const htmls = indexes.map((i) => (cells[i] as { html: string }).html)
  const n = htmls.length
  let chosen = repairAdjacentRepeats(shiftHtmls(htmls, by))
  if (hasAdjacentRepeat(chosen)) {
    for (let k = 1; k < n; k += 1) {
      const candidate = repairAdjacentRepeats(shiftHtmls(htmls, by + k))
      if (!hasAdjacentRepeat(candidate)) {
        chosen = candidate
        break
      }
    }
  }
  return cells.map((cell, i) => {
    const k = indexes.indexOf(i)
    if (k < 0) return cell
    return { kind: 'icon', html: chosen[k]! }
  })
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
  let tick = 0
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
        tick += 1
        const next =
          set.icons && slots.length >= len && tick % 3 !== 0
            ? rotateScrambleIcons(slots.slice(0, len), 1)
            : fillScrambleCells(len, set)
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
