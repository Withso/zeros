// ──────────────────────────────────────────────────────────
// PuzzleSquare — the sliding-tile square behind the agent loader
// ──────────────────────────────────────────────────────────
//
// A 4 × 4 square of tiles whose corners never move (puzzle-motion.ts). While
// `active`, three hands slide tiles into its holes, so the square keeps
// re-forming new shapes; when `active` drops the hands stop and the tiles
// rest where they are, and the next run resumes from there.
//
//   • ZerosSpinner variant="agent" draws it always active, from a random
//     square per mount, so no two live loaders share a shape.
//   • The sidebar's workspace glyph (shell/workspace-glyph.tsx) draws it from
//     a seeded square at rest and turns it on while that workspace's agent
//     works. A seeded square remembers where it last rested, so it resumes
//     from there even after its row swapped it out for a while. Only that
//     glyph is `shaded`: while it works its channel tiles take three close
//     tones of its colour.
//
// Colour rides currentColor. Every animating square shares one frame loop
// (loader-loop.ts), and hidden retained surfaces stay inert: a square only
// moves while it is actually visible. prefers-reduced-motion keeps every
// square at rest.
// ──────────────────────────────────────────────────────────

import React from "react";

import { cn } from "@/renderer/shared/ui/cn";

import { LOADER_GRID, loaderFrame } from "./loader-frame";
import { startLoaderRun } from "./loader-loop";
import {
  PUZZLE_CORNERS,
  PUZZLE_MOVE_MS,
  PuzzleBoard,
  seededRandom,
  type PuzzleMove,
} from "./puzzle-motion";
import { usePrefersReducedMotion } from "./use-prefers-reduced-motion";

/** Run a board's hands in the shared loader loop, drawing each move. The
 *  loop skips hidden retained surfaces (background chats, collapsed panels),
 *  so their hands wait until the surface is visible again. */
function startPuzzle(host: Element, board: PuzzleBoard, draw: (moves: PuzzleMove[]) => void) {
  board.start(performance.now());
  return startLoaderRun({
    host,
    tick: (now) => {
      const moves = board.step(now);
      if (moves.length) draw(moves);
    },
  });
}

/** Where each seeded square last came to rest, so a glyph its row swaps out
 *  for a while (a question icon, a regroup) comes back in that shape rather
 *  than its seeded start. Bounded: the least recently rested seeds fall out. */
const restingSquares = new Map<string, readonly number[]>();
export const PUZZLE_RESTING_LIMIT = 256;

export function rememberRestingSquare(seed: string, cells: readonly number[]): void {
  restingSquares.delete(seed);
  restingSquares.set(seed, cells.slice());
  if (restingSquares.size > PUZZLE_RESTING_LIMIT) {
    const oldest = restingSquares.keys().next().value;
    if (oldest !== undefined) restingSquares.delete(oldest);
  }
}

export function restingSquare(seed: string): readonly number[] | undefined {
  return restingSquares.get(seed);
}

const tileTransform = (cell: number) =>
  `translate(${cell % LOADER_GRID}px, ${Math.floor(cell / LOADER_GRID)}px)`;

/** Depth for a shaded square while it works: the channel tiles cycle through
 *  three close tones of its colour (by opacity, so any tint and either theme
 *  keeps them close), and the tones travel with the tiles as they slide. The
 *  corners stay full, so the outline never softens. */
export const PUZZLE_TILE_SHADES: readonly number[] = [1, 0.86, 0.72];
const SHADE_FADE = "opacity 200ms ease-out";
const TONE_FADE = `fill ${PUZZLE_MOVE_MS}ms ease`;

/** Row fills for a square lit from the top by three tones (top, middle,
 *  bottom): the top row takes the first, the bottom row the last, the two
 *  between a blend. A tile takes its row's fill as it slides, so the light
 *  stays put while the tiles move through it. */
export function puzzleRowFills(
  tones: readonly [string, string, string],
): readonly [string, string, string, string] {
  const [top, middle, bottom] = tones;
  return [
    top,
    `color-mix(in oklab, ${top} 35%, ${middle})`,
    `color-mix(in oklab, ${middle} 65%, ${bottom})`,
    bottom,
  ];
}

const tileRow = (cell: number) => Math.floor(cell / LOADER_GRID);

