import { describe, expect, it } from "vitest";
import type { DesignRuntimeNodeDetails } from "@zeros/protocol/design-runtime";

import {
  designLayoutActionUpdates,
  designLayoutConstraint,
  designLayoutPlacedByParent,
} from "../design-layout-values";
import { isDesignLayoutChildAction } from "../design-layout-children";
import {
  designRelativeSizeStyles,
  designSizingMode,
} from "../design-auto-layout-values";

function node(
  styles: Record<string, string> = {},
  layout: Partial<NonNullable<DesignRuntimeNodeDetails["layout"]>> = {},
): DesignRuntimeNodeDetails {
  return {
    sourceVersion: "a".repeat(24),
    oid: "child",
    tag: "div",
    name: "Child",
    text: null,
    selector: '[data-oid="child"]',
    visible: true,
    breadcrumb: [],
    rect: { x: 800, y: 600, width: 100, height: 60 },
    box: {
      x: 800, y: 600, width: 100, height: 60, rotation: 0,
      scaleX: 1, scaleY: 1, originX: 0.5, originY: 0.5,
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
      ...layout,
    },
    styles: {
      position: "absolute",
      left: "40px",
      top: "30px",
      right: "auto",
      bottom: "auto",
      width: "100px",
      height: "60px",
      boxSizing: "border-box",
      transform: "none",
      ...styles,
    },
  };
}

const flowChild = (parentPosition = "static") =>
  node(
    { position: "static", left: "auto", top: "auto" },
    { parentDisplay: "flex", parentPosition, isContainingBlock: parentPosition !== "static" },
  );

describe("Position acts on the selected layer itself", () => {
  it("knows a layer its parent's auto layout places", () => {
    expect(designLayoutPlacedByParent(flowChild())).toBe(true);
    expect(designLayoutPlacedByParent(node({}, { parentDisplay: "flex" }))).toBe(false);
    expect(designLayoutPlacedByParent(node({ position: "static" }))).toBe(false);
    expect(designLayoutPlacedByParent(node({ position: "static" }, { parentDisplay: "grid" }))).toBe(true);
  });

  it("places a layer freely at its current box, making only a static parent relative", () => {
    const updates = designLayoutActionUpdates([flowChild()], { type: "place-freely" });
    expect(updates.get("parent")).toEqual({ position: "relative" });
    expect(updates.get("child")).toMatchObject({
      position: "absolute",
      left: "40px",
      top: "30px",
      right: "auto",
      bottom: "auto",
      width: "100px",
      height: "60px",
      "--zeros-layout-x": "start",
      "--zeros-layout-y": "start",
    });
    // A positioned parent already contains the layer; it is left alone.
    const positioned = designLayoutActionUpdates([flowChild("relative")], { type: "place-freely" });
    expect(positioned.has("parent")).toBe(false);
    expect(positioned.get("child")).toMatchObject({ position: "absolute", left: "40px", top: "30px" });
  });

  it("aligns and constrains the layer, not its children, when asked to", () => {
    expect(isDesignLayoutChildAction({ type: "align", axis: "x", value: "end" })).toBe(true);
    expect(isDesignLayoutChildAction({ type: "align", axis: "x", value: "end", target: "self" })).toBe(false);
    expect(isDesignLayoutChildAction({ type: "constraint", axis: "x", value: "end", target: "self" })).toBe(false);
    const aligned = designLayoutActionUpdates([node()], { type: "align", axis: "x", value: "end", target: "self" });
    expect(aligned.get("child")).toMatchObject({ left: "300px", "--zeros-layout-x": "start" });
  });

  it("scales a layer with its parent as percentages, and reads the pin back", () => {
    const x = designLayoutActionUpdates([node()], { type: "constraint", axis: "x", value: "scale", target: "self" });
    expect(x.get("child")).toMatchObject({ left: "10%", width: "25%", right: "auto", "--zeros-layout-x": "scale" });
    const y = designLayoutActionUpdates([node()], { type: "constraint", axis: "y", value: "scale", target: "self" });
    expect(y.get("child")).toMatchObject({ top: "10%", height: "20%", bottom: "auto", "--zeros-layout-y": "scale" });
    expect(designLayoutConstraint(node({ "--zeros-layout-x": "scale" }), "x")).toBe("scale");
  });
});

