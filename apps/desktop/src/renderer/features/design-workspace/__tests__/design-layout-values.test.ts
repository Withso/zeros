import { describe, expect, it } from "vitest";
import type { DesignRuntimeNodeDetails } from "@zeros/protocol/design-runtime";
import {
  designLayoutMode,
  designLayoutModeStyles,
  designLayoutActionStyles,
  designLayoutActionUpdates,
  designLayoutFieldValue,
  designLayoutConstraint,
  roundDesignLayoutValue,
  preserveDesignLayoutPins,
  designLayoutTransform,
} from "../design-layout-values";

function node(styles: Record<string, string> = {}): DesignRuntimeNodeDetails {
  return {
    sourceVersion: "a".repeat(24),
    oid: "child",
    tag: "div",
    name: "Child",
    text: null,
    selector: '[data-oid="child"]',
    visible: true,
    breadcrumb: [],
    rect: { x: 800, y: 600, width: 140, height: 120 },
    box: {
      x: 800,
      y: 600,
      width: 100.4,
      height: 60.2,
      rotation: 30,
      scaleX: 1,
      scaleY: 1,
      originX: 0.5,
      originY: 0.5,
    },
    layout: {
      x: 40,
      y: 30,
      parentId: "parent",
      parentWidth: 400,
      parentHeight: 300,
      parentDisplay: "block",
      parentPosition: "relative",
      isContainingBlock: true,
    },
    styles: {
      position: "absolute",
      left: "40px",
      top: "30px",
      right: "auto",
      bottom: "auto",
      width: "100.4px",
      height: "60.2px",
      boxSizing: "border-box",
      transform: "none",
      ...styles,
    },
  };
}

