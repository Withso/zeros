// ──────────────────────────────────────────────────────────
// ZerosSpinner — the logo loader, the agent "Puzzle" and the
// transcript's glass square (square-tile loaders on one 4 × 4 grid)
// ──────────────────────────────────────────────────────────
//
//   • logo (default) — loading. The Island Z running the startup loader's
//     Weave (startup-loader.tsx): its four rows step sideways on a 72ms beat,
//     neighbours in opposite directions, and land back on the Z. One loop is
//     1800ms, moving for the first half and resting on the Z for the second.
//     Pure CSS: the rows run the shared `zeros-logo-weave-*` keyframes
//     (styles/global/animations.css), the startup loader's own steps.
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
import { STARTUP_LOGO_WEAVE_ROWS } from "@/renderer/shared/ui/startup-loader";
import { GlassTiles } from "./glass-square";
import { pickGlassMotion, type GlassMotion } from "./glass-motion";
import { PuzzleTiles } from "./puzzle-square";
import { usePrefersReducedMotion } from "./use-prefers-reduced-motion";
import { useElementActivity } from "./activity-scope";

export type ZerosSpinnerVariant = "logo" | "agent" | "glass";

export type ZerosSpinnerTone = "default" | "inverted" | "inherit";

/** Color per tone — semantic loader tokens (semantic-tokens.css) with
 *  primitive fallbacks, so the loader still paints on a bare preview page.
 *  It colours the logo's rows and the puzzle's tiles; `undefined` leaves
 *  `color` unset so the loader inherits currentColor. */
const TONE_COLORS: Record<ZerosSpinnerTone, string | undefined> = {
  default: "var(--loader-active, var(--fg2))",
  inverted: "var(--loader-active-inverted, var(--primary-button-fg))",
  inherit: undefined,
};

/** One Weave loop and the beat between its rows: the startup loader's timing
 *  (index.html). */
export const LOGO_WEAVE_LOOP_MS = 1800;
export const LOGO_WEAVE_BEAT_MS = 72;

export interface ZerosSpinnerProps {
  /** Side length of the loader box in CSS pixels (square). Default 24. The
   *  tiles use 75% of it: a 16px box draws a 12px square. */
  size?: number;
  /** Accessible label. Defaults to "Loading". */
  label?: string;
  /** "logo" (default) — loading, reconnecting, busy buttons. "agent" — the
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
  variant = "logo",
  tone = "default",
  tones,
  motion,
  className,
}: ZerosSpinnerProps) {
  const host = React.useRef<HTMLSpanElement>(null);
  const active = useElementActivity(host, variant === "logo");
  const reducedMotion = usePrefersReducedMotion();
  const color = TONE_COLORS[tone];
  const { cell, extent, offset } = loaderFrame(size);
  // A glass square keeps the motion it mounted with.
  const [pickedMotion] = React.useState(() => motion ?? pickGlassMotion());
  const glassMotion = motion ?? pickedMotion;

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
          // The logo's rows slide in from outside the square.
          overflow: variant === "logo" ? "hidden" : "visible",
        }}
      >
        {variant === "glass" ? (
          // Keyed by motion: a pinned motion that changes starts afresh.
          <GlassTiles key={glassMotion} motion={glassMotion} reducedMotion={reducedMotion} cell={cell} />
        ) : variant === "agent" ? (
          // A fresh random square per mount: no two live loaders match.
          <PuzzleTiles active reducedMotion={reducedMotion} tones={tones} />
        ) : (
          <LogoRows reducedMotion={reducedMotion} active={active} />
        )}
      </svg>
    </span>
  );
}

// ── Logo ──────────────────────────────────────────────────

function LogoRows({ reducedMotion, active }: { reducedMotion: boolean; active: boolean }) {
  return (
    <>
      {STARTUP_LOGO_WEAVE_ROWS.map((row, beat) => (
        <path
          key={row.d}
          d={row.d}
          fill="currentColor"
          style={
            reducedMotion
              ? undefined
              : {
                  animation: `zeros-logo-weave-${beat % 2 === 0 ? "r" : "l"} ${LOGO_WEAVE_LOOP_MS}ms infinite`,
                  animationDelay: `${beat * LOGO_WEAVE_BEAT_MS}ms`,
                  animationPlayState: active ? undefined : "paused",
                }
          }
        />
      ))}
    </>
  );
}