describe("Relative sizing", () => {
  it("reads a percentage size as Relative", () => {
    const relative = node({}, { widthValue: "50%" });
    expect(designSizingMode(relative, "x")).toBe("relative");
  });

  it("converts an in-flow size to a percentage of the parent's content box", () => {
    const parent = node({ paddingLeft: "20px", paddingRight: "20px", paddingTop: "0px", paddingBottom: "0px" });
    parent.oid = "parent";
    // 100px of a 400px padding box less 40px of padding: 100 / 360.
    expect(designRelativeSizeStyles(node({ position: "static" }), parent, "x")).toEqual({ width: "27.78%" });
  });

  it("uses the padding box for a positioned layer, as CSS resolves it", () => {
    const parent = node({ paddingLeft: "20px", paddingRight: "20px" });
    expect(designRelativeSizeStyles(node(), parent, "x")).toEqual({ width: "25%" });
  });

  it("stops a flex item from growing or shrinking away from its percentage", () => {
    const parent = node({ paddingLeft: "0px", paddingRight: "0px" });
    const item = node({ position: "static" }, { parentDisplay: "flex", parentFlexDirection: "row" });
    expect(designRelativeSizeStyles(item, parent, "x")).toEqual({
      width: "25%",
      "flex-grow": "0",
      "flex-shrink": "0",
      "flex-basis": "auto",
    });
  });
});

describe("a scaled layer after a canvas move", () => {
  it("keeps its position and size as shares of the parent", async () => {
    const { preserveDesignLayoutPins } = await import("../design-layout-values");
    const scaled = node({ left: "10%", width: "25%", "--zeros-layout-x": "scale" });
    scaled.authoredStyleProperties = ["position", "left", "width", "--zeros-layout-x"];
    expect(preserveDesignLayoutPins(scaled, { left: "80px", width: "200px" })).toMatchObject({
      left: "20%",
      width: "50%",
    });
  });
});

describe("Place freely", () => {
  const placed = (
    oid: string,
    styles: Record<string, string> = {},
    layout: Partial<NonNullable<DesignRuntimeNodeDetails["layout"]>> = {},
  ) => {
    const layer = node(
      { position: "static", left: "auto", top: "auto", ...styles },
      { parentDisplay: "flex", parentPosition: "static", isContainingBlock: false, ...layout },
    );
    layer.oid = oid;
    return layer;
  };

  it("keeps a layer with a margin where its border box is", () => {
    const updates = designLayoutActionUpdates(
      [placed("child", { marginLeft: "20px", marginTop: "5px", marginRight: "7px", marginBottom: "9px" })],
      { type: "place-freely" },
    );
    // The margin still applies once absolute, so the inset leaves it out.
    expect(updates.get("child")).toMatchObject({ left: "20px", top: "25px", width: "100px", height: "60px" });
  });

  it("makes a static parent relative in the same update", () => {
    const updates = designLayoutActionUpdates([placed("child")], { type: "place-freely" });
    // One map is one transaction: one undo restores the parent and the layer.
    expect([...updates.keys()].sort()).toEqual(["child", "parent"]);
    expect(updates.get("parent")).toEqual({ position: "relative" });
  });

  it("writes nothing to a parent that already contains the layer", () => {
    for (const parentPosition of ["relative", "absolute", "sticky"]) {
      const updates = designLayoutActionUpdates(
        [placed("child", {}, { parentPosition, isContainingBlock: true })],
        { type: "place-freely" },
      );
      expect(updates.has("parent")).toBe(false);
    }
  });

  it("folds a translate offset into the insets and keeps the rest of the pose", () => {
    const updates = designLayoutActionUpdates(
      [placed("child", { transform: "matrix(1, 0, 0, 1, 66, 223)", transformOrigin: "0px 0px" })],
      { type: "place-freely" },
    );
    expect(updates.get("child")).toMatchObject({ left: "106px", top: "253px", transform: "none" });
    const turned = designLayoutActionUpdates(
      [placed("child", { transform: "matrix(0, 1, -1, 0, 10, 20)", transformOrigin: "0px 0px" })],
      { type: "place-freely" },
    );
    expect(turned.get("child")).toMatchObject({ left: "50px", top: "50px", transform: "matrix(0,1,-1,0,0,0)" });
  });

  it("places several layers of one parent from the boxes they had before any left the flow", () => {
    const first = placed("first", {}, { x: 0, y: 0 });
    const second = placed("second", {}, { x: 0, y: 60 });
    const third = placed("third", {}, { x: 0, y: 120 });
    const updates = designLayoutActionUpdates([first, second, third], { type: "place-freely" });
    expect(updates.get("parent")).toEqual({ position: "relative" });
    expect(["first", "second", "third"].map((id) => updates.get(id)?.top)).toEqual(["0px", "60px", "120px"]);
  });
});
