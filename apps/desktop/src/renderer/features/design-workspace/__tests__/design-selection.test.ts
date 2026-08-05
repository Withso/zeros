import type { DesignRuntimeNodeDetails } from "@zeros/protocol/design-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  designSetSelection: vi.fn(async () => {}),
  designSetScreenshot: vi.fn(async () => {}),
  designSetRuntimeAudit: vi.fn(async () => {}),
  designFrameRuntime: vi.fn(),
}));

vi.mock("../../../platform/git", () => ({
  designSetSelection: mocks.designSetSelection,
  designSetScreenshot: mocks.designSetScreenshot,
  designSetRuntimeAudit: mocks.designSetRuntimeAudit,
}));

vi.mock("../../../platform/bridge/design-frame-runtime", () => ({
  designFrameRuntime: mocks.designFrameRuntime,
}));

import {
  hoverDesignNode,
  reconcileDesignRuntimeSnapshot,
  resetDesignSelectionWorkflowsForTests,
  selectDesignNode,
  selectDesignNodeAtLocation,
} from "../state/design-selection";
import {
  designRuntimeFrameState,
  resetDesignRuntimeStoreForTests,
} from "../state/design-runtime-store";
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
    resetDesignWorkspaceUiForTests();
    vi.clearAllMocks();
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
});
