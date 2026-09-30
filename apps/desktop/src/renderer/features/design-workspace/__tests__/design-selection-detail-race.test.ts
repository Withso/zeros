import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DesignRuntimeNodeDetails,
  DesignRuntimeSnapshot,
} from "@zeros/protocol/design-runtime";

const mocks = vi.hoisted(() => ({
  designFrameRuntime: vi.fn(),
  designSetSelection: vi.fn(
    async (
      _workspaceId: string,
      _selection: { sourceVersion: string },
      _version: number,
    ) => {},
  ),
  designSetRuntimeAudit: vi.fn(async () => {}),
  designUpdateStyles: vi.fn(),
}));

vi.mock("../../../platform/git", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../platform/git")>()),
  designSetSelection: mocks.designSetSelection,
  designSetRuntimeAudit: mocks.designSetRuntimeAudit,
  designUpdateStyles: mocks.designUpdateStyles,
}));
vi.mock("../../../platform/bridge/design-frame-runtime", () => ({
  designFrameRuntime: mocks.designFrameRuntime,
}));
vi.mock("../../../platform/bridge/active-bridge", () => ({
  onActiveBridgeConnected: vi.fn(() => () => {}),
}));
vi.mock("../design-review-dialog", () => ({
  DesignReviewDialog: () => null,
}));
vi.mock("../design-style-editor", () => ({
  DesignStyleEditor: () =>
    React.createElement("div", {
      "data-selected-style-editor": true,
    }),
}));

import { DesignInspector } from "../design-inspector";
import {
  resetDesignSelectionWorkflowsForTests,
  reconcileDesignRuntimeSnapshot,
  selectDesignNode,
  settleDesignSelectionDetails,
} from "../state/design-selection";
import {
  designRuntimeFrameState,
  resetDesignRuntimeStoreForTests,
  useDesignRuntimeStore,
} from "../state/design-runtime-store";
import {
  designWorkspaceSnapshotCache,
  primeDesignWorkspaceSnapshot,
  resetDesignWorkspaceCacheForTests,
  updateDesignNodeStylesCached,
} from "../state/design-workspace-cache";
import {
  designFrameDisclosure,
  resetDesignLayerDisclosureForTests,
  toggleDesignLayerExpanded,
  useDesignLayerDisclosureStore,
} from "../state/design-layer-disclosure";
import {
  designWorkspaceView,
  resetDesignWorkspaceUiForTests,
  useDesignWorkspaceUiStore,
} from "../state/design-workspace-ui";
import type { DesignWorkspaceSnapshotWire } from "../../../platform/git";

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

const WORKSPACE = "selection-detail-race";
const FOLDER = "/design/selection-detail-race";
const INITIAL_VERSION = "1".repeat(24);
const NEXT_VERSION = "2".repeat(24);
const FINAL_VERSION = "3".repeat(24);
const FRAME = {
  file: "home.html",
  title: "Home",
  width: 1440,
  height: 900,
  x: 0,
  y: 0,
  z: 0,
  nodeCount: 4,
  modifiedAt: 1,
  sourceVersion: INITIAL_VERSION,
};
const subscriptions: Array<() => void> = [];

function nodeDetails(
  oid: string,
  sourceVersion: string,
): DesignRuntimeNodeDetails {
  return {
    sourceVersion,
    oid,
    tag: "main",
    name: oid,
    text: null,
    selector: `[data-oid="${oid}"]`,
    visible: true,
    breadcrumb: [oid],
    rect: { x: 10, y: 20, width: 100, height: 40 },
    styles: { width: "100px" },
  };
}

function runtimeSnapshot(sourceVersion: string): DesignRuntimeSnapshot {
  return {
    sourceVersion,
    revision: sourceVersion === INITIAL_VERSION ? 1 : 2,
    frame: nodeDetails("body", sourceVersion),
    tree: ["parent", "layout-owner", "heading", "home-hero"].map((oid) => ({
      oid,
      tag: "main",
      name: oid,
      text: null,
      visible: true,
      children: [],
    })),
    warnings: [],
    viewport: {
      width: FRAME.width,
      height: FRAME.height,
      scrollX: 0,
      scrollY: 0,
    },
  };
}

