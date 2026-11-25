// ──────────────────────────────────────────────────────────
// Glass fade — the transcript's agent square, in the text tiers
// ──────────────────────────────────────────────────────────
//
// Only the glass square uses this (glass-square.tsx: the active turn's rail
// and running tool and subagent rows); chat tabs (agent tones) and workspace
// squares keep their own colours.
//
// 2026-11-25: the square paints one fade, fg1 at the top to fg3 at the bottom,
// the same fade the startup Island Z draws, so the agent at work reads in the
// app's own greys. The fourteen off-palette colour combos are gone.
//
// The motion model still runs two layers that take turns going live
// (glass-motion.ts): a tile wrapping round an edge moves into the live layer.
// Both layers paint the same fade, so a turn changes nothing on screen; the
// layers only keep the model's bookkeeping, which its tests pin.
// ──────────────────────────────────────────────────────────

/** The fade every tile shows, top to bottom of the square. */
export const GLASS_FADE: ReadonlyArray<readonly [number, string]> = [
  [0, "var(--fg1)"],
  [1, "var(--fg3)"],
];

/** How long a layer stays live before the other one takes over. */
export const GLASS_COMBO_MS = 5000;

/** A layer's generation: each new live layer counts one up. */
export type GlassCombo = number;

/** One layer of the model. */
export interface GlassComboLayer {
  combo: GlassCombo;
}

/** The next layer after `previous`. */
export function glassComboLayer(previous: GlassCombo | null): GlassComboLayer {
  return { combo: (previous ?? 0) + 1 };
}
