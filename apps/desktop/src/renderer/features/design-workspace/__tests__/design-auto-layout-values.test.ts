import { describe, expect, it } from "vitest";
import type { DesignRuntimeNodeDetails } from "@zeros/protocol/design-runtime";
import {
  canFillDesignContainer,
  canHugDesignContents,
  designSizingMode,
  designSizingStyles,
  designAutoLayoutAlignment,
  designAutoLayoutAlignmentStyles,
  designAutoLayoutFlowStyles,
  designGridTrackCount,
  designAutoLayoutUpdates,
  designFrameResizeRootStyles,
  designFrameRootFixedStyles,
} from "../design-auto-layout-values";

const node = (
  styles: Record<string, string> = {},
  parentDisplay = "flex",
  direction = "row",
): DesignRuntimeNodeDetails => ({
  sourceVersion: "a".repeat(24),
  oid: "child",
  tag: "div",
  name: "Child",
  text: null,
  selector: '[data-oid="child"]',
  visible: true,
  breadcrumb: [],
  rect: { x: 0, y: 0, width: 120, height: 80 },
  layout: {
    x: 0,
    y: 0,
    parentId: "parent",
    parentWidth: 400,
    parentHeight: 300,
    parentDisplay,
    parentPosition: "relative",
    parentFlexDirection: direction,
    parentAlignItems: "stretch",
    parentJustifyItems: "stretch",
    widthValue: "120px",
    heightValue: "80px",
    isContainingBlock: true,
  },
  styles: {
    display: "block",
    position: "relative",
    width: "120px",
    height: "80px",
    boxSizing: "border-box",
    ...styles,
  },
});