describe("designer layout values", () => {
  it("pins selected parents and children independently in either selection order", () => {
    const parent = node({ position: "static" });
    parent.oid = "parent";
    parent.layout = { ...parent.layout!, parentId: "grandparent" };
    const child = node({ position: "static" });
    child.layout = { ...child.layout!, isContainingBlock: false };
    for (const selection of [
      [parent, child],
      [child, parent],
    ]) {
      const updates = designLayoutActionUpdates(selection, {
        type: "constraint",
        axis: "x",
        value: "end",
      });
      expect(updates.get("parent")).toMatchObject({
        position: "absolute",
        right: "260px",
      });
      expect(updates.get("child")).toMatchObject({
        position: "absolute",
        right: "260px",
      });
    }
  });
  it("preserves both coordinates when pinning into a newly positioned parent", () => {
    const child = node({ top: "200px" });
    child.layout = {
      ...child.layout!,
      isContainingBlock: false,
      parentPosition: "static",
    };
    expect(
      designLayoutActionStyles(child, {
        type: "constraint",
        axis: "x",
        value: "end",
      }),
    ).toMatchObject({ top: "30px", right: "260px", height: "60px" });
    expect(designLayoutActionStyles(child, { type: "center" })).toMatchObject({
      left: "calc(50% - 160px)",
      top: "calc(50% - 120px)",
    });
  });
  it("edits parent-local positions when the CSS containing block is an ancestor", () => {
    const child = node({ left: "240px", top: "200px" });
    child.layout = {
      ...child.layout!,
      isContainingBlock: false,
      parentPosition: "static",
    };
    expect(
      designLayoutActionStyles(child, {
        type: "position",
        axis: "x",
        value: 50,
      }),
    ).toMatchObject({ left: "250px" });
  });
  it("toggles clipping from the current CSS state on both axes", () => {
    expect(
      designLayoutActionStyles(
        node({ overflowX: "visible", overflowY: "visible" }),
        { type: "clip" },
      ),
    ).toEqual({
      overflow: "hidden",
      "overflow-x": "hidden",
      "overflow-y": "hidden",
    });
    expect(
      designLayoutActionStyles(
        node({ overflowX: "hidden", overflowY: "hidden" }),
        { type: "clip" },
      ),
    ).toEqual({
      overflow: "visible",
      "overflow-x": "visible",
      "overflow-y": "visible",
    });
  });
  it("preserves pin behavior through canvas movement and resizing", () => {
    const pinned = node({
      "--zeros-layout-x": "end",
      left: "40px",
      right: "260px",
    });
    expect(preserveDesignLayoutPins(pinned, { left: "50px" })).toEqual({
      left: "auto",
      right: "250px",
    });
    expect(preserveDesignLayoutPins(pinned, { width: "120px" })).toEqual({
      left: "auto",
      right: "240px",
      width: "120px",
    });
    const centered = node({ "--zeros-layout-y": "center" });
    expect(preserveDesignLayoutPins(centered, { top: "40px" })).toEqual({
      top: "calc(50% - 110px)",
    });
  });

  it("includes Layout rotation and mirroring in direct-manipulation geometry", () => {
    const turned = designLayoutTransform(
      node({ rotate: "90deg", scale: "-1 1", transform: "none" }),
    );
    expect(turned.rotate).toBeCloseTo(-90);
    expect(turned.scaleX).toBe(1);
    expect(turned.scaleY).toBe(-1);
  });
  it("uses None for normal flow and never hides a frame when disabling automatic layout", () => {
    expect(designLayoutMode("block")).toBe("none");
    expect(designLayoutMode("inline-flex")).toBe("flex");
    expect(designLayoutMode("inline-grid")).toBe("grid");
    expect(designLayoutModeStyles("none")).toEqual({ display: "block" });
  });

  it("rounds Layout numbers without changing raw CSS functions or other editors", () => {
    expect(roundDesignLayoutValue("1395.140625px")).toBe("1395px");
    expect(roundDesignLayoutValue("650.875px")).toBe("651px");
    expect(roundDesignLayoutValue("-0.2deg")).toBe("0deg");
    expect(roundDesignLayoutValue("calc(50% - 2.5px)")).toBe(
      "calc(50% - 2.5px)",
    );
    expect(designLayoutFieldValue(node(), "left")).toBe("40px");
    expect(designLayoutFieldValue(node(), "width")).toBe("100px");
  });

  it("pins a child to its parent's far edge without moving it or replacing its transform", () => {
    const styles = designLayoutActionStyles(node(), {
      type: "constraint",
      axis: "x",
      value: "end",
    });
    expect(styles).toMatchObject({
      position: "absolute",
      left: "auto",
      right: "260px",
      width: "100px",
    });
    expect(styles.transform).toBeUndefined();
    expect(styles.top).toBeUndefined();
    expect(
      designLayoutConstraint(
        {
          ...node(),
          styles: { ...node().styles, ...styles },
        } as DesignRuntimeNodeDetails,
        "x",
      ),
    ).toBe("end");
  });

  it("centers responsively with a preserved offset and stretches between two pins", () => {
    expect(
      designLayoutActionStyles(node(), {
        type: "constraint",
        axis: "x",
        value: "center",
      }),
    ).toMatchObject({
      left: "calc(50% - 160px)",
      right: "auto",
      width: "100px",
    });
    expect(
      designLayoutActionStyles(node(), {
        type: "constraint",
        axis: "y",
        value: "stretch",
      }),
    ).toMatchObject({ top: "30px", bottom: "210px", height: "auto" });
  });

  it("aligns with parent geometry, not frame-space or rotated bounding-box dimensions", () => {
    expect(
      designLayoutActionStyles(node(), {
        type: "align",
        axis: "x",
        value: "end",
      }),
    ).toMatchObject({ left: "300px", right: "auto" });
    expect(
      designLayoutActionStyles(node(), {
        type: "align",
        axis: "y",
        value: "center",
      }),
    ).toMatchObject({ top: "120px", bottom: "auto" });
  });

  it("keeps content-box sizing and margins consistent with the designer's border box", () => {
    const details = node({
      boxSizing: "content-box",
      paddingLeft: "10px",
      paddingRight: "10px",
      borderLeftWidth: "2px",
      borderRightWidth: "2px",
      marginLeft: "8px",
      marginRight: "12px",
    });
    expect(
      designLayoutActionStyles(details, {
        type: "size",
        axis: "x",
        value: 150,
      }),
    ).toMatchObject({ width: "126px" });
    expect(
      designLayoutActionStyles(details, {
        type: "constraint",
        axis: "x",
        value: "end",
      }),
    ).toMatchObject({ right: "248px", width: "76px" });
  });

  it("clears the obsolete far edge when typing a position on a right-pinned child", () => {
    expect(
      designLayoutActionStyles(node({ left: "auto", right: "260px" }), {
        type: "position",
        axis: "x",
        value: 25.7,
      }),
    ).toMatchObject({ left: "26px", right: "auto" });
  });

  it("rotates clockwise relative to each layer and preserves translation and scale", () => {
    const details = node({
      rotate: "30deg",
      transform: "matrix(1, 0, 0, 1, 24, 12)",
      scale: "2 3",
    });
    expect(
      designLayoutActionStyles(details, { type: "rotate", delta: 90 }),
    ).toEqual({ rotate: "120deg" });
    expect(
      designLayoutActionStyles(details, { type: "flip", axis: "x" }),
    ).toEqual({ scale: "-2 3" });
    expect(
      designLayoutActionStyles(node({ scale: "-2 3" }), {
        type: "flip",
        axis: "x",
      }),
    ).toEqual({ scale: "2 3" });
  });
});
