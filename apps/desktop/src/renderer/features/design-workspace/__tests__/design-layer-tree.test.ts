import { describe, expect, it } from "vitest";

import {
  collectDesignLayerParentIds,
  designLayerAncestorIds,
  designLayerChildId,
  designLayerParentId,
  designLayerPathIds,
  designLayerPeerIds,
  designLayerBlockEdges,
  designLayerRevealWindow,
  designLayerRovingTabStop,
  designLayerSelectionSubtreeIds,
  designLayerSiblingId,
  designLayerTopLevelSelectionIds,
  designLayerVirtualWindow,
  flattenDesignLayerTree,
  resolveDesignFrameBodyTarget,
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

  it("keeps a tall viewport window intact while keyboard travel stays inside it", () => {
    const current = { start: 0, end: 48 };
    expect(
      designLayerRevealWindow({
        count: 10_000,
        index: 1,
        viewportHeight: 840,
        current,
      }),
    ).toEqual(current);
    expect(
      designLayerRevealWindow({
        count: 10_000,
        index: 500,
        viewportHeight: 840,
        current,
      }),
    ).toEqual({ start: 488, end: 542 });
  });

  it("keeps one roving tab stop inside the rendered virtual slice", () => {
    const dense = Array.from(
      { length: 500 },
      (_, index) => `layer:home.html:layer-${index}`,
    );
    const rendered = dense.slice(200, 240);
    expect(designLayerRovingTabStop(rendered, dense[220])).toBe(dense[220]);
    expect(designLayerRovingTabStop(rendered, dense[0])).toBe(dense[200]);
    // A frame row holds the tab stop exactly like a layer row.
    expect(designLayerRovingTabStop(["frame:home.html"], null)).toBe(
      "frame:home.html",
    );
    expect(designLayerRovingTabStop([], "frame:home.html")).toBeNull();
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

  it("shows children only under explicitly expanded parents", () => {
    // Rows default to folded, so an untouched document costs one row per root
    // no matter how deep it is.
    expect(
      flattenDesignLayerTree(tree, { expandedNodeIds: new Set() }).map(
        (layer) => layer.node.oid,
      ),
    ).toEqual(["hero", "footer"]);
    expect(
      flattenDesignLayerTree(tree, {
        expandedNodeIds: new Set(["hero"]),
      }).map((layer) => layer.node.oid),
    ).toEqual(["hero", "heading", "footer"]);
    // Omitting the option keeps whole-tree callers (name maps, counts) intact.
    expect(flattenDesignLayerTree(tree).map((layer) => layer.node.oid)).toEqual(
      ["hero", "heading", "footer"],
    );
  });

  it("rounds a selection-owned run as one block, top row to last row", () => {
    // A container and the rows it owns: [container, child, unrelated sibling].
    expect(designLayerBlockEdges([true, true, false])).toEqual([
      "top",
      "bottom",
      null,
    ]);
    // A lone leaf owns nothing, so it stays a single rounded chip.
    expect(designLayerBlockEdges([false, false, true])).toEqual([
      null,
      null,
      "single",
    ]);
    // A selected frame row leads its own run and the last layer closes it.
    expect(designLayerBlockEdges([true, true, true, true])).toEqual([
      "top",
      "middle",
      "middle",
      "bottom",
    ]);
    // Two frames' runs stay separate blocks, never one merged fill.
    expect(designLayerBlockEdges([true, true, false, true, true])).toEqual([
      "top",
      "bottom",
      null,
      "top",
      "bottom",
    ]);
    expect(designLayerBlockEdges([])).toEqual([]);
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

  it("tints exactly the selection's descendants, never its ancestors", () => {
    expect(designLayerSelectionSubtreeIds(tree, ["hero"])).toEqual(
      new Set(["heading"]),
    );
    // A selected leaf owns nothing; its parent stays untinted.
    expect(designLayerSelectionSubtreeIds(tree, ["heading"])).toEqual(
      new Set(),
    );
    expect(designLayerSelectionSubtreeIds(tree, [])).toEqual(new Set());
    // Multi-selection unions each selected node's subtree.
    expect(designLayerSelectionSubtreeIds(tree, ["hero", "footer"])).toEqual(
      new Set(["heading"]),
    );
  });

  it("marks descendants of hidden layers so whole subtrees can fade", () => {
    const shadowed = [
      {
        oid: "wrap",
        tag: "div",
        name: "Wrap",
        text: null,
        visible: false,
        children: [
          {
            oid: "inner",
            tag: "p",
            name: "Inner",
            text: "hi",
            visible: true,
            children: [],
          },
        ],
      },
    ];
    expect(
      flattenDesignLayerTree(shadowed).map((layer) => ({
        oid: layer.node.oid,
        hiddenByAncestor: layer.hiddenByAncestor,
      })),
    ).toEqual([
      { oid: "wrap", hiddenByAncestor: false },
      { oid: "inner", hiddenByAncestor: true },
    ]);
    // A folded hidden parent still fades on its own row.
    expect(
      flattenDesignLayerTree(shadowed, {
        expandedNodeIds: new Set(),
      }).map((layer) => ({
        oid: layer.node.oid,
        visible: layer.node.visible,
      })),
    ).toEqual([{ oid: "wrap", visible: false }]);
  });

  it("keeps a frame's body-like root out of plain click selection", () => {
    const frameSize = { width: 400, height: 300 };
    const bodyRect = { x: 0, y: 0, width: 400, height: 300 };
    const seeded = [
      {
        oid: "main",
        tag: "main",
        name: "main",
        text: null,
        visible: true,
        children: [
          {
            oid: "heading",
            tag: "h1",
            name: "Heading",
            text: "Hello",
            visible: true,
            children: [
              {
                oid: "em",
                tag: "em",
                name: "em",
                text: "Hello",
                visible: true,
                children: [],
              },
            ],
          },
        ],
      },
    ];
    // Plain click over content enters at the root's children.
    expect(
      resolveDesignFrameBodyTarget({
        nodes: seeded,
        deepestNodeId: "em",
        deepestRect: { x: 40, y: 40, width: 80, height: 20 },
        selectedNodeId: null,
        intent: "plain",
        frameSize,
        rootRect: bodyRect,
        labeledFrame: true,
      }),
    ).toEqual({ kind: "node", nodeId: "heading" });
    // Clicking the already-selected node keeps it selected for dragging.
    expect(
      resolveDesignFrameBodyTarget({
        nodes: seeded,
        deepestNodeId: "em",
        deepestRect: { x: 40, y: 40, width: 80, height: 20 },
        selectedNodeId: "heading",
        intent: "plain",
        frameSize,
        rootRect: bodyRect,
        labeledFrame: true,
      }),
    ).toEqual({ kind: "node", nodeId: "heading" });
    // Repeated clicks descend one level; the platform modifier goes deepest.
    expect(
      resolveDesignFrameBodyTarget({
        nodes: seeded,
        deepestNodeId: "em",
        deepestRect: { x: 40, y: 40, width: 80, height: 20 },
        selectedNodeId: "heading",
        intent: "descend",
        frameSize,
        rootRect: bodyRect,
        labeledFrame: true,
      }),
    ).toEqual({ kind: "node", nodeId: "em" });
    expect(
      resolveDesignFrameBodyTarget({
        nodes: seeded,
        deepestNodeId: "em",
        deepestRect: { x: 40, y: 40, width: 80, height: 20 },
        selectedNodeId: null,
        intent: "deepest",
        frameSize,
        rootRect: bodyRect,
        labeledFrame: true,
      }),
    ).toEqual({ kind: "node", nodeId: "em" });
    // A root-only hit on a frame-filling root reads as empty canvas.
    expect(
      resolveDesignFrameBodyTarget({
        nodes: seeded,
        deepestNodeId: "main",
        deepestRect: bodyRect,
        selectedNodeId: "heading",
        intent: "plain",
        frameSize,
        rootRect: bodyRect,
        labeledFrame: true,
      }),
    ).toEqual({ kind: "clear" });
    // A small lone root is a real element, not a frame body.
    const lone = [
      {
        oid: "chip",
        tag: "div",
        name: "Chip",
        text: null,
        visible: true,
        children: [],
      },
    ];
    expect(
      resolveDesignFrameBodyTarget({
        nodes: lone,
        deepestNodeId: "chip",
        deepestRect: { x: 24, y: 24, width: 80, height: 40 },
        selectedNodeId: null,
        intent: "plain",
        frameSize,
        rootRect: null,
        labeledFrame: true,
      }),
    ).toEqual({ kind: "node", nodeId: "chip" });
    // Text frames have no label, so their root stays plainly clickable.
    expect(
      resolveDesignFrameBodyTarget({
        nodes: lone,
        deepestNodeId: "chip",
        deepestRect: bodyRect,
        selectedNodeId: null,
        intent: "plain",
        frameSize,
        rootRect: bodyRect,
        labeledFrame: false,
      }),
    ).toEqual({ kind: "node", nodeId: "chip" });
    // A hit the local tree cannot place defers to the runtime's own modes.
    expect(
      resolveDesignFrameBodyTarget({
        nodes: seeded,
        deepestNodeId: "gone",
        deepestRect: bodyRect,
        selectedNodeId: null,
        intent: "plain",
        frameSize,
        rootRect: bodyRect,
        labeledFrame: true,
      }),
    ).toEqual({ kind: "unresolved" });
  });
});
