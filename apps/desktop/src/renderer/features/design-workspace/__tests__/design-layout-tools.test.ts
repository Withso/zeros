import { describe, expect, it } from "vitest";

import {
  designConstraintGuidesApply,
  designConstraintReferenceRect,
  designFlexGaps,
  designGapDistribution,
  designGapDragDirection,
  designGapUsedValue,
  designGridTrackLayout,
  designGridTrackSizes,
  designLayoutChildLocalRect,
  designLayoutToolModel,
  designLayoutToolsFit,
  designLocalAxisCursor,
  designLocalAxisDelta,
  designPaddingBandAtPoint,
  designPaddingBands,
  designSizeBadgeText,
  designSpacingDragValue,
  designSpacingModifiers,
} from "../design-layout-tools";

const styles = (overrides: Record<string, string> = {}) => ({
  display: "flex",
  flexDirection: "row",
  flexWrap: "nowrap",
  paddingTop: "0px",
  paddingRight: "0px",
  paddingBottom: "0px",
  paddingLeft: "0px",
  borderTopWidth: "0px",
  borderRightWidth: "0px",
  borderBottomWidth: "0px",
  borderLeftWidth: "0px",
  rowGap: "normal",
  columnGap: "normal",
  ...overrides,
});

describe("padding bands", () => {
  it("starts each band inside the border and keeps its measured depth", () => {
    const bands = designPaddingBands({
      width: 600,
      height: 300,
      styles: styles({
        borderTopWidth: "20px",
        borderRightWidth: "20px",
        borderBottomWidth: "20px",
        borderLeftWidth: "20px",
        paddingTop: "40px",
        paddingRight: "40px",
        paddingBottom: "40px",
        paddingLeft: "40px",
      }),
    });
    const left = bands.find((band) => band.side === "left")!;
    expect(left.rect).toEqual({ x: 20, y: 20, width: 40, height: 260 });
    expect(left.handle).toEqual({ x: 40, y: 150 });
    expect(left.axis).toBe("x");
    expect(left.direction).toBe(1);
    const right = bands.find((band) => band.side === "right")!;
    expect(right.rect.x).toBe(540);
    expect(right.direction).toBe(-1);
  });

  it("never caps an asymmetric padding at half the box", () => {
    const left = designPaddingBands({
      width: 600,
      height: 300,
      styles: styles({ paddingLeft: "400px", paddingRight: "20px" }),
    }).find((band) => band.side === "left")!;
    expect(left.rect.width).toBe(400);
    expect(left.handle.x).toBe(200);
    expect(left.value).toBe(400);
  });

  it("scales local geometry but reports CSS values", () => {
    const top = designPaddingBands({
      width: 200,
      height: 100,
      styles: styles({ paddingTop: "10px" }),
      scale: { x: 2, y: 2 },
    }).find((band) => band.side === "top")!;
    expect(top.rect.height).toBe(20);
    expect(top.value).toBe(10);
  });

  it("resolves a corner to the side whose outer edge is nearer", () => {
    const bands = designPaddingBands({
      width: 300,
      height: 300,
      styles: styles({
        paddingTop: "60px",
        paddingRight: "60px",
        paddingBottom: "60px",
        paddingLeft: "60px",
      }),
    });
    expect(designPaddingBandAtPoint(bands, { x: 10, y: 40 })?.side).toBe(
      "left",
    );
    expect(designPaddingBandAtPoint(bands, { x: 40, y: 10 })?.side).toBe("top");
    expect(designPaddingBandAtPoint(bands, { x: 150, y: 150 })).toBeNull();
  });
});

describe("flex gaps", () => {
  const child = (id: string, x: number, y: number, w = 100, h = 80) => ({
    id,
    rect: { x, y, width: w, height: h },
  });

  it("separates a row's items with column-gap spanning the line", () => {
    const gaps = designFlexGaps({
      content: { x: 20, y: 20, width: 560, height: 260 },
      children: [child("a", 20, 20), child("b", 140, 20, 100, 40)],
      flexDirection: "row",
    });
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({
      property: "column-gap",
      axis: "x",
      x: 120,
      width: 20,
      y: 20,
      height: 80,
      size: 20,
    });
  });

  it("groups wrapped items into lines and exposes the line gap", () => {
    const gaps = designFlexGaps({
      content: { x: 20, y: 20, width: 280, height: 360 },
      children: [child("a", 20, 20), child("b", 140, 20), child("c", 20, 300)],
      flexDirection: "row",
      flexWrap: "wrap",
    });
    const line = gaps.find((gap) => gap.property === "row-gap")!;
    expect(line).toMatchObject({ axis: "y", y: 100, height: 200, size: 200 });
    expect(line.x).toBe(20);
    expect(line.width).toBe(280);
    expect(gaps.filter((gap) => gap.property === "column-gap")).toHaveLength(1);
  });

  it("ignores absolute children and keeps hidden slots", () => {
    const gaps = designFlexGaps({
      content: { x: 0, y: 0, width: 400, height: 100 },
      children: [
        child("a", 0, 0),
        { ...child("float", 110, 0), position: "absolute" },
        child("hidden", 120, 0),
        child("b", 240, 0),
      ],
    });
    expect(gaps.map((gap) => [gap.leadingId, gap.trailingId])).toEqual([
      ["a", "hidden"],
      ["hidden", "b"],
    ]);
  });
});

