import { describe, expect, it } from "vitest";
import {
  designMovementDelta,
  designNudgeStep,
  designNodeMovementStyles,
  designNodeRelocation,
  designParentDelta,
  designRelocatedBorderStyles,
} from "../design-movement-geometry";
import type { DesignRuntimeNodeDetails } from "@zeros/protocol/design-runtime";

describe("design movement coordinates", () => {
  it("prepares the same bounded inherited affine placement for preview and relocation", () => {
    const node: DesignRuntimeNodeDetails = {
      sourceVersion: "a".repeat(24),
      oid: "child",
      tag: "div",
      name: "Child",
      text: null,
      selector: "",
      visible: true,
      breadcrumb: [],
      rect: { x: 40, y: 80, width: 240, height: 280 },
      styles: {},
      box: {
        x: 40,
        y: 80,
        width: 100,
        height: 80,
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        originX: 0.5,
        originY: 0.5,
      },
      borderCoordinateSpace: [0, 2, -3, 1, 280, 80],
      relocationContext: {
        inheritedStyles: {
          color: "navy",
          "font-size": "30px",
          "--accent": "red",
        },
        unsupported: [],
      },
    };
    expect(
      designNodeRelocation(node, { x: 100, y: 80 }, [2, 0, 0, 2, 100, 50]),
    ).toEqual({
      width: 100,
      height: 80,
      matrix: [0, 1, -1.5, 0.5, 120, 15],
      inheritedStyles: node.relocationContext!.inheritedStyles,
    });
    expect(designNodeRelocation(node, { x: 0, y: 0 }).matrix).toEqual([
      0, 2, -3, 1, 240, 0,
    ]);
    expect(() =>
      designNodeRelocation(
        {
          ...node,
          relocationContext: {
            inheritedStyles: {},
            unsupported: ["ancestor compositing"],
          },
        },
        { x: 0, y: 0 },
      ),
    ).toThrow(/ancestor compositing/);
    expect(() =>
      designNodeRelocation(
        { ...node, relocationContext: undefined },
        { x: 0, y: 0 },
      ),
    ).toThrow(/appearance/);
  });
  it("uses one and eight world pixels, preserving fractional parent offsets and center pins", () => {
    expect(designNudgeStep(false)).toBe(1);
    expect(designNudgeStep(true)).toBe(8);
    const node: DesignRuntimeNodeDetails = {
      sourceVersion: "a".repeat(24),
      oid: "child",
      tag: "div",
      name: "Child",
      text: null,
      selector: "",
      visible: true,
      breadcrumb: [],
      rect: { x: 20, y: 30, width: 100, height: 80 },
      styles: { position: "absolute", left: "20px", top: "30px" },
      parentCoordinateSpace: [0, 2, -3, 0, 100, 50],
    };
    const moved = designNodeMovementStyles(node, { x: 1, y: 0 });
    expect(moved.left).toBe("20px");
    expect(parseFloat(moved.top)).toBeCloseTo(30 - 1 / 3, 6);
    const centered: DesignRuntimeNodeDetails = {
      ...node,
      parentCoordinateSpace: [2, 0, 0, 2, 0, 0],
      styles: {
        position: "absolute",
        left: "150px",
        top: "0px",
        "--zeros-layout-x": "center",
      },
      layout: {
        x: 150,
        y: 0,
        parentId: "parent",
        parentDisplay: "block",
        parentPosition: "relative",
        isContainingBlock: true,
        parentWidth: 300,
        parentHeight: 200,
      },
    };
    expect(designNodeMovementStyles(centered, { x: 1, y: 0 }).left).toBe(
      "calc(50% + 0.5px)",
    );
    expect(
      designNodeMovementStyles(
        {
          ...centered,
          rect: { ...centered.rect, width: 33.4 },
          styles: {
            position: "absolute",
            left: "20px",
            top: "0px",
            "--zeros-layout-x": "end",
          },
        },
        { x: 1, y: 0 },
      ).right,
    ).toBe("246.1px");
  });
  it("keeps a world grab point beneath the pointer while the camera pans and zooms", () => {
    const start = { x: 128, y: 92 };
    const viewport = { left: 20, top: 30 };
    const grab = { x: 40, y: 20 };
    expect(designMovementDelta({ x: 154, y: 206 }, viewport, { panX: 50, panY: 120, zoom: 0.5 }, start, grab)).toEqual({ x: 0, y: 0 });
    expect(designMovementDelta({ x: 155, y: 206 }, viewport, { panX: 0, panY: 120, zoom: 0.5 }, start, grab)).toEqual({ x: 102, y: 0 });
    expect(designMovementDelta({ x: 356, y: 374 }, viewport, { panX: 0, panY: 120, zoom: 2 }, start, grab)).toEqual({ x: 0, y: 0 });
  });

  it("inverts the full parent linear map for a world-space nudge", () => {
    expect(designParentDelta([0, 2, -3, 0, 100, 50], { x: 1, y: 0 })).toEqual({ x: 0, y: -1 / 3 });
    expect(designParentDelta([-2, 0, 1, 3, 100, 50], { x: 8, y: 3 })).toEqual({ x: -3.5, y: 1 });
    expect(() => designParentDelta(null, { x: 1, y: 0 })).toThrow(/coordinates/);
    expect(() => designParentDelta([0, 0, 0, 0, 0, 0], { x: 1, y: 0 })).toThrow(/invertible/);
  });

  it("preserves the complete border transform and margins on reparenting", () => {
    const result = designRelocatedBorderStyles({
      border: [0, 2, -3, 1, 160, 180],
      parent: [2, 0, 0, 2, 100, 50],
      delta: { x: 60, y: 0 },
      margin: { x: 20, y: 5 },
    });
    expect(result).toEqual({ left: "40px", top: "60px", transform: "matrix(0,1,-1.5,0.5,0,0)", "transform-origin": "0 0", rotate: "none", scale: "none", translate: "none" });
  });
});
