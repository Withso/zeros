import {
  DESIGN_SELECTION_NODE_LIMIT,
  type DesignRuntimeNodeDetails,
} from "@zeros/protocol/design-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  designSetSelection: vi.fn(async () => {}),
  designSetScreenshot: vi.fn(async () => {}),
  designSetRuntimeAudit: vi.fn(async () => {}),
  designProvenance: vi.fn(),
  designFrameRuntime: vi.fn(),
}));

vi.mock("../../../platform/git", () => ({
  designSetSelection: mocks.designSetSelection,
  designSetScreenshot: mocks.designSetScreenshot,
  designSetRuntimeAudit: mocks.designSetRuntimeAudit,
  designProvenance: mocks.designProvenance,
}));

vi.mock("../../../platform/bridge/design-frame-runtime", () => ({
  designFrameRuntime: mocks.designFrameRuntime,
}));

import {
  hoverDesignNode,
  inspectDesignNodeStyleProvenance,
  reconcileDesignRuntimeSnapshot,
  previewDesignNodeStylesTransient,
  resetDesignSelectionWorkflowsForTests,
  selectDesignNode,
  selectDesignNodes,
  selectDesignNodeAtLocation,
  toggleDesignNodeSelection,
} from "../state/design-selection";
import {
  designRuntimeFrameState,
  resetDesignRuntimeStoreForTests,
} from "../state/design-runtime-store";
import {
  designLivePreviewValue,
  resetDesignLivePreviewForTests,
} from "../state/design-live-preview";
import {
  designWorkspaceView,
  resetDesignWorkspaceUiForTests,
} from "../state/design-workspace-ui";

function details(
  oid: string,
  sourceVersion = "111111111111111111111111",
): DesignRuntimeNodeDetails {
  return {
    sourceVersion,
    oid,
    tag: "h1",
    name: oid,
    text: oid,
    selector: `[data-oid="${oid}"]`,
    visible: true,
    breadcrumb: [`h1 · ${oid}`],
    rect: { x: 0, y: 0, width: 100, height: 40 },
    styles: { fontSize: "32px" },
  };
}

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
  sourceVersion: "111111111111111111111111",
  source: "",
  srcDoc: "",
  tree: [],
};

