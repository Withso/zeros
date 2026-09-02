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
  'pentagon',
  'tangent',
  'align-horizontal-space-around',
  'palette',
  'panels-top-left',
] as const

export type DesignMark = (typeof DESIGN_MARKS)[number]

/**
 * developers → designers: compact unique Lucide marks while scrambling.
 * Code and matrix still follow word length. After the compact row, this
 * pass still left-to-right decodes `designers`.
 */
export const DESIGN_VISIBLE = 6

const ICON_COLORS = [
  SCRAMBLE_PALETTE[0],
  SCRAMBLE_PALETTE[1],
  SCRAMBLE_PALETTE[2],
  SCRAMBLE_PALETTE[3],
  SCRAMBLE_PALETTE[4],
  SCRAMBLE_PALETTE[5],
] as const

const lucide = (
  name: string,
  color: string,
  inner: string,
  kind: 'tool' | 'key' = 'tool',
) =>
  `<svg class="hero-scramble-icon${kind === 'key' ? ' is-key' : ''}" data-hero-scramble-icon="${name}" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="${kind === 'key' ? '1.75' : '2'}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${inner}</svg>`

/**
 * Lucide design marks (ISC, same drawings as lucide-react).
 * One hardcoded hue each; marketing scramble is allowed off tokens.
 */
export const DESIGN_ICONS = [
  lucide(
    'frame',
    ICON_COLORS[0],
    '<line x1="22" x2="2" y1="6" y2="6"/><line x1="22" x2="2" y1="18" y2="18"/><line x1="6" x2="6" y1="2" y2="22"/><line x1="18" x2="18" y1="2" y2="22"/>',
  ),
  lucide(
    'pentagon',
    ICON_COLORS[1],
    '<path d="M10.83 2.38a2 2 0 0 1 2.34 0l8 5.74a2 2 0 0 1 .73 2.25l-3.04 9.26a2 2 0 0 1-1.9 1.37H7.04a2 2 0 0 1-1.9-1.37L2.1 10.37a2 2 0 0 1 .73-2.25z"/>',
  ),
  lucide(
    'tangent',
    ICON_COLORS[2],
    '<circle cx="17" cy="4" r="2"/><path d="M15.59 5.41 5.41 15.59"/><circle cx="4" cy="17" r="2"/><path d="M12 22s-4-9-1.5-11.5S22 12 22 12"/>',
  ),
  lucide(
    'align-horizontal-space-around',
    ICON_COLORS[3],
    '<rect width="6" height="10" x="9" y="7" rx="2"/><path d="M4 22V2"/><path d="M20 22V2"/>',
  ),
  lucide(
    'palette',
    ICON_COLORS[4],
    `<circle cx="13.5" cy="6.5" r=".5" fill="${ICON_COLORS[4]}"/><circle cx="17.5" cy="10.5" r=".5" fill="${ICON_COLORS[4]}"/><circle cx="8.5" cy="7.5" r=".5" fill="${ICON_COLORS[4]}"/><circle cx="6.5" cy="12.5" r=".5" fill="${ICON_COLORS[4]}"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/>`,
  ),
  lucide(
    'panels-top-left',
    ICON_COLORS[5],
    '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/><path d="M9 21V9"/>',
  ),
] as const

export const KEYBOARD_MARKS = [
  'shift',
  'control',
  'option',
  'command',
  'key-c',
  'key-v',
  'enter',
  'delete',
] as const

export type KeyboardMark = (typeof KEYBOARD_MARKS)[number]

const KEY_MUTED = SCRAMBLE_PALETTE[7]
const KEY_COOL = SCRAMBLE_PALETTE[6]

/**
 * Quiet keyboard layer (Lucide + simple C/V strokes). Same six slots;
 * these recede beside the design marks.
 */
