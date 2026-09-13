import { describe, expect, it } from "vitest";
import type { DesignRuntimeNodeDetails } from "@zeros/protocol/design-runtime";
import {
  designLayoutChildUpdates,
  designLayoutChildrenSummary,
} from "../design-layout-children";

function layer(
  oid: string,
  parentId: string | null,
  x = 0,
  width = 100,
): DesignRuntimeNodeDetails {
  return {
    oid,
    sourceVersion: "a".repeat(24),
    tag: "div",
    name: oid,
    text: null,
    selector: `[data-oid="${oid}"]`,
    visible: true,
    breadcrumb: [],
    rect: { x: 900, y: 700, width, height: 60 },
    box: {
      x: 900,
      y: 700,
      width,
      height: 60,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      originX: 0.5,
      originY: 0.5,
    },
    layout: {
      x,
      y: 30,
      parentId,
      parentWidth: 400,
      parentHeight: 300,
      parentDisplay: "block",
      parentPosition: "relative",
      isContainingBlock: true,
    },
    styles: {
      position: "absolute",
      boxSizing: "border-box",
      width: `${width}px`,
      height: "60px",
      left: `${x}px`,
      top: "30px",
      right: "auto",
      bottom: "auto",
    },
  };
}
function container() {
  const parent = layer("parent", null, 0, 400);
  parent.box!.height = 300;
  parent.styles = { ...parent.styles, position: "relative", height: "300px" };
  parent.childrenLayout = {
    count: 3,
    nodeIds: ["a", "b", "c"],
    x: "start",
    y: "start",
    truncated: false,
  };
  return parent;
}

describe("layout controls for a container's children", () => {
  it("aligns direct visible children without moving the selected container or grandchildren", () => {
    const hidden = layer("hidden", "parent");
    hidden.visible = false;
    const updates = designLayoutChildUpdates(
      [container()],
      [layer("a", "parent", 40), layer("nested", "a"), hidden],
      { type: "align", axis: "x", value: "end" },
    );
    expect(updates.get("a")).toMatchObject({ left: "300px", right: "auto" });
    expect(updates.has("parent")).toBe(false);
    expect(updates.has("nested")).toBe(false);
    expect(updates.has("hidden")).toBe(false);
  });
  it("keeps a flow container's measured size when its children become pinned", () => {
    const parent = container();
    parent.styles.position = "static";
    const child = layer("a", "parent", 40);
    child.styles.position = "static";
    child.layout!.isContainingBlock = false;
    const updates = designLayoutChildUpdates([parent], [child], {
      type: "constraint",
      axis: "x",
      value: "end",
    });
    expect(updates.get("parent")).toMatchObject({
      position: "relative",
      width: "400px",
      height: "300px",
    });
    expect(updates.get("a")).toMatchObject({
      position: "absolute",
      right: "260px",
      top: "30px",
    });
  });
  it("distributes different-sized children by their gaps in visual order, keeping outer edges", () => {
    const updates = designLayoutChildUpdates(
      [container()],
      [
        layer("c", "parent", 300, 80),
        layer("a", "parent", 10, 40),
        layer("b", "parent", 100, 60),
      ],
      { type: "distribute", axis: "x" },
    );
    expect(updates.get("a")).toMatchObject({ left: "10px" });
    expect(updates.get("b")).toMatchObject({ left: "145px" });
    expect(updates.get("c")).toMatchObject({ left: "300px" });
  });
  it("does not create an empty or single-child distribution transaction", () => {
    expect(
      designLayoutChildUpdates([container()], [], {
        type: "align",
        axis: "x",
        value: "end",
      }).size,
    ).toBe(0);
    expect(
      designLayoutChildUpdates([container()], [layer("a", "parent")], {
        type: "distribute",
        axis: "x",
      }).size,
    ).toBe(0);
  });
  it("fits the container around children while retaining its origin, borders and padding", () => {
    const parent = container();
    parent.styles = {
      ...parent.styles,
      paddingRight: "12px",
      paddingBottom: "8px",
      borderLeftWidth: "2px",
      borderRightWidth: "2px",
      borderTopWidth: "2px",
      borderBottomWidth: "2px",
    };
    const updates = designLayoutChildUpdates(
      [parent],
      [layer("a", "parent", 40, 100)],
      { type: "resize-fit" },
    );
    expect(updates.get("parent")).toMatchObject({
      width: "156px",
      height: "102px",
    });
    expect(updates.get("parent")?.left).toBeUndefined();
  });
  it("aggregates multiple containers without claiming a shared pin when they differ", () => {
    const parent = container();
    const other = container();
    other.oid = "other";
    other.childrenLayout = {
      count: 1,
      nodeIds: ["d"],
      x: "end",
      y: "start",
      truncated: false,
    };
    expect(designLayoutChildrenSummary([parent, other])).toMatchObject({
      count: 4,
      nodeIds: ["a", "b", "c", "d"],
      x: "mixed",
      y: "start",
    });
  });
  it("rejects an oversized group before producing any partial update", () => {
    const parent = container();
    parent.childrenLayout!.truncated = true;
    expect(() =>
      designLayoutChildUpdates([parent], [layer("a", "parent")], {
        type: "align",
        axis: "x",
        value: "start",
      }),
    ).toThrow(/smaller frame/i);
  });
});