/** The tiles, for an svg whose viewBox is the LOADER_GRID square. */
export function PuzzleTiles({
  seed,
  active,
  reducedMotion,
  shaded = false,
  tones,
}: {
  seed?: string;
  active: boolean;
  reducedMotion: boolean;
  /** Shade the tiles while active (PUZZLE_TILE_SHADES). */
  shaded?: boolean;
  /** Light the square from the top in these tones (puzzleRowFills). */
  tones?: readonly [string, string, string];
}) {
  // The board outlives every start/stop, so a paused square resumes where it
  // came to rest; a remounted seeded square picks up where its last board
  // rested. Callers remount (key) to change the seed.
  const [board] = React.useState(() => {
    const next = new PuzzleBoard(seed === undefined ? Math.random : seededRandom(seed));
    const rested = seed === undefined ? undefined : restingSquare(seed);
    if (rested) next.restore(rested);
    return next;
  });
  const [initialCells] = React.useState(() => board.cellOf.slice());
  // Corners never move, so a tile's starting cell says whether it anchors.
  const [tileShades] = React.useState(() => {
    let channel = 0;
    return initialCells.map((cell) =>
      PUZZLE_CORNERS.includes(cell)
        ? 1
        : PUZZLE_TILE_SHADES[channel++ % PUZZLE_TILE_SHADES.length],
    );
  });
  const groupRef = React.useRef<SVGGElement | null>(null);
  const rowFills = React.useMemo(() => (tones ? puzzleRowFills(tones) : null), [tones]);

  React.useEffect(() => {
    const group = groupRef.current;
    if (!active || reducedMotion || !group) return;
    const tiles = Array.from(group.children) as SVGElement[];
    const stop = startPuzzle(group, board, (moves) => {
      // Tiles glide by transform; React never re-renders for a move.
      for (const move of moves) {
        const tile = tiles[move.tile];
        if (!tile) continue;
        tile.style.transform = tileTransform(move.to);
        if (rowFills) tile.style.fill = rowFills[tileRow(move.to)];
      }
    });
    return () => {
      stop();
      if (seed !== undefined) rememberRestingSquare(seed, board.cellOf);
    };
  }, [board, seed, active, reducedMotion, rowFills]);

  return (
    <g ref={groupRef} fill="currentColor">
      {initialCells.map((at, tile) => (
        <rect
          key={tile}
          width={1}
          height={1}
          style={{
            transform: tileTransform(at),
            transition: `transform ${PUZZLE_MOVE_MS}ms cubic-bezier(0.55, 0, 0.25, 1)${shaded ? `, ${SHADE_FADE}` : ""}${rowFills ? `, ${TONE_FADE}` : ""}`,
            opacity: shaded && active && tileShades[tile] < 1 ? tileShades[tile] : undefined,
            fill: rowFills ? rowFills[tileRow(at)] : undefined,
          }}
        />
      ))}
    </g>
  );
}

export interface PuzzleSquareProps {
  /** Square box size in CSS pixels. The tiles use 75% of it. */
  size?: number;
  /** Fixes the starting square; omit for a random one. */
  seed?: string;
  /** Run the hands. Dropping it stops them where the tiles rest. */
  active?: boolean;
  /** Give the tiles depth while active (the sidebar's workspace glyph only);
   *  at rest the square stays one flat colour. */
  shaded?: boolean;
  /** Optional accessible name. Decorative uses should omit this. */
  label?: string;
  className?: string;
}

export function PuzzleSquare({
  size = 16,
  seed,
  active = false,
  shaded = false,
  label,
  className,
}: PuzzleSquareProps) {
  const reducedMotion = usePrefersReducedMotion();
  const { extent, offset } = loaderFrame(size);
  return (
    <span
      className={cn("relative inline-block shrink-0 align-middle", className)}
      style={{ width: size, height: size }}
      data-puzzle-square=""
      data-active={active ? "true" : undefined}
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
        // Pinned inline: rows and Buttons carry blanket `[&_svg]:size-*`
        // rules, which outrank presentation attributes.
        style={{
          position: "absolute",
          left: offset,
          top: offset,
          width: extent,
          height: extent,
          overflow: "visible",
        }}
      >
        <PuzzleTiles
          key={seed ?? "random"}
          seed={seed}
          active={active}
          reducedMotion={reducedMotion}
          shaded={shaded}
        />
      </svg>
    </span>
  );
}
