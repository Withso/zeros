import { describe, expect, it } from "vitest";
import type { DesignRuntimeNodeDetails, DesignRuntimeTreeNode } from "@zeros/protocol/design-runtime";
import {
  canInsertDesignFrame,
  designWrapInFlow,
  designShiftAConvertsInPlace,
  designDrawnFrameWrapOperations,
  designFrameInsertionOperations,
  designTreeChildIds,
  designSizeInChildCoordinateSpace,
} from "../design-frame-insertion";

const parent: DesignRuntimeNodeDetails = {
  sourceVersion: "a".repeat(24),
  oid: "parent",
  tag: "div",
  name: "Frame",
  text: null,
  selector: '[data-oid="parent"]',
  visible: true,
  breadcrumb: [],
  rect: { x: 10, y: 20, width: 200, height: 200 },
  childCoordinateSpace: [2, 0, 0, 2, 10, 20],
  styles: { display: "block", position: "static" },
};

describe("child frame insertion", () => {
  it("lets Shift+A lay out one selected frame in place, as Figma does, and wraps anything else", () => {
    const children: NonNullable<DesignRuntimeNodeDetails["childrenLayout"]> = { count: 2, nodeIds: ["a", "b"], x: "start", y: "start", truncated: false };
    const frame: DesignRuntimeNodeDetails = { ...parent, childrenLayout: children };
    expect(designShiftAConvertsInPlace([frame])).toBe(true);
    // A frame that already flows, an empty frame, text, an image, or several
    // layers are wrapped in a new flow instead.
    expect(designShiftAConvertsInPlace([{ ...frame, styles: { ...frame.styles, display: "flex" } }])).toBe(false);
    expect(designShiftAConvertsInPlace([{ ...frame, childrenLayout: { ...children, count: 0, nodeIds: [] } }])).toBe(false);
    expect(designShiftAConvertsInPlace([{ ...frame, tag: "p", text: "Hello" }])).toBe(false);
    expect(designShiftAConvertsInPlace([{ ...frame, tag: "img" }])).toBe(false);
    expect(designShiftAConvertsInPlace([frame, { ...frame, oid: "other" }])).toBe(false);
    expect(designShiftAConvertsInPlace([null])).toBe(false);
  });
  it("reads a layer's direct children, or the frame root's top level", () => {
    const leaf = (oid: string, children: DesignRuntimeTreeNode[] = []): DesignRuntimeTreeNode =>
      ({ oid, tag: "div", name: oid, text: null, visible: true, children });
    const tree = [leaf("card", [leaf("title"), leaf("row", [leaf("deep")])]), leaf("footer")];
    expect(designTreeChildIds(tree, "card", "body")).toEqual(["title", "row"]);
    expect(designTreeChildIds(tree, "body", "body")).toEqual(["card", "footer"]);
    expect(designTreeChildIds(tree, "missing", "body")).toEqual([]);
    // A frame root the tree lists (a seeded <main>) is read like any layer.
    expect(designTreeChildIds([leaf("main", [leaf("label")])], "main", "main")).toEqual(["label"]);
  });
  it("adopts free layers a drawn frame fully encloses, keeping their canvas place", () => {
    const free = (oid: string, x: number, y: number, extra: Partial<DesignRuntimeNodeDetails["styles"]> = {}) => ({
      ...parent, oid, styles: { ...parent.styles, position: "absolute", ...extra },
      layout: { ...parent.layout!, parentId: parent.oid, x, y }, rect: { x, y, width: 61, height: 19 },
    }) as DesignRuntimeNodeDetails;
    const bounds = { x: 40, y: 30, width: 200, height: 80 };
    const ops = designDrawnFrameWrapOperations(parent, "drawn", bounds, [
      free("inside", 60, 40), free("overlapping", 200, 40), free("rotated", 60, 40, { transform: "rotate(10deg)" }),
      { ...free("flow", 60, 40), styles: { ...parent.styles, position: "static" } }, null,
    ]);
    expect(ops).toEqual([
      expect.objectContaining({ type: "node.move", nodeId: "inside", parentId: "drawn", beforeId: null }),
      expect.objectContaining({ type: "node.set-styles", nodeId: "inside", styles: { left: "20px", top: "10px", right: "auto", bottom: "auto" } }),
    ]);
    expect(designDrawnFrameWrapOperations({ ...parent, styles: { ...parent.styles, display: "flex" } }, "drawn", bounds,
      [free("inside", 60, 40)])).toEqual([]);
    // A percentage size would resolve against the drawn frame; it keeps its measured pixels.
    const percent = free("percent", 60, 40);
    percent.layout = { ...percent.layout!, widthValue: "50%", heightValue: "auto" };
    percent.styles = { ...percent.styles, width: "61px", boxSizing: "border-box" };
    expect(designDrawnFrameWrapOperations(parent, "drawn", bounds, [percent])[1]).toMatchObject({
      styles: { left: "20px", top: "10px", width: "61px" } });
    expect(designDrawnFrameWrapOperations(parent, "drawn", bounds, [percent])[1]).not.toHaveProperty("styles.height");
    // A layer stretched between both insets keeps its size on that axis.
    const stretched = free("stretched", 60, 40, { left: "20px", right: "119px", width: "61px", boxSizing: "border-box" });
    stretched.authoredStyleProperties = ["position", "left", "right", "top"];
    const placed = designDrawnFrameWrapOperations(parent, "drawn", bounds, [stretched])[1];
    expect(placed).toMatchObject({ styles: { left: "20px", right: "auto", width: "61px" } });
    expect(placed).not.toHaveProperty("styles.height");
  });
  it("wraps free layers of a static parent without re-anchoring the parent's other overlays", () => {
    // The parent sits 200px inside its positioned ancestor; its free layers
    // are anchored to that ancestor.
    const free = (oid: string, x: number) => ({ ...parent, oid,
      styles: { ...parent.styles, position: "absolute", left: `${x + 200}px`, top: "220px" },
      layout: { parentId: parent.oid, x, y: 20, isContainingBlock: false }, rect: { x, y: 20, width: 61, height: 19 },
    }) as unknown as DesignRuntimeNodeDetails;
    const ops = designWrapInFlow(parent, [free("a", 10), free("b", 84)], "wrap");
    expect(ops.some(op => op.type === "node.set-styles" && op.nodeId === parent.oid)).toBe(false);
    expect(ops.find(op => op.type === "node.set-html")?.html).toContain("position:absolute;left:210px;top:220px;");
  });
  it("keeps the slot block layers reserve when Shift+A wraps them", () => {
    // Two stacked paragraphs of an auto-height card: the wrapper stays in
    // flow where the first one stood, so the card keeps its height.
    const paragraph = (oid: string, y: number) => ({ ...parent, oid, tag: "p", text: oid,
      styles: { ...parent.styles, position: "static" },
      layout: { parentId: parent.oid, x: 0, y }, rect: { x: 0, y, width: 180, height: 19 },
    }) as unknown as DesignRuntimeNodeDetails;
    const ops = designWrapInFlow(parent, [paragraph("second", 40), paragraph("first", 0)], "wrap");
    const html = ops.find(op => op.type === "node.set-html")?.html ?? "";
    expect(html).toContain("position:relative;display:flex;flex-direction:column;");
    expect(html).not.toContain("left:");
    expect(ops.find(op => op.type === "node.move" && op.nodeId === "wrap")).toMatchObject({ parentId: parent.oid, beforeId: "first" });
    expect(ops.some(op => op.type === "node.set-styles" && op.nodeId === parent.oid)).toBe(false);
  });
  it("wraps siblings in spatial order, infers the gap and leaves a label content-sized", () => {
    const item = (oid: string, x: number) => ({ ...parent, oid,
      layout: { parentId: parent.oid, x, y: 20 }, rect: { x, y: 20, width: 61, height: 19 },
      textSizing: { width: "max-content", height: "auto", availableWidth: 200 },
    }) as DesignRuntimeNodeDetails;
    const ops = designWrapInFlow(parent, [item("right", 84), item("left", 10)], "wrap");
    expect(ops.find(op => op.type === "node.set-html")?.html).toContain("width:max-content;height:max-content;");
    expect(ops.find(op => op.type === "node.set-html")?.html).toContain("flex-direction:row;gap:13px;");
    expect(ops.flatMap(op => op.type === "node.move" && op.parentId === "wrap" ? [op.nodeId] : [])).toEqual(["left", "right"]);
    expect(ops.find(op => op.type === "node.set-styles" && op.nodeId === "right")).toMatchObject({ styles: { width: "max-content", height: "auto" } });
  });
  it("creates an opaque white frame with no auto layout", () => {
    const operation = designFrameInsertionOperations(parent, "child", {
      x: 10,
      y: 20,
    }).find((entry) => entry.type === "node.set-html");
    expect(operation?.html).toContain("display:block;");
    expect(operation?.html).toContain("background-color:#ffffff;opacity:1;"); // check:ui ignore-line -- authored canvas frame color, not editor chrome.
  });
  it("converts a drawn size into a scaled parent's child coordinates", () => {
    expect(
      designSizeInChildCoordinateSpace(parent, { x: 40, y: 20 }),
    ).toEqual({ x: 20, y: 10 });
  });
  it("keeps a square drawn size nonzero inside a rotated parent", () => {
    const half = Math.SQRT1_2;
    expect(
      designSizeInChildCoordinateSpace(
        { ...parent, childCoordinateSpace: [half, -half, half, half, 10, 20] },
        { x: 40, y: 40 },
      ),
    ).toEqual({ x: 40, y: 40 });
  });
  it("keeps the click-created default size inside a rotated and scaled parent", () => {
    const operations = designFrameInsertionOperations(
      { ...parent, childCoordinateSpace: [1, 1, -1, 1, 10, 20] },
      "child",
      { x: 10, y: 40 },
      undefined,
    );
    const insertion = operations.find(
      (operation) => operation.type === "node.set-html",
    );
    expect(insertion?.html).toContain(
      "left:10px;top:10px;width:100px;height:100px;",
    );
  });
  it("skips controls and structural tags that cannot contain a frame", () => {
    for (const tag of ["input", "img", "br", "select", "table", "tr", "ul"])
      expect(canInsertDesignFrame({ ...parent, tag })).toBe(false);
    expect(canInsertDesignFrame(parent)).toBe(true);
    expect(
      canInsertDesignFrame({ ...parent, styles: { display: "contents" } }),
    ).toBe(false);
  });
  it("keeps both drawn edges on their nearest whole pixel after inverse scaling", () => {
    const operations = designFrameInsertionOperations(
      parent,
      "child",
      { x: 11.2, y: 21.2 },
      { x: 210.4, y: 220.4 },
    );
    const insertion = operations.find(
      (operation) => operation.type === "node.set-html",
    );
    expect(insertion).toMatchObject({ nodeId: "parent", mode: "append" });
    expect(insertion?.html).toContain(
      "left:1px;top:1px;width:99px;height:99px;",
    );
    expect(operations[0]).toMatchObject({
      type: "node.set-styles",
      nodeId: "parent",
      styles: { position: "relative" },
    });
  });

  it.each(["flex", "inline-flex", "grid", "inline-grid"])(
    "adds a drawn frame to the end of %s flow without rewriting the parent",
    (display) => {
      const operations = designFrameInsertionOperations(
        { ...parent, styles: { ...parent.styles, display } },
        "child",
        { x: 10, y: 20 },
        { x: 210, y: 220 },
      );
      expect(operations).toHaveLength(1);
      const insertion = operations[0];
      if (insertion?.type !== "node.set-html")
        throw new Error("Missing insertion");
      expect(insertion).toMatchObject({ nodeId: "parent", mode: "append" });
      expect(insertion.html).toContain(
        "display:block;position:relative;width:100px;height:100px;",
      );
      expect(insertion.html).not.toContain("left:");
    },
  );

  it("places a drawn frame absolutely inside an ordinary block parent", () => {
    const operations = designFrameInsertionOperations(
      parent,
      "child",
      { x: 10, y: 20 },
      { x: 210, y: 220 },
    );
    expect(operations[0]).toMatchObject({
      type: "node.set-styles",
      nodeId: "parent",
      styles: { position: "relative" },
    });
    const insertion = operations[1];
    if (insertion?.type !== "node.set-html")
      throw new Error("Missing insertion");
    expect(insertion.html).toContain(
      "display:block;position:absolute;left:0px;top:0px;width:100px;height:100px;",
    );
  });
});