describe("grid tracks", () => {
  it("reads used track sizes and drops named lines", () => {
    expect(designGridTrackSizes("100px 140px 180px")).toEqual([100, 140, 180]);
    expect(
      designGridTrackSizes("[start] 100px [middle] 140px [end] 180px"),
    ).toEqual([100, 140, 180]);
    expect(designGridTrackSizes("repeat(3, 1fr)")).toBeNull();
  });

  it("places tracks at their real edges with gutters between", () => {
    const layout = designGridTrackLayout({
      template: "100px 140px 180px",
      gap: 40,
      contentStart: 40,
      contentSize: 520,
    })!;
    expect(layout.tracks.map((track) => track.start)).toEqual([40, 180, 360]);
    expect(layout.gutters).toEqual([
      { start: 140, size: 40 },
      { start: 320, size: 40 },
    ]);
  });

  it("adds distributed free space to the gutters", () => {
    const layout = designGridTrackLayout({
      template: "100px 100px",
      gap: 20,
      contentStart: 0,
      contentSize: 320,
      distribution: "space-between",
    })!;
    expect(layout.gutters).toEqual([{ start: 100, size: 120 }]);
  });
});

describe("gap semantics", () => {
  it("treats distributed axes as Auto with an axis-scoped release", () => {
    expect(
      designGapDistribution({
        display: "flex",
        flexDirection: "row",
        flexWrap: "wrap",
        alignContent: "space-between",
        property: "row-gap",
      }),
    ).toEqual({ automatic: true, reset: { "align-content": "flex-start" } });
    expect(
      designGapDistribution({
        display: "grid",
        justifyContent: "space-between",
        property: "column-gap",
      }),
    ).toEqual({ automatic: true, reset: { "justify-content": "start" } });
    expect(
      designGapDistribution({
        display: "flex",
        justifyContent: "center",
        property: "column-gap",
      }).automatic,
    ).toBe(false);
  });

  it("grows reversed and end-packed gaps toward the start", () => {
    expect(
      designGapDragDirection({
        display: "flex",
        flexDirection: "row-reverse",
        property: "column-gap",
      }),
    ).toBe(-1);
    expect(
      designGapDragDirection({
        display: "flex",
        flexDirection: "row",
        justifyContent: "flex-end",
        property: "column-gap",
      }),
    ).toBe(-1);
    expect(
      designGapDragDirection({
        display: "flex",
        flexDirection: "column",
        property: "row-gap",
      }),
    ).toBe(1);
  });

  it("labels an Auto gap with the space it renders", () => {
    const model = designLayoutToolModel({
      width: 600,
      height: 100,
      styles: styles({
        justifyContent: "space-between",
        columnGap: "20px",
      }),
      children: [
        { id: "a", rect: { x: 0, y: 0, width: 100, height: 100 } },
        { id: "b", rect: { x: 500, y: 0, width: 100, height: 100 } },
      ],
    })!;
    expect(model.gaps[0]).toMatchObject({ value: 400, automatic: true });
  });

  it("draws no tools for a box that does not lay out children", () => {
    expect(
      designLayoutToolModel({
        width: 100,
        height: 100,
        styles: styles({ display: "block" }),
        children: [],
      }),
    ).toBeNull();
  });
});

describe("transformed boxes", () => {
  it("projects a drag onto the turned local axis", () => {
    // A 90° turn maps local +x onto screen +y.
    expect(
      designLocalAxisDelta({ dx: 0, dy: 40, axis: "x", rotation: 90, zoom: 1 }),
    ).toBeCloseTo(40);
    expect(
      designLocalAxisDelta({ dx: 40, dy: 0, axis: "x", rotation: 90, zoom: 1 }),
    ).toBeCloseTo(0);
    expect(
      designLocalAxisDelta({ dx: 50, dy: 0, axis: "x", zoom: 0.5 }),
    ).toBeCloseTo(100);
  });

  it("points the cursor along the turned axis", () => {
    expect(designLocalAxisCursor("x", 0)).toBe("ew-resize");
    expect(designLocalAxisCursor("x", 90)).toBe("ns-resize");
    expect(designLocalAxisCursor("y", 45)).toBe("nesw-resize");
  });

  it("maps children through a quarter turn without inventing size", () => {
    const local = designLayoutChildLocalRect(
      { rect: { x: 180, y: 110, width: 80, height: 100 } },
      {
        rect: { x: 0, y: 0, width: 300, height: 400 },
        box: { x: 300, y: 0, rotation: 90, scaleX: 1, scaleY: 1 },
        styles: {},
      },
    );
    expect(local.width).toBeCloseTo(100);
    expect(local.height).toBeCloseTo(80);
    expect(local.x).toBeCloseTo(110);
    expect(local.y).toBeCloseTo(40);
  });
});

