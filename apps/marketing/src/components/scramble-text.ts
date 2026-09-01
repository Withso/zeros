import gsap from 'gsap'

export const SCRAMBLE_MS = 1500

/** Bright fills from the marketing design-tool icon sheet. */
export const SCRAMBLE_PALETTE = [
  '#68E098',
  '#F0C840',
  '#E87038',
  '#E84848',
  '#E840A8',
  '#B838F0',
  '#3888F0',
  '#E8E8E8',
] as const

export const DESIGN_MARKS = [
  'frame',
  'component',
  'pentagon',
  'tangent',
  'triangle',
  'circle',
  'square',
  'diamond',
  'align-horizontal-space-around',
  'palette',
  'panels-top-left',
] as const

export type DesignMark = (typeof DESIGN_MARKS)[number]

/** developers → designers: 10 unique marks, one per character of "developers". */
export const DESIGN_VISIBLE = 10

const ICON_COLORS = [
  ...SCRAMBLE_PALETTE,
  '#5AA8FF',
  '#B49030',
  '#C04040',
] as const

const lucide = (name: DesignMark, color: string, inner: string) =>
  `<svg class="hero-scramble-icon" data-hero-scramble-icon="${name}" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${inner}</svg>`

/**
 * Lucide design marks only (ISC, same drawings as lucide-react).
 * One hardcoded hue each; marketing scramble is allowed off tokens.
 */
export const DESIGN_ICONS = [
  lucide(
    'frame',
    ICON_COLORS[0],
    '<line x1="22" x2="2" y1="6" y2="6"/><line x1="22" x2="2" y1="18" y2="18"/><line x1="6" x2="6" y1="2" y2="22"/><line x1="18" x2="18" y1="2" y2="22"/>',
  ),
  lucide(
    'component',
    ICON_COLORS[1],
    '<path d="M15.536 11.293a1 1 0 0 0 0 1.414l2.376 2.377a1 1 0 0 0 1.414 0l2.377-2.377a1 1 0 0 0 0-1.414l-2.377-2.377a1 1 0 0 0-1.414 0z"/><path d="M2.297 11.293a1 1 0 0 0 0 1.414l2.377 2.377a1 1 0 0 0 1.414 0l2.377-2.377a1 1 0 0 0 0-1.414L6.088 8.916a1 1 0 0 0-1.414 0z"/><path d="M8.916 17.912a1 1 0 0 0 0 1.415l2.377 2.376a1 1 0 0 0 1.414 0l2.377-2.376a1 1 0 0 0 0-1.415l-2.377-2.376a1 1 0 0 0-1.414 0z"/><path d="M8.916 4.674a1 1 0 0 0 0 1.414l2.377 2.376a1 1 0 0 0 1.414 0l2.377-2.376a1 1 0 0 0 0-1.414l-2.377-2.377a1 1 0 0 0-1.414 0z"/>',
  ),
  lucide(
    'pentagon',
    ICON_COLORS[2],
    '<path d="M10.83 2.38a2 2 0 0 1 2.34 0l8 5.74a2 2 0 0 1 .73 2.25l-3.04 9.26a2 2 0 0 1-1.9 1.37H7.04a2 2 0 0 1-1.9-1.37L2.1 10.37a2 2 0 0 1 .73-2.25z"/>',
  ),
  lucide(
    'tangent',
    ICON_COLORS[3],
    '<circle cx="17" cy="4" r="2"/><path d="M15.59 5.41 5.41 15.59"/><circle cx="4" cy="17" r="2"/><path d="M12 22s-4-9-1.5-11.5S22 12 22 12"/>',
  ),
  lucide(
    'triangle',
    ICON_COLORS[4],
    '<path d="M13.73 4a2 2 0 0 0-3.46 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/>',
  ),
  lucide(
    'circle',
    ICON_COLORS[5],
    '<circle cx="12" cy="12" r="10"/>',
  ),
  lucide(
    'square',
    ICON_COLORS[6],
    '<rect width="18" height="18" x="3" y="3" rx="2"/>',
  ),
  lucide(
    'diamond',
    ICON_COLORS[7],
    '<path d="M2.7 10.3a2.41 2.41 0 0 0 0 3.41l7.59 7.59a2.41 2.41 0 0 0 3.41 0l7.59-7.59a2.41 2.41 0 0 0 0-3.41l-7.59-7.59a2.41 2.41 0 0 0-3.41 0Z"/>',
  ),
  lucide(
    'align-horizontal-space-around',
    ICON_COLORS[8],
    '<rect width="6" height="10" x="9" y="7" rx="2"/><path d="M4 22V2"/><path d="M20 22V2"/>',
  ),
  lucide(
    'palette',
    ICON_COLORS[9],
    `<circle cx="13.5" cy="6.5" r=".5" fill="${ICON_COLORS[9]}"/><circle cx="17.5" cy="10.5" r=".5" fill="${ICON_COLORS[9]}"/><circle cx="8.5" cy="7.5" r=".5" fill="${ICON_COLORS[9]}"/><circle cx="6.5" cy="12.5" r=".5" fill="${ICON_COLORS[9]}"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/>`,
  ),
  lucide(
    'panels-top-left',
    ICON_COLORS[10],
    '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/><path d="M9 21V9"/>',
  ),
] as const

