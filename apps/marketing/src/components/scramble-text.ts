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
  'arrow',
  'bars',
  'layout',
  'swatch',
  'sync',
  'media',
  'select',
  'crop',
] as const

export type DesignMark = (typeof DESIGN_MARKS)[number]

const mark = (name: DesignMark, inner: string) =>
  `<svg class="hero-scramble-icon" data-hero-scramble-icon="${name}" viewBox="0 0 16 16" aria-hidden="true" focusable="false">${inner}</svg>`

/**
 * Eight unique filled marks, one hue family each. Hardcoded on purpose:
 * the marketing scramble is allowed to leave Neutral Dark tokens.
 */
export const DESIGN_ICONS = [
  mark(
    'arrow',
    '<rect x="0.7" y="6.15" width="5.3" height="3.7" rx="1.85" fill="#246048"/><path d="M7.2 3.15c.18-1.02 1.52-1.18 2.18-.4l5.2 4.42c.72.6.72 1.66 0 2.26l-5.2 4.42c-.66.78-2 .62-2.18-.4V3.15Z" fill="#68E098"/>',
  ),
  mark(
    'bars',
    '<rect x="1.6" y="2.15" width="12.6" height="2.7" rx="1.35" fill="#F0C840"/><rect x="1.6" y="6.65" width="7.4" height="2.7" rx="1.35" fill="#B49030"/><rect x="1.6" y="11.15" width="10.2" height="2.7" rx="1.35" fill="#6C5418"/>',
  ),
  mark(
    'layout',
    '<rect x="1.45" y="1.45" width="7.5" height="7.5" rx="1.7" fill="#E87038"/><rect x="9.7" y="1.45" width="4.85" height="7.5" rx="1.7" fill="#B44830"/><rect x="1.45" y="9.8" width="13.1" height="4.75" rx="1.7" fill="#6C3024"/>',
  ),
  mark(
    'swatch',
    '<rect x="8.35" y="1.7" width="5.1" height="12.1" rx="2.4" transform="rotate(18 10.9 7.75)" fill="#601818"/><rect x="6.55" y="1.55" width="5.1" height="12.1" rx="2.4" transform="rotate(8 9.1 7.6)" fill="#C04040"/><rect x="2.35" y="1.55" width="5.35" height="12.3" rx="2.5" fill="#E84848"/><circle cx="5.05" cy="11.55" r="1.2" fill="#121212"/>',
  ),
  mark(
    'sync',
    '<rect x="1.15" y="1.2" width="5.15" height="5.15" rx="1.45" fill="#E840A8"/><rect x="9.7" y="9.65" width="5.15" height="5.15" rx="1.45" fill="#E840A8"/><path d="M7.7 2.35h2.55c2.55 0 4.35 2.05 4.35 4.85" fill="none" stroke="#842460" stroke-width="2.45" stroke-linecap="round"/><path d="M8.3 13.65H5.75c-2.55 0-4.35-2.05-4.35-4.85" fill="none" stroke="#842460" stroke-width="2.45" stroke-linecap="round"/>',
  ),
  mark(
    'media',
    '<circle cx="4.15" cy="3.85" r="1.65" fill="#54186C"/><rect x="2.2" y="6.15" width="4.35" height="4.35" rx="1.2" fill="#54186C"/><path d="M6.05 13.55h8.05L10.35 3.7Z" fill="#B838F0"/>',
  ),
  mark(
    'select',
    '<rect x="1.2" y="1.2" width="5.35" height="5.35" rx="1.45" fill="#3888F0"/><rect x="9.45" y="1.2" width="5.35" height="5.35" rx="1.45" fill="#2460B4"/><rect x="1.2" y="9.45" width="5.35" height="5.35" rx="1.45" fill="#183C6C"/><path d="M9.15 14.45V8.55l5.55 5.35Z" fill="#5AA8FF"/>',
  ),
  mark(
    'crop',
    '<path d="M2.15 2.2h8.7c.8 0 1.4.6 1.4 1.4s-.6 1.4-1.4 1.4H4.95v8.45c0 .8-.6 1.4-1.4 1.4s-1.4-.6-1.4-1.4V2.2Z" fill="#E8E8E8"/><path d="M13.85 13.8H5.15c-.8 0-1.4-.6-1.4-1.4s.6-1.4 1.4-1.4h6.9V3.55c0-.8.6-1.4 1.4-1.4s1.4.6 1.4 1.4v10.25Z" fill="#808088"/>',
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

/** developers → designers — sparse unique marks, not a repeated strip. */
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

function designIconCount(length: number, catalog: number): number {
  if (length <= 0 || catalog <= 0) return 0
  return Math.min(4, catalog, Math.max(1, Math.round(length * 0.36)))
}

export function fillScrambleCells(length: number, set: ScrambleSet): ScrambleCell[] {
  if (length <= 0) return []
  const colors = dealDistinct(SCRAMBLE_PALETTE, length)
  const icons = set.icons
  if (!icons || icons.length === 0) {
    return Array.from({ length }, (_, i) => pickScrambleCell(set, colors[i]))
  }

  const iconCount = designIconCount(length, icons.length)
  const uniqueIcons = shuffle(icons).slice(0, iconCount)
  const iconAt = new Set(
    shuffle(Array.from({ length }, (_, i) => i)).slice(0, uniqueIcons.length),
  )
  const cells: ScrambleCell[] = []
  let k = 0
  for (let i = 0; i < length; i += 1) {
    if (iconAt.has(i)) {
      cells.push({ kind: 'icon', html: uniqueIcons[k]! })
      k += 1
      continue
    }
    cells.push(pickScrambleCell(set, colors[i]))
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
