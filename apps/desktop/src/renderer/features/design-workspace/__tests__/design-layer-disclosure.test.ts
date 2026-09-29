import { beforeEach, describe, expect, it } from "vitest";

import type { DesignRuntimeTreeNode } from "@zeros/protocol/design-runtime";

import {
  EMPTY_DESIGN_FRAME_DISCLOSURE,
  collapseAllDesignLayers,
  designFrameDisclosure,
  designWorkspaceHasExpandedLayers,
  forgetDesignLayerDisclosure,
  requestDesignLayerReveal,
  resetDesignLayerDisclosureForTests,
  revealDesignLayerPath,
  setDesignFrameTreeExpanded,
  settleDesignLayerReveal,
  toggleDesignFrameTreeExpanded,
  toggleDesignLayerExpanded,
  useDesignLayerDisclosureStore,
} from "../state/design-layer-disclosure";

function node(
  oid: string,
  children: DesignRuntimeTreeNode[] = [],
): DesignRuntimeTreeNode {
  return { oid, tag: "div", name: oid, text: null, visible: true, children };
}

/** body > main > (hero > heading, footer) */
const TREE = [
  node("body", [
    node("main", [node("hero", [node("heading")]), node("footer")]),
  ]),
];

function revealRequest(workspaceId: string) {
  return useDesignLayerDisclosureStore.getState().revealByWorkspace[
    workspaceId
  ];
}

function workspaceDisclosures(workspaceId: string) {
  return (
    useDesignLayerDisclosureStore.getState().byWorkspace[workspaceId]?.frames ??
    {}
  );
}