export const KEYBOARD_ICONS = [
  lucide('shift', KEY_MUTED, '<path d="M9 18v-6H5l7-7 7 7h-4v6H9z"/>', 'key'),
  lucide('control', KEY_MUTED, '<path d="m18 15-6-6-6 6"/>', 'key'),
  lucide(
    'option',
    KEY_MUTED,
    '<path d="M3 3h6l6 18h6"/><path d="M14 3h7"/>',
    'key',
  ),
  lucide(
    'command',
    KEY_MUTED,
    '<path d="M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3"/>',
    'key',
  ),
  lucide('key-c', KEY_COOL, '<path d="M16.8 7.4a5.8 5.8 0 1 0 0 9.2"/>', 'key'),
  lucide('key-v', KEY_COOL, '<path d="M7 7.2 12 16.8 17 7.2"/>', 'key'),
  lucide(
    'enter',
    KEY_MUTED,
    '<polyline points="9 10 4 15 9 20"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/>',
    'key',
  ),
  lucide(
    'delete',
    KEY_MUTED,
    '<path d="M10 5a2 2 0 0 0-1.344.519l-6.328 5.74a1 1 0 0 0 0 1.481l6.328 5.741A2 2 0 0 0 10 19h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2z"/><path d="m12 9 6 6"/><path d="m18 9-6 6"/>',
    'key',
  ),
] as const

/** Six-slot designers pass: design marks plus the keyboard layer. */
export const DESIGN_SCRAMBLE_ICONS = [...DESIGN_ICONS, ...KEYBOARD_ICONS]

export type ScrambleSet = {
  chars: string
  icons?: readonly string[]
}

/** builders → developers */
export const CODE_SCRAMBLE: ScrambleSet = {
  chars: '{}[]</>;:=()*&|#$@!?\\^~`01',
}

