import { describe, expect, it } from "vitest";

import {
  DESIGN_GPU_TILE_GUTTER,
  DESIGN_GPU_TILE_INNER,
  designGpuChooseDensity,
  designGpuDensity,
  designGpuGrid,
  designGpuScreenRect,
  designGpuUnitRaster,
  designGpuVisibleUnits,
  packDesignGpuBurst,
} from "../gpu/design-gpu-plan";
import { designTileDensity } from "../design-source-tiles";

describe("Design GPU planning", () => {
  it("rasterizes at the source tiles' power-of-two density: never below screen resolution, at most twice it", () => {
    for (const [zoom, dpr] of [[0.05, 2], [0.25, 2], [0.3, 1], [1, 2], [1.5, 2], [8, 2], [0.01, 1]] as const) {
      const density = designGpuDensity(zoom, dpr);
      expect(density).toBe(designTileDensity(zoom, dpr));
      expect(density).toBeGreaterThanOrEqual(zoom * dpr - 1e-9);
      expect(density).toBeLessThan(zoom * dpr * 2 + 1e-9);
    }
  });

  it("keeps a frame that fits one unit as a single sprite and splits a larger one into gutter tiles", () => {
    expect(designGpuGrid({ width: 1440, height: 900 }, 0.125)).toEqual({ kind: "sprite", cols: 1, rows: 1, width: 180, height: 113 });
    const grid = designGpuGrid({ width: 1440, height: 900 }, 1);
    expect(grid).toEqual({ kind: "tiles", cols: Math.ceil(1440 / DESIGN_GPU_TILE_INNER), rows: Math.ceil(900 / DESIGN_GPU_TILE_INNER), width: 1440, height: 900 });
    // A sprite has no neighbour to sample: its raster is the frame.
    expect(designGpuUnitRaster(designGpuGrid({ width: 1440, height: 900 }, 0.125), 0, 0)).toEqual({
      x: 0, y: 0, width: 180, height: 113, inner: { x: 0, y: 0, width: 180, height: 113 } });
    // An interior tile carries one texel of each neighbour so linear sampling
    // across the seam reads continuous content.
    const inner = DESIGN_GPU_TILE_INNER, gutter = DESIGN_GPU_TILE_GUTTER;
    expect(designGpuUnitRaster(grid, 1, 1)).toEqual({ x: inner - gutter, y: inner - gutter,
      width: inner + gutter * 2, height: 900 - inner + gutter,
      inner: { x: gutter, y: gutter, width: inner, height: 900 - inner } });
    expect(designGpuUnitRaster(grid, 0, 0)).toMatchObject({ x: 0, y: 0, width: inner + gutter, inner: { x: 0, y: 0 } });
    for (let col = 0; col < grid.cols; col++) for (let row = 0; row < grid.rows; row++) {
      const raster = designGpuUnitRaster(grid, col, row);
      expect(Math.max(raster.width, raster.height)).toBeLessThanOrEqual(512);
    }
  });

  it("culls units outside the viewport plus overscan, in frame-local tile coordinates", () => {
    const frame = { x: 100, y: 50, width: 1440, height: 900 };
    const view = { zoom: 2, panX: -400, panY: -200 };
    const size = { width: 800, height: 600 };
    const density = designGpuDensity(view.zoom, 1);
    const grid = designGpuGrid(frame, density);
    // Screen [0,800]x[0,600] is world [200,600]x[100,400], frame-local [100,500]x[50,350] → device ×2.
    expect(designGpuVisibleUnits(frame, grid, density, view, size, 0)).toEqual([
      { col: 0, row: 0 }, { col: 1, row: 0 }, { col: 0, row: 1 }, { col: 1, row: 1 }]);
    expect(designGpuVisibleUnits({ ...frame, x: 5_000 }, grid, density, view, size, 0)).toEqual([]);
    const overscanned = designGpuVisibleUnits(frame, grid, density, view, size, 400);
    expect(overscanned.length).toBeGreaterThan(4);
  });

  it("maps a unit to DPR-correct device pixels and snaps a 1:1 composite to whole pixels", () => {
    const frame = { x: 10.3, y: 20.6, width: 200, height: 100 };
    const view = { zoom: 1, panX: 0.25, panY: 0 };
    const grid = designGpuGrid(frame, 2);
    const rect = designGpuScreenRect(frame, grid, 2, { col: 0, row: 0 }, view, 2);
    // At density == zoom × dpr the texture is drawn 1:1, on whole device pixels.
    expect(rect).toEqual({ x: 21, y: 41, width: 400, height: 200 });
    const scaled = designGpuScreenRect(frame, grid, 2, { col: 0, row: 0 }, { ...view, zoom: 0.75 }, 2);
    expect(scaled.x).toBeCloseTo((10.3 * 0.75 + 0.25) * 2, 6);
    expect(scaled.width).toBeCloseTo(200 * 0.75 * 2, 6);
  });

  it("chooses the crisp density first, then the nearest finer one, and stretches a coarser one only as a last resort", () => {
    expect(designGpuChooseDensity(1, [0.5, 1, 2])).toEqual({ density: 1, crisp: true });
    expect(designGpuChooseDensity(1, [0.25, 2, 4])).toEqual({ density: 2, crisp: true });
    expect(designGpuChooseDensity(1, [0.25, 0.5])).toEqual({ density: 0.5, crisp: false });
    expect(designGpuChooseDensity(1, [])).toBeNull();
  });

  it("packs a burst in priority order into one staging rectangle without overlap", () => {
    const sizes = [{ width: 180, height: 113 }, { width: 512, height: 512 }, { width: 300, height: 200 }, { width: 2000, height: 10 }];
    const { placements, width, height } = packDesignGpuBurst(sizes, 2048);
    expect(placements.map(placement => placement.index)).toEqual([0, 1, 2, 3]);
    for (const [index, a] of placements.entries()) {
      expect(a.x + sizes[a.index]!.width).toBeLessThanOrEqual(width);
      expect(a.y + sizes[a.index]!.height).toBeLessThanOrEqual(height);
      for (const b of placements.slice(index + 1)) {
        const overlap = a.x < b.x + sizes[b.index]!.width && b.x < a.x + sizes[a.index]!.width &&
          a.y < b.y + sizes[b.index]!.height && b.y < a.y + sizes[a.index]!.height;
        expect(overlap).toBe(false);
      }
    }
    expect(width).toBeLessThanOrEqual(2048);
    expect(height).toBeLessThanOrEqual(2048);
    // What does not fit waits for the next burst; order is never reshuffled.
    const full = packDesignGpuBurst(Array.from({ length: 20 }, () => ({ width: 512, height: 512 })), 2048);
    expect(full.placements.map(placement => placement.index)).toEqual(Array.from({ length: 16 }, (_, index) => index));
  });
});
