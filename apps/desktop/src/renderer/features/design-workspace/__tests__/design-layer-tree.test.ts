import { describe, expect, it } from "vitest";

import {
  collectDesignLayerParentIds,
  designLayerChildId,
  designLayerParentId,
  designLayerPathIds,
  designLayerPeerIds,
  designLayerBlockEdges,
  designLayerRevealPaths,
  designLayerRevealScrollTop,
  designLayerRovingTabStop,
  designLayerSelectionSubtreeIds,
  designLayerSiblingId,
  designLayerTopLevelSelectionIds,
  designLayerVirtualWindow,
  designFrameLayerChildren,
  designFrameRowDiscloses,
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
  it("keeps a viewport-sized authored frame selectable when the document body owns the canvas", () => {
    const input = {
      nodes: [tree[0]!],
      deepestNodeId: "hero",
      deepestRect: { x: 0, y: 0, width: 600, height: 400 },
      selectedNodeId: null,
      intent: "descend" as const,
      frameSize: { width: 600, height: 400 },
      labeledFrame: true,
      frameRootId: "::zeros-document-body",
    };
    expect(resolveDesignFrameBodyTarget(input)).toEqual({
      kind: "node",
      nodeId: "hero",
    });
    expect(
      resolveDesignFrameBodyTarget({ ...input, frameRootId: "hero" }),
    ).toEqual({ kind: "frame" });
  });
  it("represents the editable frame root once and exposes only its real children", () => {
    const root = tree[0]!;
    expect(designFrameLayerChildren([root], root.oid)).toBe(root.children);
    expect(
      designFrameLayerChildren([{ ...root, children: [] }], root.oid),
    ).toEqual([]);
    expect(
      designFrameLayerChildren(tree, root.oid).map((node) => node.oid),
    ).toEqual(["heading", "footer"]);
    // A nested main must not make its real parent disappear.
    expect(designFrameLayerChildren(tree, "heading")).toBe(tree);
    expect(designFrameLayerChildren(tree, null)).toBe(tree);
  });

  it("unwraps legacy document plumbing without inventing frame children", () => {
    const legacy = [
      { ...tree[0]!, oid: "body", tag: "body", children: [tree[0]!] },
    ];
    expect(designFrameLayerChildren(legacy, "hero")).toBe(tree[0]!.children);
    expect(
      designFrameLayerChildren(legacy, null).map((node) => node.oid),
    ).toEqual(["hero"]);
  });

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
    expect(designLayerRevealPaths(tree, ["heading"]).ancestorIds).toEqual([
      "hero",
    ]);
    expect(designLayerRevealPaths(tree, ["missing"]).ancestorIds).toEqual([]);
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

  it("selects the outer frame first and preserves explicit nested selection", () => {
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
    // The outer frame owns the first ordinary click, even over nested content.
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
    ).toEqual({ kind: "frame" });
    expect(
      resolveDesignFrameBodyTarget({
        nodes: seeded,
        deepestNodeId: "em",
        deepestRect: { x: 40, y: 40, width: 80, height: 20 },
        selectedNodeId: null,
        intent: "descend",
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
    // The empty part of a frame selects that frame, including from a child.
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
    ).toEqual({ kind: "frame" });
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
        intent: "descend",
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
        selectedNodeId: "heading",
        intent: "plain",
        frameSize,
        rootRect: bodyRect,
        labeledFrame: true,
      }),
    ).toEqual({ kind: "unresolved" });
  });

  it.each(["plain", "descend", "deepest"] as const)(
    "maps an explicit frame root to the frame for %s, even without cached geometry",
    (intent) => {
      expect(
        resolveDesignFrameBodyTarget({
          nodes: [],
          deepestNodeId: "::zeros-document-body",
          deepestRect: { x: 0, y: 0, width: 400, height: 300 },
          selectedNodeId: "heading",
          intent,
          frameSize: { width: 400, height: 300 },
          labeledFrame: true,
          frameRootId: "::zeros-document-body",
        }),
      ).toEqual({ kind: "frame" });
    },
  );

  it("descends through document wrappers without hiding an unmarked authored root", () => {
    const nodes = [
      { ...tree[0]!, oid: "body", tag: "body", children: [tree[0]!] },
    ];
    const input = {
      nodes,
      deepestNodeId: "heading",
      deepestRect: { x: 10, y: 10, width: 100, height: 20 },
      selectedNodeId: null,
      intent: "descend" as const,
      frameSize: { width: 400, height: 300 },
      labeledFrame: true,
    };
    expect(
      resolveDesignFrameBodyTarget({ ...input, frameRootId: "hero" }),
    ).toEqual({ kind: "node", nodeId: "heading" });
    expect(
      resolveDesignFrameBodyTarget({
        ...input,
        frameRootId: "::zeros-document-body",
      }),
    ).toEqual({ kind: "node", nodeId: "hero" });
  });

  it("discloses a frame row only when it has layers under it", () => {
    // A new frame's only node is its seeded root, which the row itself is.
    expect(designFrameRowDiscloses(undefined, { nodeCount: 1, layerCount: 0 })).toBe(false);
    expect(designFrameRowDiscloses(undefined, { nodeCount: 3, layerCount: 2 })).toBe(true);
    // Older engines send only nodeCount; a live tree always wins.
    expect(designFrameRowDiscloses(undefined, { nodeCount: 1 })).toBe(true);
    expect(designFrameRowDiscloses([], { nodeCount: 4, layerCount: 3 })).toBe(false);
    expect(designFrameRowDiscloses(tree, { nodeCount: 1, layerCount: 0 })).toBe(true);
  });

  it("opens a reveal's paths in one walk and names the ids the tree lacks", () => {
    const nested = [
      {
        oid: "page",
        tag: "main",
        name: "Page",
        text: null,
        visible: true,
        children: [
          {
            oid: "card",
            tag: "article",
            name: "Card",
            text: null,
            visible: true,
            children: [
              {
                oid: "title",
                tag: "h2",
                name: "Title",
                text: "Plans",
                visible: true,
                children: [],
              },
            ],
          },
          {
            oid: "aside",
            tag: "aside",
            name: "Aside",
            text: null,
            visible: true,
            children: [
              {
                oid: "note",
                tag: "p",
                name: "Note",
                text: "Hi",
                visible: true,
                children: [],
              },
            ],
          },
        ],
      },
    ];
    const reveal = designLayerRevealPaths(nested, ["title", "note", "later"]);
    // Shared ancestors appear once, in document order.
    expect(reveal.ancestorIds).toEqual(["page", "card", "aside"]);
    expect([...reveal.found].sort()).toEqual(["note", "title"]);
    expect(reveal.pathsByNode.get("title")).toEqual(["page", "card"]);
    expect(reveal.pathsByNode.get("note")).toEqual(["page", "aside"]);
    expect(reveal.pathsByNode.has("later")).toBe(false);
    const reordered = designLayerRevealPaths(
      [{ ...nested[0]!, children: [...nested[0]!.children].reverse() }],
      ["title", "note"],
    );
    expect(reordered.pathsByNode).toEqual(reveal.pathsByNode);
    // The union alone cannot detect two selected layers swapping parents.
    const [card, aside] = nested[0]!.children;
    const swapped = designLayerRevealPaths(
      [{
        ...nested[0]!,
        children: [
          { ...card!, children: aside!.children },
          { ...aside!, children: card!.children },
        ],
      }],
      ["title", "note"],
    );
    expect(swapped.ancestorIds).toEqual(reveal.ancestorIds);
    expect(swapped.pathsByNode.get("title")).toEqual(["page", "aside"]);
    expect(swapped.pathsByNode.get("note")).toEqual(["page", "card"]);
    // A top-level node needs no container opened, yet it is found.
    const top = designLayerRevealPaths(nested, ["page"]);
    expect(top.ancestorIds).toEqual([]);
    expect(top.found.has("page")).toBe(true);
    expect(top.pathsByNode.get("page")).toEqual([]);
    expect(designLayerRevealPaths(nested, []).found.size).toBe(0);
  });

  it("scrolls a revealed row into view only as far as a designer expects", () => {
    const base = { rowHeight: 28, viewportHeight: 200, scrollHeight: 2_000 };
    // Fully visible rows never move the list.
    expect(
      designLayerRevealScrollTop({ ...base, rowTop: 56, scrollTop: 0 }),
    ).toBeNull();
    // A row peeking at the bottom edge scrolls the least distance.
    expect(
      designLayerRevealScrollTop({ ...base, rowTop: 190, scrollTop: 0 }),
    ).toBe(18);
    // A row peeking at the top edge aligns to the top.
    expect(
      designLayerRevealScrollTop({ ...base, rowTop: 90, scrollTop: 100 }),
    ).toBe(90);
    // A row out of sight lands centred, so its neighbours read around it.
    expect(
      designLayerRevealScrollTop({ ...base, rowTop: 1_000, scrollTop: 0 }),
    ).toBe(914);
    // ...but never past either end of the list.
    expect(
      designLayerRevealScrollTop({ ...base, rowTop: 1_990, scrollTop: 0 }),
    ).toBe(1_800);
    expect(
      designLayerRevealScrollTop({ ...base, rowTop: 0, scrollTop: 1_500 }),
    ).toBe(0);
    // Keyboard travel moves the least distance even from out of sight.
    expect(
      designLayerRevealScrollTop({
        ...base,
        rowTop: 1_000,
        scrollTop: 0,
        mode: "nearest",
      }),
    ).toBe(828);
    // Nothing to measure yet: leave the list alone.
    expect(
      designLayerRevealScrollTop({
        ...base,
        rowTop: 1_000,
        scrollTop: 0,
        viewportHeight: 0,
      }),
    ).toBeNull();
  });
});