describe("design layer disclosure", () => {
  beforeEach(() => {
    resetDesignLayerDisclosureForTests();
  });

  it("holds several frames open at once, each on its own terms", () => {
    toggleDesignFrameTreeExpanded("workspace-a", "home.html");
    toggleDesignFrameTreeExpanded("workspace-a", "pricing.html");
    toggleDesignLayerExpanded("workspace-a", "home.html", "main");

    // Opening or working in one frame never folds another.
    expect(designFrameDisclosure("workspace-a", "home.html")).toEqual({
      treeExpanded: true,
      expandedNodeIds: ["main"],
    });
    expect(designFrameDisclosure("workspace-a", "pricing.html")).toEqual({
      treeExpanded: true,
      expandedNodeIds: [],
    });

    // Folding a frame keeps its inner shape, so reopening restores it.
    toggleDesignFrameTreeExpanded("workspace-a", "home.html");
    expect(designFrameDisclosure("workspace-a", "home.html")).toEqual({
      treeExpanded: false,
      expandedNodeIds: ["main"],
    });
    expect(
      designFrameDisclosure("workspace-a", "pricing.html").treeExpanded,
    ).toBe(true);
  });

  it("keeps each frame's expansion separate and intact across switches", () => {
    toggleDesignLayerExpanded("workspace-a", "home.html", "main");
    toggleDesignLayerExpanded("workspace-a", "home.html", "hero");
    toggleDesignLayerExpanded("workspace-a", "pricing.html", "plans");

    // Visiting another frame — or another workspace — cannot disturb what the
    // user left open here.
    toggleDesignLayerExpanded("workspace-b", "home.html", "other");
    expect(
      designFrameDisclosure("workspace-a", "home.html").expandedNodeIds,
    ).toEqual(["main", "hero"]);
    expect(
      designFrameDisclosure("workspace-a", "pricing.html").expandedNodeIds,
    ).toEqual(["plans"]);
    expect(
      designFrameDisclosure("workspace-b", "home.html").expandedNodeIds,
    ).toEqual(["other"]);

    toggleDesignLayerExpanded("workspace-a", "home.html", "hero");
    expect(
      designFrameDisclosure("workspace-a", "home.html").expandedNodeIds,
    ).toEqual(["main"]);
  });

  it("returns one stable identity for frames nobody has opened", () => {
    expect(designFrameDisclosure("workspace-a", "home.html")).toBe(
      EMPTY_DESIGN_FRAME_DISCLOSURE,
    );
    expect(designFrameDisclosure(null, null)).toBe(
      EMPTY_DESIGN_FRAME_DISCLOSURE,
    );
    toggleDesignLayerExpanded("workspace-a", "home.html", "main");
    const opened = designFrameDisclosure("workspace-a", "home.html");
    // An unrelated frame's update must not hand the panel a new object.
    toggleDesignLayerExpanded("workspace-a", "pricing.html", "plans");
    expect(designFrameDisclosure("workspace-a", "home.html")).toBe(opened);
  });

  it("reveals a selection path without disturbing an unrelated fold", () => {
    toggleDesignLayerExpanded("workspace-a", "home.html", "aside");
    revealDesignLayerPath("workspace-a", "home.html", ["body", "main"]);
    expect(designFrameDisclosure("workspace-a", "home.html")).toEqual({
      treeExpanded: true,
      expandedNodeIds: ["aside", "body", "main"],
    });

    // Revealing the same path again is a no-op, so a container the user folds
    // afterwards is never reopened behind their back.
    const revealed = designFrameDisclosure("workspace-a", "home.html");
    revealDesignLayerPath("workspace-a", "home.html", ["body", "main"]);
    expect(designFrameDisclosure("workspace-a", "home.html")).toBe(revealed);

    // A canvas selection inside a folded frame opens that frame again.
    setDesignFrameTreeExpanded("workspace-a", "home.html", false);
    revealDesignLayerPath("workspace-a", "home.html", ["body", "main"]);
    expect(designFrameDisclosure("workspace-a", "home.html").treeExpanded).toBe(
      true,
    );
  });

  it("collapses every frame and container in the workspace at once", () => {
    toggleDesignFrameTreeExpanded("workspace-a", "home.html");
    toggleDesignLayerExpanded("workspace-a", "home.html", "main");
    toggleDesignFrameTreeExpanded("workspace-a", "pricing.html");
    toggleDesignLayerExpanded("workspace-a", "pricing.html", "plans");
    // A container left open inside a folded frame still counts as expanded.
    toggleDesignLayerExpanded("workspace-a", "about.html", "hero");
    toggleDesignFrameTreeExpanded("workspace-b", "home.html");

    expect(
      designWorkspaceHasExpandedLayers(workspaceDisclosures("workspace-a")),
    ).toBe(true);
    collapseAllDesignLayers("workspace-a");
    expect(
      designWorkspaceHasExpandedLayers(workspaceDisclosures("workspace-a")),
    ).toBe(false);
    for (const frame of ["home.html", "pricing.html", "about.html"]) {
      expect(designFrameDisclosure("workspace-a", frame)).toBe(
        EMPTY_DESIGN_FRAME_DISCLOSURE,
      );
    }
    // Another workspace's tree is untouched.
    expect(designFrameDisclosure("workspace-b", "home.html").treeExpanded).toBe(
      true,
    );
  });

  it("reports expansion for the frames a panel currently shows", () => {
    toggleDesignFrameTreeExpanded("workspace-a", "home.html");
    const disclosures = workspaceDisclosures("workspace-a");
    expect(designWorkspaceHasExpandedLayers(disclosures, ["home.html"])).toBe(
      true,
    );
    // A frame that no longer exists cannot enable Collapse all on its own.
    expect(
      designWorkspaceHasExpandedLayers(disclosures, ["pricing.html"]),
    ).toBe(false);
    expect(designWorkspaceHasExpandedLayers({}, ["home.html"])).toBe(false);
  });

  it("bounds frames per workspace, workspaces, and ids per frame", () => {
    for (let index = 0; index < 40; index += 1) {
      toggleDesignLayerExpanded("workspace-a", `frame-${index}.html`, "main");
    }
    const workspace =
      useDesignLayerDisclosureStore.getState().byWorkspace["workspace-a"];
    expect(Object.keys(workspace?.frames ?? {}).length).toBe(24);
    // The oldest frames fall out; the newest stay addressable.
    expect(designFrameDisclosure("workspace-a", "frame-0.html")).toBe(
      EMPTY_DESIGN_FRAME_DISCLOSURE,
    );
    expect(
      designFrameDisclosure("workspace-a", "frame-39.html").expandedNodeIds,
    ).toEqual(["main"]);

    for (let index = 0; index < 12; index += 1) {
      toggleDesignLayerExpanded(`workspace-${index}`, "home.html", "main");
    }
    expect(
      Object.keys(useDesignLayerDisclosureStore.getState().byWorkspace).length,
    ).toBe(8);

    revealDesignLayerPath(
      "workspace-deep",
      "home.html",
      Array.from({ length: 600 }, (_, index) => `node-${index}`),
    );
    const deep = designFrameDisclosure("workspace-deep", "home.html");
    expect(deep.expandedNodeIds.length).toBe(512);
    expect(deep.expandedNodeIds[0]).toBe("node-88");
    expect(deep.expandedNodeIds.at(-1)).toBe("node-599");
  });

  it("does not allocate a frame slot for a reveal that asks for nothing", () => {
    setDesignFrameTreeExpanded("workspace-a", "home.html", false);
    expect(useDesignLayerDisclosureStore.getState().byWorkspace).toEqual({});
    // An opened frame keeps its entry once it holds real state.
    toggleDesignLayerExpanded("workspace-a", "home.html", "main");
    const opened = useDesignLayerDisclosureStore.getState().byWorkspace;
    setDesignFrameTreeExpanded("workspace-a", "home.html", false);
    expect(useDesignLayerDisclosureStore.getState().byWorkspace).toBe(opened);
  });

  it("rejects malformed ids and prunes a deleted workspace", () => {
    revealDesignLayerPath("workspace-a", "home.html", [
      "main",
      "",
      "   ",
      `${String.fromCharCode(0)}oid`,
      "a".repeat(300),
    ]);
    expect(
      designFrameDisclosure("workspace-a", "home.html").expandedNodeIds,
    ).toEqual(["main"]);
    forgetDesignLayerDisclosure("workspace-a");
    expect(designFrameDisclosure("workspace-a", "home.html")).toBe(
      EMPTY_DESIGN_FRAME_DISCLOSURE,
    );
  });

  it("opens a revealed layer's frame and path and asks for its row in one update", () => {
    const updates: unknown[] = [];
    const unsubscribe = useDesignLayerDisclosureStore.subscribe((state) =>
      updates.push(state),
    );
    requestDesignLayerReveal({
      workspaceId: "workspace-a",
      frame: "home.html",
      nodeIds: ["heading"],
      tree: TREE,
    });
    unsubscribe();
    // One store publication: the panel never paints the row folded away.
    expect(updates).toHaveLength(1);
    expect(designFrameDisclosure("workspace-a", "home.html")).toEqual({
      treeExpanded: true,
      expandedNodeIds: ["body", "main", "hero"],
    });
    const first = revealRequest("workspace-a");
    expect(first).toMatchObject({
      frame: "home.html",
      nodeIds: ["heading"],
      pendingNodeIds: [],
    });

    // Asking again for the same row is a fresh request, so the panel scrolls
    // to it again even though nothing had to open.
    requestDesignLayerReveal({
      workspaceId: "workspace-a",
      frame: "home.html",
      nodeIds: ["heading"],
      tree: TREE,
    });
    expect(revealRequest("workspace-a")!.nonce).toBeGreaterThan(first!.nonce);
  });

  it("scrolls to the frame row for the frame or its root without unfolding it", () => {
    requestDesignLayerReveal({
      workspaceId: "workspace-a",
      frame: "home.html",
      nodeIds: [],
      tree: TREE,
    });
    requestDesignLayerReveal({
      workspaceId: "workspace-a",
      frame: "home.html",
      nodeIds: ["body"],
      tree: TREE,
      frameRowNodeId: "body",
    });
    expect(designFrameDisclosure("workspace-a", "home.html")).toBe(
      EMPTY_DESIGN_FRAME_DISCLOSURE,
    );
    expect(revealRequest("workspace-a")).toMatchObject({ nodeIds: ["body"] });
  });

  it("keeps an unknown layer pending until a tree holds it, then opens it once", () => {
    requestDesignLayerReveal({
      workspaceId: "workspace-a",
      frame: "home.html",
      nodeIds: ["heading", "fresh"],
      tree: TREE,
    });
    const pending = revealRequest("workspace-a");
    expect(pending?.pendingNodeIds).toEqual(["fresh"]);

    // A tree for another frame, or one that still lacks the node, waits.
    settleDesignLayerReveal("workspace-a", "pricing.html", [
      node("body", [node("fresh")]),
    ]);
    settleDesignLayerReveal("workspace-a", "home.html", TREE);
    expect(revealRequest("workspace-a")).toBe(pending);

    settleDesignLayerReveal("workspace-a", "home.html", [
      node("body", [
        node("main", [
          node("hero", [node("heading")]),
          node("footer", [node("fresh")]),
        ]),
      ]),
    ]);
    expect(
      designFrameDisclosure("workspace-a", "home.html").expandedNodeIds,
    ).toEqual(["body", "main", "hero", "footer"]);
    // The same request completes; it never scrolls a second time.
    expect(revealRequest("workspace-a")).toMatchObject({
      nonce: pending!.nonce,
      pendingNodeIds: [],
    });
  });

  it("lets the user's fold and Collapse all win over a path still pending", () => {
    requestDesignLayerReveal({
      workspaceId: "workspace-a",
      frame: "home.html",
      nodeIds: ["fresh"],
      tree: undefined,
    });
    // No tree yet: the frame opens at once; the path waits.
    expect(designFrameDisclosure("workspace-a", "home.html").treeExpanded).toBe(
      true,
    );
    toggleDesignFrameTreeExpanded("workspace-a", "home.html");
    expect(revealRequest("workspace-a")?.pendingNodeIds).toEqual([]);
    settleDesignLayerReveal("workspace-a", "home.html", [node("fresh")]);
    expect(designFrameDisclosure("workspace-a", "home.html").treeExpanded).toBe(
      false,
    );

    requestDesignLayerReveal({
      workspaceId: "workspace-a",
      frame: "home.html",
      nodeIds: ["later"],
      tree: undefined,
    });
    collapseAllDesignLayers("workspace-a");
    expect(revealRequest("workspace-a")?.pendingNodeIds).toEqual([]);
    settleDesignLayerReveal("workspace-a", "home.html", [node("later")]);
    expect(designFrameDisclosure("workspace-a", "home.html")).toBe(
      EMPTY_DESIGN_FRAME_DISCLOSURE,
    );
  });

  it("lets a container folded while its tree loads stay folded", () => {
    toggleDesignFrameTreeExpanded("workspace-a", "home.html");
    toggleDesignLayerExpanded("workspace-a", "home.html", "parent");
    requestDesignLayerReveal({
      workspaceId: "workspace-a",
      frame: "home.html",
      nodeIds: ["fresh"],
      tree: [node("parent")],
    });
    expect(revealRequest("workspace-a")?.pendingNodeIds).toEqual(["fresh"]);
    // The user folds the container before the tree holding `fresh` arrives.
    toggleDesignLayerExpanded("workspace-a", "home.html", "parent");
    expect(revealRequest("workspace-a")?.pendingNodeIds).toEqual([]);
    settleDesignLayerReveal("workspace-a", "home.html", [
      node("parent", [node("fresh")]),
    ]);
    expect(
      designFrameDisclosure("workspace-a", "home.html").expandedNodeIds,
    ).toEqual([]);
    // Opening a container never cancels a pending path.
    requestDesignLayerReveal({
      workspaceId: "workspace-a",
      frame: "home.html",
      nodeIds: ["later"],
      tree: [node("parent")],
    });
    toggleDesignLayerExpanded("workspace-a", "home.html", "other");
    expect(revealRequest("workspace-a")?.pendingNodeIds).toEqual(["later"]);
  });

  it("keeps reveal requests owner-scoped, bounded, and pruned with their workspace", () => {
    requestDesignLayerReveal({
      workspaceId: "workspace-a",
      frame: "home.html",
      nodeIds: ["heading"],
      tree: TREE,
    });
    const owned = revealRequest("workspace-a");
    // Another workspace's reveal leaves this one's request untouched.
    requestDesignLayerReveal({
      workspaceId: "workspace-b",
      frame: "home.html",
      nodeIds: ["heading"],
      tree: TREE,
    });
    expect(revealRequest("workspace-a")).toBe(owned);

    for (let index = 0; index < 12; index += 1) {
      requestDesignLayerReveal({
        workspaceId: `workspace-${index}`,
        frame: "home.html",
        nodeIds: [],
        tree: undefined,
      });
    }
    expect(
      Object.keys(useDesignLayerDisclosureStore.getState().revealByWorkspace),
    ).toHaveLength(8);

    forgetDesignLayerDisclosure("workspace-11");
    expect(revealRequest("workspace-11")).toBeUndefined();
  });
});
