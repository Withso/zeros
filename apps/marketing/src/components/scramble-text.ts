import gsap from 'gsap'

export const SCRAMBLE_MS = 1200

const ICON = (d: string) =>
  `<svg class="hero-scramble-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="${d}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`

/** Code-tool marks mixed into builders → developers. */
export const CODE_ICONS = [
  ICON('M5 3L1 8l4 5M11 3l4 5-4 5'),
  ICON('M5 2v12M2 5h5M9 2v12M14 11H9'),
  ICON('M3 4h10v8H3zM5 11h2'),
  ICON('M2 3h12M2 8h7M2 13h10'),
] as const

/** Layout / frame / component marks mixed into developers → designers. */
export const DESIGN_ICONS = [
  ICON('M2 3h12M2 8h8M2 13h10'),
  ICON('M3 3h10v10H3z'),
  ICON('M8 1.8l1.7 1.7L8 5.2 6.3 3.5zM12.8 6.3l1.7 1.7-1.7 1.7-1.7-1.7zM8 10.8l1.7 1.7L8 14.2 6.3 12.5zM3.2 6.3L4.9 8 3.2 9.7 1.5 8z'),
  ICON('M4 2v12M8 2v12M12 2v12'),
  ICON('M3 4h10M8 4v8M3 12h10'),
  ICON('M2 4h5v3H2zM9 9h5v3H9z'),
] as const

export type ScrambleSet = {
  chars: string
  tokens: string[]
  icons: readonly string[]
}

/** builders → developers */
export const CODE_SCRAMBLE: ScrambleSet = {
  chars: '{}[]</>;:=()*&|#$@!?\\^~`01x',
  tokens: ['fn', 'git', 'const', 'async', 'await', '=>', '</>', 'npm', 'cli', 'src', 'tsx', 'import'],
  icons: CODE_ICONS,
}

/** developers → designers */
export const DESIGN_SCRAMBLE: ScrambleSet = {
  chars: '#[]|=+*·',
  tokens: ['align', 'frame', 'design', 'components', 'auto', 'layer', 'stack', 'grid', 'layout'],
  icons: DESIGN_ICONS,
}

/** designers → builders */
export const MATRIX_SCRAMBLE: ScrambleSet = {
  chars: '01ﾊﾐﾋｰｳｼﾅﾓﾆｻﾜﾂｵﾘｴｱﾎﾃﾏｹﾒ23456789',
  tokens: ['01', '10', '11'],
  icons: [],
}

export const SCRAMBLE_FROM: Record<string, ScrambleSet> = {
  builders: CODE_SCRAMBLE,
  developers: DESIGN_SCRAMBLE,
  designers: MATRIX_SCRAMBLE,
}

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

/**
 * Random glyphs of a fixed length, with occasional related tokens
 * dropped in as consecutive characters (ScrambleTextPlugin `chars`
 * cannot hold multi-character words on their own).
 */
export function scrambleFill(length: number, chars: string, tokens: string[]): string {
  if (length <= 0) return ''
  const out = Array.from({ length }, () => pickChar(chars))
  placeToken(out, tokens)
  return out.join('')
}

function placeToken(out: string[], tokens: string[]): void {
  const usable = tokens.filter((token) => token.length <= out.length)
  if (usable.length === 0) return
  if (Math.random() > 0.72) return
  const token = pick(usable)
  const start = Math.floor(Math.random() * (out.length - token.length + 1))
  for (let i = 0; i < token.length; i += 1) out[start + i] = token[i]
}

/** HTML tail: icon glyphs mixed with chars/tokens. Each slot is one unit. */
export function scrambleTail(
  length: number,
  set: ScrambleSet,
  { allowTokens = true }: { allowTokens?: boolean } = {},
): string {
  if (length <= 0) return ''
  const slots: string[] = Array.from({ length }, () => {
    if (set.icons.length > 0 && Math.random() < 0.32) return pick(set.icons)
    return escapeHtml(pickChar(set.chars))
  })
  if (allowTokens) {
    const usable = set.tokens.filter((token) => token.length <= length)
    if (usable.length > 0) {
      const token = pick(usable)
      const start = Math.floor(Math.random() * (length - token.length + 1))
      for (let i = 0; i < token.length; i += 1) slots[start + i] = escapeHtml(token[i])
    }
  }
  return slots.join('')
}

/**
 * ScrambleText-style decode: random glyphs, then left-to-right reveal.
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
    revealDelay = 0.45,
    speed = 1.2,
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
  const refreshMs = Math.max(24, 62 / speed)
  let lastRefresh = -Infinity
  let lastRevealed = -1
  let tail = ''
  const state = { t: 0 }

  return gsap.to(state, {
    t: 1,
    duration,
    ease: 'none',
    onUpdate: () => {
      const elapsed = state.t * duration
      const revealWindow = Math.max(0.001, duration - revealDelay)
      const revealT = elapsed <= revealDelay ? 0 : (elapsed - revealDelay) / revealWindow
      const len = Math.max(1, Math.round(startLen + (endLen - startLen) * state.t))
      const revealed = Math.min(endLen, Math.floor(endLen * revealT))
      const now = performance.now()
      if (revealed !== lastRevealed || now - lastRefresh >= refreshMs) {
        lastRefresh = now
        lastRevealed = revealed
        tail = scrambleTail(Math.max(0, len - revealed), set, {
          allowTokens: revealed === 0,
        })
      }
      const revealedText = escapeHtml(text.slice(0, revealed))
      el.innerHTML =
        revealed > 0
          ? `<span class="hero-role-revealed">${revealedText}</span>${tail}`
          : tail
    },
    onComplete: () => {
      el.textContent = text
    },
  })
}
