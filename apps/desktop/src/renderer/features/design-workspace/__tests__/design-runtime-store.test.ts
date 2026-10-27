import type { DesignRuntimeNodeDetails } from "@zeros/protocol/design-runtime";
import { beforeEach, describe, expect, it } from "vitest";

import {
  designRuntimeFrameState,
  resetDesignRuntimeStoreForTests,
  useDesignRuntimeStore,
} from "../state/design-runtime-store";

const SOURCE_VERSION = "1".repeat(24);
const NEXT_SOURCE_VERSION = "2".repeat(24);

function details(): DesignRuntimeNodeDetails {
  return {
    sourceVersion: SOURCE_VERSION,
    oid: "heading",
    tag: "h1",
    name: "Heading",
    text: "Hello",
    textEditable: true,
    selector: '[data-oid="heading"]',
    visible: true,
    breadcrumb: ["main · Hero", "h1 · Heading"],
    rect: { x: 10, y: 20, width: 100, height: 40 },
    styles: { left: "10px", top: "20px" },
    authoredStyleProperties: ["left", "top"],
  };
}

describe("design runtime store", () => {
  beforeEach(() => resetDesignRuntimeStoreForTests());

  it("bounds screenshot bytes across all workspace owners while preserving their geometry", () => {
    for (let index = 0; index < 40; index++) {
      const workspace = `workspace-${index}`;
      useDesignRuntimeStore
        .getState()
        .publishNodeDetails(
          workspace,
          `/design/${index}`,
          "home.html",
          details(),
          SOURCE_VERSION,
        );
      useDesignRuntimeStore.getState().publishScreenshot(
        workspace,
        `/design/${index}`,
        "home.html",
        {
          sourceVersion: SOURCE_VERSION,
          nodeId: null,
          mimeType: "image/png",
          dataUrl: "data:image/png;base64," + "a".repeat(1024 * 1024),
          width: 1000,
          height: 1000,
          scale: 1,
        },
        SOURCE_VERSION,
      );
    }
    const frames = Object.values(
      useDesignRuntimeStore.getState().byWorkspace,
    ).flatMap((workspace) => Object.values(workspace.frames));
    const bytes = frames
      .flatMap((frame) => Object.values(frame.screenshotsByNode))
      .reduce((total, shot) => total + shot.dataUrl.length * 2, 0);
    expect(bytes).toBeLessThanOrEqual(24 * 1024 * 1024);
    expect(frames.every((frame) => frame.detailsByNode.heading)).toBe(true);
    expect(
      designRuntimeFrameState("workspace-39", "home.html")?.screenshotsByNode[
        ""
      ],
    ).toBeDefined();
  });

  it("publishes child membership and pin changes while retaining identical exact-key readbacks", () => {
    const store = useDesignRuntimeStore.getState();
    const initial: DesignRuntimeNodeDetails = {
      ...details(),
      childCoordinateSpace: [1, 0, 0, 1, 0, 0],
      childrenLayout: {
        count: 1,
        nodeIds: ["child"],
        x: "start",
        y: "start",
        truncated: false,
      },
    };
    const publish = (node: DesignRuntimeNodeDetails) =>
      store.publishNodeDetails(
        "workspace-a",
        "/design/a",
        "home.html",
        node,
        SOURCE_VERSION,
      );
    publish(initial);
    publish({
      ...initial,
      childCoordinateSpace: [...initial.childCoordinateSpace!],
      childrenLayout: { ...initial.childrenLayout!, nodeIds: ["child"] },
    });
    expect(
      designRuntimeFrameState("workspace-a", "home.html")?.detailsByNode
        .heading,
    ).toBe(initial);
    const scrolled: DesignRuntimeNodeDetails = {
      ...initial,
      childCoordinateSpace: [1, 0, 0, 1, -10, 0],
    };
    publish(scrolled);
    expect(
      designRuntimeFrameState("workspace-a", "home.html")?.detailsByNode
        .heading,
    ).toBe(scrolled);
    const pinned: DesignRuntimeNodeDetails = {
      ...initial,
      childrenLayout: { ...initial.childrenLayout!, x: "end" },
    };
    publish(pinned);
    expect(
      designRuntimeFrameState("workspace-a", "home.html")?.detailsByNode
        .heading,
    ).toBe(pinned);
    const replaced = {
      ...pinned,
      childrenLayout: { ...pinned.childrenLayout!, nodeIds: ["other-child"] },
    };
    publish(replaced);
    expect(
      designRuntimeFrameState("workspace-a", "home.html")?.detailsByNode
        .heading,
    ).toBe(replaced);
    const empty = {
      ...replaced,
      childrenLayout: { ...replaced.childrenLayout!, count: 0, nodeIds: [] },
    };
    publish(empty);
    expect(
      designRuntimeFrameState("workspace-a", "home.html")?.detailsByNode
        .heading,
    ).toBe(empty);
    store.publishNodeDetails(
      "workspace-b",
      "/design/b",
      "home.html",
      initial,
      SOURCE_VERSION,
    );
    expect(
      designRuntimeFrameState("workspace-a", "home.html")?.detailsByNode
        .heading,
    ).toBe(empty);
  });

  it("publishes parent layout changes even when the child's painted box stays still", () => {
    const store = useDesignRuntimeStore.getState();
    const initial = {
      ...details(),
      layout: {
        x: 10,
        y: 20,
        parentId: "parent",
        parentWidth: 400,
        parentHeight: 300,
        parentDisplay: "block",
        parentPosition: "relative",
        isContainingBlock: true,
      },
    };
    store.publishNodeDetails(
      "workspace-a",
      "/design/a",
      "home.html",
      initial,
      SOURCE_VERSION,
    );
    const resized = {
      ...initial,
      layout: { ...initial.layout, parentWidth: 600 },
    };
    store.publishNodeDetails(
      "workspace-a",
      "/design/a",
      "home.html",
      resized,
      SOURCE_VERSION,
    );
    expect(
      designRuntimeFrameState("workspace-a", "home.html")?.detailsByNode.heading
        ?.layout?.parentWidth,
    ).toBe(600);
  });

  it("does not notify subscribers for an identical runtime snapshot", () => {
    const currentDetails = details();
    const snapshot = {
      sourceVersion: SOURCE_VERSION,
      revision: 1,
      tree: [],
      frame: { ...currentDetails, oid: "" },
      warnings: [],
      viewport: { width: 100, height: 80, scrollX: 0, scrollY: 0 },
    };
    let notifications = 0;
    const unsubscribe = useDesignRuntimeStore.subscribe(() => {
      notifications += 1;
    });

    const store = useDesignRuntimeStore.getState();
    store.publishSnapshot(
      "workspace-a",
      "/design/a",
      "home.html",
      snapshot,
      SOURCE_VERSION,
    );
    const firstFrame = designRuntimeFrameState("workspace-a", "home.html");
    store.publishSnapshot(
      "workspace-a",
      "/design/a",
      "home.html",
      snapshot,
      SOURCE_VERSION,
    );
    unsubscribe();

    expect(notifications).toBe(1);
    expect(designRuntimeFrameState("workspace-a", "home.html")).toBe(
      firstFrame,
    );
  });

  it("keeps a cloned snapshot of the same runtime revision without notifying", () => {
    // Re-applying the active theme returns the runtime's cached snapshot, but
    // the port structured-clones it: every frame switch republished every live
    // frame's identical snapshot and re-rendered Layers, canvas and inspector.
    const snapshot = {
      sourceVersion: SOURCE_VERSION,
      revision: 4,
      tree: [{ oid: "heading", tag: "h1", name: "Heading", text: "Hello", visible: true, children: [] }],
      frame: { ...details(), oid: "root" },
      warnings: [],
      viewport: { width: 100, height: 80, scrollX: 0, scrollY: 0 },
    };
    const store = useDesignRuntimeStore.getState();
    store.publishSnapshot("workspace-a", "/design/a", "home.html", snapshot, SOURCE_VERSION);
    const first = designRuntimeFrameState("workspace-a", "home.html");
    let notifications = 0;
    const unsubscribe = useDesignRuntimeStore.subscribe(() => { notifications += 1; });
    store.publishSnapshot("workspace-a", "/design/a", "home.html", structuredClone(snapshot), SOURCE_VERSION);
    expect(notifications).toBe(0);
    expect(designRuntimeFrameState("workspace-a", "home.html")).toBe(first);
    // A new revision, a changed root readback or a retired entry still publishes.
    store.publishSnapshot("workspace-a", "/design/a", "home.html", { ...structuredClone(snapshot), revision: 5 }, SOURCE_VERSION);
    expect(notifications).toBe(1);
    const changedRoot = structuredClone({ ...snapshot, revision: 5 });
    changedRoot.frame.styles = { ...changedRoot.frame.styles, opacity: "0.5" };
    store.publishSnapshot("workspace-a", "/design/a", "home.html", changedRoot, SOURCE_VERSION);
    expect(notifications).toBe(2);
    useDesignRuntimeStore.getState().retireFrame("workspace-a", "home.html");
    const retiredCount = notifications;
    store.publishSnapshot("workspace-a", "/design/a", "home.html", structuredClone(changedRoot), SOURCE_VERSION);
    expect(notifications).toBe(retiredCount + 1);
    expect(designRuntimeFrameState("workspace-a", "home.html")?.retiredAt).toBeUndefined();
    unsubscribe();
  });

  it("reuses semantically equal node details without notifying subscribers", () => {
    let notifications = 0;
    const unsubscribe = useDesignRuntimeStore.subscribe(() => {
      notifications += 1;
    });

    useDesignRuntimeStore
      .getState()
      .publishNodeDetails(
        "workspace-a",
        "/design/a",
        "home.html",
        details(),
        SOURCE_VERSION,
      );
    const first = designRuntimeFrameState("workspace-a", "home.html")
      ?.detailsByNode.heading;
    useDesignRuntimeStore
      .getState()
      .publishNodeDetails(
        "workspace-a",
        "/design/a",
        "home.html",
        details(),
        SOURCE_VERSION,
      );
    unsubscribe();

    expect(notifications).toBe(1);
    expect(
      designRuntimeFrameState("workspace-a", "home.html")?.detailsByNode
        .heading,
    ).toBe(first);
  });

  it("publishes a turned box even when the bounding rect is unchanged", () => {
    // Rotating a square by a quarter turn leaves its bounding box identical, so
    // the canvas would keep painting the previous angle if only rect compared.
    const square = (rotation: number): DesignRuntimeNodeDetails => ({
      ...details(),
      rect: { x: 10, y: 20, width: 80, height: 80 },
      box: {
        x: 10,
        y: 20,
        width: 80,
        height: 80,
        rotation,
        scaleX: 1,
        scaleY: 1,
        originX: 0.5,
        originY: 0.5,
      },
      styles: { left: "10px", top: "20px" },
    });
    const store = useDesignRuntimeStore.getState();
    store.publishNodeDetails(
      "workspace-a",
      "/design/a",
      "home.html",
      square(0),
      SOURCE_VERSION,
    );
    let notifications = 0;
    const unsubscribe = useDesignRuntimeStore.subscribe(() => {
      notifications += 1;
    });
    store.publishNodeDetails(
      "workspace-a",
      "/design/a",
      "home.html",
      square(90),
      SOURCE_VERSION,
    );
    expect(notifications).toBe(1);
    expect(
      designRuntimeFrameState("workspace-a", "home.html")?.detailsByNode.heading
        ?.box?.rotation,
    ).toBe(90);
    // An identical box still reuses the retained details reference.
    store.publishNodeDetails(
      "workspace-a",
      "/design/a",
      "home.html",
      square(90),
      SOURCE_VERSION,
    );
    unsubscribe();
    expect(notifications).toBe(1);
  });

  it("promotes one mounted frame generation without discarding exact-key readback", () => {
    const store = useDesignRuntimeStore.getState();
    const currentDetails = details();
    const retainedTree = [
      {
        oid: "heading",
        tag: "h1",
        name: "Heading",
        text: "Hello",
        visible: true,
        children: [],
      },
    ];
    store.publishSnapshot(
      "workspace-a",
      "/design/a",
      "home.html",
      {
        sourceVersion: SOURCE_VERSION,
        revision: 1,
        tree: retainedTree,
        frame: { ...currentDetails, oid: "" },
        warnings: [],
        viewport: { width: 100, height: 80, scrollX: 0, scrollY: 0 },
      },
      SOURCE_VERSION,
    );
    store.publishNodeDetails(
      "workspace-a",
      "/design/a",
      "home.html",
      currentDetails,
      SOURCE_VERSION,
    );
    const promotedDetails = {
      ...currentDetails,
      sourceVersion: NEXT_SOURCE_VERSION,
      rect: { ...currentDetails.rect, width: 240 },
      styles: { ...currentDetails.styles, width: "240px" },
    };

    const promoted = store.adoptFrameGeneration(
      "workspace-a",
      "home.html",
      SOURCE_VERSION,
      NEXT_SOURCE_VERSION,
      {
        sourceVersion: NEXT_SOURCE_VERSION,
        revision: 2,
        tree: [],
        frame: { ...promotedDetails, oid: "" },
        warnings: [],
        viewport: { width: 100, height: 80, scrollX: 0, scrollY: 0 },
      },
      [promotedDetails],
      true,
    );

    expect(promoted).toBe(true);
    expect(designRuntimeFrameState("workspace-a", "home.html")).toMatchObject({
      sourceVersion: NEXT_SOURCE_VERSION,
      snapshot: { sourceVersion: NEXT_SOURCE_VERSION, revision: 2 },
      detailsByNode: {
        heading: {
          sourceVersion: NEXT_SOURCE_VERSION,
          rect: { width: 240 },
          styles: { width: "240px" },
        },
      },
    });
    expect(
      designRuntimeFrameState("workspace-a", "home.html")?.snapshot?.tree,
    ).toBe(retainedTree);
  });

  it("drops unrefreshed details after a layout change instead of relabeling them current", () => {
    const store = useDesignRuntimeStore.getState();
    const heading = details();
    const copy = { ...details(), oid: "copy", name: "Copy" };
    store.publishSnapshot(
      "workspace-a",
      "/design/a",
      "home.html",
      {
        sourceVersion: SOURCE_VERSION,
        revision: 1,
        tree: [],
        frame: { ...heading, oid: "" },
        warnings: [],
        viewport: { width: 100, height: 80, scrollX: 0, scrollY: 0 },
      },
      SOURCE_VERSION,
    );
    for (const value of [heading, copy]) {
      store.publishNodeDetails(
        "workspace-a",
        "/design/a",
        "home.html",
        value,
        SOURCE_VERSION,
      );
    }
    // The heading's padding changed; the copy it contains moved, but only the
    // heading was measured in the new generation.
    const measured = {
      ...heading,
      sourceVersion: NEXT_SOURCE_VERSION,
      styles: { ...heading.styles, paddingTop: "60px" },
    };
    store.adoptFrameGeneration(
      "workspace-a",
      "home.html",
      SOURCE_VERSION,
      NEXT_SOURCE_VERSION,
      {
        sourceVersion: NEXT_SOURCE_VERSION,
        revision: 2,
        tree: [],
        frame: { ...measured, oid: "" },
        warnings: [],
        viewport: { width: 100, height: 80, scrollX: 0, scrollY: 0 },
      },
      [measured],
      true,
      { dropUnrefreshed: true },
    );
    const frame = designRuntimeFrameState("workspace-a", "home.html");
    expect(frame?.detailsByNode.heading?.styles.paddingTop).toBe("60px");
    // A stale box must be read again, never presented as new geometry.
    expect(frame?.detailsByNode.copy).toBeUndefined();
  });
  it("retires a hidden document without discarding its exact-generation tree and selected details", () => {
    // Retirement used to clear the tree and every readback, so returning to a
    // frame (or to its workspace) painted "Loading frame…" in Layers and an
    // empty inspector until a new runtime booted for the same source.
    const store = useDesignRuntimeStore.getState();
    const heading = details();
    const tree = [{ oid: "heading", tag: "h1", name: "Heading", text: "Hello", visible: true, children: [] }];
    store.publishSnapshot("workspace-a", "/design/a", "home.html", {
      sourceVersion: SOURCE_VERSION, revision: 1, tree,
      frame: { ...heading, oid: "root" }, warnings: [],
      viewport: { width: 100, height: 80, scrollX: 0, scrollY: 0 },
    }, SOURCE_VERSION);
    store.publishNodeDetails("workspace-a", "/design/a", "home.html", heading, SOURCE_VERSION);
    for (const nodeId of [null, "heading"]) {
      store.publishScreenshot("workspace-a", "/design/a", "home.html", {
        sourceVersion: SOURCE_VERSION, nodeId, mimeType: "image/png",
        dataUrl: "data:image/png;base64,AAAA", width: 1, height: 1, scale: 1,
      }, SOURCE_VERSION);
    }
    store.setHoveredNode("workspace-a", "home.html", "heading");

    useDesignRuntimeStore.getState().retireFrame("workspace-a", "home.html");

    const retired = designRuntimeFrameState("workspace-a", "home.html");
    expect(retired?.sourceVersion).toBe(SOURCE_VERSION);
    expect(retired?.snapshot?.tree).toBe(tree);
    expect(retired?.detailsByNode.heading).toBe(heading);
    expect(Object.keys(retired?.screenshotsByNode ?? {})).toEqual([""]);
    expect(useDesignRuntimeStore.getState().byWorkspace["workspace-a"]?.hoveredNodeId).toBeNull();
    expect(retired?.retiredAt).toEqual(expect.any(Number));

    // A runtime that boots again for the same source takes the entry back.
    store.publishSnapshot("workspace-a", "/design/a", "home.html", {
      sourceVersion: SOURCE_VERSION, revision: 2, tree: [],
      frame: { ...heading, oid: "root" }, warnings: [],
      viewport: { width: 100, height: 80, scrollX: 0, scrollY: 0 },
    }, SOURCE_VERSION);
    const live = designRuntimeFrameState("workspace-a", "home.html");
    expect(live?.retiredAt).toBeUndefined();
    expect(live?.snapshot?.revision).toBe(2);
    expect(live?.detailsByNode.heading).toBe(heading);
  });

  it("bounds retained retired presentation by bytes, evicting the oldest retirement first", () => {
    const store = useDesignRuntimeStore.getState();
    const largeTree = (prefix: string) => Array.from({ length: 1_000 }, (_, index) => ({
      oid: `${prefix}-${index}`, tag: "p", name: "Paragraph", text: "x".repeat(400), visible: true, children: [],
    }));
    const live = { workspace: "workspace-live", file: "live.html" };
    store.publishSnapshot(live.workspace, "/design/live", live.file, {
      sourceVersion: SOURCE_VERSION, revision: 1, tree: largeTree("live"),
      frame: { ...details(), oid: "root" }, warnings: [],
      viewport: { width: 100, height: 80, scrollX: 0, scrollY: 0 },
    }, SOURCE_VERSION);
    for (let index = 0; index < 20; index++) {
      const workspace = `workspace-${index}`;
      store.publishSnapshot(workspace, `/design/${index}`, "home.html", {
        sourceVersion: SOURCE_VERSION, revision: 1, tree: largeTree(`w${index}`),
        frame: { ...details(), oid: "root" }, warnings: [],
        viewport: { width: 100, height: 80, scrollX: 0, scrollY: 0 },
      }, SOURCE_VERSION);
      useDesignRuntimeStore.getState().retireFrame(workspace, "home.html");
    }
    const state = useDesignRuntimeStore.getState();
    const retained = Object.entries(state.byWorkspace)
      .filter(([workspaceId]) => workspaceId.startsWith("workspace-") && workspaceId !== live.workspace)
      .filter(([, workspace]) => workspace.frames["home.html"]?.snapshot)
      .map(([workspaceId]) => Number(workspaceId.slice("workspace-".length)));
    // ~1 MB of text per tree: only the newest retirements fit the budget.
    expect(retained.length).toBeGreaterThan(0);
    expect(retained.length).toBeLessThan(12);
    expect(Math.min(...retained)).toBe(20 - retained.length);
    expect(retained).toContain(19);
    // Bytes never evict a live runtime's tree, and evicted entries keep their
    // exact generation so a later boot is still fenced by source version.
    expect(state.byWorkspace[live.workspace]?.frames[live.file]?.snapshot?.tree).toHaveLength(1_000);
    expect(state.byWorkspace["workspace-0"]?.frames["home.html"]).toMatchObject({
      sourceVersion: SOURCE_VERSION, snapshot: undefined, detailOrder: [],
    });
  });
});

