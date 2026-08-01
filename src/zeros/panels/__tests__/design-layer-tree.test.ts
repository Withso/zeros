import { describe, expect, it } from "vitest";

import { flattenDesignLayerTree } from "../design-layer-tree";

describe("design layer tree", () => {
  it("preserves DOM order, depth, and parent identity for keyboard traversal", () => {
    const flattened = flattenDesignLayerTree([
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
    ]);

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
});