describe("design selection workflows", () => {
  beforeEach(() => {
    resetDesignSelectionWorkflowsForTests();
    resetDesignRuntimeStoreForTests();
    resetDesignLivePreviewForTests();
    resetDesignWorkspaceUiForTests();
    vi.clearAllMocks();
  });

  it("bounds persisted key styles without discarding full inspector details", async () => {
    const computedStyles = Object.fromEntries(
      Array.from({ length: 96 }, (_, index) => [
        `computedProperty${index}`,
        `${index}px`,
      ]),
    );
    const selectedDetails = {
      ...details("heading"),
      styles: computedStyles,
    };

    await selectDesignNode({
      workspaceId: "workspace-a",
      folder: "/design/a",
      frame: FRAME,
      nodeId: "heading",
      details: selectedDetails,
    });

    const persistedSelection = (
      mocks.designSetSelection.mock.calls[0] as unknown as
        | [string, { keyComputedStyles: Record<string, string> }, number]
        | undefined
    )?.[1];
    expect(
      Object.keys(persistedSelection?.keyComputedStyles ?? {}),
    ).toHaveLength(64);
    expect(
      designRuntimeFrameState("workspace-a", "home.html")?.detailsByNode.heading
        ?.styles,
    ).toEqual(computedStyles);
  });

  it("rejects an old node response after a newer exact selection wins", async () => {
    let resolveFirst!: (value: DesignRuntimeNodeDetails) => void;
    let resolveSecond!: (value: DesignRuntimeNodeDetails) => void;
    const first = new Promise<DesignRuntimeNodeDetails>((resolve) => {
      resolveFirst = resolve;
    });
    const second = new Promise<DesignRuntimeNodeDetails>((resolve) => {
      resolveSecond = resolve;
    });
    mocks.designFrameRuntime.mockReturnValue({
      getNodeDetails: vi
        .fn()
        .mockReturnValueOnce(first)
        .mockReturnValueOnce(second),
      captureScreenshot: vi.fn(async () => {
        throw new Error("capture unavailable in unit test");
      }),
    });

    const selectingFirst = selectDesignNode({
      workspaceId: "workspace-a",
      folder: "/design/a",
      frame: FRAME,
      nodeId: "first",
    });
    const selectingSecond = selectDesignNode({
      workspaceId: "workspace-a",
      folder: "/design/a",
      frame: FRAME,
      nodeId: "second",
    });
    resolveSecond(details("second"));
    await expect(selectingSecond).resolves.toMatchObject({ oid: "second" });
    resolveFirst(details("first"));
    await expect(selectingFirst).resolves.toBeNull();

    expect(designWorkspaceView("workspace-a")).toMatchObject({
      selectedFrame: "home.html",
      selectedNodeId: "second",
    });
    expect(
      designRuntimeFrameState("workspace-a", "home.html")?.detailsByNode,
    ).toEqual({ second: expect.objectContaining({ oid: "second" }) });
    expect(mocks.designSetSelection).toHaveBeenCalledTimes(1);
    expect(mocks.designSetSelection).toHaveBeenCalledWith(
      "workspace-a",
      expect.objectContaining({ nodeIds: ["second"] }),
      expect.any(Number),
    );
  });

  it("publishes one atomic bounded selection for multiple runtime nodes", async () => {
    mocks.designFrameRuntime.mockReturnValue({
      getNodeDetails: vi.fn(async (nodeId: string) => ({
        ...details(nodeId),
        rect: {
          x: nodeId === "heading" ? 10 : 140,
          y: 20,
          width: 100,
          height: 40,
        },
      })),
    });

    await expect(
      selectDesignNodes({
        workspaceId: "workspace-a",
        folder: "/design/a",
        frame: FRAME,
        nodeIds: ["heading", "copy"],
        primaryNodeId: "copy",
      }),
    ).resolves.toMatchObject([{ oid: "copy" }, { oid: "heading" }]);

    expect(designWorkspaceView("workspace-a")).toMatchObject({
      selectedFrame: "home.html",
      selectedNodeId: "copy",
      selectedNodeIds: ["copy", "heading"],
    });
    expect(mocks.designSetSelection).toHaveBeenCalledWith(
      "workspace-a",
      expect.objectContaining({
        nodeIds: ["copy", "heading"],
        rects: [
          { x: 140, y: 20, width: 100, height: 40 },
          { x: 10, y: 20, width: 100, height: 40 },
        ],
      }),
      expect.any(Number),
    );
  });

  it("publishes selections larger than the former sixteen-node engine limit", async () => {
    const nodeIds = Array.from({ length: 20 }, (_, index) => `layer-${index}`);
    mocks.designFrameRuntime.mockReturnValue({
      getNodeDetails: vi.fn(async (nodeId: string) => details(nodeId)),
      captureScreenshot: vi.fn(async () => {
        throw new Error("capture unavailable in unit test");
      }),
    });

    await expect(
      selectDesignNodes({
        workspaceId: "workspace-a",
        folder: "/design/a",
        frame: FRAME,
        nodeIds,
      }),
    ).resolves.toHaveLength(20);

    expect(designWorkspaceView("workspace-a").selectedNodeIds).toEqual(nodeIds);
    expect(mocks.designSetSelection).toHaveBeenCalledWith(
      "workspace-a",
      expect.objectContaining({
        nodeIds,
        rects: expect.arrayContaining([{ x: 0, y: 0, width: 100, height: 40 }]),
      }),
      expect.any(Number),
    );
  });

  it("keeps a newly toggled primary when an additive selection is at the cap", async () => {
    const selectedNodeIds = Array.from(
      { length: DESIGN_SELECTION_NODE_LIMIT },
      (_, index) => `layer-${index}`,
    );
    mocks.designFrameRuntime.mockReturnValue({
      getNodeDetails: vi.fn(async (nodeId: string) => details(nodeId)),
      captureScreenshot: vi.fn(async () => {
        throw new Error("capture unavailable in unit test");
      }),
    });

    await selectDesignNodes({
      workspaceId: "workspace-a",
      folder: "/design/a",
      frame: FRAME,
      nodeIds: selectedNodeIds,
      primaryNodeId: selectedNodeIds[0],
    });
    mocks.designSetSelection.mockClear();

    const addedNodeId = `layer-${DESIGN_SELECTION_NODE_LIMIT}`;
    await expect(
      toggleDesignNodeSelection({
        workspaceId: "workspace-a",
        folder: "/design/a",
        frame: FRAME,
        nodeId: addedNodeId,
        details: details(addedNodeId),
      }),
    ).resolves.toHaveLength(DESIGN_SELECTION_NODE_LIMIT);

    const expectedNodeIds = [
      addedNodeId,
      ...selectedNodeIds.slice(0, DESIGN_SELECTION_NODE_LIMIT - 1),
    ];
    expect(designWorkspaceView("workspace-a")).toMatchObject({
      selectedNodeId: addedNodeId,
      selectedNodeIds: expectedNodeIds,
    });
    expect(designWorkspaceView("workspace-a").selectedNodeIds).not.toContain(
      selectedNodeIds.at(-1),
    );
    expect(mocks.designSetSelection).toHaveBeenCalledWith(
      "workspace-a",
      expect.objectContaining({ nodeIds: expectedNodeIds }),
      expect.any(Number),
    );
  });

  it("aligns group node ids with the persisted and engine validation contract", async () => {
    mocks.designFrameRuntime.mockReturnValue({
      getNodeDetails: vi.fn(async (nodeId: string) => details(nodeId)),
      captureScreenshot: vi.fn(async () => {
        throw new Error("capture unavailable in unit test");
      }),
    });

    await expect(
      selectDesignNodes({
        workspaceId: "workspace-a",
        folder: "/design/a",
        frame: FRAME,
        nodeIds: ["heading", `invalid\u0000node`, "x".repeat(257)],
      }),
    ).resolves.toMatchObject([{ oid: "heading" }]);

    expect(designWorkspaceView("workspace-a").selectedNodeIds).toEqual([
      "heading",
    ]);
    expect(mocks.designSetSelection).toHaveBeenCalledWith(
      "workspace-a",
      expect.objectContaining({ nodeIds: ["heading"] }),
      expect.any(Number),
    );
  });

  it("clears an unconfirmed live scalar when its runtime preview rejects", async () => {
    mocks.designFrameRuntime.mockReturnValue({
      previewStyles: vi.fn(async () => {
        throw new Error("Element not found");
      }),
    });

    const preview = previewDesignNodeStylesTransient({
      workspaceId: "workspace-a",
      frame: FRAME.file,
      sourceVersion: FRAME.sourceVersion,
      nodeId: "heading",
      styles: { left: "48px" },
    });
    expect(
      designLivePreviewValue("workspace-a", FRAME.file, "heading", "left"),
    ).toBe("48px");

    await expect(preview).rejects.toThrow("Element not found");
    expect(
      designLivePreviewValue("workspace-a", FRAME.file, "heading", "left"),
    ).toBeUndefined();
  });

  it("does not let an older rejected preview clear a newer live scalar", async () => {
    let rejectFirst!: (error: Error) => void;
    const first = new Promise<DesignRuntimeNodeDetails>((_, reject) => {
      rejectFirst = reject;
    });
    mocks.designFrameRuntime.mockReturnValue({
      previewStyles: vi
        .fn()
        .mockReturnValueOnce(first)
        .mockResolvedValueOnce(details("heading")),
    });

    const older = previewDesignNodeStylesTransient({
      workspaceId: "workspace-a",
      frame: FRAME.file,
      sourceVersion: FRAME.sourceVersion,
      nodeId: "heading",
      styles: { left: "48px" },
    });
    await previewDesignNodeStylesTransient({
      workspaceId: "workspace-a",
      frame: FRAME.file,
      sourceVersion: FRAME.sourceVersion,
      nodeId: "heading",
      styles: { left: "64px" },
    });
    rejectFirst(new Error("stale preview failed"));
    await expect(older).rejects.toThrow("stale preview failed");

    expect(
      designLivePreviewValue("workspace-a", FRAME.file, "heading", "left"),
    ).toBe("64px");
  });

  it("collapses an additive selection when its primary layer is clicked", async () => {
    await selectDesignNodes({
      workspaceId: "workspace-a",
      folder: "/design/a",
      frame: FRAME,
      nodeIds: ["heading", "copy"],
      primaryNodeId: "heading",
      details: [details("heading"), details("copy")],
    });

    await selectDesignNode({
      workspaceId: "workspace-a",
      folder: "/design/a",
      frame: FRAME,
      nodeId: "heading",
    });

    expect(designWorkspaceView("workspace-a")).toMatchObject({
      selectedFrame: "home.html",
      selectedNodeId: "heading",
      selectedNodeIds: ["heading"],
    });
  });

  it("rejects an old hit-test response after a newer canvas click wins", async () => {
    let resolveFirst!: (value: DesignRuntimeNodeDetails) => void;
    let resolveSecond!: (value: DesignRuntimeNodeDetails) => void;
    const first = new Promise<DesignRuntimeNodeDetails>((resolve) => {
      resolveFirst = resolve;
    });
    const second = new Promise<DesignRuntimeNodeDetails>((resolve) => {
      resolveSecond = resolve;
    });
    mocks.designFrameRuntime.mockReturnValue({
      getElementAtLoc: vi
        .fn()
        .mockReturnValueOnce(first)
        .mockReturnValueOnce(second),
      captureScreenshot: vi.fn(async () => {
        throw new Error("capture unavailable in unit test");
      }),
    });

    const selectingFirst = selectDesignNodeAtLocation({
      workspaceId: "workspace-a",
      folder: "/design/a",
      frame: FRAME,
      x: 10,
      y: 10,
    });
    const selectingSecond = selectDesignNodeAtLocation({
      workspaceId: "workspace-a",
      folder: "/design/a",
      frame: FRAME,
      x: 20,
      y: 20,
    });
    resolveSecond(details("second"));
    await expect(selectingSecond).resolves.toMatchObject({ oid: "second" });
    resolveFirst(details("first"));
    await expect(selectingFirst).resolves.toBeNull();

    expect(designWorkspaceView("workspace-a")).toMatchObject({
      selectedFrame: "home.html",
      selectedNodeId: "second",
    });
    expect(mocks.designSetSelection).toHaveBeenCalledTimes(1);
  });

  it("selects the frame when a cached canvas has no live iframe runtime", async () => {
    mocks.designFrameRuntime.mockReturnValue(undefined);

    await expect(
      selectDesignNodeAtLocation({
        workspaceId: "workspace-a",
        folder: "/design/a",
        frame: FRAME,
        x: 20,
        y: 20,
      }),
    ).resolves.toBeNull();

    expect(designWorkspaceView("workspace-a")).toMatchObject({
      selectedFrame: "home.html",
      selectedNodeId: null,
    });
    expect(mocks.designSetSelection).toHaveBeenCalledTimes(1);
    expect(mocks.designSetSelection).toHaveBeenCalledWith(
      "workspace-a",
      expect.objectContaining({
        frame: "home.html",
        updatedAt: expect.any(Number),
      }),
      expect.any(Number),
    );
  });

  it("rejects details returned by the iframe generation being replaced", async () => {
    const stale = details("stale", "111111111111111111111111");
    const result = await selectDesignNode({
      workspaceId: "workspace-a",
      folder: "/design/a",
      frame: { ...FRAME, sourceVersion: "222222222222222222222222" },
      nodeId: stale.oid,
      details: stale,
    });

    expect(result).toBeNull();
    expect(designWorkspaceView("workspace-a").selectedNodeId).toBe("stale");
    expect(mocks.designSetSelection).not.toHaveBeenCalled();
  });

  it("treats a disappearing hover target as transient", async () => {
    mocks.designFrameRuntime.mockReturnValue({
      getNodeDetails: vi.fn(async () => {
        throw new Error("Element not found");
      }),
    });

    await expect(
      hoverDesignNode({
        workspaceId: "workspace-a",
        folder: "/design/a",
        frame: FRAME.file,
        sourceVersion: FRAME.sourceVersion,
        nodeId: "removed",
      }),
    ).resolves.toBeUndefined();
  });

  it("correlates exact-source runtime matches through authored provenance", async () => {
    const computedRed = "rgb(255, 0, 0)"; // check:ui ignore-line (CSSOM protocol fixture)
    mocks.designFrameRuntime.mockReturnValue({
      getMatchedStyles: vi.fn(async () => ({
        sourceVersion: FRAME.sourceVersion,
        nodeId: "heading",
        property: "color",
        computedValue: computedRed,
        matched: [
          {
            property: "color",
            value: "red",
            important: false,
            inherited: false,
            active: true,
          },
        ],
        truncated: false,
      })),
    });
    mocks.designProvenance.mockResolvedValue({
      nodeId: "heading",
      property: "color",
      computedValue: computedRed,
      winner: null,
      candidates: [],
      origin: "computed",
      confidence: "computed-only",
      reason: "No authored declaration",
    });

    await inspectDesignNodeStyleProvenance({
      workspaceId: "workspace-a",
      frame: FRAME.file,
      sourceVersion: FRAME.sourceVersion,
      expectedRevision: "authored-revision",
      nodeId: "heading",
      property: "color",
    });

    expect(mocks.designProvenance).toHaveBeenCalledWith("workspace-a", {
      frame: FRAME.file,
      nodeId: "heading",
      property: "color",
      expectedRevision: "authored-revision",
      computedValue: computedRed,
      matched: [expect.objectContaining({ value: "red" })],
    });
  });

  it("does not retry a rejected runtime-audit fingerprint on every snapshot", async () => {
    mocks.designSetRuntimeAudit.mockRejectedValue(
      new Error("permanent validation failure"),
    );
    const snapshot = {
      sourceVersion: FRAME.sourceVersion,
      revision: 1,
      tree: [],
      frame: details("frame"),
      warnings: [
        {
          ruleId: "overflow" as const,
          oid: "removed",
          message: "Stale warning",
          fix: "Refresh",
        },
      ],
      viewport: {
        width: FRAME.width,
        height: FRAME.height,
        scrollX: 0,
        scrollY: 0,
      },
    };

    reconcileDesignRuntimeSnapshot({
      workspaceId: "workspace-a",
      folder: "/design/a",
      frame: FRAME,
      snapshot,
    });
    await vi.waitFor(() =>
      expect(mocks.designSetRuntimeAudit).toHaveBeenCalledTimes(1),
    );
    await Promise.resolve();
    reconcileDesignRuntimeSnapshot({
      workspaceId: "workspace-a",
      folder: "/design/a",
      frame: FRAME,
      snapshot,
    });
    await Promise.resolve();

    expect(mocks.designSetRuntimeAudit).toHaveBeenCalledTimes(1);
  });

  it("refreshes selected computed details when the runtime revision changes", async () => {
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
    ];
    const snapshot = (revision: number) => ({
      sourceVersion: FRAME.sourceVersion,
      revision,
      tree,
      frame: details("frame"),
      warnings: [],
      viewport: {
        width: FRAME.width,
        height: FRAME.height,
        scrollX: 0,
        scrollY: 0,
      },
    });
    const refreshed = {
      ...details("heading"),
      styles: { fontSize: "40px" },
    };
    const getNodeDetails = vi.fn(async () => refreshed);
    mocks.designFrameRuntime.mockReturnValue({
      getNodeDetails,
      captureScreenshot: vi.fn(async () => {
        throw new Error("capture unavailable in unit test");
      }),
    });

    reconcileDesignRuntimeSnapshot({
      workspaceId: "workspace-a",
      folder: "/design/a",
      frame: FRAME,
      snapshot: snapshot(1),
    });
    await selectDesignNode({
      workspaceId: "workspace-a",
      folder: "/design/a",
      frame: FRAME,
      nodeId: "heading",
      details: details("heading"),
    });

    reconcileDesignRuntimeSnapshot({
      workspaceId: "workspace-a",
      folder: "/design/a",
      frame: FRAME,
      snapshot: snapshot(2),
    });

    await vi.waitFor(() => expect(getNodeDetails).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(
        designRuntimeFrameState("workspace-a", "home.html")?.detailsByNode
          .heading?.styles.fontSize,
      ).toBe("40px"),
    );
  });

  it("refreshes every selected node when only the runtime revision changes", async () => {
    const tree = [
      {
        oid: "hero",
        tag: "main",
        name: "Hero",
        text: null,
        visible: true,
        children: ["heading", "copy"].map((oid) => ({
          oid,
          tag: "p",
          name: oid,
          text: oid,
          visible: true,
          children: [],
        })),
      },
    ];
    const snapshot = (revision: number) => ({
      sourceVersion: FRAME.sourceVersion,
      revision,
      tree,
      frame: details("frame"),
      warnings: [],
      viewport: {
        width: FRAME.width,
        height: FRAME.height,
        scrollX: 0,
        scrollY: 0,
      },
    });
    const getNodeDetails = vi.fn(async (nodeId: string) => ({
      ...details(nodeId),
      styles: { fontSize: nodeId === "heading" ? "40px" : "24px" },
    }));
    mocks.designFrameRuntime.mockReturnValue({
      getNodeDetails,
      captureScreenshot: vi.fn(async () => {
        throw new Error("capture unavailable in unit test");
      }),
    });

    reconcileDesignRuntimeSnapshot({
      workspaceId: "workspace-a",
      folder: "/design/a",
      frame: FRAME,
      snapshot: snapshot(1),
    });
    await selectDesignNodes({
      workspaceId: "workspace-a",
      folder: "/design/a",
      frame: FRAME,
      nodeIds: ["heading", "copy"],
      details: [details("heading"), details("copy")],
    });
    getNodeDetails.mockClear();

    reconcileDesignRuntimeSnapshot({
      workspaceId: "workspace-a",
      folder: "/design/a",
      frame: FRAME,
      snapshot: snapshot(2),
    });

    await vi.waitFor(() => expect(getNodeDetails).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(
        designRuntimeFrameState("workspace-a", "home.html")?.detailsByNode,
      ).toMatchObject({
        heading: { styles: { fontSize: "40px" } },
        copy: { styles: { fontSize: "24px" } },
      }),
    );
  });
});
