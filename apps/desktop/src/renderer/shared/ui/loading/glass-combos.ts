// ──────────────────────────────────────────────────────────
// Glass combos — the transcript's agent square in soft glass colours
// ──────────────────────────────────────────────────────────
//
// Only the glass square uses these (glass-square.tsx: the active turn's rail
// and running tool and subagent rows); chat tabs (agent tones) and workspace
// squares keep their own colours. This module is colour only.
//
// A combo is a soft mesh of four to six colours: one gradient runs them one
// way across the square and a second crosses it with them reversed at half
// strength, so they blend in both directions. Every colour is kept lighter
// than pastel (mostly white on dark, mostly a dark grey on light), lit a touch
// from the top, and finished like glass with a sheen and a faint glow, so no
// tile reads as a flat block.
//
// Each square starts on a random combo and brings in another every few
// seconds, never by crossfading: the moving tiles carry the new one in, and a
// glint crosses the square as it arrives.
// ──────────────────────────────────────────────────────────

export interface GlassCombo {
  name: string;
  colors: readonly string[];
}

export const GLASS_COMBOS: readonly GlassCombo[] = [
  { name: "Opal", colors: ["#F27BC4", "#A78BF0", "#4FB3E6", "#5ED6A8", "#F2D14B"] }, // check:ui ignore-line (loader combo palette)
  { name: "Aurora", colors: ["#5ED6A8", "#1FA89A", "#4FB3E6", "#8A55D8", "#EB6FB6"] }, // check:ui ignore-line (loader combo palette)
  { name: "Sunrise", colors: ["#F07A5A", "#F6B37A", "#F2D14B", "#EB6FB6"] }, // check:ui ignore-line (loader combo palette)
  { name: "Lagoon", colors: ["#56CFE1", "#4FB3E6", "#7B8CF0", "#5ED6A8"] }, // check:ui ignore-line (loader combo palette)
  { name: "Prism", colors: ["#E8413C", "#F07F3C", "#F2D14B", "#47A35A", "#3C6BE0", "#8A55D8"] }, // check:ui ignore-line (loader combo palette)
  { name: "Sorbet", colors: ["#F27BC4", "#F07A5A", "#F6B37A", "#F2D14B"] }, // check:ui ignore-line (loader combo palette)
  { name: "Nebula", colors: ["#8A55D8", "#D6418F", "#4FB3E6", "#1FA89A"] }, // check:ui ignore-line (loader combo palette)
  { name: "Meadow", colors: ["#B9E25A", "#5ED6A8", "#4FB3E6", "#F2D14B"] }, // check:ui ignore-line (loader combo palette)
  { name: "Dusk", colors: ["#7B8CF0", "#8A55D8", "#EB6FB6", "#F6B37A"] }, // check:ui ignore-line (loader combo palette)
  { name: "Sea glass", colors: ["#56CFE1", "#5ED6A8", "#B9E25A", "#4FB3E6"] }, // check:ui ignore-line (loader combo palette)
  { name: "Candy", colors: ["#4FB3E6", "#F27BC4", "#F2D14B", "#A78BF0"] }, // check:ui ignore-line (loader combo palette)
  { name: "Tropic", colors: ["#1FA89A", "#B9E25A", "#F2D14B", "#F07A5A"] }, // check:ui ignore-line (loader combo palette)
  { name: "Iris", colors: ["#3C6BE0", "#8A55D8", "#F27BC4", "#56CFE1"] }, // check:ui ignore-line (loader combo palette)
  { name: "Pearl", colors: ["#F2D14B", "#F6B37A", "#F27BC4", "#A78BF0", "#4FB3E6"] }, // check:ui ignore-line (loader combo palette)
];

/** The most colours a combo has: every gradient renders this many stops. */
export const GLASS_COMBO_STOPS = 6;
/** How long a combo shows before the square brings in the next. */
export const GLASS_COMBO_MS = 5000;
/** The crossing gradient sits at half strength over the first. */
export const GLASS_COMBO_CROSS_OPACITY = 0.5;

/** Directions a combo can run, as end points [x1, y1, x2, y2] across the
 *  square (0–1), each with the direction its reversed twin crosses it. */
export const GLASS_COMBO_FLOWS: ReadonlyArray<{
  run: readonly [number, number, number, number];
  cross: readonly [number, number, number, number];
}> = [
  { run: [0, 0, 1, 1], cross: [1, 0, 0, 1] },
  { run: [1, 0, 0, 1], cross: [0, 0, 1, 1] },
  { run: [0, 0.5, 1, 0.5], cross: [0.5, 0, 0.5, 1] },
  { run: [1, 0.5, 0, 0.5], cross: [0.5, 1, 0.5, 0] },
];