/** developers → designers — six unique slots; design marks plus keyboard layer. */
export const DESIGN_SCRAMBLE: ScrambleSet = {
  chars: '',
  icons: DESIGN_SCRAMBLE_ICONS,
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

function mixLayeredIconCells(count: number): ScrambleCell[] {
  const keySlots = Math.min(2, KEYBOARD_ICONS.length, Math.max(0, count - 3))
  const designSlots = Math.min(count - keySlots, DESIGN_ICONS.length)
  const design = shuffle([...DESIGN_ICONS]).slice(0, designSlots)
  const keys = shuffle([...KEYBOARD_ICONS]).slice(0, keySlots)
  return shuffle([...design, ...keys]).map((html) => ({ kind: 'icon' as const, html }))
}

function fillIconCells(length: number, icons: readonly string[]): ScrambleCell[] {
  if (length <= 0 || icons.length === 0) return []
  const count = Math.min(DESIGN_VISIBLE, length, icons.length)
  if (icons === DESIGN_SCRAMBLE_ICONS) return mixLayeredIconCells(count)
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

function sineInOut(t: number): number {
  return 0.5 - Math.cos(Math.PI * Math.min(1, Math.max(0, t))) / 2
}

function cellToGlyph(cell: ScrambleCell): Glyph {
  if (cell.kind === 'icon') return { kind: 'icon', html: cell.html }
  return { kind: 'scramble', ch: cell.ch, color: cell.color }
}

export function isIconScramble(set: ScrambleSet): boolean {
  return iconScrambleCount(set) > 0
}

function iconScrambleCount(set: ScrambleSet): number {
  const icons = set.icons
  if (!icons || icons.length === 0) return 0
  return Math.min(DESIGN_VISIBLE, icons.length)
}

/**
 * Icon pass: hold a compact unique row, then lock `to` left-to-right.
 * Unrevealed letters stay icons, never leftover `from` text.
 */
export function iconDecodeKind(
  i: number,
  t: number,
  count: number,
): 'scramble' | 'to' {
  const n = Math.max(1, count)
  const hold = 0.4
  if (t <= hold) return 'scramble'
  const lock = hold + (i / n) * 0.58
  return t >= lock ? 'to' : 'scramble'
}

function iconRevealCounts(
  to: string,
  t: number,
  iconCount: number,
): { revealed: number; icons: number } {
  const visualT = sineInOut(Math.min(1, Math.max(0, t)))
  const n = Math.max(1, to.length)
  let revealed = 0
  let scramble = 0
  for (let i = 0; i < to.length; i += 1) {
    if (iconDecodeKind(i, visualT, n) === 'to') revealed += 1
    else scramble += 1
  }
  return { revealed, icons: Math.min(iconCount, scramble) }
}

/** Slot count for one scramble frame. Icon passes stay compact until decode. */
export function scrambleSlotCount(
  from: string,
  to: string,
  t: number,
  set: ScrambleSet,
): number {
  const icons = iconScrambleCount(set)
  if (icons > 0) {
    const plan = iconRevealCounts(to, t, icons)
    const count = plan.revealed + plan.icons
    return count > 0 ? count : icons
  }
  const visualT = sineInOut(Math.min(1, Math.max(0, t)))
  const startLen = Math.max(1, from.length)
  const endLen = to.length
  return Math.max(1, Math.round(startLen + (endLen - startLen) * visualT))
}

/** One decode frame. Icon passes: compact marks, then left-to-right `to`. */
export function buildScrambleGlyphs(
  from: string,
  to: string,
  t: number,
  set: ScrambleSet,
  slots: ScrambleCell[],
): Glyph[] {
  const iconCount = iconScrambleCount(set)
  if (iconCount > 0) {
    const plan = iconRevealCounts(to, t, iconCount)
    const glyphs: Glyph[] = []
    for (let i = 0; i < plan.revealed; i += 1) {
      glyphs.push({ kind: 'to', ch: to[i]! })
    }
    for (let i = 0; i < plan.icons; i += 1) {
      const cell = slots[i]
      if (cell) glyphs.push(cellToGlyph(cell))
    }
    return glyphs
  }

  const visualT = sineInOut(Math.min(1, Math.max(0, t)))
  const startLen = Math.max(1, from.length)
  const endLen = to.length
  const maxLen = Math.max(startLen, endLen)
  const len = scrambleSlotCount(from, to, t, set)
  const glyphs: Glyph[] = []
  for (let i = 0; i < len; i += 1) {
    const kind = scrambleGlyphKind(i, visualT, maxLen)
    if (kind === 'from' && i < from.length) {
      glyphs.push({ kind: 'from', ch: from[i]! })
    } else if (kind === 'to' && i < to.length) {
      glyphs.push({ kind: 'to', ch: to[i]! })
    } else {
      glyphs.push(cellToGlyph(slots[i] ?? pickScrambleCell(set)))
    }
  }
  return glyphs
}

/** HTML tail of scramble glyphs. Each slot is one character or icon. */
export function scrambleTail(length: number, set: ScrambleSet): string {
  if (length <= 0) return ''
  return renderGlyphRun(fillScrambleCells(length, set).map(cellToGlyph))
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
  const iconCount = iconScrambleCount(set)
  const startLen = Math.max(1, from.length)
  const endLen = text.length
  const refreshMs = Math.max(28, 40 / Math.max(0.4, speed))
  let slots = fillScrambleCells(
    iconCount > 0 ? iconCount : Math.max(startLen, endLen),
    set,
  )
  let lastRefresh = -Infinity
  let lastHtml = ''
  const state = { t: 0 }
  let iconTick = 0

  return gsap.to(state, {
    t: 1,
    duration,
    ease: 'none',
    onUpdate: () => {
      const now = performance.now()
      if (now - lastRefresh >= refreshMs) {
        lastRefresh = now
        if (iconCount > 0) {
          iconTick += 1
          if (slots.length !== iconCount || iconTick % 4 === 0) {
            slots = fillScrambleCells(iconCount, set)
          } else {
            slots = rotateScrambleIcons(slots, 1)
          }
        } else {
          slots = fillScrambleCells(scrambleSlotCount(from, text, state.t, set), set)
        }
      }
      const html = renderGlyphRun(
        buildScrambleGlyphs(from, text, state.t, set, slots),
      )
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