function workspaceSnapshot(sourceVersion: string): DesignWorkspaceSnapshotWire {
  return {
    directoryId: "design-race",
    protocolCapability: "c".repeat(64),
    frames: [{ ...FRAME, sourceVersion }],
    tokens: [],
    tokenSourceVersion: INITIAL_VERSION,
    assets: [],
    lint: {
      workspacePath: FOLDER,
      checkedFiles: [FRAME.file],
      violations: [],
      healedOids: 0,
    },
  };
}

function inspectorMarkup(): string {
  const view = designWorkspaceView(WORKSPACE);
  const runtime = designRuntimeFrameState(WORKSPACE, FRAME.file);
  return renderToStaticMarkup(
    React.createElement(DesignInspector, {
      workspaceId: WORKSPACE,
      folder: FOLDER,
      frame: {
        ...FRAME,
        sourceVersion: runtime?.sourceVersion ?? INITIAL_VERSION,
      },
      frameSelected: view.frameSelected,
      selectedNodeId: view.selectedNodeId,
      selectedNodeIds: view.selectedNodeIds,
      details: runtime?.detailsByNode[view.selectedNodeId ?? ""] ?? null,
      lint: null,
      active: true,
      canvasBackground: "white",
      onCanvasBackgroundChange: () => {},
      motionTimelineOpen: false,
      motionProperties: [],
      onOpenMotionTimeline: () => {},
      zoomActionsRef: { current: null },
    }),
  );
}