/** Lighter than pastel: a colour keeps only a breath of its hue, mixed into
 *  white on dark and into a dark grey on light. */
export function glassTint(color: string): string {
  return `color-mix(in oklab, ${color} 30%, light-dark(#3b3b3b, #ffffff))`; // check:ui ignore-line (loader combo tint base per theme)
}

/** The soft light from the top: a touch lighter above, a touch deeper below. */
export const GLASS_LIGHT: ReadonlyArray<readonly [number, string]> = [
  [0, "light-dark(rgb(255 255 255 / 0.12), rgb(255 255 255 / 0.4))"], // check:ui ignore-line (loader glass light)
  [0.5, "rgb(255 255 255 / 0)"], // check:ui ignore-line (loader glass light)
  [1, "light-dark(rgb(0 0 0 / 0.18), rgb(0 0 0 / 0.1))"], // check:ui ignore-line (loader glass shade)
];

/** The glass sheen: a diagonal highlight with a softer second reflection. */
export const GLASS_SHEEN: ReadonlyArray<readonly [number, string]> = [
  [0, "rgb(255 255 255 / 0)"], // check:ui ignore-line (loader glass sheen)
  [0.22, "light-dark(rgb(255 255 255 / 0.2), rgb(255 255 255 / 0.34))"], // check:ui ignore-line (loader glass sheen)
  [0.4, "rgb(255 255 255 / 0)"], // check:ui ignore-line (loader glass sheen)
  [0.6, "rgb(255 255 255 / 0)"], // check:ui ignore-line (loader glass sheen)
  [0.7, "light-dark(rgb(255 255 255 / 0.08), rgb(255 255 255 / 0.14))"], // check:ui ignore-line (loader glass sheen)
  [0.8, "rgb(255 255 255 / 0)"], // check:ui ignore-line (loader glass sheen)
];

/** The glint that crosses the square as a new combo arrives: one bright
 *  diagonal band, gone either side. */
export const GLASS_GLINT: ReadonlyArray<readonly [number, string]> = [
  [0, "rgb(255 255 255 / 0)"], // check:ui ignore-line (loader glass glint)
  [0.38, "rgb(255 255 255 / 0)"], // check:ui ignore-line (loader glass glint)
  [0.5, "light-dark(rgb(255 255 255 / 0.45), rgb(255 255 255 / 0.75))"], // check:ui ignore-line (loader glass glint)
  [0.62, "rgb(255 255 255 / 0)"], // check:ui ignore-line (loader glass glint)
  [1, "rgb(255 255 255 / 0)"], // check:ui ignore-line (loader glass glint)
];

/** The glow around the tiles, in the combo's own colours: its blur (a share
 *  of the square's side) and strength. Barely there on light. */
export const GLASS_GLOW = {
  dark: { blur: 0.05, strength: 0.5 },
  light: { blur: 0.04, strength: 0.22 },
} as const;

/** A random combo other than the one showing. */
export function pickGlassCombo(
  previous: GlassCombo | null,
  random: () => number = Math.random,
): GlassCombo {
  const pool = GLASS_COMBOS.filter((combo) => combo !== previous);
  return pool[Math.floor(random() * pool.length)];
}

/** A combo's stops, top-aligned to GLASS_COMBO_STOPS: shorter combos hold
 *  their last colour to the end. */
export function glassComboStops(
  combo: GlassCombo,
  reversed = false,
): Array<{ offset: number; color: string }> {
  const colors = reversed ? [...combo.colors].reverse() : combo.colors;
  return Array.from({ length: GLASS_COMBO_STOPS }, (_, i) => {
    const at = Math.min(i, colors.length - 1);
    return {
      offset: at / (colors.length - 1),
      color: glassTint(colors[at]),
    };
  });
}

/** One layer's combo and the way its colours run (GLASS_COMBO_FLOWS). */
export interface GlassComboLayer {
  combo: GlassCombo;
  flow: number;
}

/** A layer on a random combo other than `previous`, running a random way. */
export function glassComboLayer(
  previous: GlassCombo | null,
  random: () => number = Math.random,
): GlassComboLayer {
  return {
    combo: pickGlassCombo(previous, random),
    flow: Math.floor(random() * GLASS_COMBO_FLOWS.length),
  };
}
