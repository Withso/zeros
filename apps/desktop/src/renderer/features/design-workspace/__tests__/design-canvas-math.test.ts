import { describe, expect, it, vi } from "vitest";

import {
  designCssSizeAfterResize,
  designSelectionClickIntent,
  designSpacingMeasurements,
  designPointerRotation,
  fitDesignRects,
  resizeDesignRect,
  resizeDesignRectWithinBounds,
  snapDesignRect,
  snapDesignResizeRect,
  retainLiveDesignFrameFiles,
  selectLiveDesignFrameFiles,
  settleDesignFrameGesture,
  zoomDesignViewportAtPoint,
} from "../design-canvas-math";

describe("design canvas viewport math", () => {
  it("delays selected-layer click semantics until a group drag is ruled out", () => {
    expect(
      designSelectionClickIntent({
        shiftKey: true,
        metaKey: false,
        ctrlKey: false,
        detail: 1,
      }),
    ).toBe("toggle");
    expect(
      designSelectionClickIntent({
        shiftKey: false,
        metaKey: true,
        ctrlKey: false,
        detail: 1,
      }),
    ).toBe("deepest");
    expect(
      designSelectionClickIntent({
        shiftKey: false,
        metaKey: false,
        ctrlKey: false,
        detail: 2,
      }),
    ).toBe("descend");
    expect(
      designSelectionClickIntent({
        shiftKey: false,
        metaKey: false,
        ctrlKey: false,
        detail: 1,
      }),
    ).toBe("primary");
  });

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

  it("repaints the committed geometry even when clamping returns the start", async () => {
    const start = { x: 1_000_000, y: 0, w: 400, h: 300, z: 0 };
    const paint = vi.fn();

    await expect(
      settleDesignFrameGesture(Promise.resolve(start), start, paint),
    ).resolves.toEqual(start);
    expect(paint).toHaveBeenCalledWith(start);
  });

  it("resizes every edge without losing the opposite anchor", () => {
    const start = { x: 100, y: 80, width: 240, height: 160 };

    expect(resizeDesignRect(start, -20, 12, "w")).toEqual({
      x: 80,
      y: 80,
      width: 260,
      height: 160,
    });
    expect(resizeDesignRect(start, 30, -20, "ne")).toEqual({
      x: 100,
      y: 60,
      width: 270,
      height: 180,
    });
  });

  it("supports aspect-locked and center-based direct resize", () => {
    const start = { x: 100, y: 100, width: 200, height: 100 };

    expect(resizeDesignRect(start, 40, 5, "se", { keepAspect: true })).toEqual({
      x: 100,
      y: 100,
      width: 240,
      height: 120,
    });
    expect(resizeDesignRect(start, 20, 10, "se", { fromCenter: true })).toEqual(
      { x: 80, y: 90, width: 240, height: 120 },
    );
  });

  it("keeps the center and aspect ratio stable when resize reaches a minimum", () => {
    expect(
      resizeDesignRect({ x: 10, y: 20, width: 100, height: 80 }, 200, 0, "w", {
        fromCenter: true,
        minWidth: 24,
      }),
    ).toEqual({ x: 48, y: 20, width: 24, height: 80 });

    expect(
      resizeDesignRect({ x: 0, y: 0, width: 200, height: 50 }, -180, 0, "e", {
        keepAspect: true,
        minWidth: 24,
        minHeight: 20,
      }),
    ).toEqual({ x: 0, y: 15, width: 80, height: 20 });
  });

  it("clamps resize at a usable minimum while keeping the dragged edge", () => {
    expect(
      resizeDesignRect({ x: 10, y: 20, width: 100, height: 80 }, 200, 0, "w", {
        minWidth: 24,
      }),
    ).toEqual({ x: 86, y: 20, width: 24, height: 80 });
  });

  it("projects every selected child through a group resize", () => {
    const source = { x: 100, y: 80, width: 300, height: 200 };
    const resized = { x: 40, y: 50, width: 600, height: 100 };

    expect(
      resizeDesignRectWithinBounds(
        { x: 150, y: 100, width: 80, height: 40 },
        source,
        resized,
      ),
    ).toEqual({ x: 140, y: 60, width: 160, height: 20 });
    expect(
      resizeDesignRectWithinBounds(
        { x: 350, y: 240, width: 50, height: 40 },
        source,
        resized,
      ),
    ).toEqual({ x: 540, y: 130, width: 100, height: 20 });
  });

  it("converts an outer-box resize into the matching computed CSS size", () => {
    // A 120px border box may contain a 96px computed content width. Growing
    // the box by 30px should author 126px, not the 150px outer dimension.
    expect(designCssSizeAfterResize("96px", 120, 150)).toBe(126);
    expect(designCssSizeAfterResize("auto", 120, 90)).toBe(90);
    expect(designCssSizeAfterResize("4px", 20, 0)).toBe(0);
  });

  it("keeps degenerate group axes finite while translating them", () => {
    expect(
      resizeDesignRectWithinBounds(
        { x: 20, y: 40, width: 10, height: 20 },
        { x: 20, y: 40, width: 0, height: 0 },
        { x: 80, y: 90, width: 0, height: 0 },
      ),
    ).toEqual({ x: 80, y: 90, width: 10, height: 20 });
  });

  it("snaps the nearest moving edges and centers without changing size", () => {
    expect(
      snapDesignRect(
        { x: 97, y: 128, width: 40, height: 20 },
        [{ x: 100, y: 100, width: 100, height: 80 }],
        5,
      ),
    ).toEqual({
      rect: { x: 100, y: 130, width: 40, height: 20 },
      guides: { x: 100, y: 140 },
    });
  });

  it("snaps only the actively resized edges to sibling axes", () => {
    expect(
      snapDesignResizeRect(
        { x: 40, y: 52, width: 157, height: 95 },
        "se",
        [{ x: 200, y: 40, width: 100, height: 110 }],
        5,
      ),
    ).toEqual({
      rect: { x: 40, y: 52, width: 160, height: 98 },
      guides: { x: 200, y: 150 },
    });

    expect(
      snapDesignResizeRect(
        { x: 103, y: 52, width: 94, height: 95 },
        "w",
        [{ x: 0, y: 40, width: 100, height: 110 }],
        5,
      ),
    ).toEqual({
      rect: { x: 100, y: 52, width: 97, height: 95 },
      guides: { x: 100 },
    });
  });

  it("measures the nearest visible gap on each side of a selection", () => {
    expect(
      designSpacingMeasurements({ x: 100, y: 100, width: 80, height: 60 }, [
        { x: 20, y: 110, width: 50, height: 20 },
        { x: 200, y: 120, width: 40, height: 20 },
        { x: 110, y: 50, width: 20, height: 30 },
        { x: 120, y: 180, width: 20, height: 30 },
        // Farther candidates must not replace the nearest gap.
        { x: 0, y: 115, width: 20, height: 10 },
      ]),
    ).toEqual([
      {
        side: "left",
        axis: "horizontal",
        x: 70,
        y: 120,
        length: 30,
        distance: 30,
      },
      {
        side: "right",
        axis: "horizontal",
        x: 180,
        y: 130,
        length: 20,
        distance: 20,
      },
      {
        side: "top",
        axis: "vertical",
        x: 120,
        y: 80,
        length: 20,
        distance: 20,
      },
      {
        side: "bottom",
        axis: "vertical",
        x: 130,
        y: 160,
        length: 20,
        distance: 20,
      },
    ]);
  });

  it("normalizes pointer rotation across the angle seam and supports snapping", () => {
    const center = { x: 100, y: 100 };
    expect(
      designPointerRotation(center, { x: 99, y: 90 }, { x: 101, y: 90 }),
    ).toBeCloseTo(11.421, 3);
    expect(
      designPointerRotation(center, { x: 100, y: 80 }, { x: 117, y: 90 }, 15),
    ).toBe(60);
  });
});
