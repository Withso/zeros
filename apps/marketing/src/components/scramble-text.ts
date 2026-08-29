import gsap from 'gsap'

export const SCRAMBLE_MS = 1500

const svg = (inner: string) =>
  `<svg class="hero-scramble-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">${inner}</svg>`

const stroke = (d: string) =>
  `<path d="${d}" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/>`

/**
 * Figma-adjacent marks for developers → designers.
 * Sized in CSS at the hero em so they sit with the type, not as tiny chips.
 */
export const DESIGN_ICONS = [
  svg(stroke('M2 2.5v11 M5.2 4h9 M5.2 8h6.2 M5.2 12h9')),
  svg(stroke('M8 2v12 M3.2 5h9.6 M5 8h6 M3.2 11h9.6')),
  svg(stroke('M3 2.5h10 M3 13.5h10 M5.2 6h5.6v4H5.2z')),
  svg(stroke('M3.4 3.4h9.2v9.2H3.4z')),
  svg(
    `${stroke('M8 1.7l1.8 1.8L8 5.3 6.2 3.5z')}${stroke('M12.5 6.2l1.8 1.8-1.8 1.8-1.8-1.8z')}${stroke('M8 10.7l1.8 1.8L8 14.3 6.2 12.5z')}${stroke('M3.5 6.2L5.3 8 3.5 9.8 1.7 8z')}`,
  ),
  svg(stroke('M2.2 4.2h5v7.6h-5z M8.8 4.2h5v7.6h-5z')),
  svg(stroke('M3.4 13.1l2.1-.7 7-7.1-1.5-1.5-7.1 7z M11.2 3.6l1.6 1.6')),
  svg(stroke('M2.6 13.4V6.4A3.8 3.8 0 0 1 6.4 2.6h7')),
] as const

/** Short Figma vocabulary. Flickers in the decode; never a locked long layer name. */
export const DESIGN_TOKENS = ['auto', 'hug', 'fill', 'gap', 'var', 'align', '8px'] as const

export type ScrambleSet = {
  chars: string
  tokens?: readonly string[]
  icons?: readonly string[]
}

/** builders → developers */
export const CODE_SCRAMBLE: ScrambleSet = {
  chars: '{}[]</>;:=()*&|#$@!?\\^~`01',
}

/** developers → designers */
export const DESIGN_SCRAMBLE: ScrambleSet = {
  chars: '#[]|=+*·',
  tokens: DESIGN_TOKENS,
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

export type GlyphKind = 'from' | 'scramble' | 'to' | 'token' | 'icon'

export type Glyph =
  | { kind: 'from' | 'to' | 'scramble' | 'token'; ch: string }
  | { kind: 'icon'; html: string }

type ScrambleCell =
  | { kind: 'char'; ch: string }
  | { kind: 'token'; ch: string }
  | { kind: 'icon'; html: string }

function pickChar(chars: string): string {
  return chars[Math.floor(Math.random() * chars.length)] ?? '0'
}

function pick<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)] as T
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
      let run = ''
      while (i < glyphs.length && glyphs[i]!.kind === 'icon') {
        run += (glyphs[i] as { html: string }).html
        i += 1
      }
      html += run
      continue
    }
    const { kind } = glyph
    let run = ''
    while (i < glyphs.length && glyphs[i]!.kind === kind) {
      run += escapeHtml((glyphs[i] as { ch: string }).ch)
      i += 1
    }
    const cls =
      kind === 'scramble'
        ? 'hero-scramble-symbol'
        : kind === 'token'
          ? 'hero-scramble-token'
          : 'hero-scramble-text hero-role-revealed'
    html += `<span class="${cls}">${run}</span>`
  }
  return html
}

function pickScrambleCell(set: ScrambleSet): ScrambleCell {
  if (set.icons && set.icons.length > 0 && Math.random() < 0.42) {
    return { kind: 'icon', html: pick(set.icons) }
  }
  return { kind: 'char', ch: pickChar(set.chars) }
}

export function fillScrambleCells(length: number, set: ScrambleSet): ScrambleCell[] {
  if (length <= 0) return []
  const cells = Array.from({ length }, () => pickScrambleCell(set))
  const tokens = (set.tokens ?? []).filter((token) => token.length <= length)
  if (tokens.length === 0 || Math.random() > 0.62) return cells
  const token = pick(tokens)
  const start = Math.floor(Math.random() * (length - token.length + 1))
  for (let i = 0; i < token.length; i += 1) {
    cells[start + i] = { kind: 'token', ch: token[i]! }
  }
  return cells
}

function cellToGlyph(cell: ScrambleCell): Glyph {
  if (cell.kind === 'icon') return { kind: 'icon', html: cell.html }
  if (cell.kind === 'token') return { kind: 'token', ch: cell.ch }
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
          if (scrambleGlyphKind(i, visualT, maxLen) === 'scramble' && Math.random() < 0.42) {
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
