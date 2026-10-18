import { describe, expect, it } from "vitest";
import type { DesignRuntimeNodeDetails } from "@zeros/protocol/design-runtime";
import { createDesignLayoutDropResolver, designLayoutDrop } from "../design-layout-drag";

function node(
  oid: string,
  parentId: string | null,
  x: number,
  y: number,
  width = 100,
  height = 80,
  display = "block",
): DesignRuntimeNodeDetails {
  return {
    oid,
    sourceVersion: "a".repeat(24),
    name: oid,
    tag: "div",
    text: null,
    selector: "",
    visible: true,
    breadcrumb: [],
    rect: { x, y, width, height },
    styles: {
      display,
      position: parentId ? "relative" : "static",
      flexDirection: "row",
      width: `${width}px`,
      height: `${height}px`,
      boxSizing: "border-box",
    },
    layout: {
      x,
      y,
      parentId,
      parentWidth: 600,
      parentHeight: 400,
      parentDisplay: "flex",
      parentPosition: "relative",
      isContainingBlock: true,
    },
    childCoordinateSpace: [1, 0, 0, 1, x, y],
  };
}
const root = node("root", null, 0, 0, 600, 400, "flex");
const a = node("a", "root", 0, 0);
const b = node("b", "root", 110, 0);
const c = node("c", "root", 220, 0);
describe("canvas layout drop intent", () => {
  it.each([0.5, 1, 8])("uses the moved center and screen-space boundary hysteresis at zoom %s", (zoom) => {
    const outer = node("outer", null, 0, 0, 900, 700);
    const inner = node("inner", "outer", 100, 100, 200, 200);
    const child = { ...node("child", "inner", 150, 150, 20, 20), styles: { position: "absolute", width: "20px", height: "20px" } };
    const resolve = createDesignLayoutDropResolver(child, [outer, inner, child], { zoom: () => zoom });
    expect(resolve({ x: 890, y: 690 }, { x: 150, y: 150 })?.parentId).toBe("inner");
    expect(resolve({ x: 0, y: 0 }, { x: 290 + 7 / zoom, y: 150 })?.parentId).toBe("inner");
    expect(resolve({ x: 0, y: 0 }, { x: 290 + 9 / zoom, y: 150 })?.parentId).toBe("outer");
  });

  it("does not treat the empty corner of a rotated parent AABB as a containing parent", () => {
    const outer = node("outer", null, 0, 0, 500, 500);
    const parent = { ...node("diamond", "outer", 100, 0, 200, 200), box: { width: 100, height: 100 }, borderCoordinateSpace: [1, 1, -1, 1, 200, 0] } as DesignRuntimeNodeDetails;
    const child = { ...node("child", "diamond", 180, 80, 10, 10), styles: { position: "absolute" } };
    const resolve = createDesignLayoutDropResolver(child, [outer, parent, child], { zoom: () => 1 });
    expect(resolve({ x: 110, y: 10 }, { x: 105, y: 5 })?.parentId).toBe("outer");
  });

  it("retains free positioning when entering a flex container", () => {
    const outer = node("outer", null, 0, 0, 900, 700);
    const child = { ...a, layout: { ...a.layout!, parentId: "outer" }, styles: { ...a.styles, position: "absolute" } };
    const resolve = createDesignLayoutDropResolver(child, [outer, root, child], { zoom: () => 1, preserveFreePosition: true });
    expect(resolve({ x: 400, y: 200 }, { x: 400, y: 200 })?.styles.position).toBe("absolute");
  });
  it("reorders in a flow instead of adding offsets or nesting into a sibling", () => {
    const drop = designLayoutDrop(
      a,
      [root, a, b, c],
      { x: 190, y: 30 },
      { x: 180, y: 0 },
    );
    expect(drop).toMatchObject({
      parentId: "root",
      beforeId: "c",
      styles: { position: "relative", left: "auto", top: "auto" },
    });
  });
  it("keeps explicitly absolute children out of flow and preserves their stacking order", () => {
    const floating = {
      ...a,
      styles: {
        ...a.styles,
        position: "absolute",
        marginLeft: "4px",
        marginTop: "6px",
      },
    };
    expect(
      designLayoutDrop(
        floating,
        [root, floating, b, c],
        { x: 190, y: 30 },
        { x: 180, y: 20 },
      ),
    ).toMatchObject({
      parentId: "root",
      beforeId: "b",
      styles: { position: "absolute", left: "176px", top: "14px" },
    });
  });

  it("maps reversed flex and grid placement to authored sibling order", () => {
    const reverse = {
      ...root,
      styles: { ...root.styles, flexDirection: "row-reverse" },
    };
    expect(
      designLayoutDrop(a, [reverse, a, b, c], { x: 119, y: 30 }, { x: 0, y: 0 })
        ?.beforeId,
    ).toBe("c");
    const grid = { ...root, styles: { ...root.styles, display: "grid" } };
    expect(
      designLayoutDrop(a, [grid, a, b, c], { x: 119, y: 30 }, { x: 0, y: 0 })
        ?.beforeId,
    ).toBe("b");
  });
  it("leaves an inner parent, excludes descendants, and enters an auto-layout parent", () => {
    const outer = node("outer", null, 0, 0, 900, 700);
    const parent = { ...root, layout: { ...root.layout!, parentId: "outer" } };
    expect(
      designLayoutDrop(
        a,
        [outer, parent, a, b],
        { x: 750, y: 500 },
        { x: 700, y: 460 },
      ),
    ).toMatchObject({
      parentId: "outer",
      styles: { position: "absolute", left: "700px", top: "460px" },
    });
    const free = {
      ...a,
      layout: { ...a.layout!, parentId: "outer", parentDisplay: "block" },
    };
    expect(
      designLayoutDrop(
        free,
        [outer, parent, free, b],
        { x: 400, y: 200 },
        { x: 400, y: 200 },
      )?.parentId,
    ).toBe("root");
    expect(
      designLayoutDrop(
        a,
        [root, a, b],
        { x: 1000, y: 1000 },
        { x: 980, y: 980 },
      ),
    ).toBeNull();
  });
});