export type ScrambleSet = {
  chars: string
  icons?: readonly string[]
}

/** builders → developers */
export const CODE_SCRAMBLE: ScrambleSet = {
  chars: '{}[]</>;:=()*&|#$@!?\\^~`01',
}

/** developers → designers — 10 unique Lucide marks, one per character slot. */
export const DESIGN_SCRAMBLE: ScrambleSet = {
  chars: '',
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
  | { kind: 'from' | 'to'; ch: string }
  | { kind: 'scramble'; ch: string; color: string }
  | { kind: 'icon'; html: string }

export type ScrambleCell =
  | { kind: 'char'; ch: string; color: string }
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

function colorAttr(color: string): string {
  return /^#[0-9A-Fa-f]{6}$/.test(color) ? ` style="color:${color}"` : ''
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
    if (glyph.kind === 'scramble') {
      html += `<span class="hero-scramble-symbol"${colorAttr(glyph.color)}>${escapeHtml(glyph.ch)}</span>`
      i += 1
      continue
    }
    let run = ''
    while (i < glyphs.length && glyphs[i]!.kind === glyph.kind) {
      run += escapeHtml((glyphs[i] as { ch: string }).ch)
      i += 1
    }
    html += `<span class="hero-scramble-text hero-role-revealed">${run}</span>`
  }
  return html
}

function pickScrambleCell(set: ScrambleSet, color?: string): ScrambleCell {
  if (set.icons && set.icons.length > 0) {
    return { kind: 'icon', html: set.icons[Math.floor(Math.random() * set.icons.length)]! }
  }
  return {
    kind: 'char',
    ch: pickChar(set.chars),
    color: color ?? pickPaletteColor(),
  }
}

function pickPaletteColor(except?: string): string {
  const pool =
    except === undefined
      ? SCRAMBLE_PALETTE
      : SCRAMBLE_PALETTE.filter((color) => color !== except)
  return pool[Math.floor(Math.random() * pool.length)] ?? SCRAMBLE_PALETTE[0]
}

/** Deal `count` values from shuffled decks so neighbors never match. */
function dealDistinct(items: readonly string[], count: number): string[] {
  const out: string[] = []
  let deck: string[] = []
  while (out.length < count) {
    if (deck.length === 0) {
      deck = shuffle(items)
      const prev = out[out.length - 1]
      if (prev !== undefined && deck[0] === prev && deck.length > 1) {
        const swap = deck.findIndex((item) => item !== prev)
        if (swap > 0) {
          const a = deck[0]!
          deck[0] = deck[swap]!
          deck[swap] = a
        }
      }
    }
    const next = deck.shift()!
    const prev = out[out.length - 1]
    if (prev === next && items.length > 1) {
      const alt = deck.find((item) => item !== prev) ?? items.find((item) => item !== prev)
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

function fillIconCells(length: number, icons: readonly string[]): ScrambleCell[] {
  if (length <= 0 || icons.length === 0) return []
  const count = Math.min(DESIGN_VISIBLE, length, icons.length)
  return shuffle(icons)
    .slice(0, count)
    .map((html) => ({ kind: 'icon' as const, html }))
}

export function fillScrambleCells(length: number, set: ScrambleSet): ScrambleCell[] {
  if (length <= 0) return []
  const icons = set.icons
  if (icons && icons.length > 0) return fillIconCells(length, icons)
  const colors = dealDistinct(SCRAMBLE_PALETTE, length)
  return Array.from({ length }, (_, i) => pickScrambleCell(set, colors[i]))
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
  return { kind: 'scramble', ch: cell.ch, color: cell.color }
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
  let slots = fillScrambleCells(
    set.icons && set.icons.length > 0
      ? Math.min(DESIGN_VISIBLE, maxLen, set.icons.length)
      : maxLen,
    set,
  )
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
        if (set.icons && set.icons.length > 0) {
          const n = Math.min(DESIGN_VISIBLE, len, set.icons.length)
          if (slots.length !== n) slots = fillScrambleCells(n, set)
          else slots = rotateScrambleIcons(slots, 1)
        } else {
          slots = fillScrambleCells(len, set)
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
          const cell = slots[i]
          if (cell) glyphs.push(cellToGlyph(cell))
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
