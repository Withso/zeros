import { describe, expect, it } from "vitest";
import type { DesignRuntimeNodeDetails } from "@zeros/protocol/design-runtime";
import {
  canInsertDesignFrame,
  designFrameInsertionOperations,
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

  it.each(["flex", "grid"])(
    "adds a normal frame to %s without rewriting the parent's layout",
    (display) => {
      const operations = designFrameInsertionOperations(
        { ...parent, styles: { ...parent.styles, display } },
        "child",
        { x: 10, y: 20 },
        { x: 210, y: 220 },
      );
      expect(operations).toHaveLength(1);
      expect(operations[0]).toMatchObject({
        type: "node.set-html",
        nodeId: "parent",
      });
      const insertion = operations[0];
      if (insertion?.type !== "node.set-html")
        throw new Error("Missing insertion");
      expect(insertion.html).toContain(
        "display:block;position:relative;width:100px;height:100px;",
      );
      expect(insertion.html).not.toContain("left:");
    },
  );
});
