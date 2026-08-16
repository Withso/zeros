import { beforeEach, describe, expect, it } from "vitest";

import {
  EMPTY_DESIGN_FRAME_DISCLOSURE,
  collapseAllDesignLayers,
  designFrameDisclosure,
  designWorkspaceHasExpandedLayers,
  forgetDesignLayerDisclosure,
  resetDesignLayerDisclosureForTests,
  revealDesignLayerPath,
  setDesignFrameTreeExpanded,
  toggleDesignFrameTreeExpanded,
  toggleDesignLayerExpanded,
  useDesignLayerDisclosureStore,
} from "../state/design-layer-disclosure";

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
});
