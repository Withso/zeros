import type { DesignViewport, DesignViewportSize } from "../design-canvas-math";
import { designTileDensity } from "../design-source-tiles";

/** A raster unit never exceeds this many device pixels on a side. */
export const DESIGN_GPU_UNIT_PIXELS = 512;
/** Tiles carry one texel of each neighbour so linear sampling is seamless. */
export const DESIGN_GPU_TILE_GUTTER = 1;
export const DESIGN_GPU_TILE_INNER = DESIGN_GPU_UNIT_PIXELS - DESIGN_GPU_TILE_GUTTER * 2;
/** One burst's staging surface, and so one atlas page, is at most this square. */
export const DESIGN_GPU_PAGE_PIXELS = 2048;

/** Device pixels per CSS pixel of a raster. It is the source tiles' density:
 * at least screen resolution, so a raster is only ever minified, by less
 * than two. */
export function designGpuDensity(zoom: number, dpr: number): number {
  return designTileDensity(zoom, dpr);
}

export interface DesignGpuGrid {
  readonly kind: "sprite" | "tiles";
  readonly cols: number;
  readonly rows: number;
  /** The whole frame in device pixels at this density. */
  readonly width: number;
  readonly height: number;
}

export function designGpuGrid(frame: { readonly width: number; readonly height: number }, density: number): DesignGpuGrid {
  const width = Math.max(1, Math.ceil(frame.width * density - 1e-6));
  const height = Math.max(1, Math.ceil(frame.height * density - 1e-6));
  if (width <= DESIGN_GPU_UNIT_PIXELS && height <= DESIGN_GPU_UNIT_PIXELS) return { kind: "sprite", cols: 1, rows: 1, width, height };
  return { kind: "tiles", cols: Math.ceil(width / DESIGN_GPU_TILE_INNER), rows: Math.ceil(height / DESIGN_GPU_TILE_INNER), width, height };
}

export interface DesignGpuUnitRaster {
  /** The rasterized rectangle in frame device pixels, gutter included. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** The part that is drawn, relative to the raster. */
  readonly inner: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
}

export function designGpuUnitRaster(grid: DesignGpuGrid, col: number, row: number): DesignGpuUnitRaster {
  if (grid.kind === "sprite") return { x: 0, y: 0, width: grid.width, height: grid.height,
    inner: { x: 0, y: 0, width: grid.width, height: grid.height } };
  const left = col * DESIGN_GPU_TILE_INNER, top = row * DESIGN_GPU_TILE_INNER;
  const right = Math.min(grid.width, left + DESIGN_GPU_TILE_INNER), bottom = Math.min(grid.height, top + DESIGN_GPU_TILE_INNER);
  const x = Math.max(0, left - DESIGN_GPU_TILE_GUTTER), y = Math.max(0, top - DESIGN_GPU_TILE_GUTTER);
  const width = Math.min(grid.width, right + DESIGN_GPU_TILE_GUTTER) - x;
  const height = Math.min(grid.height, bottom + DESIGN_GPU_TILE_GUTTER) - y;
  return { x, y, width, height, inner: { x: left - x, y: top - y, width: right - left, height: bottom - top } };
}

export interface DesignGpuTileAddress { readonly col: number; readonly row: number }
export interface DesignGpuWorldRect { readonly x: number; readonly y: number; readonly width: number; readonly height: number }

/** Units whose drawn part meets the viewport grown by `margin` CSS pixels. */
export function designGpuVisibleUnits(frame: DesignGpuWorldRect, grid: DesignGpuGrid, density: number,
  view: DesignViewport, size: DesignViewportSize, margin: number): DesignGpuTileAddress[] {
  if (!(view.zoom > 0) || !(density > 0) || !(size.width > 0) || !(size.height > 0)) return [];
  const left = ((-margin - view.panX) / view.zoom - frame.x) * density;
  const top = ((-margin - view.panY) / view.zoom - frame.y) * density;
  const right = ((size.width + margin - view.panX) / view.zoom - frame.x) * density;
  const bottom = ((size.height + margin - view.panY) / view.zoom - frame.y) * density;
  if (right <= 0 || bottom <= 0 || left >= grid.width || top >= grid.height) return [];
  if (grid.kind === "sprite") return [{ col: 0, row: 0 }];
  const side = DESIGN_GPU_TILE_INNER;
  const firstCol = Math.max(0, Math.floor(left / side)), lastCol = Math.min(grid.cols - 1, Math.ceil(right / side) - 1);
  const firstRow = Math.max(0, Math.floor(top / side)), lastRow = Math.min(grid.rows - 1, Math.ceil(bottom / side) - 1);
  const result: DesignGpuTileAddress[] = [];
  for (let row = firstRow; row <= lastRow; row++) for (let col = firstCol; col <= lastCol; col++) result.push({ col, row });
  return result;
}

/** Device-pixel rectangle on the plane where a unit's drawn part lands. A
 * one-to-one composite lands on whole device pixels: a fractional offset
 * would resample, and blur, every texel of a raster made for this zoom. */
export function designGpuScreenRect(frame: DesignGpuWorldRect, grid: DesignGpuGrid, density: number,
  unit: DesignGpuTileAddress, view: DesignViewport, dpr: number): { x: number; y: number; width: number; height: number } {
  const raster = designGpuUnitRaster(grid, unit.col, unit.row);
  const scale = view.zoom * dpr / density;
  let originX = (frame.x * view.zoom + view.panX) * dpr, originY = (frame.y * view.zoom + view.panY) * dpr;
  if (Math.abs(scale - 1) < 1e-9) { originX = Math.round(originX); originY = Math.round(originY); }
  return { x: originX + (raster.x + raster.inner.x) * scale, y: originY + (raster.y + raster.inner.y) * scale,
    width: raster.inner.width * scale, height: raster.inner.height * scale };
}

/** Which density to draw a frame at, given those whose units cover its
 * visible part. Never a coarser (stretched) raster while a crisp one exists. */
export function designGpuChooseDensity(required: number, available: Iterable<number>): { density: number; crisp: boolean } | null {
  let finer = Infinity, coarser = 0;
  for (const density of available) {
    if (Math.abs(density - required) < 1e-9) return { density, crisp: true };
    if (density > required) finer = Math.min(finer, density);
    else coarser = Math.max(coarser, density);
  }
  if (finer !== Infinity) return { density: finer, crisp: true };
  return coarser > 0 ? { density: coarser, crisp: false } : null;
}

export interface DesignGpuPlacement { readonly index: number; readonly x: number; readonly y: number }

/** Shelf-packs units in priority order into one staging rectangle. The first
 * unit that does not fit ends the burst, so priority is never reshuffled. */
export function packDesignGpuBurst(sizes: ReadonlyArray<{ readonly width: number; readonly height: number }>, maxSide: number):
  { placements: DesignGpuPlacement[]; width: number; height: number } {
  const placements: DesignGpuPlacement[] = [];
  let x = 0, y = 0, shelf = 0, width = 0;
  for (const [index, size] of sizes.entries()) {
    if (size.width > maxSide || size.height > maxSide) break;
    if (x + size.width > maxSide) { y += shelf; x = 0; shelf = 0; }
    if (y + size.height > maxSide) break;
    placements.push({ index, x, y });
    x += size.width;
    shelf = Math.max(shelf, size.height);
    width = Math.max(width, x);
  }
  return { placements, width, height: y + shelf };
}
