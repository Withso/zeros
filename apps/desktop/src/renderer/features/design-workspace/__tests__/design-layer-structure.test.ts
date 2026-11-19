import { describe, expect, it } from "vitest";
import type { DesignRuntimeTreeNode } from "@zeros/protocol/design-runtime";
import {
  designSelectionParentId,
  designStructureModifierPressed,
  designStructureOutlines,
  designStructureOutlineShown,
} from "../design-layer-structure";

const node = (oid: string, children: DesignRuntimeTreeNode[] = []) =>
  ({ oid, tag: "div", name: oid, children }) as unknown as DesignRuntimeTreeNode;

// root > (stack > (a, b), card > (c))
const tree = [node("root", [node("stack", [node("a"), node("b")]), node("card", [node("c")])])];
const frame = { width: 400, height: 300 };
const FILE = "page/home.html";
const targets = (...nodeIds: string[]) => nodeIds.map((nodeId) => ({ frame: FILE, nodeId }));

describe("layer structure outlines", () => {
  it("outlines a box with area that is not the frame's own edge", () => {
    expect(designStructureOutlineShown({ x: 20, y: 20, width: 100, height: 40 }, frame)).toBe(true);
    // The frame root traces the frame edge, which the frame already draws.
    expect(designStructureOutlineShown({ x: 0, y: 0, width: 400, height: 300 }, frame)).toBe(false);
    expect(designStructureOutlineShown({ x: 0.2, y: -0.3, width: 399.6, height: 300.4 }, frame)).toBe(false);
    // A root inset from the frame is a real box.
    expect(designStructureOutlineShown({ x: 0, y: 0, width: 400, height: 280 }, frame)).toBe(true);
    // display: contents and collapsed boxes have no outline to draw.
    expect(designStructureOutlineShown({ x: 10, y: 10, width: 0, height: 0 }, frame)).toBe(false);
    expect(designStructureOutlineShown({ x: 10, y: 10, width: 100, height: 0.2 }, frame)).toBe(false);
    expect(designStructureOutlineShown({ x: Number.NaN, y: 10, width: 100, height: 20 }, frame)).toBe(false);
    expect(designStructureOutlineShown(null, frame)).toBe(false);
  });

  it("names the parent a selection shares, and none across parents", () => {
    expect(designSelectionParentId(tree, targets("a"), FILE, "a")).toBe("stack");
    expect(designSelectionParentId(tree, targets("a", "b"), FILE, "b")).toBe("stack");
    expect(designSelectionParentId(tree, targets("a", "c"), FILE, "a")).toBeNull();
    expect(designSelectionParentId(tree, targets("stack"), FILE, "stack")).toBe("root");
    // The frame root has no parent layer; an unknown layer has none either.
    expect(designSelectionParentId(tree, targets("root"), FILE, "root")).toBeNull();
    expect(designSelectionParentId(tree, targets("missing"), FILE, "missing")).toBeNull();
    expect(designSelectionParentId(tree, [], FILE, null)).toBeNull();
    // A selection that also holds a frame, or a layer of another frame, has
    // no one parent in this frame.
    expect(designSelectionParentId(tree, [...targets("a"), { frame: FILE }], FILE, "a")).toBeNull();
    expect(designSelectionParentId(tree, [...targets("a"), { frame: "other.html", nodeId: "b" }], FILE, "a")).toBeNull();
  });

  it("reads ⌘ or Ctrl as the structure modifier", () => {
    expect(designStructureModifierPressed({ metaKey: true, ctrlKey: false })).toBe(true);
    expect(designStructureModifierPressed({ metaKey: false, ctrlKey: true })).toBe(true);
    expect(designStructureModifierPressed({ metaKey: false, ctrlKey: false })).toBe(false);
  });

  it("dots a hovered layer's parent and direct children, leaving selected and frame-edge boxes alone", () => {
    const parent = { oid: "stack", rect: { x: 10, y: 10, width: 200, height: 120 } };
    const children = [
      { oid: "a", rect: { x: 20, y: 20, width: 80, height: 40 } },
      { oid: "b", rect: { x: 20, y: 70, width: 80, height: 40 } },
      { oid: "collapsed", rect: { x: 20, y: 120, width: 80, height: 0 } },
    ];
    expect(designStructureOutlines({ parent, children, frame, excludedNodeIds: [] })).toEqual({
      parent,
      children: children.slice(0, 2),
    });
    // A selected layer keeps its solid selection outline; the selection's
    // parent is already dotted once.
    expect(designStructureOutlines({ parent, children, frame, excludedNodeIds: ["stack", "b"] })).toEqual({
      parent: null,
      children: [children[0]],
    });
    // A parent that is the frame's own edge is drawn by the frame.
    const rootParent = { oid: "root", rect: { x: 0, y: 0, width: 400, height: 300 } };
    expect(designStructureOutlines({ parent: rootParent, children: [], frame, excludedNodeIds: [] })).toEqual({
      parent: null,
      children: [],
    });
    expect(designStructureOutlines({ parent: null, children: [], frame, excludedNodeIds: [] })).toEqual({
      parent: null,
      children: [],
    });
  });
});
