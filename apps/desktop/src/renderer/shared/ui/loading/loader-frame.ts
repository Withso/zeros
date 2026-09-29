// Shared geometry for the square-tile loaders (Orbit, the agent Puzzle and
// the Run Stream). Every one draws a 4 × 4 grid of tiles inside a square box,
// using 75% of the box for ink so a loader reads the same weight as the icon
// it stands in for.
//
// Tiles snap to half pixels — whole device pixels on the Retina displays
// Zeros ships to — so resting edges stay crisp: 2.5px tiles at 12–14px, 3px
// at 16px, 4px at 20px and 4.5px at 24px. The grid is centred on whole
// pixels too, so no size lands its first edge between two device pixels.

/** Tiles per side. */
export const LOADER_GRID = 4;

/** Share of the box a loader's tiles may cover. */
const INK_RATIO = 0.75;

export interface LoaderFrame {
  /** One tile's side, in CSS px. */
  cell: number;
  /** The whole grid's side (LOADER_GRID tiles), in CSS px. */
  extent: number;
  /** Inset of the grid from the box's top-left corner, in CSS px. */
  offset: number;
}

export function loaderFrame(size: number): LoaderFrame {
  const cell = Math.max(0.5, Math.round(((size * INK_RATIO) / LOADER_GRID) * 2) / 2);
  const extent = cell * LOADER_GRID;
  const offset = Math.round((size - extent) / 2);
  return { cell, extent, offset };
}
