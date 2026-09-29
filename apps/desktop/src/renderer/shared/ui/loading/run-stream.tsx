// ──────────────────────────────────────────────────────────
// RunStream — the live Run indicator
// ──────────────────────────────────────────────────────────
//
// An irregular 4 × 4 square of tiles, like the agent puzzle, making the one
// motion the puzzle never makes: every 95ms the next row, top to bottom,
// slides one tile to the right in 140ms and wraps round at the square's edge,
// so the whole square streams steadily forward, one full pass every 1520ms.
// "Running" and "agent working" can share a row without looking alike.
//
// Pure CSS. Each row is ONE path holding two copies of its pattern (one tile
// width apart from the wrap), so tiles side by side never seam and a full lap
// looks identical to none. Every row runs the shared `zeros-run-stream`
// keyframe (styles/global/animations.css), delayed one beat per row. Colour
// rides currentColor; prefers-reduced-motion rests the square in place.
// ──────────────────────────────────────────────────────────

import { useState } from "react";

import { cn } from "@/renderer/shared/ui/cn";

import { LOADER_GRID, loaderFrame } from "./loader-frame";
import { usePrefersReducedMotion } from "./use-prefers-reduced-motion";

/** The square: 10 tiles, 6 gaps, the density of the agent puzzle. */
export const RUN_STREAM_PATTERN: readonly (readonly number[])[] = [
  [1, 1, 0, 1],
  [0, 1, 1, 0],
  [1, 0, 1, 1],
  [1, 1, 0, 0],
];
/** A new row starts sliding every beat. */
export const RUN_STREAM_BEAT_MS = 95;
/** One slide; the keyframe's moving segments are this share of the cycle. */
export const RUN_STREAM_MOVE_MS = 140;
/** Each row slides once per LOADER_GRID beats and laps after LOADER_GRID
 *  slides, so one cycle is 4 × 4 × 95 = 1520ms. */
export const RUN_STREAM_CYCLE_MS = RUN_STREAM_BEAT_MS * LOADER_GRID * LOADER_GRID;

/** A row as one path: its tiles, plus the same tiles one row-width to the
 *  left so the tile leaving on the right re-enters on the left. */
export function runStreamRowPath(row: readonly number[], y: number): string {
  let d = "";
  for (const copy of [-LOADER_GRID, 0]) {
    row.forEach((on, x) => {
      if (on) d += `M${x + copy} ${y}h1v1h-1z`;
    });
  }
  return d;
}

const ROW_PATHS = RUN_STREAM_PATTERN.map(runStreamRowPath);

export interface RunStreamProps {
  /** Square box size in CSS pixels. */
  size?: number;
  className?: string;
  /** Optional standalone accessible name. Decorative uses should omit this. */
  label?: string;
}

export function RunStream({ size = 16, className, label }: RunStreamProps) {
  const reducedMotion = usePrefersReducedMotion();
  // One random entry point per mount, so two runs never stream in lockstep.
  const [phaseMs] = useState(() => Math.random() * RUN_STREAM_CYCLE_MS);
  const { extent, offset } = loaderFrame(size);

  return (
    <span
      className={cn("relative inline-block shrink-0 align-middle", className)}
      style={{ width: size, height: size }}
      data-run-stream=""
      data-animated={reducedMotion ? undefined : "true"}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : "true"}
    >
      <svg
        aria-hidden="true"
        focusable="false"
        viewBox={`0 0 ${LOADER_GRID} ${LOADER_GRID}`}
        width={extent}
        height={extent}
        fill="currentColor"
        // Pinned inline: Buttons and tab pills carry blanket `[&_svg]:size-*`
        // rules, which outrank presentation attributes. The wrap relies on
        // the svg's own clip at the square's edge.
        style={{
          position: "absolute",
          left: offset,
          top: offset,
          width: extent,
          height: extent,
          overflow: "hidden",
        }}
      >
        {ROW_PATHS.map((d, row) => (
          <path
            key={row}
            d={d}
            style={
              reducedMotion
                ? undefined
                : {
                    animation: `zeros-run-stream ${RUN_STREAM_CYCLE_MS}ms linear infinite`,
                    animationDelay: `${row * RUN_STREAM_BEAT_MS - phaseMs}ms`,
                  }
            }
          />
        ))}
      </svg>
    </span>
  );
}