describe("selected-detail convergence after hot adoption", () => {
  afterEach(() => {
    subscriptions.splice(0).forEach((unsubscribe) => unsubscribe());
  });
  beforeEach(() => {
    resetDesignSelectionWorkflowsForTests();
    resetDesignWorkspaceCacheForTests();
    resetDesignRuntimeStoreForTests();
    resetDesignWorkspaceUiForTests();
    resetDesignLayerDisclosureForTests();
    vi.clearAllMocks();
  });

  it("keeps manual Layers folds and scroll demand unchanged when promotion retries a pending selection", async () => {
    const oldRead = deferred<DesignRuntimeNodeDetails>();
    const initialSnapshot = runtimeSnapshot(INITIAL_VERSION);
    const tree = [
      {
        ...initialSnapshot.tree[0]!,
        children: initialSnapshot.tree.slice(1),
      },
    ];
    const runtime = {
      sourceVersion: INITIAL_VERSION,
      isActive: () => true,
      getNodeDetails: vi
        .fn()
        .mockImplementationOnce(() => oldRead.promise)
        .mockImplementation(async (nodeId: string) =>
          nodeDetails(nodeId, runtime.sourceVersion),
        ),
    };
    mocks.designFrameRuntime.mockReturnValue(runtime);
    designWorkspaceSnapshotCache.setData(
      WORKSPACE,
      workspaceSnapshot(INITIAL_VERSION),
    );
    useDesignRuntimeStore
      .getState()
      .publishSnapshot(
        WORKSPACE,
        FOLDER,
        FRAME.file,
        { ...initialSnapshot, tree },
        INITIAL_VERSION,
      );
    const selecting = selectDesignNode({
      workspaceId: WORKSPACE,
      folder: FOLDER,
      frame: FRAME,
      nodeId: "home-hero",
    });
    expect(
      designFrameDisclosure(WORKSPACE, FRAME.file).expandedNodeIds,
    ).toContain("parent");
    toggleDesignLayerExpanded(WORKSPACE, FRAME.file, "parent");
    const folded = designFrameDisclosure(WORKSPACE, FRAME.file);
    const reveal =
      useDesignLayerDisclosureStore.getState().revealByWorkspace[WORKSPACE];

    runtime.sourceVersion = NEXT_VERSION;
    primeDesignWorkspaceSnapshot(WORKSPACE, workspaceSnapshot(NEXT_VERSION));
    await Promise.resolve();
    useDesignRuntimeStore
      .getState()
      .publishSnapshot(
        WORKSPACE,
        FOLDER,
        FRAME.file,
        { ...runtimeSnapshot(NEXT_VERSION), tree },
        NEXT_VERSION,
      );
    await vi.waitFor(() => {
      expect(
        designRuntimeFrameState(WORKSPACE, FRAME.file)?.detailsByNode[
          "home-hero"
        ]?.sourceVersion,
      ).toBe(NEXT_VERSION);
    });

    expect(designFrameDisclosure(WORKSPACE, FRAME.file)).toBe(folded);
    expect(
      useDesignLayerDisclosureStore.getState().revealByWorkspace[WORKSPACE],
    ).toBe(reveal);
    expect(runtime.getNodeDetails).toHaveBeenCalledTimes(2);
    expect(inspectorMarkup()).toContain("data-selected-style-editor");
    oldRead.resolve(nodeDetails("home-hero", INITIAL_VERSION));
    expect(await selecting).toBeNull();
    expect(
      designRuntimeFrameState(WORKSPACE, FRAME.file)?.detailsByNode["home-hero"]
        ?.sourceVersion,
    ).toBe(NEXT_VERSION);
  });

  it("seeds one uncached restored group demand from repeated snapshot publications without revealing Layers", async () => {
    const headingRead = deferred<DesignRuntimeNodeDetails>();
    const heroRead = deferred<DesignRuntimeNodeDetails>();
    const getNodeDetails = vi.fn((nodeId: string) =>
      nodeId === "heading" ? headingRead.promise : heroRead.promise,
    );
    mocks.designFrameRuntime.mockReturnValue({
      sourceVersion: NEXT_VERSION,
      isActive: () => true,
      getNodeDetails,
    });
    designWorkspaceSnapshotCache.setData(
      WORKSPACE,
      workspaceSnapshot(INITIAL_VERSION),
    );
    useDesignRuntimeStore
      .getState()
      .publishSnapshot(
        WORKSPACE,
        FOLDER,
        FRAME.file,
        runtimeSnapshot(NEXT_VERSION),
        NEXT_VERSION,
      );
    useDesignWorkspaceUiStore
      .getState()
      .setSelection(WORKSPACE, FRAME.file, "heading", ["heading", "home-hero"]);
    const folded = designFrameDisclosure(WORKSPACE, FRAME.file);
    primeDesignWorkspaceSnapshot(WORKSPACE, workspaceSnapshot(NEXT_VERSION));
    primeDesignWorkspaceSnapshot(WORKSPACE, workspaceSnapshot(NEXT_VERSION));
    expect(getNodeDetails.mock.calls.map(([nodeId]) => nodeId)).toEqual([
      "heading",
      "home-hero",
    ]);
    headingRead.resolve(nodeDetails("heading", NEXT_VERSION));
    heroRead.resolve(nodeDetails("home-hero", NEXT_VERSION));
    await settleDesignSelectionDetails(WORKSPACE, FRAME.file, NEXT_VERSION);

    expect(
      designRuntimeFrameState(WORKSPACE, FRAME.file)?.detailsByNode.heading,
    ).toEqual(nodeDetails("heading", NEXT_VERSION));
    expect(
      designRuntimeFrameState(WORKSPACE, FRAME.file)?.detailsByNode[
        "home-hero"
      ],
    ).toEqual(nodeDetails("home-hero", NEXT_VERSION));
    expect(getNodeDetails).toHaveBeenCalledTimes(2);
    expect(mocks.designSetSelection).toHaveBeenCalledTimes(1);
    expect(designFrameDisclosure(WORKSPACE, FRAME.file)).toBe(folded);
    expect(
      useDesignLayerDisclosureStore.getState().revealByWorkspace[WORKSPACE],
    ).toBeUndefined();
    expect(inspectorMarkup()).toContain("data-selected-style-editor");
  });

  it("retains restored selection demand when publication precedes readiness without awaiting outgoing data", async () => {
    const outgoingRead = deferred<DesignRuntimeNodeDetails>();
    const incomingRead = deferred<DesignRuntimeNodeDetails>();
    const incomingStarted = deferred<void>();
    const runtime = {
      sourceVersion: INITIAL_VERSION,
      isActive: () => true,
      getNodeDetails: vi
        .fn()
        .mockImplementationOnce(() => outgoingRead.promise)
        .mockImplementation(() => {
          incomingStarted.resolve();
          return incomingRead.promise;
        }),
    };
    mocks.designFrameRuntime.mockReturnValue(runtime);
    designWorkspaceSnapshotCache.setData(
      WORKSPACE,
      workspaceSnapshot(INITIAL_VERSION),
    );
    useDesignRuntimeStore
      .getState()
      .publishSnapshot(
        WORKSPACE,
        FOLDER,
        FRAME.file,
        runtimeSnapshot(INITIAL_VERSION),
        INITIAL_VERSION,
      );
    useDesignWorkspaceUiStore
      .getState()
      .setSelection(WORKSPACE, FRAME.file, "home-hero");
    const publishedVersions: string[] = [];
    subscriptions.push(
      useDesignRuntimeStore.subscribe((state) => {
        const details =
          state.byWorkspace[WORKSPACE]?.frames[FRAME.file]?.detailsByNode[
            "home-hero"
          ];
        if (details) publishedVersions.push(details.sourceVersion);
      }),
    );
    primeDesignWorkspaceSnapshot(WORKSPACE, workspaceSnapshot(NEXT_VERSION));
    const settling = settleDesignSelectionDetails(
      WORKSPACE,
      FRAME.file,
      NEXT_VERSION,
    );
    expect(runtime.getNodeDetails).toHaveBeenCalledTimes(1);
    expect(inspectorMarkup()).not.toContain("data-selected-style-editor");

    runtime.sourceVersion = NEXT_VERSION;
    useDesignRuntimeStore
      .getState()
      .publishSnapshot(
        WORKSPACE,
        FOLDER,
        FRAME.file,
        runtimeSnapshot(NEXT_VERSION),
        NEXT_VERSION,
      );
    await incomingStarted.promise;
    incomingRead.resolve(nodeDetails("home-hero", NEXT_VERSION));
    await settling;
    expect(inspectorMarkup()).toContain("data-selected-style-editor");
    outgoingRead.resolve(nodeDetails("home-hero", INITIAL_VERSION));
    await Promise.resolve();
    await Promise.resolve();

    expect(
      designRuntimeFrameState(WORKSPACE, FRAME.file)?.detailsByNode[
        "home-hero"
      ],
    ).toEqual(nodeDetails("home-hero", NEXT_VERSION));
    expect(publishedVersions).not.toContain(INITIAL_VERSION);
    expect(runtime.getNodeDetails).toHaveBeenCalledTimes(2);
    expect(mocks.designSetSelection).toHaveBeenCalledTimes(1);
    expect(
      useDesignLayerDisclosureStore.getState().revealByWorkspace[WORKSPACE],
    ).toBeUndefined();
  });

  it.each(["before promotion", "after promotion", "second generation"])(
    "recovers an uncached selection when its first read settles %s",
    async (schedule) => {
      const headingRead = deferred<DesignRuntimeNodeDetails>();
      const heroRead = deferred<DesignRuntimeNodeDetails>();
      const parentRead = deferred<DesignRuntimeNodeDetails>();
      const parentReadStarted = deferred<void>();
      const currentHeroRead = deferred<DesignRuntimeNodeDetails>();
      let heroReads = 0;
      const runtime = {
        sourceVersion: INITIAL_VERSION,
        isActive: () => true,
        captureScreenshot: vi.fn(async () => {
          throw new Error("unused capture");
        }),
        getNodeDetails: vi.fn((nodeId: string) => {
          if (nodeId === "parent") {
            parentReadStarted.resolve();
            return parentRead.promise;
          }
          if (nodeId === "heading") return headingRead.promise;
          heroReads += 1;
          if (heroReads === 1) return heroRead.promise;
          if (heroReads === 2 && schedule === "second generation")
            return currentHeroRead.promise;
          return Promise.resolve(nodeDetails(nodeId, runtime.sourceVersion));
        }),
        commitStyles: vi.fn(
          async (_updates: unknown, sourceVersion: string) => {
            runtime.sourceVersion = sourceVersion;
            return {
              sourceVersion,
              treeUnchanged: true,
              snapshot: runtimeSnapshot(sourceVersion),
              details: [nodeDetails("layout-owner", sourceVersion)],
            };
          },
        ),
      };
      mocks.designFrameRuntime.mockReturnValue(runtime);
      const publishedVersions: string[] = [];
      subscriptions.push(
        useDesignRuntimeStore.subscribe((state) => {
          const details =
            state.byWorkspace[WORKSPACE]?.frames[FRAME.file]?.detailsByNode;
          for (const nodeId of ["home-hero", "heading"]) {
            if (details?.[nodeId])
              publishedVersions.push(details[nodeId]!.sourceVersion);
          }
        }),
      );
      const store = useDesignRuntimeStore.getState();
      store.publishSnapshot(
        WORKSPACE,
        FOLDER,
        FRAME.file,
        runtimeSnapshot(INITIAL_VERSION),
        INITIAL_VERSION,
      );
      store.publishNodeDetails(
        WORKSPACE,
        FOLDER,
        FRAME.file,
        {
          ...nodeDetails("parent", INITIAL_VERSION),
          childrenLayout: {
            count: 1,
            nodeIds: ["layout-owner"],
            x: "start",
            y: "start",
            truncated: false,
          },
        },
        INITIAL_VERSION,
      );
      designWorkspaceSnapshotCache.setData(
        WORKSPACE,
        workspaceSnapshot(INITIAL_VERSION),
      );
      const next = workspaceSnapshot(NEXT_VERSION);
      mocks.designUpdateStyles.mockResolvedValue({
        mutation: {
          changed: true,
          frame: { ...next.frames[0]!, source: "", srcDoc: "", tree: [] },
          lint: next.lint,
        },
        snapshot: next,
      });

      const selectingHeading = selectDesignNode({
        workspaceId: WORKSPACE,
        folder: FOLDER,
        frame: FRAME,
        nodeId: "heading",
      });
      const adopting = updateDesignNodeStylesCached(WORKSPACE, {
        frame: FRAME.file,
        nodeId: "layout-owner",
        sourceVersion: INITIAL_VERSION,
        styles: { width: "240px" },
      });
      await parentReadStarted.promise;
      const selectingHero = selectDesignNode({
        workspaceId: WORKSPACE,
        folder: FOLDER,
        frame: FRAME,
        nodeId: "home-hero",
      });
      expect(designWorkspaceView(WORKSPACE).selectedNodeId).toBe("home-hero");
      expect(inspectorMarkup()).not.toContain("data-selected-style-editor");

      if (schedule === "before promotion") {
        heroRead.resolve(nodeDetails("home-hero", NEXT_VERSION));
        await selectingHero;
        expect(
          designRuntimeFrameState(WORKSPACE, FRAME.file)?.detailsByNode[
            "home-hero"
          ],
        ).toBeUndefined();
      }
      parentRead.resolve(nodeDetails("parent", NEXT_VERSION));
      await adopting;
      if (schedule !== "before promotion")
        heroRead.resolve(nodeDetails("home-hero", INITIAL_VERSION));
      headingRead.resolve(nodeDetails("heading", INITIAL_VERSION));
      await Promise.all([selectingHeading, selectingHero]);

      if (schedule === "second generation") {
        await vi.waitFor(() => expect(heroReads).toBe(2));
        const final = workspaceSnapshot(FINAL_VERSION);
        mocks.designUpdateStyles.mockResolvedValue({
          mutation: {
            changed: true,
            frame: { ...final.frames[0]!, source: "", srcDoc: "", tree: [] },
            lint: final.lint,
          },
          snapshot: final,
        });
        await updateDesignNodeStylesCached(WORKSPACE, {
          frame: FRAME.file,
          nodeId: "layout-owner",
          sourceVersion: NEXT_VERSION,
          styles: { width: "320px" },
        });
        currentHeroRead.resolve(nodeDetails("home-hero", NEXT_VERSION));
      }

      const expectedVersion =
        schedule === "second generation" ? FINAL_VERSION : NEXT_VERSION;
      await vi.waitFor(() =>
        expect(
          designRuntimeFrameState(WORKSPACE, FRAME.file)?.detailsByNode[
            "home-hero"
          ],
        ).toEqual(nodeDetails("home-hero", expectedVersion)),
      );
      expect(
        designRuntimeFrameState(WORKSPACE, FRAME.file)?.detailsByNode.heading,
      ).toBeUndefined();
      expect(designWorkspaceView(WORKSPACE).selectedNodeId).toBe("home-hero");
      expect(inspectorMarkup()).toContain("data-selected-style-editor");
      expect(
        mocks.designSetSelection.mock.calls.every(
          ([, selection]) => selection.sourceVersion === expectedVersion,
        ),
      ).toBe(true);
      expect(publishedVersions.length).toBeGreaterThan(0);
      expect(
        publishedVersions.every(
          (sourceVersion) => sourceVersion === expectedVersion,
        ),
      ).toBe(true);
      expect(heroReads).toBe(schedule === "second generation" ? 3 : 2);
    },
  );

  it("recovers a selection made with old frame metadata after the store already promoted", async () => {
    const runtime = {
      sourceVersion: NEXT_VERSION,
      getNodeDetails: vi.fn(async (nodeId: string) =>
        nodeDetails(nodeId, NEXT_VERSION),
      ),
    };
    mocks.designFrameRuntime.mockReturnValue(runtime);
    useDesignRuntimeStore
      .getState()
      .publishSnapshot(
        WORKSPACE,
        FOLDER,
        FRAME.file,
        runtimeSnapshot(NEXT_VERSION),
        NEXT_VERSION,
      );
    designWorkspaceSnapshotCache.setData(
      WORKSPACE,
      workspaceSnapshot(NEXT_VERSION),
    );

    await selectDesignNode({
      workspaceId: WORKSPACE,
      folder: FOLDER,
      frame: FRAME,
      nodeId: "home-hero",
    });

    await vi.waitFor(() =>
      expect(
        designRuntimeFrameState(WORKSPACE, FRAME.file)?.detailsByNode[
          "home-hero"
        ],
      ).toEqual(nodeDetails("home-hero", NEXT_VERSION)),
    );
    expect(runtime.getNodeDetails).toHaveBeenCalledTimes(1);
    expect(inspectorMarkup()).toContain("data-selected-style-editor");
  });

  it("settles readiness against the latest selection instead of the IDs sampled before an await", async () => {
    const headingRead = deferred<DesignRuntimeNodeDetails>();
    const heroRead = deferred<DesignRuntimeNodeDetails>();
    const runtime = {
      sourceVersion: INITIAL_VERSION,
      getNodeDetails: vi.fn((nodeId: string) =>
        nodeId === "heading" ? headingRead.promise : heroRead.promise,
      ),
    };
    mocks.designFrameRuntime.mockReturnValue(runtime);
    const selectingHeading = selectDesignNode({
      workspaceId: WORKSPACE,
      folder: FOLDER,
      frame: FRAME,
      nodeId: "heading",
    });
    let settled = false;
    const settling = settleDesignSelectionDetails(
      WORKSPACE,
      FRAME.file,
      INITIAL_VERSION,
    ).then(() => {
      settled = true;
    });
    const selectingHero = selectDesignNode({
      workspaceId: WORKSPACE,
      folder: FOLDER,
      frame: FRAME,
      nodeId: "home-hero",
    });
    headingRead.resolve(nodeDetails("heading", INITIAL_VERSION));
    await selectingHeading;
    expect(settled).toBe(false);
    heroRead.resolve(nodeDetails("home-hero", INITIAL_VERSION));
    await Promise.all([selectingHero, settling]);
    expect(settled).toBe(true);
    expect(
      designRuntimeFrameState(WORKSPACE, FRAME.file)?.detailsByNode.heading,
    ).toBeUndefined();
    expect(inspectorMarkup()).toContain("data-selected-style-editor");
  });

  it.each(["directory replacement", "workspace removal"] as const)(
    "cancels selected readback on %s without resurrecting the old owner",
    async (change) => {
      const pending = deferred<DesignRuntimeNodeDetails>();
      let signal: AbortSignal | undefined;
      mocks.designFrameRuntime.mockReturnValue({
        sourceVersion: INITIAL_VERSION,
        getNodeDetails: vi.fn((_nodeId: string, inputSignal: AbortSignal) => {
          signal = inputSignal;
          return pending.promise;
        }),
      });
      const ui = useDesignWorkspaceUiStore.getState();
      ui.bindDirectory(WORKSPACE, "old-directory");
      const selecting = selectDesignNode({
        workspaceId: WORKSPACE,
        folder: FOLDER,
        frame: FRAME,
        nodeId: "home-hero",
      });
      if (change === "directory replacement")
        ui.bindDirectory(WORKSPACE, "replacement-directory");
      else ui.forgetWorkspace(WORKSPACE);
      expect(signal?.aborted).toBe(true);
      pending.resolve(nodeDetails("home-hero", INITIAL_VERSION));
      await expect(selecting).resolves.toBeNull();
      expect(designRuntimeFrameState(WORKSPACE, FRAME.file)).toBeUndefined();
      expect(mocks.designSetSelection).not.toHaveBeenCalled();
    },
  );

  it("rejects a retired connection and recovers on the replacement's exact ready snapshot", async () => {
    const pending = deferred<DesignRuntimeNodeDetails>();
    const retired = {
      sourceVersion: INITIAL_VERSION,
      getNodeDetails: vi.fn(() => pending.promise),
    };
    mocks.designFrameRuntime.mockReturnValue(retired);
    const selecting = selectDesignNode({
      workspaceId: WORKSPACE,
      folder: FOLDER,
      frame: FRAME,
      nodeId: "home-hero",
    });
    const current = {
      sourceVersion: INITIAL_VERSION,
      getNodeDetails: vi.fn(async () =>
        nodeDetails("home-hero", INITIAL_VERSION),
      ),
    };
    mocks.designFrameRuntime.mockReturnValue(current);
    reconcileDesignRuntimeSnapshot({
      workspaceId: WORKSPACE,
      folder: FOLDER,
      frame: FRAME,
      snapshot: runtimeSnapshot(INITIAL_VERSION),
    });
    pending.resolve({
      ...nodeDetails("home-hero", INITIAL_VERSION),
      styles: { width: "999px" },
    });
    await expect(selecting).resolves.toBeNull();
    await vi.waitFor(() =>
      expect(
        designRuntimeFrameState(WORKSPACE, FRAME.file)?.detailsByNode[
          "home-hero"
        ],
      ).toEqual(nodeDetails("home-hero", INITIAL_VERSION)),
    );
    expect(current.getNodeDetails).toHaveBeenCalledTimes(1);
  });

  it("does not turn a permanent detail failure into a store-driven retry loop", async () => {
    const runtime = {
      sourceVersion: INITIAL_VERSION,
      getNodeDetails: vi.fn(async () => {
        throw new Error("Element not found");
      }),
    };
    mocks.designFrameRuntime.mockReturnValue(runtime);
    useDesignRuntimeStore
      .getState()
      .publishSnapshot(
        WORKSPACE,
        FOLDER,
        FRAME.file,
        runtimeSnapshot(INITIAL_VERSION),
        INITIAL_VERSION,
      );
    await expect(
      selectDesignNode({
        workspaceId: WORKSPACE,
        folder: FOLDER,
        frame: FRAME,
        nodeId: "home-hero",
      }),
    ).rejects.toThrow("Element not found");
    for (const revision of [1, 2, 3]) {
      useDesignRuntimeStore
        .getState()
        .publishSnapshot(
          WORKSPACE,
          FOLDER,
          FRAME.file,
          { ...runtimeSnapshot(INITIAL_VERSION), revision },
          INITIAL_VERSION,
        );
    }
    await Promise.resolve();
    expect(runtime.getNodeDetails).toHaveBeenCalledTimes(1);
  });

  it("re-reads current demand after its first confirmed directory binding", async () => {
    const pending = deferred<DesignRuntimeNodeDetails>();
    const runtime = {
      sourceVersion: INITIAL_VERSION,
      getNodeDetails: vi
        .fn()
        .mockReturnValueOnce(pending.promise)
        .mockResolvedValue(nodeDetails("home-hero", INITIAL_VERSION)),
    };
    mocks.designFrameRuntime.mockReturnValue(runtime);
    useDesignRuntimeStore
      .getState()
      .publishSnapshot(
        WORKSPACE,
        FOLDER,
        FRAME.file,
        runtimeSnapshot(INITIAL_VERSION),
        INITIAL_VERSION,
      );
    const selecting = selectDesignNode({
      workspaceId: WORKSPACE,
      folder: FOLDER,
      frame: FRAME,
      nodeId: "home-hero",
    });
    useDesignWorkspaceUiStore
      .getState()
      .bindDirectory(WORKSPACE, "confirmed-directory");
    pending.resolve({
      ...nodeDetails("home-hero", INITIAL_VERSION),
      styles: { width: "999px" },
    });
    await selecting;
    await vi.waitFor(() =>
      expect(
        designRuntimeFrameState(WORKSPACE, FRAME.file)?.detailsByNode[
          "home-hero"
        ],
      ).toEqual(nodeDetails("home-hero", INITIAL_VERSION)),
    );
    expect(runtime.getNodeDetails).toHaveBeenCalledTimes(2);
  });

  it("settles latest readiness without waiting for a cancelled read to answer", async () => {
    const pending = deferred<DesignRuntimeNodeDetails>();
    const runtime = {
      sourceVersion: INITIAL_VERSION,
      getNodeDetails: vi.fn((nodeId: string) =>
        nodeId === "heading"
          ? pending.promise
          : Promise.resolve(nodeDetails(nodeId, INITIAL_VERSION)),
      ),
    };
    mocks.designFrameRuntime.mockReturnValue(runtime);
    const selectingHeading = selectDesignNode({
      workspaceId: WORKSPACE,
      folder: FOLDER,
      frame: FRAME,
      nodeId: "heading",
    });
    let settled = false;
    const settling = settleDesignSelectionDetails(
      WORKSPACE,
      FRAME.file,
      INITIAL_VERSION,
    ).then(() => {
      settled = true;
    });
    try {
      await selectDesignNode({
        workspaceId: WORKSPACE,
        folder: FOLDER,
        frame: FRAME,
        nodeId: "home-hero",
      });
      await vi.waitFor(() => expect(settled).toBe(true));
    } finally {
      pending.resolve(nodeDetails("heading", INITIAL_VERSION));
      await Promise.all([selectingHeading, settling]);
    }
    expect(
      designRuntimeFrameState(WORKSPACE, FRAME.file)?.detailsByNode.heading,
    ).toBeUndefined();
  });

  it("bounds selected-detail owners and cancels the oldest pending read on eviction", async () => {
    const pending = deferred<DesignRuntimeNodeDetails>();
    const signals: AbortSignal[] = [];
    mocks.designFrameRuntime.mockReturnValue({
      sourceVersion: INITIAL_VERSION,
      getNodeDetails: vi.fn((_nodeId: string, signal: AbortSignal) => {
        signals.push(signal);
        return pending.promise;
      }),
    });
    let timestamp = Date.now();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => ++timestamp);
    const selecting = Array.from({ length: 33 }, (_value, index) =>
      selectDesignNode({
        workspaceId: `${WORKSPACE}-${index}`,
        folder: FOLDER,
        frame: FRAME,
        nodeId: "home-hero",
      }),
    );
    clock.mockRestore();
    try {
      expect(signals).toHaveLength(33);
      expect(signals[0]!.aborted).toBe(true);
      expect(signals.slice(1).every((signal) => !signal.aborted)).toBe(true);
      await expect(selecting[0]).resolves.toBeNull();
    } finally {
      pending.resolve(nodeDetails("home-hero", INITIAL_VERSION));
      await Promise.all(selecting);
    }
    expect(
      designRuntimeFrameState(`${WORKSPACE}-0`, FRAME.file),
    ).toBeUndefined();
    expect(mocks.designSetSelection).toHaveBeenCalledTimes(32);
  });

  it("never falls back to the outgoing generation while the selected incoming frame readies", async () => {
    const outgoing = {
      sourceVersion: INITIAL_VERSION,
      getNodeDetails: vi.fn(async () =>
        nodeDetails("home-hero", INITIAL_VERSION),
      ),
    };
    mocks.designFrameRuntime.mockReturnValue(outgoing);
    useDesignRuntimeStore
      .getState()
      .publishSnapshot(
        WORKSPACE,
        FOLDER,
        FRAME.file,
        runtimeSnapshot(INITIAL_VERSION),
        INITIAL_VERSION,
      );
    designWorkspaceSnapshotCache.setData(
      WORKSPACE,
      workspaceSnapshot(NEXT_VERSION),
    );
    await selectDesignNode({
      workspaceId: WORKSPACE,
      folder: FOLDER,
      frame: { ...FRAME, sourceVersion: NEXT_VERSION },
      nodeId: "home-hero",
    });
    await Promise.resolve();
    expect(
      designRuntimeFrameState(WORKSPACE, FRAME.file)?.detailsByNode[
        "home-hero"
      ],
    ).toBeUndefined();
    expect(mocks.designSetSelection).not.toHaveBeenCalled();

    const incoming = {
      sourceVersion: NEXT_VERSION,
      getNodeDetails: vi.fn(async () => nodeDetails("home-hero", NEXT_VERSION)),
    };
    mocks.designFrameRuntime.mockReturnValue(incoming);
    reconcileDesignRuntimeSnapshot({
      workspaceId: WORKSPACE,
      folder: FOLDER,
      frame: { ...FRAME, sourceVersion: NEXT_VERSION },
      snapshot: runtimeSnapshot(NEXT_VERSION),
    });
    await vi.waitFor(() =>
      expect(
        designRuntimeFrameState(WORKSPACE, FRAME.file)?.detailsByNode[
          "home-hero"
        ],
      ).toEqual(nodeDetails("home-hero", NEXT_VERSION)),
    );
    expect(outgoing.getNodeDetails).toHaveBeenCalledTimes(1);
    expect(incoming.getNodeDetails).toHaveBeenCalledTimes(1);
  });
});
