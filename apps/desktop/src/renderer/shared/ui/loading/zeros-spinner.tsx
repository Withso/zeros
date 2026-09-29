// ──────────────────────────────────────────────────────────
// ZerosSpinner — the "Orbit" loader, the agent "Puzzle" and the
// transcript's glass square (square-tile loaders on one 4 × 4 grid)
// ──────────────────────────────────────────────────────────
//
//   • orbit (default) — loading. A snake laps the ring of a 4 × 4 square over
//     a faint track, one lap every 1200ms. Track and snake are continuous
//     bands, and the snake's tail fades as one smooth ramp (orbit-motion.ts),
//     so the loop never breaks into grey blocks. Pure CSS: every layer runs
//     the shared `zeros-orbit-lap` keyframe (styles/global/animations.css).
//
//   • agent — the agent is working. A 4 × 4 sliding-tile square whose corner
//     tiles never move, worked by three hands at once (puzzle-square.tsx,
//     puzzle-motion.ts): two or three tiles are usually gliding into holes,
//     so the square keeps re-forming new shapes without losing its outline.
//     Every mount starts from its own random square and runs its own random
//     hands, so no two chat tabs march in step. (A sidebar workspace animates
//     its own glyph instead.)
//
//   • glass — the agent is working, in the transcript: the active turn's rail
//     and running tool and subagent rows (glass-square.tsx). The same square
//     in soft glass colour combos, running like Run's Stream instead of
//     shuffling: every mount picks one of three running motions at random
//     (glass-motion.ts), so a turn and its tool rows rarely look alike.
//
// All keep 75% of the box for ink and sit on whole device pixels
// (loader-frame.ts). The inner <svg> pins its size inline: Buttons and rows
// carry blanket `[&_svg]:size-*` rules, which outrank presentation attributes.
//
// Tones: default → --loader-active / --loader-rest; inverted → the on-inverted
// foreground for primary-button fills; inherit → currentColor, for bespoke
// fills (green Merge, destructive, the yellow review glyph).
//
// Hidden retained surfaces stay inert: the agent's squares only move while
// the spinner is actually visible (one shared frame loop, loader-loop.ts),
// and prefers-reduced-motion stops every loader on a resting pose.
// ──────────────────────────────────────────────────────────

import React from "react";

import { cn } from "@/renderer/shared/ui/cn";

import { LOADER_GRID, loaderFrame } from "./loader-frame";
import {
  ORBIT_LAP_MS,
  ORBIT_LAYERS,
  ORBIT_REST_HEAD,
  ORBIT_RING_LENGTH,
  ORBIT_RING_PATH,
  orbitDashArray,
} from "./orbit-motion";
import { GlassTiles } from "./glass-square";
import { pickGlassMotion, type GlassMotion } from "./glass-motion";
import { PuzzleTiles } from "./puzzle-square";
import { usePrefersReducedMotion } from "./use-prefers-reduced-motion";

export type ZerosSpinnerVariant = "orbit" | "agent" | "glass";

export type ZerosSpinnerTone = "default" | "inverted" | "inherit";

/** Colors per tone — semantic loader tokens (semantic-tokens.css) with
 *  primitive fallbacks, so the loader still paints on a bare preview page.
 *  `active` colours the snake and the puzzle's tiles; `rest` the Orbit track.
 *  `undefined` leaves `color` unset so the loader inherits currentColor. */
const TONE_COLORS: Record<
  ZerosSpinnerTone,
  { active: string | undefined; rest: string; restOpacity: number }
> = {
  default: {
    active: "var(--loader-active, var(--fg2))",
    rest: "var(--loader-rest, var(--muted-fg))",
    restOpacity: 0.4,
  },
  inverted: {
    active: "var(--loader-active-inverted, var(--primary-button-fg))",
    rest: "var(--loader-rest-inverted, var(--primary-button-fg))",
    restOpacity: 0.22,
  },
  inherit: { active: undefined, rest: "currentColor", restOpacity: 0.3 },
};