describe("auto layout intent", () => {
  it("brings drawn children into flow and freezes their positions when removing layout", () => {
    const parent = { ...node({ display: "block" }), oid: "parent" };
    const child = node({ position: "absolute" }, "block");
    const added = designAutoLayoutUpdates([parent], [child], "row");
    expect(added.get("child")).toMatchObject({
      position: "relative",
      left: "auto",
      width: "120px",
      "flex-shrink": "0",
    });
    const removed = designAutoLayoutUpdates(
      [{ ...parent, styles: { display: "flex" } }],
      [node()],
      "none",
    );
    expect(removed.get("child")).toMatchObject({
      position: "absolute",
      left: "0px",
      top: "0px",
      width: "120px",
    });
  });

  it("keeps per-axis Fill when changing the parent's direction", () => {
    const parent = {
      ...node({ display: "flex", flexDirection: "row" }),
      oid: "parent",
    };
    const child = node({ flexGrow: "1", flexBasis: "0px", alignSelf: "auto" });
    child.layout!.widthValue = "auto";
    const changed = designAutoLayoutUpdates([parent], [child], "column");
    expect(changed.get("child")).toMatchObject({
      width: "auto",
      "align-self": "stretch",
      height: "80px",
      "flex-grow": "0",
      "flex-basis": "auto",
    });
  });
  it("offers Hug only to layers containing children", () => {
    expect(canHugDesignContents(node())).toBe(false);
    expect(
      canHugDesignContents({
        ...node(),
        childrenLayout: {
          count: 1,
          nodeIds: ["nested"],
          x: "start",
          y: "start",
          truncated: false,
        },
      }),
    ).toBe(true);
    expect(
      canHugDesignContents({
        ...node(),
        childrenLayout: {
          count: 0,
          nodeIds: [],
          x: "start",
          y: "start",
          truncated: false,
        },
      }),
    ).toBe(false);
  });

  it("offers Fill only to in-flow children of flex and grid parents", () => {
    expect(canFillDesignContainer(node())).toBe(true);
    expect(canFillDesignContainer(node({}, "grid"))).toBe(true);
    expect(canFillDesignContainer(node({}, "block"))).toBe(false);
    expect(canFillDesignContainer(node({ position: "absolute" }))).toBe(false);
    expect(canFillDesignContainer({ ...node(), layout: undefined })).toBe(
      false,
    );
  });

  it.each(["row", "row-reverse", "column", "column-reverse"])(
    "fills the main axis of %s without leaving flow",
    (direction) => {
      const axis = direction.startsWith("row") ? "x" : "y";
      const styles = designSizingStyles(
        node({}, "flex", direction),
        axis,
        "fill",
      );
      expect(styles).toMatchObject({
        [axis === "x" ? "width" : "height"]: "auto",
        "flex-grow": "1",
        "flex-basis": "0px",
      });
      expect(styles.position).toBeUndefined();
      expect(styles.left).toBeUndefined();
    },
  );

  it("fills cross axes and grid cells using stretch, preserving the other axis", () => {
    expect(
      designSizingStyles(node({}, "flex", "column"), "x", "fill"),
    ).toMatchObject({ width: "auto", "align-self": "stretch" });
    const grid = designSizingStyles(node({}, "grid"), "x", "fill");
    expect(grid).toMatchObject({ width: "auto", "justify-self": "stretch" });
    expect(grid.height).toBeUndefined();
    expect(grid["flex-grow"]).toBeUndefined();
    expect(() => designSizingStyles(node({}, "block"), "x", "fill")).toThrow();
  });

  it("freezes fixed sizing and releases flex growth when leaving Fill", () => {
    expect(
      designSizingStyles(
        node({ flexGrow: "1", flexBasis: "0px" }),
        "x",
        "fixed",
      ),
    ).toMatchObject({
      width: "120px",
      "flex-grow": "0",
      "flex-shrink": "0",
      "flex-basis": "auto",
    });
    expect(designSizingStyles(node(), "x", "hug")).toMatchObject({
      width: "max-content",
      "flex-grow": "0",
    });
  });

  it("fixes only the Hug axes a manual frame resize changes", () => {
    const root = (widthValue: string, heightValue: string) => ({
      ...node(),
      layout: { ...node().layout!, widthValue, heightValue },
    });
    const start = { w: 800, h: 600 };
    // Taller Hug frame: height becomes the frame viewport; width untouched.
    expect(
      designFrameResizeRootStyles(root("max-content", "max-content"), start, {
        w: 800,
        h: 900,
      }),
    ).toEqual({ height: "100vh" });
    expect(
      designFrameResizeRootStyles(root("fit-content", "320px"), start, {
        w: 1_000,
        h: 700,
      }),
    ).toEqual({ width: "100%" });
    // Fixed roots already follow the viewport; an unchanged axis stays Hug.
    expect(
      designFrameResizeRootStyles(root("100%", "100vh"), start, {
        w: 900,
        h: 900,
      }),
    ).toBeNull();
    expect(
      designFrameResizeRootStyles(root("max-content", "max-content"), start, start),
    ).toBeNull();
    expect(designFrameResizeRootStyles(null, start, { w: 1, h: 1 })).toBeNull();
  });

  it("keeps a content-box root inside the frame it now follows", () => {
    // A body root with 20px padding and content-box sizing: `height:100vh`
    // alone would make its border box 40px taller than the frame.
    const root = {
      ...node({
        boxSizing: "content-box",
        paddingTop: "20px",
        paddingBottom: "20px",
        paddingLeft: "10px",
        paddingRight: "10px",
        width: "300px",
      }),
      box: {
        x: 0,
        y: 0,
        width: 320,
        height: 140,
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        originX: 0.5,
        originY: 0.5,
      },
      layout: {
        ...node().layout!,
        widthValue: "300px",
        heightValue: "max-content",
      },
    };
    // Only the edited axis changes: its border box becomes the frame, and the
    // other axis (and the box model) are left exactly as authored, so queued
    // W and H edits can never overwrite each other's root style.
    expect(
      designFrameResizeRootStyles(root, { w: 320, h: 140 }, { w: 320, h: 240 }),
    ).toEqual({ height: "calc(100vh - 40px)" });
    expect(designFrameRootFixedStyles(root, { width: true })).toEqual({
      width: "calc(100% - 20px)",
    });
    // Border-box roots and roots without edges on the fixed axis stay as-is.
    expect(
      designFrameResizeRootStyles(
        { ...root, styles: { ...root.styles, boxSizing: "border-box" } },
        { w: 320, h: 140 },
        { w: 320, h: 240 },
      ),
    ).toEqual({ height: "100vh" });
    expect(
      designFrameRootFixedStyles(
        {
          ...root,
          styles: { ...root.styles, paddingTop: "0px", paddingBottom: "0px" },
        },
        { height: true },
      ),
    ).toEqual({ height: "100vh" });
  });

  it("reads intrinsic sizing from the exact snapshot instead of computed pixels", () => {
    const child = node({ width: "120px" });
    child.layout!.widthValue = "max-content";
    expect(designSizingMode(child, "x")).toBe("hug");
    child.layout!.widthValue = "auto";
    child.styles.flexGrow = "1";
    expect(designSizingMode(child, "x")).toBe("fill");
    child.styles.flexGrow = "0";
    expect(designSizingMode(child, "x")).toBe("hug");
    child.layout!.widthValue = "60%";
    expect(designSizingMode(child, "x")).toBe("custom");
  });

  it("maps physical alignment through reversed flex directions", () => {
    const row = node({ display: "flex", flexDirection: "row-reverse" });
    const styles = designAutoLayoutAlignmentStyles(row, 0, 2);
    expect(styles).toEqual({
      "justify-content": "flex-end",
      "align-items": "flex-end",
    });
    expect(
      designAutoLayoutAlignment({
        ...row,
        styles: { ...row.styles, ...styles },
      }),
    ).toMatchObject({ x: 0, y: 2 });
    const grid = node({ display: "grid" });
    expect(designAutoLayoutAlignmentStyles(grid, 2, 1)).toEqual({
      "justify-items": "end",
      "align-items": "center",
    });
  });

  it("keeps automatic spacing while changing cross-axis alignment", () => {
    const column = node({
      display: "flex",
      flexDirection: "column",
      justifyContent: "space-between",
    });
    expect(designAutoLayoutAlignmentStyles(column, 2, 1)).toEqual({
      "align-items": "flex-end",
    });
  });

  it("starts new automatic layouts with predictable alignment and a usable grid", () => {
    expect(
      designAutoLayoutFlowStyles(node({}, "block"), "column"),
    ).toMatchObject({
      display: "flex",
      "flex-direction": "column",
      "align-items": "flex-start",
      "justify-content": "flex-start",
    });
    expect(designAutoLayoutFlowStyles(node(), "grid")).toMatchObject({
      display: "grid",
      "grid-template-columns": "repeat(2, minmax(0, 1fr))",
    });
    expect(
      designAutoLayoutFlowStyles(node({ display: "flex" }), "none"),
    ).toEqual({ display: "block" });
    expect(designGridTrackCount("100px 200px 100px")).toBe(3);
    expect(designGridTrackCount("[start] minmax(0px, 1fr) [end] 100px")).toBe(
      2,
    );
  });
});