describe("spacing gestures", () => {
  it("follows Figma's modifier contract", () => {
    expect(
      designSpacingModifiers({ altKey: true, shiftKey: true }, true),
    ).toEqual({ mirror: "all", step: 1 });
    expect(
      designSpacingModifiers({ altKey: true, shiftKey: false }, true),
    ).toEqual({ mirror: "opposite", step: 1 });
    expect(
      designSpacingModifiers({ altKey: false, shiftKey: true }, true),
    ).toEqual({ mirror: "none", step: 10 });
    expect(
      designSpacingModifiers({ altKey: true, shiftKey: false }, false),
    ).toEqual({ mirror: "none", step: 1 });
  });

  it("clamps at zero and snaps to the requested step", () => {
    expect(
      designSpacingDragValue({ start: 20, delta: -40, direction: 1, step: 1 }),
    ).toBe(0);
    expect(
      designSpacingDragValue({ start: 20, delta: 14, direction: 1, step: 10 }),
    ).toBe(30);
    expect(
      designSpacingDragValue({ start: 20, delta: 14, direction: -1, step: 1 }),
    ).toBe(6);
  });

  it("hides tools on boxes too small to hold them on screen", () => {
    expect(designLayoutToolsFit({ width: 40, height: 24, zoom: 1 })).toBe(
      false,
    );
    expect(designLayoutToolsFit({ width: 600, height: 300, zoom: 0.25 })).toBe(
      true,
    );
  });
});

describe("constraints", () => {
  it("pins only out-of-flow boxes to a parent they are positioned in", () => {
    expect(
      designConstraintGuidesApply({ hasParent: true, position: "static" }),
    ).toBe(false);
    expect(
      designConstraintGuidesApply({ hasParent: true, position: "relative" }),
    ).toBe(false);
    expect(
      designConstraintGuidesApply({ hasParent: true, position: "absolute" }),
    ).toBe(true);
    expect(
      designConstraintGuidesApply({
        hasParent: true,
        position: "absolute",
        parentIsContainingBlock: false,
      }),
    ).toBe(false);
    expect(
      designConstraintGuidesApply({ hasParent: false, position: "absolute" }),
    ).toBe(false);
  });

  it("measures insets from the parent's padding edge", () => {
    expect(
      designConstraintReferenceRect(
        { x: 80, y: 80, width: 600, height: 300 },
        {
          borderTopWidth: "20px",
          borderRightWidth: "20px",
          borderBottomWidth: "20px",
          borderLeftWidth: "20px",
        },
      ),
    ).toEqual({ x: 100, y: 100, width: 560, height: 260 });
  });
});

describe("size badge", () => {
  it("names non-fixed sizing after each dimension", () => {
    expect(designSizeBadgeText(600, 300)).toBe("600 × 300");
    expect(designSizeBadgeText(546, 388.4, { y: "hug" })).toBe("546 × 388 Hug");
    expect(designSizeBadgeText(600, 300, { x: "fill", y: "hug" })).toBe(
      "600 Fill × 300 Hug",
    );
  });
});

