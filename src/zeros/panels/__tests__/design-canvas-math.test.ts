import { describe, expect, it } from "vitest";

import {
  fitDesignRects,
  retainLiveDesignFrameFiles,
  selectLiveDesignFrameFiles,
  zoomDesignViewportAtPoint,
} from "../design-canvas-math";

describe("design canvas viewport math", () => {
  it("keeps the world point under the pointer fixed while zooming", () => {
    const previous = { zoom: 0.5, panX: 40, panY: 20 };
    const point = { x: 240, y: 170 };
    const worldBefore = {
      x: (point.x - previous.panX) / previous.zoom,
      y: (point.y - previous.panY) / previous.zoom,
    };

    const next = zoomDesignViewportAtPoint(previous, 1, point);

    expect((point.x - next.panX) / next.zoom).toBe(worldBefore.x);
    expect((point.y - next.panY) / next.zoom).toBe(worldBefore.y);
  });

  it("fits an offset frame into the viewport and centers its bounds", () => {
    const fit = fitDesignRects(
      [{ x: 200, y: 100, width: 1_440, height: 900 }],
      { width: 1_000, height: 700 },
      50,
    );

    expect(fit).not.toBeNull();
    expect(fit!.zoom).toBeCloseTo(0.625);
    expect(200 * fit!.zoom + fit!.panX).toBeCloseTo(50);
    expect(100 * fit!.zoom + fit!.panY).toBeCloseTo(68.75);
  });

  it("returns null for an empty canvas and clamps extreme fits", () => {
    expect(fitDesignRects([], { width: 1_000, height: 700 })).toBeNull();
    expect(
      fitDesignRects([{ x: 0, y: 0, width: 10, height: 10 }], {
        width: 1_000,
        height: 700,
      })?.zoom,
    ).toBe(2);
  });

  it("keeps a bounded live iframe window around the viewport and selection", () => {
    const frames = Array.from({ length: 30 }, (_, index) => ({
      file: `frame-${index}.html`,
      x: index * 500,
      y: 0,
      width: 400,
      height: 300,
    }));
    const live = selectLiveDesignFrameFiles({
      frames,
      viewport: { width: 1_000, height: 700 },
      view: { zoom: 1, panX: 0, panY: 0 },
      selectedFrame: "frame-29.html",
      maxLive: 6,
    });

    expect(live.size).toBe(6);
    expect(live.has("frame-0.html")).toBe(true);
    expect(live.has("frame-1.html")).toBe(true);
    expect(live.has("frame-29.html")).toBe(true);

    const panned = selectLiveDesignFrameFiles({
      frames,
      viewport: { width: 1_000, height: 700 },
      view: { zoom: 1, panX: -5_000, panY: 0 },
      selectedFrame: null,
      maxLive: 4,
    });
    expect(panned.has("frame-10.html")).toBe(true);
    expect(panned.has("frame-0.html")).toBe(false);
  });

  it("retains a bounded live iframe window while the design surface is hidden", () => {
    const previous = new Set(["frame-0.html", "frame-1.html", "removed.html"]);
    const retained = retainLiveDesignFrameFiles({
      previous,
      available: ["frame-0.html", "frame-1.html", "frame-2.html"],
      active: false,
      maxLive: 2,
      next: new Set(),
    });

    expect([...retained]).toEqual(["frame-0.html", "frame-1.html"]);
    expect(retained.size).toBeLessThanOrEqual(2);
  });
});
