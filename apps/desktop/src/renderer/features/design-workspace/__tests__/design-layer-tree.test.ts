import { describe, expect, it } from "vitest";

import {
  collectDesignLayerParentIds,
  designLayerAncestorIds,
  designLayerChildId,
  designLayerParentId,
  designLayerPathIds,
  designLayerPeerIds,
  designLayerSiblingId,
  designLayerTopLevelSelectionIds,
  designLayerVirtualWindow,
  flattenDesignLayerTree,
  resolveDesignLayerHit,
} from "../design-layer-tree";

const tree = [
  {
    oid: "hero",
    tag: "main",
    name: "Hero",
    text: null,
    visible: true,
    children: [
      {
        oid: "heading",
        tag: "h1",
        name: "Heading",
        text: "Hello",
        visible: true,
        children: [],
      },
    ],
  },
  {
    oid: "footer",
    tag: "footer",
    name: "Footer",
    text: null,
    visible: false,
    children: [],
  },
];

describe("design layer tree", () => {
  it("keeps small trees whole and windows dense layer sets with overscan", () => {
    expect(
      designLayerVirtualWindow({
        count: 100,
        visibleTop: 560,
        viewportHeight: 280,
      }),
    ).toEqual({ start: 0, end: 100 });
    expect(
      designLayerVirtualWindow({
        count: 10_000,
        visibleTop: 28_000,
        viewportHeight: 560,
      }),
    ).toEqual({ start: 988, end: 1_032 });
    expect(
      designLayerVirtualWindow({
        count: 10_000,
        visibleTop: 280_000,
        viewportHeight: 560,
      }),
    ).toEqual({ start: 9_988, end: 10_000 });
  });

  it("preserves DOM order, depth, and parent identity for keyboard traversal", () => {
    const flattened = flattenDesignLayerTree(tree);

    expect(
      flattened.map(({ node, depth, parentOid }) => ({
        oid: node.oid,
        depth,
        parentOid,
      })),
    ).toEqual([
      { oid: "hero", depth: 0, parentOid: null },
      { oid: "heading", depth: 1, parentOid: "hero" },
      { oid: "footer", depth: 0, parentOid: null },
    ]);
  });

  it("omits descendants of collapsed parents", () => {
    expect(
      flattenDesignLayerTree(tree, {
        collapsedNodeIds: new Set(["hero"]),
      }).map((layer) => layer.node.oid),
    ).toEqual(["hero", "footer"]);
  });

  it("searches names, tags, and text while retaining matching ancestry", () => {
    expect(
      flattenDesignLayerTree(tree, {
        collapsedNodeIds: new Set(["hero"]),
        query: "hello",
      }).map((layer) => layer.node.oid),
    ).toEqual(["hero", "heading"]);
    expect(
      flattenDesignLayerTree(tree, { query: "footer" }).map(
        (layer) => layer.node.oid,
      ),
    ).toEqual(["footer"]);
  });

  it("finds parent containers and the exact ancestor path", () => {
    expect(collectDesignLayerParentIds(tree)).toEqual(new Set(["hero"]));
    expect(designLayerAncestorIds(tree, "heading")).toEqual(["hero"]);
    expect(designLayerAncestorIds(tree, "missing")).toEqual([]);
    expect(designLayerPathIds(tree, "heading")).toEqual(["hero", "heading"]);
  });

  it("navigates parent, child, and wrapping siblings by stable identity", () => {
    expect(designLayerParentId(tree, "heading")).toBe("hero");
    expect(designLayerParentId(tree, "hero")).toBeNull();
    expect(designLayerChildId(tree, "hero")).toBe("heading");
    expect(designLayerChildId(tree, "heading")).toBeNull();
    expect(designLayerSiblingId(tree, "hero", 1)).toBe("footer");
    expect(designLayerSiblingId(tree, "footer", 1)).toBe("hero");
    expect(designLayerSiblingId(tree, "hero", -1)).toBe("footer");
    expect(designLayerSiblingId(tree, "heading", 1)).toBe("heading");
    expect(
      designLayerPeerIds([tree[0]!, { ...tree[1]!, visible: true }], "hero"),
    ).toEqual(["footer"]);
    expect(designLayerPeerIds(tree, "hero")).toEqual([]);
    expect(designLayerPeerIds(tree, "heading")).toEqual([]);
    expect(designLayerPeerIds(tree, "missing")).toEqual([]);
  });

  it("resolves Figma-like parent, deep, preserve, and drill-in selection", () => {
    expect(resolveDesignLayerHit(tree, "heading", null, "top-level")).toBe(
      "hero",
    );
    expect(resolveDesignLayerHit(tree, "heading", null, "deepest")).toBe(
      "heading",
    );
    expect(resolveDesignLayerHit(tree, "heading", "hero", "preserve")).toBe(
      "hero",
    );
    expect(resolveDesignLayerHit(tree, "heading", "hero", "descend")).toBe(
      "heading",
    );
    expect(resolveDesignLayerHit(tree, "heading", "heading", "descend")).toBe(
      "heading",
    );
    expect(resolveDesignLayerHit(tree, "footer", "hero", "preserve")).toBe(
      "footer",
    );
  });

  it("keeps the current nesting depth when selecting a nested peer", () => {
    const nestedPeers = [
      {
        oid: "page",
        tag: "main",
        name: "Page",
        text: null,
        visible: true,
        children: [
          {
            oid: "hero",
            tag: "section",
            name: "Hero",
            text: null,
            visible: true,
            children: [
              {
                oid: "heading",
                tag: "h1",
                name: "Heading",
                text: "Hello",
                visible: true,
                children: [],
              },
              {
                oid: "copy",
                tag: "p",
                name: "Copy",
                text: "World",
                visible: true,
                children: [],
              },
            ],
          },
          {
            oid: "footer",
            tag: "footer",
            name: "Footer",
            text: null,
            visible: true,
            children: [
              {
                oid: "legal",
                tag: "span",
                name: "Legal",
                text: "Legal",
                visible: true,
                children: [],
              },
            ],
          },
        ],
      },
    ];

    expect(
      resolveDesignLayerHit(nestedPeers, "copy", "heading", "preserve"),
    ).toBe("copy");
    expect(
      resolveDesignLayerHit(nestedPeers, "legal", "heading", "preserve"),
    ).toBe("legal");
    expect(resolveDesignLayerHit(nestedPeers, "copy", "hero", "preserve")).toBe(
      "hero",
    );
  });

  it("removes selected descendants when an ancestor already owns a group operation", () => {
    expect(
      designLayerTopLevelSelectionIds(tree, ["heading", "hero", "footer"]),
    ).toEqual(["hero", "footer"]);
    expect(designLayerTopLevelSelectionIds(tree, ["heading"])).toEqual([
      "heading",
    ]);
  });
});