export interface ZerosSpinnerProps {
  /** Side length of the loader box in CSS pixels (square). Default 24. The
   *  tiles use 75% of it: a 16px box draws a 12px square. */
  size?: number;
  /** Accessible label. Defaults to "Loading". */
  label?: string;
  /** "orbit" (default) — loading, reconnecting, busy buttons. "agent" — the
   *  agent is working (chat tabs, workspace rows). "glass" — the agent is
   *  working, in the transcript (the active turn's rail, running tool and
   *  subagent rows). */
  variant?: ZerosSpinnerVariant;
  /** "default" — normal surfaces. "inverted" — primary-button fills.
   *  "inherit" — currentColor, for buttons with bespoke fills. */
  tone?: ZerosSpinnerTone;
  /** "agent" only: light the square from the top in these three tones
   *  instead of one colour (a chat tab's agent logo colours). */
  tones?: readonly [string, string, string];
  /** "glass" only: run this motion instead of one picked at random. */
  motion?: GlassMotion;
  /** Optional extra className for the outer box. */
  className?: string;
}

export function ZerosSpinner({
  size = 24,
  label = "Loading",
  variant = "orbit",
  tone = "default",
  tones,
  motion,
  className,
}: ZerosSpinnerProps) {
  const reducedMotion = usePrefersReducedMotion();
  const colors = TONE_COLORS[tone];
  const { cell, extent, offset } = loaderFrame(size);
  // A glass square keeps the motion it mounted with.
  const [pickedMotion] = React.useState(() => motion ?? pickGlassMotion());
  const glassMotion = motion ?? pickedMotion;

  return (
    <span
      role="status"
      aria-label={label}
      data-zeros-loader={variant}
      data-glass-motion={variant === "glass" ? glassMotion : undefined}
      // `align-middle`: in inline flow a baseline-seated box sits visually low
      // next to its label. `shrink-0`: the art is absolutely positioned, so a
      // flex parent could otherwise squeeze the box to nothing.
      className={cn("relative inline-block shrink-0 align-middle", className)}
      style={{ width: size, height: size, color: colors.active }}
    >
      <svg
        aria-hidden="true"
        focusable="false"
        viewBox={`0 0 ${LOADER_GRID} ${LOADER_GRID}`}
        width={extent}
        height={extent}
        style={{
          position: "absolute",
          left: offset,
          top: offset,
          width: extent,
          height: extent,
          overflow: "visible",
        }}
      >
        {variant === "glass" ? (
          // Keyed by motion: a pinned motion that changes starts afresh.
          <GlassTiles key={glassMotion} motion={glassMotion} reducedMotion={reducedMotion} cell={cell} />
        ) : variant === "agent" ? (
          // A fresh random square per mount: no two live loaders match.
          <PuzzleTiles active reducedMotion={reducedMotion} tones={tones} />
        ) : (
          <OrbitBands colors={colors} reducedMotion={reducedMotion} />
        )}
      </svg>
    </span>
  );
}

// ── Orbit ─────────────────────────────────────────────────

function OrbitBands({
  colors,
  reducedMotion,
}: {
  colors: (typeof TONE_COLORS)[ZerosSpinnerTone];
  reducedMotion: boolean;
}) {
  // One random entry point per mount, so loaders mounted on the same frame
  // don't lap in lockstep. Every layer shares it: the snake stays one piece.
  const [phaseMs] = React.useState(() => Math.random() * ORBIT_LAP_MS);
  const band = {
    d: ORBIT_RING_PATH,
    fill: "none",
    strokeWidth: 1,
    strokeLinejoin: "miter" as const,
    pathLength: ORBIT_RING_LENGTH,
  };
  return (
    <>
      <path {...band} style={{ stroke: colors.rest, opacity: colors.restOpacity }} />
      {ORBIT_LAYERS.map(({ length, alpha }) => (
        <path
          key={length}
          {...band}
          stroke="currentColor"
          strokeDasharray={orbitDashArray(length)}
          style={
            reducedMotion
              ? { opacity: alpha, strokeDashoffset: ORBIT_RING_LENGTH - ORBIT_REST_HEAD }
              : {
                  opacity: alpha,
                  animation: `zeros-orbit-lap ${ORBIT_LAP_MS}ms linear infinite`,
                  animationDelay: `${-phaseMs}ms`,
                }
          }
        />
      ))}
    </>
  );
}
