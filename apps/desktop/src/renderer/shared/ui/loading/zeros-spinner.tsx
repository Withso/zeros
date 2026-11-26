// ──────────────────────────────────────────────────────────
// ZerosSpinner — Stream-run, the agent "Puzzle" and the transcript's
// glass square (square-tile loaders on one 4 × 4 grid)
// ──────────────────────────────────────────────────────────
//
//   • stream (default) — loading, waiting, busy buttons: Stream-run
//     (run-stream.tsx), the app's one loader everywhere but startup. Every
//     95ms the next row slides one tile right in 140ms and wraps, one full
//     pass every 1520ms. Pure CSS on the shared `zeros-run-stream` keyframe.
//     Only app startup shows the Island Z weave (startup-loader.tsx).
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
//     in one fg1 → fg3 fade, running like Stream-run instead of shuffling,
//     with one pinned motion (the weave), so a turn and its tool rows read
//     alike.
//
// All keep 75% of the box for ink and sit on whole device pixels
// (loader-frame.ts). The inner <svg> pins its size inline: Buttons and rows
// carry blanket `[&_svg]:size-*` rules, which outrank presentation attributes.
//
// Tones: default → --loader-active; inverted → the on-inverted
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
import { RUN_STREAM_CYCLE_MS, RunStreamRows } from "./run-stream";
import { GlassTiles } from "./glass-square";
import { GLASS_DEFAULT_MOTION, type GlassMotion } from "./glass-motion";
import { PuzzleTiles } from "./puzzle-square";
import { usePrefersReducedMotion } from "./use-prefers-reduced-motion";
import { useElementActivity } from "./activity-scope";

export type ZerosSpinnerVariant = "stream" | "agent" | "glass";

export type ZerosSpinnerTone = "default" | "inverted" | "inherit";

/** Color per tone — semantic loader tokens (semantic-tokens.css) with
 *  primitive fallbacks, so the loader still paints on a bare preview page.
 *  It colours the stream's rows and the puzzle's tiles; `undefined` leaves
 *  `color` unset so the loader inherits currentColor. */
const TONE_COLORS: Record<ZerosSpinnerTone, string | undefined> = {
  default: "var(--loader-active, var(--fg2))",
  inverted: "var(--loader-active-inverted, var(--primary-button-fg))",
  inherit: undefined,
};

export interface ZerosSpinnerProps {
  /** Side length of the loader box in CSS pixels (square). Default 24. The
   *  tiles use 75% of it: a 16px box draws a 12px square. */
  size?: number;
  /** Accessible label. Defaults to "Loading". */
  label?: string;
  /** "stream" (default) — loading, reconnecting, busy buttons. "agent" — the
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
  /** "glass" only: run this motion instead of the pinned weave. */
  motion?: GlassMotion;
  /** Optional extra className for the outer box. */
  className?: string;
}

export function ZerosSpinner({
  size = 24,
  label = "Loading",
  variant = "stream",
  tone = "default",
  tones,
  motion,
  className,
}: ZerosSpinnerProps) {
  const host = React.useRef<HTMLSpanElement>(null);
  const active = useElementActivity(host, variant === "stream");
  // One random entry point per mount, so two waits never stream in lockstep.
  const [phaseMs] = React.useState(() => Math.random() * RUN_STREAM_CYCLE_MS);
  const reducedMotion = usePrefersReducedMotion();
  const color = TONE_COLORS[tone];
  const { cell, extent, offset } = loaderFrame(size);
  const glassMotion = motion ?? GLASS_DEFAULT_MOTION;

  return (
    <span
      ref={host}
      role="status"
      aria-label={label}
      data-zeros-loader={variant}
      data-glass-motion={variant === "glass" ? glassMotion : undefined}
      // `align-middle`: in inline flow a baseline-seated box sits visually low
      // next to its label. `shrink-0`: the art is absolutely positioned, so a
      // flex parent could otherwise squeeze the box to nothing.
      className={cn("relative inline-block shrink-0 align-middle", className)}
      style={{ width: size, height: size, color }}
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
          // The stream's rows wrap round at the square's edge.
          overflow: variant === "stream" ? "hidden" : "visible",
        }}
      >
        {variant === "glass" ? (
          // Keyed by motion: a pinned motion that changes starts afresh.
          <GlassTiles key={glassMotion} motion={glassMotion} reducedMotion={reducedMotion} cell={cell} />
        ) : variant === "agent" ? (
          // A fresh random square per mount: no two live loaders match.
          <PuzzleTiles active reducedMotion={reducedMotion} tones={tones} />
        ) : (
          <RunStreamRows phaseMs={phaseMs} reducedMotion={reducedMotion} active={active} />
        )}
      </svg>
    </span>
  );
}

