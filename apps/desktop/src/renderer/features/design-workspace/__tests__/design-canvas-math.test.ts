import { describe, expect, it, vi } from "vitest";

import {
  DESIGN_ROTATION_CORNERS,
  designAuthoredResizeAxis,
  designCanvasPointFromClient,
  designCanvasRectFromPoints,
  designConstraintGuides,
  designConstraintSides,
  designCssSizeAfterResize,
  designLocalDelta,
  designOriginFraction,
  designOriginTranslationShift,
  designResizeStyleAxes,
  designResizeAnchor,
  designResizeLayoutOffset,
  designRotatedResizeOrigin,
  designRotationCursor,
  designSelectionBox,
  designSelectionBoxBounds,
  designSelectionBoxCorners,
  designSelectionOverlayFrame,
  designSelectionPivot,
  designGridTrackSegments,
  designHighResolutionViewportTile,
  designInlineGapDistributionStyles,
  designInlineGapGeometry,
  designInlineGapRegions,
  designInlineSpacingValue,
  designSelectionClickIntent,
  designMeasureSpacing,
  designPointerRotation,
  designWheelDeltaPixels,
  designWheelZoomFactor,
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
  it("rebases extreme zoom into one bounded device-resolution viewport tile", () => {
    const zoom = 256;
    const frame = {
      file: "home.html",
      x: 100,
      y: 80,
      width: 1_000,
      height: 700,
    };
    const view = {
      zoom,
      panX: 300 - (frame.x + 505) * zoom,
      panY: 350 - (frame.y + 351) * zoom,
    };

    const tile = designHighResolutionViewportTile({
      frame,
      view,
      viewport: { width: 600, height: 700 },
      devicePixelRatio: 2,
      overscan: 32,
    });

    expect(tile).not.toBeNull();
    expect(tile?.crop.width).toBeCloseTo((600 + 64) / zoom);
    expect(tile?.crop.height).toBeCloseTo((700 + 64) / zoom);
    expect(tile?.outputWidth).toBe(1_328);
    expect(tile?.outputHeight).toBe(1_528);
    expect(tile?.crop.width).toBeLessThan(frame.width / 100);
    expect(tile?.crop.height).toBeLessThan(frame.height / 100);
  });

  it("does not allocate a high-resolution tile for an offscreen frame", () => {
    expect(
      designHighResolutionViewportTile({
        frame: { x: 5_000, y: 5_000, width: 400, height: 300 },
        view: { zoom: 16, panX: 0, panY: 0 },
        viewport: { width: 800, height: 600 },
        devicePixelRatio: 2,
      }),
    ).toBeNull();
  });

  it("oversamples high-zoom viewport tiles even on a 1x display", () => {
    const tile = designHighResolutionViewportTile({
      frame: { x: 0, y: 0, width: 100, height: 100 },
      view: { zoom: 8, panX: 0, panY: 0 },
      viewport: { width: 400, height: 300 },
      devicePixelRatio: 1,
    });

    expect(tile).not.toBeNull();
    expect(tile?.crop).toEqual({ x: 0, y: 0, width: 50, height: 37.5 });
    expect(tile?.outputWidth).toBe(800);
    expect(tile?.outputHeight).toBe(600);
  });

  it("maps insertion gestures through viewport pan and zoom", () => {
    expect(
      designCanvasPointFromClient(
        { x: 380, y: 260 },
        { left: 100, top: 60 },
        { zoom: 0.5, panX: 40, panY: 20 },
      ),
    ).toEqual({ x: 480, y: 360 });
  });

  it("normalizes reverse insertion drags without losing exact bounds", () => {
    expect(
      designCanvasRectFromPoints({ x: 420, y: 300 }, { x: 120, y: 90 }),
    ).toEqual({ x: 120, y: 90, width: 300, height: 210 });
  });

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

  it("normalizes pixel, line, and page wheel deltas onto one zoom curve", () => {
    expect(designWheelDeltaPixels(12, 0, 900)).toBe(12);
    expect(designWheelDeltaPixels(3, 1, 900)).toBe(48);
    expect(designWheelDeltaPixels(-0.5, 2, 900)).toBe(-450);
    expect(designWheelDeltaPixels(Number.NaN, 0, 900)).toBe(0);
  });

  it("tracks Chromium's synthesized pinch scale one-to-one", () => {
    // Chromium encodes trackpad pinch as ctrl+wheel with deltaY ≈ -100·ln(s):
    // inverting it must reproduce the native pinch scale exactly.
    const scale = 1.18;
    expect(
      designWheelZoomFactor({
        deltaY: -100 * Math.log(scale),
        deltaMode: 0,
        ctrlKey: true,
        metaKey: false,
        pageHeight: 900,
      }),
    ).toBeCloseTo(scale, 10);
  });

  it("keeps command-scroll zoom on the flatter trackpad scroll curve", () => {
    expect(
      designWheelZoomFactor({
        deltaY: -120,
        deltaMode: 0,
        ctrlKey: false,
        metaKey: true,
        pageHeight: 900,
      }),
    ).toBeCloseTo(Math.exp(120 * 0.002), 10);
    // Meta wins when a pinch-style ctrl flag rides along with it.
    expect(
      designWheelZoomFactor({
        deltaY: -120,
        deltaMode: 0,
        ctrlKey: true,
        metaKey: true,
        pageHeight: 900,
      }),
    ).toBeCloseTo(Math.exp(120 * 0.002), 10);
  });

  it("clamps one physical ctrl-wheel notch to a familiar zoom step", () => {
    // A discrete mouse notch reports |deltaY| ≈ 120; unclamped pinch math
    // would jump 3.3× per detent.
    expect(
      designWheelZoomFactor({
        deltaY: -120,
        deltaMode: 0,
        ctrlKey: true,
        metaKey: false,
        pageHeight: 900,
      }),
    ).toBeCloseTo(Math.exp(0.3), 10);
    expect(
      designWheelZoomFactor({
        deltaY: 120,
        deltaMode: 0,
        ctrlKey: true,
        metaKey: false,
        pageHeight: 900,
      }),
    ).toBeCloseTo(Math.exp(-0.3), 10);
    // Command-scroll bursts keep their historical ±4 exponent guard.
    expect(
      designWheelZoomFactor({
        deltaY: -8_000,
        deltaMode: 0,
        ctrlKey: false,
        metaKey: true,
        pageHeight: 900,
      }),
    ).toBeCloseTo(Math.exp(4), 10);
  });

  it("gives pinch deltas five times the proximity of command-scroll", () => {
    const pinch = designWheelZoomFactor({
      deltaY: -12,
      deltaMode: 0,
      ctrlKey: true,
      metaKey: false,
      pageHeight: 900,
    });
    const scroll = designWheelZoomFactor({
      deltaY: -12,
      deltaMode: 0,
      ctrlKey: false,
      metaKey: true,
      pageHeight: 900,
    });
    expect(Math.log(pinch) / Math.log(scroll)).toBeCloseTo(5, 10);
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
    ).toBeCloseTo(57.2);
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

    // A frame the Layers panel holds open needs its runtime to answer with a
    // tree, so that demand ranks with the selection instead of with distance.
    const withOpenLayers = selectLiveDesignFrameFiles({
      frames,
      viewport: { width: 1_000, height: 700 },
      view: { zoom: 1, panX: -5_000, panY: 0 },
      selectedFrame: null,
      maxLive: 4,
      requiredFiles: ["frame-0.html", "missing.html"],
    });
    expect(withOpenLayers.has("frame-0.html")).toBe(true);
    expect(withOpenLayers.has("missing.html")).toBe(false);
    expect(withOpenLayers.size).toBe(4);
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

  it("authors only the dimensions controlled by the active resize edge", () => {
    expect(designResizeStyleAxes("e")).toEqual({ width: true, height: false });
    expect(designResizeStyleAxes("n")).toEqual({ width: false, height: true });
    expect(designResizeStyleAxes("sw")).toEqual({ width: true, height: true });
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

  it("measures all four inset distances on the inner box's center axes", () => {
    expect(
      designMeasureSpacing(
        { x: 100, y: 80, width: 60, height: 40 },
        { x: 0, y: 0, width: 400, height: 300 },
      ),
    ).toEqual({
      lines: [
        {
          side: "left",
          axis: "horizontal",
          x: 0,
          y: 100,
          length: 100,
          distance: 100,
        },
        {
          side: "right",
          axis: "horizontal",
          x: 160,
          y: 100,
          length: 240,
          distance: 240,
        },
        {
          side: "top",
          axis: "vertical",
          x: 130,
          y: 0,
          length: 80,
          distance: 80,
        },
        {
          side: "bottom",
          axis: "vertical",
          x: 130,
          y: 120,
          length: 180,
          distance: 180,
        },
      ],
      extensions: [],
    });
    // Measuring into an owned child inverts containment but keeps the same
    // four inset readings, anchored on the child's center axes.
    expect(
      designMeasureSpacing(
        { x: 0, y: 0, width: 400, height: 300 },
        { x: 50, y: 50, width: 100, height: 100 },
      ).lines.map(({ side, distance }) => ({ side, distance })),
    ).toEqual([
      { side: "left", distance: 50 },
      { side: "right", distance: 250 },
      { side: "top", distance: 50 },
      { side: "bottom", distance: 150 },
    ]);
  });

  it("measures the gap to a disjoint neighbor and projects its edges", () => {
    expect(
      designMeasureSpacing(
        { x: 100, y: 100, width: 80, height: 60 },
        { x: 300, y: 220, width: 100, height: 50 },
      ),
    ).toEqual({
      lines: [
        {
          side: "right",
          axis: "horizontal",
          x: 180,
          y: 130,
          length: 120,
          distance: 120,
        },
        {
          side: "bottom",
          axis: "vertical",
          x: 140,
          y: 160,
          length: 60,
          distance: 60,
        },
      ],
      extensions: [
        { axis: "vertical", x: 300, y: 130, length: 90 },
        { axis: "horizontal", x: 140, y: 220, length: 160 },
      ],
    });
  });

  it("measures same-side edge deltas when the boxes overlap on an axis", () => {
    expect(
      designMeasureSpacing(
        { x: 100, y: 100, width: 100, height: 80 },
        { x: 140, y: 60, width: 200, height: 200 },
      ),
    ).toEqual({
      lines: [
        {
          side: "left",
          axis: "horizontal",
          x: 100,
          y: 140,
          length: 40,
          distance: 40,
        },
        {
          side: "right",
          axis: "horizontal",
          x: 200,
          y: 140,
          length: 140,
          distance: 140,
        },
        {
          side: "top",
          axis: "vertical",
          x: 150,
          y: 60,
          length: 40,
          distance: 40,
        },
        {
          side: "bottom",
          axis: "vertical",
          x: 150,
          y: 180,
          length: 80,
          distance: 80,
        },
      ],
      extensions: [],
    });
  });

  it("converts direct padding and gap drags into clamped, snapped values", () => {
    expect(designInlineSpacingValue(16, 5.2, 1)).toBe(21);
    expect(designInlineSpacingValue(16, 5.2, -1)).toBe(11);
    expect(designInlineSpacingValue(2, 20, -1)).toBe(0);
    expect(designInlineSpacingValue(16, 5.2, 1, 8)).toBe(24);
  });

  it("places flex gap controls only inside real spaces between direct children", () => {
    expect(
      designInlineGapRegions({
        container: { x: 100, y: 200, width: 300, height: 400 },
        children: [
          {
            id: "first",
            rect: { x: 120, y: 220, width: 100, height: 40 },
          },
          {
            id: "ignored-absolute",
            position: "absolute",
            rect: { x: 120, y: 265, width: 100, height: 10 },
          },
          {
            id: "second",
            rect: { x: 120, y: 280, width: 100, height: 40 },
          },
          {
            id: "third",
            rect: { x: 120, y: 360, width: 100, height: 40 },
          },
        ],
        display: "flex",
        flexDirection: "column",
        flexWrap: "nowrap",
      }),
    ).toEqual([
      {
        key: "y:first:second",
        property: "gap",
        axis: "y",
        x: 20,
        y: 60,
        width: 100,
        height: 20,
        leadingId: "first",
        trailingId: "second",
      },
      {
        key: "y:second:third",
        property: "gap",
        axis: "y",
        x: 20,
        y: 120,
        width: 100,
        height: 40,
        leadingId: "second",
        trailingId: "third",
      },
    ]);
  });

  it("spans the complete content cross-axis for non-wrapping flex gaps", () => {
    expect(
      designInlineGapRegions({
        container: { x: 100, y: 200, width: 360, height: 400 },
        children: [
          { id: "wide", rect: { x: 120, y: 220, width: 220, height: 40 } },
          { id: "narrow", rect: { x: 210, y: 300, width: 24, height: 20 } },
          { id: "medium", rect: { x: 150, y: 360, width: 140, height: 40 } },
        ],
        display: "flex",
        flexDirection: "column",
        flexWrap: "nowrap",
      }),
    ).toMatchObject([
      { key: "y:wide:narrow", x: 20, width: 220 },
      { key: "y:narrow:medium", x: 20, width: 220 },
    ]);
  });

  it("exposes both row and column gaps for wrapped and grid layouts", () => {
    const children = [
      { id: "a", rect: { x: 0, y: 0, width: 50, height: 40 } },
      { id: "b", rect: { x: 70, y: 0, width: 50, height: 40 } },
      { id: "c", rect: { x: 0, y: 60, width: 50, height: 40 } },
      { id: "d", rect: { x: 70, y: 60, width: 50, height: 40 } },
    ];

    const wrapped = designInlineGapRegions({
      container: { x: 0, y: 0, width: 120, height: 100 },
      children,
      display: "flex",
      flexDirection: "row",
      flexWrap: "wrap",
    });
    expect(wrapped.map(({ key, property }) => ({ key, property }))).toEqual([
      { key: "x:a:b", property: "column-gap" },
      { key: "x:c:d", property: "column-gap" },
      { key: "y:a:c", property: "row-gap" },
      { key: "y:b:d", property: "row-gap" },
    ]);

    const grid = designInlineGapRegions({
      container: { x: 0, y: 0, width: 120, height: 100 },
      children,
      display: "grid",
    });
    expect(grid.map(({ key, property }) => ({ key, property }))).toEqual(
      wrapped.map(({ key, property }) => ({ key, property })),
    );
  });

  it("retains a zero-width gap boundary so zero spacing stays discoverable", () => {
    expect(
      designInlineGapRegions({
        container: { x: 0, y: 0, width: 100, height: 40 },
        children: [
          { id: "a", rect: { x: 0, y: 0, width: 50, height: 40 } },
          { id: "b", rect: { x: 50, y: 0, width: 50, height: 40 } },
        ],
        display: "flex",
        flexDirection: "row",
      }),
    ).toMatchObject([
      {
        key: "x:a:b",
        property: "gap",
        axis: "x",
        x: 50,
        width: 0,
      },
    ]);
  });

  it("separates a forgiving gap hit target from the exact visible gap", () => {
    expect(
      designInlineGapGeometry(
        {
          key: "x:a:b",
          property: "gap",
          axis: "x",
          x: 50,
          y: 8,
          width: 0,
          height: 24,
          leadingId: "a",
          trailingId: "b",
        },
        1,
      ),
    ).toEqual({
      hitRect: { x: 41, y: 8, width: 18, height: 24 },
      visualRect: { x: 9, y: 0, width: 0, height: 24 },
    });

    expect(
      designInlineGapGeometry(
        {
          key: "y:a:b",
          property: "row-gap",
          axis: "y",
          x: 12,
          y: 40,
          width: 80,
          height: 6,
          leadingId: "a",
          trailingId: "b",
        },
        2,
      ),
    ).toEqual({
      hitRect: { x: 12, y: 38.5, width: 80, height: 9 },
      visualRect: { x: 0, y: 1.5, width: 80, height: 6 },
    });
  });

  it("converts Auto-distributed flex space to fixed spacing on the dragged axis", () => {
    expect(
      designInlineGapDistributionStyles({
        display: "flex",
        flexDirection: "row",
        flexWrap: "nowrap",
        axis: "x",
        justifyContent: "space-between",
        alignContent: "normal",
      }),
    ).toEqual({ "justify-content": "flex-start" });
    expect(
      designInlineGapDistributionStyles({
        display: "flex",
        flexDirection: "row",
        flexWrap: "wrap",
        axis: "y",
        justifyContent: "flex-start",
        alignContent: "space-between",
      }),
    ).toEqual({ "align-content": "flex-start" });
    expect(
      designInlineGapDistributionStyles({
        display: "grid",
        flexDirection: "row",
        flexWrap: "nowrap",
        axis: "x",
        justifyContent: "space-between",
        alignContent: "space-between",
      }),
    ).toEqual({});
  });

  it("projects computed grid tracks into canvas segment geometry", () => {
    expect(designGridTrackSegments("100px 200px 100px", 400)).toEqual([
      { start: 0, end: 25, label: "100px" },
      { start: 25, end: 75, label: "200px" },
      { start: 75, end: 100, label: "100px" },
    ]);
    expect(designGridTrackSegments("repeat(3, 1fr)", 300)).toEqual([
      { start: 0, end: 33.3, label: "1fr" },
      { start: 33.3, end: 66.7, label: "1fr" },
      { start: 66.7, end: 100, label: "1fr" },
    ]);
    expect(designGridTrackSegments("none", 300)).toEqual([]);
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

describe("design rotated selection geometry", () => {
  const upright = {
    x: 100,
    y: 50,
    width: 200,
    height: 100,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    originX: 0.5,
    originY: 0.5,
  };

  it("falls back to the axis-aligned rect and its computed pivot", () => {
    expect(
      designSelectionBox({
        rect: { x: 12, y: 20, width: 200, height: 80 },
        styles: { transformOrigin: "50px 20px" },
      }),
    ).toEqual({
      x: 12,
      y: 20,
      width: 200,
      height: 80,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      originX: 0.25,
      originY: 0.25,
    });
    // A runtime-reported box always wins over the rect.
    expect(
      designSelectionBox({
        rect: { x: 0, y: 0, width: 10, height: 10 },
        box: { ...upright, rotation: 30 },
      }).rotation,
    ).toBe(30);
  });

  it("anchors a rotated overlay on the pivot a rotation cannot move", () => {
    // An upright box needs no compensation at all, so existing placement and
    // every geometry assertion built on it stay byte-identical.
    expect(designSelectionOverlayFrame(upright)).toEqual({
      left: 100,
      top: 50,
      width: 200,
      height: 100,
      rotation: 0,
      pivotX: 100,
      pivotY: 50,
    });
    // Rotating about the center: the overlay's own box shifts so that rotating
    // it about the same pivot reproduces the painted shape.
    const turned = designSelectionOverlayFrame({ ...upright, rotation: 90 });
    expect(turned.left).toBeCloseTo(100 + (-50 - 100), 6);
    expect(turned.top).toBeCloseTo(50 + (100 - 50), 6);
    // A corner pivot leaves the box exactly where the element's corner is.
    expect(
      designSelectionOverlayFrame({
        ...upright,
        rotation: 37,
        originX: 0,
        originY: 0,
      }),
    ).toMatchObject({ left: 100, top: 50, pivotX: 0, pivotY: 0 });
    // Painted size folds in scale, so handles and labels stay undistorted.
    expect(
      designSelectionOverlayFrame({ ...upright, scaleX: 2, scaleY: 0.5 }),
    ).toMatchObject({ width: 400, height: 50 });
  });

  it("places rotated corners and the pivot in frame coordinates", () => {
    const corners = designSelectionBoxCorners({ ...upright, rotation: 90 });
    expect(corners[0]).toEqual({ x: 100, y: 50 });
    expect(corners[1]?.x).toBeCloseTo(100, 6);
    expect(corners[1]?.y).toBeCloseTo(250, 6);
    expect(corners[2]?.x).toBeCloseTo(0, 6);
    expect(corners[2]?.y).toBeCloseTo(250, 6);
    expect(designSelectionPivot(upright)).toEqual({ x: 200, y: 100 });
    const pivot = designSelectionPivot({ ...upright, rotation: 180 });
    expect(pivot.x).toBeCloseTo(0, 6);
    expect(pivot.y).toBeCloseTo(0, 6);
  });

  it("rotates pointer deltas into the element's own axes", () => {
    const local = designLocalDelta({ x: 10, y: 0 }, 90);
    expect(local.x).toBeCloseTo(0, 6);
    expect(local.y).toBeCloseTo(-10, 6);
    expect(designLocalDelta({ x: 3, y: -4 }, 0)).toEqual({ x: 3, y: -4 });
  });

  it("snaps a dragged pivot to the nine standard anchors", () => {
    // Coordinates are box-local: the caller un-rotates the pointer first.
    expect(designOriginFraction(upright, { x: 4, y: -2 }, 6)).toEqual({
      originX: 0,
      originY: 0,
      snappedX: true,
      snappedY: true,
    });
    expect(designOriginFraction(upright, { x: 150, y: 48 }, 6)).toEqual({
      originX: 0.75,
      originY: 0.5,
      snappedX: false,
      snappedY: true,
    });
    // No tolerance means no snapping, and a pivot may leave its box.
    expect(designOriginFraction(upright, { x: -100, y: 250 })).toEqual({
      originX: -0.5,
      originY: 2.5,
      snappedX: false,
      snappedY: false,
    });
    // An origin cannot orbit arbitrarily far from the box it turns.
    expect(designOriginFraction(upright, { x: 100_000, y: -100_000 })).toEqual({
      originX: 4,
      originY: -3,
      snappedX: false,
      snappedY: false,
    });
  });

  it("compensates a moved pivot so the element itself does not move", () => {
    const identity = designOriginTranslationShift({
      width: 200,
      height: 100,
      originX: 0.5,
      originY: 0.5,
      nextOriginX: 0,
      nextOriginY: 0,
      transform: { rotate: 0, scaleX: 1, scaleY: 1, skewX: 0, skewY: 0 },
    });
    // With no transform there is nothing to compensate.
    expect(identity.x).toBeCloseTo(0, 6);
    expect(identity.y).toBeCloseTo(0, 6);
    // Under a quarter turn, (I - R)(origin - next) rotates the pivot delta.
    const quarter = designOriginTranslationShift({
      width: 200,
      height: 100,
      originX: 0.5,
      originY: 0.5,
      nextOriginX: 0,
      nextOriginY: 0,
      transform: { rotate: 90, scaleX: 1, scaleY: 1, skewX: 0, skewY: 0 },
    });
    expect(quarter.x).toBeCloseTo(150, 6);
    expect(quarter.y).toBeCloseTo(-50, 6);
  });

  it("recovers the held anchor from an unrotated resize result", () => {
    const start = { x: 0, y: 0, width: 200, height: 100 };
    // Dragging the north-west handle out by 60 × 30 holds the south-east corner.
    expect(
      designResizeAnchor(start, resizeDesignRect(start, -60, -30, "nw")),
    ).toEqual({ x: 1, y: 1 });
    expect(
      designResizeAnchor(start, resizeDesignRect(start, 60, 30, "se")),
    ).toEqual({ x: 0, y: 0 });
    // Option-resize holds the center on both axes.
    expect(
      designResizeAnchor(
        start,
        resizeDesignRect(start, 60, 30, "se", { fromCenter: true }),
      ),
    ).toEqual({ x: 0.5, y: 0.5 });
    // Shift-resize from an edge handle changes the untouched axis about its
    // center, which the recovered anchor reports rather than assumes.
    expect(
      designResizeAnchor(
        start,
        resizeDesignRect(start, 60, 0, "e", { keepAspect: true }),
      ),
    ).toEqual({ x: 0, y: 0.5 });
  });

  it("keeps the pinned corner still while a rotated box resizes", () => {
    // Unrotated, growing from the south-east handle leaves the box position
    // alone; growing from the north-west moves it by the growth.
    expect(
      designRotatedResizeOrigin({
        box: upright,
        anchor: { x: 0, y: 0 },
        width: 260,
        height: 130,
      }),
    ).toEqual({ x: 100, y: 50 });
    expect(
      designRotatedResizeOrigin({
        box: upright,
        anchor: { x: 1, y: 1 },
        width: 260,
        height: 130,
      }),
    ).toEqual({ x: 40, y: 20 });
    // Rotated a quarter turn, that same growth moves the box along the
    // element's own axes instead of the screen's.
    const box = { ...upright, rotation: 90 };
    const turned = designRotatedResizeOrigin({
      box,
      anchor: { x: 1, y: 1 },
      width: 260,
      height: 130,
    });
    expect(turned.x).toBeCloseTo(130, 6);
    expect(turned.y).toBeCloseTo(-10, 6);
    // Independent check: the pinned corner has not moved on canvas.
    const pinned = designSelectionBoxCorners(box)[2];
    const resized = designSelectionBoxCorners({
      ...box,
      x: turned.x,
      y: turned.y,
      width: 260,
      height: 130,
    })[2];
    expect(resized?.x).toBeCloseTo(pinned?.x ?? Number.NaN, 6);
    expect(resized?.y).toBeCloseTo(pinned?.y ?? Number.NaN, 6);
  });

  it("cancels the drift a transformed element picks up while resizing", () => {
    const shared = {
      anchor: { x: 1, y: 1 },
      originX: 0.5,
      originY: 0.5,
      deltaWidth: 60,
      deltaHeight: 30,
    };
    // Without a transform this is exactly the offset the old resize authored.
    expect(
      designResizeLayoutOffset({
        ...shared,
        transform: { rotate: 0, scaleX: 1, scaleY: 1, skewX: 0, skewY: 0 },
      }),
    ).toEqual({ x: -60, y: -30 });
    // Quarter-turned about its center, a 200×100 box grown by 60×30 from the
    // north-west handle must author (-15, -45) to hold its far corner: the
    // element's own painted anchor sits at (50, 150) before and after.
    const rotated = designResizeLayoutOffset({
      ...shared,
      transform: { rotate: 90, scaleX: 1, scaleY: 1, skewX: 0, skewY: 0 },
    });
    expect(rotated.x).toBeCloseTo(-15, 6);
    expect(rotated.y).toBeCloseTo(-45, 6);
    // A pivot on the anchored corner leaves nothing to cancel: the element
    // grows away from exactly the point it turns about.
    const pinnedPivot = designResizeLayoutOffset({
      ...shared,
      originX: 1,
      originY: 1,
      transform: { rotate: 90, scaleX: 1, scaleY: 1, skewX: 0, skewY: 0 },
    });
    expect(pinnedPivot.x).toBeCloseTo(-60, 6);
    expect(pinnedPivot.y).toBeCloseTo(-30, 6);
  });

  it("spans a rotated box with its own bounding box", () => {
    expect(designSelectionBoxBounds(upright)).toEqual({
      x: 100,
      y: 50,
      width: 200,
      height: 100,
    });
    const turned = designSelectionBoxBounds({ ...upright, rotation: 90 });
    expect(turned.x).toBeCloseTo(0, 6);
    expect(turned.y).toBeCloseTo(50, 6);
    expect(turned.width).toBeCloseTo(100, 6);
    expect(turned.height).toBeCloseTo(200, 6);
  });

  it("reads constraints off the CSS that actually pins the element", () => {
    // Offsets do not apply to a static box; flow anchors it to the start edges.
    expect(
      designConstraintSides({
        position: "static",
        authored: ["right", "bottom"],
      }),
    ).toEqual({ horizontal: ["left"], vertical: ["top"] });
    // A relative box computes both offsets of an axis symmetrically, so only the
    // authored side is a real constraint.
    expect(
      designConstraintSides({
        position: "relative",
        authored: ["right", "top"],
        styles: { left: "-20px", right: "20px", top: "8px", bottom: "-8px" },
      }),
    ).toEqual({ horizontal: ["right"], vertical: ["top"] });
    // Pinning both sides stretches the element with its parent.
    expect(
      designConstraintSides({
        position: "absolute",
        authored: ["left", "right", "bottom"],
      }),
    ).toEqual({ horizontal: ["left", "right"], vertical: ["bottom"] });
    // Without authored provenance, a resolved offset still reads as a pin.
    expect(
      designConstraintSides({
        position: "absolute",
        styles: { left: "auto", right: "12px", top: "auto", bottom: "auto" },
      }),
    ).toEqual({ horizontal: ["right"], vertical: ["top"] });
  });

  it("measures constraint runs to the pinned parent edges only", () => {
    const parent = { x: 0, y: 0, width: 500, height: 400 };
    const bounds = { x: 100, y: 50, width: 200, height: 100 };
    expect(
      designConstraintGuides(bounds, parent, {
        horizontal: ["right"],
        vertical: ["bottom"],
      }),
    ).toEqual([
      { side: "right", axis: "horizontal", x: 300, y: 100, length: 200 },
      { side: "bottom", axis: "vertical", x: 200, y: 150, length: 250 },
    ]);
    expect(
      designConstraintGuides(bounds, parent, {
        horizontal: ["left", "right"],
        vertical: ["top"],
      }),
    ).toEqual([
      { side: "left", axis: "horizontal", x: 0, y: 100, length: 100 },
      { side: "right", axis: "horizontal", x: 300, y: 100, length: 200 },
      { side: "top", axis: "vertical", x: 200, y: 0, length: 50 },
    ]);
    // An element outside its parent reports no negative run.
    expect(
      designConstraintGuides({ x: -40, y: 50, width: 20, height: 20 }, parent, {
        horizontal: ["left"],
        vertical: [],
      }),
    ).toEqual([{ side: "left", axis: "horizontal", x: 0, y: 60, length: 0 }]);
  });

  it("bakes a quantized angle into the rotation cursor", () => {
    const cursor = designRotationCursor(46);
    expect(cursor.startsWith('url("data:image/svg+xml,<svg')).toBe(true);
    expect(cursor).toContain("rotate(45 12 12)");
    expect(cursor.endsWith('") 12 12, crosshair')).toBe(true);
    // A cursor image cannot resolve CSS variables, and a data URL cannot carry
    // a raw "#", so the colors stay percent-encoded literals.
    expect(cursor).toContain("stroke='%23fff'");
    expect(designRotationCursor(-7)).toContain("rotate(0 12 12)");
    expect(designRotationCursor(Number.NaN)).toContain("rotate(0 12 12)");
    expect(DESIGN_ROTATION_CORNERS.map((corner) => corner.corner)).toEqual([
      "nw",
      "ne",
      "se",
      "sw",
    ]);
  });
});

describe("designAuthoredResizeAxis", () => {
  /** The reported shake: dragging the west edge of a box whose layout offset and
   * width are both fractional used to move the anchored east edge a whole pixel
   * back and forth, twice per pixel of travel. */
  it("holds the edge the pointer is not dragging exactly still", () => {
    const offset = 10.34;
    const size = 137.21;
    const edges = new Set<number>();
    for (let travel = 0; travel > -6; travel -= 0.15) {
      const axis = designAuthoredResizeAxis({
        offset,
        size,
        startTravel: travel,
        endTravel: 0,
        authorsOffset: true,
      });
      edges.add(axis.offset + axis.size);
      // Both authored values are whole pixels.
      expect(axis.offset).toBe(Math.round(axis.offset));
      expect(axis.size).toBe(Math.round(axis.size));
    }
    expect(edges.size).toBe(1);
  });

  it("keeps the dragged edge monotone in its own travel", () => {
    const sizes = [0, -0.4, -0.9, -1.6, -2.2, -3.1].map(
      (travel) =>
        designAuthoredResizeAxis({
          offset: 10.34,
          size: 137.21,
          startTravel: travel,
          endTravel: 0,
          authorsOffset: true,
        }).size,
    );
    for (let index = 1; index < sizes.length; index += 1) {
      expect(sizes[index]!).toBeGreaterThanOrEqual(sizes[index - 1]!);
    }
  });

  it("leaves the offset alone when the handle does not author it", () => {
    const axis = designAuthoredResizeAxis({
      offset: 10.34,
      size: 137.21,
      startTravel: 0,
      endTravel: 12.6,
      authorsOffset: false,
    });
    expect(axis).toEqual({
      offset: 10.34,
      size: 150,
      offsetTravel: 0,
      sizeTravel: 150 - 137.21,
    });
  });

  it("reports the travel the authored integers actually produce", () => {
    const axis = designAuthoredResizeAxis({
      offset: 20,
      size: 100,
      startTravel: -4.7,
      endTravel: 0,
      authorsOffset: true,
    });
    expect(axis.offset).toBe(15);
    expect(axis.offsetTravel).toBe(-5);
    expect(axis.size).toBe(105);
    expect(axis.sizeTravel).toBe(5);
  });

  it("never authors a size below the minimum", () => {
    const axis = designAuthoredResizeAxis({
      offset: 0,
      size: 40,
      startTravel: 80,
      endTravel: 0,
      authorsOffset: true,
      minimum: 1,
    });
    expect(axis.size).toBe(1);
  });
});