describe("review regressions", () => {
  it("keeps the exact baseline when a drag returns to its origin", () => {
    expect(
      designSpacingDragValue({ start: 20.5, delta: 0, direction: 1, step: 1 }),
    ).toBe(20.5);
    expect(
      designSpacingDragValue({ start: 23, delta: 0.2, direction: 1, step: 10 }),
    ).toBe(23);
  });

  it("keeps opposite-aligned items on one stretched line", () => {
    const gaps = designFlexGaps({
      content: { x: 0, y: 0, width: 500, height: 200 },
      children: [
        { id: "a", rect: { x: 0, y: 0, width: 100, height: 20 } },
        { id: "b", rect: { x: 120, y: 180, width: 100, height: 20 } },
      ],
      flexDirection: "row",
      flexWrap: "wrap",
    });
    expect(gaps.map((gap) => gap.property)).toEqual(["column-gap"]);
  });

  it("grows right-to-left rows toward the left", () => {
    expect(
      designGapDragDirection({
        display: "flex",
        flexDirection: "row",
        direction: "rtl",
        property: "column-gap",
      }),
    ).toBe(-1);
    expect(
      designGapDragDirection({
        display: "flex",
        flexDirection: "row-reverse",
        direction: "rtl",
        property: "column-gap",
      }),
    ).toBe(1);
  });

  it("resolves percentage gaps against the content box", () => {
    expect(designGapUsedValue({ columnGap: "10%" }, "column-gap", 600)).toBe(
      60,
    );
    expect(
      designGapUsedValue({ rowGap: "calc(1em + 2px)" }, "row-gap", 300),
    ).toBeNull();
    const model = designLayoutToolModel({
      width: 600,
      height: 100,
      styles: styles({
        display: "grid",
        gridTemplateColumns: "100px 100px 100px",
        gridTemplateRows: "100px",
        columnGap: "10%",
      }),
      children: [],
    })!;
    expect(model.gaps.map((gap) => gap.value)).toEqual([60, 60]);
    expect(model.columns?.tracks.map((track) => track.start)).toEqual([
      0, 160, 320,
    ]);
  });

  it("leaves margins out of an Auto gap's fixed value", () => {
    const model = designLayoutToolModel({
      width: 600,
      height: 100,
      styles: styles({ justifyContent: "space-between" }),
      children: [
        {
          id: "a",
          rect: { x: 0, y: 0, width: 100, height: 100 },
          margins: { top: 0, right: 40, bottom: 0, left: 0 },
        },
        { id: "b", rect: { x: 270, y: 0, width: 100, height: 100 } },
        { id: "c", rect: { x: 500, y: 0, width: 100, height: 100 } },
      ],
    })!;
    expect(model.gaps[0]).toMatchObject({ size: 170, margin: 40, value: 130 });
  });
});

describe("review round 2 regressions", () => {
  it("splits lines in order-modified document order", () => {
    const gaps = designFlexGaps({
      content: { x: 0, y: 0, width: 500, height: 200 },
      children: [
        { id: "a", rect: { x: 240, y: 0, width: 100, height: 80 }, order: 1 },
        { id: "b", rect: { x: 0, y: 0, width: 100, height: 80 } },
        { id: "c", rect: { x: 120, y: 0, width: 100, height: 80 } },
      ],
      flexWrap: "wrap",
    });
    expect(gaps.map((gap) => gap.key)).toEqual(["x:b:c", "x:c:a"]);
  });

  it("leaves cross-line and negative margins out of an Auto gap", () => {
    const wrapped = designLayoutToolModel({
      width: 150,
      height: 400,
      styles: styles({
        flexWrap: "wrap",
        alignContent: "space-between",
        rowGap: "20px",
        columnGap: "20px",
      }),
      children: [
        {
          id: "a",
          rect: { x: 0, y: 0, width: 100, height: 80 },
          margins: { top: 0, right: 0, bottom: 40, left: 0 },
        },
        { id: "b", rect: { x: 0, y: 180, width: 100, height: 80 } },
        { id: "c", rect: { x: 0, y: 320, width: 100, height: 80 } },
      ],
    })!;
    expect(wrapped.gaps[0]).toMatchObject({ size: 100, margin: 40, value: 60 });
    const pulled = designLayoutToolModel({
      width: 600,
      height: 100,
      styles: styles({ justifyContent: "space-between" }),
      children: [
        {
          id: "a",
          rect: { x: 0, y: 0, width: 100, height: 100 },
          margins: { top: 0, right: -40, bottom: 0, left: 0 },
        },
        { id: "b", rect: { x: 230, y: 0, width: 100, height: 100 } },
        { id: "c", rect: { x: 500, y: 0, width: 100, height: 100 } },
      ],
    })!;
    expect(pulled.gaps[0]).toMatchObject({ size: 130, value: 170 });
  });

  it("starts an indefinite flex percentage gap from the rendered space", () => {
    const model = designLayoutToolModel({
      width: 200,
      height: 240,
      styles: styles({ flexDirection: "column", rowGap: "10%" }),
      children: [
        { id: "a", rect: { x: 0, y: 0, width: 100, height: 80 } },
        { id: "b", rect: { x: 0, y: 80, width: 100, height: 80 } },
        { id: "c", rect: { x: 0, y: 160, width: 100, height: 80 } },
      ],
    })!;
    expect(model.gaps.map((gap) => gap.value)).toEqual([0, 0]);
  });

  it("draws no tracks for an axis whose gutter only layout can size", () => {
    const model = designLayoutToolModel({
      width: 600,
      height: 100,
      styles: styles({
        display: "grid",
        gridTemplateColumns: "100px 100px 100px",
        gridTemplateRows: "100px",
        columnGap: "calc(10% + 5px)",
      }),
      children: [],
    })!;
    expect(model.columns).toBeNull();
    expect(model.gaps.some((gap) => gap.property === "column-gap")).toBe(false);
  });
});
