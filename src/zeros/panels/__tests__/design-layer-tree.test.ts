import { describe, expect, it } from "vitest";

import {
  collectDesignLayerParentIds,
  designLayerAncestorIds,
  flattenDesignLayerTree,
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
  });
});
