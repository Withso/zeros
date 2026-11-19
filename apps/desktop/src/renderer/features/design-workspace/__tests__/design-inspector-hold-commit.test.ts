// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesignRuntimeNodeDetails, DesignRuntimeSnapshot } from "@zeros/protocol/design-runtime";
import type { DesignLayoutAction } from "../design-layout-values";

const mocks = vi.hoisted(() => {
  const state: { prepared: unknown } = { prepared: undefined };
  return {
  runtime: vi.fn(),
  editor: { props: null as null | {
    onCommitStyles: (styles: Record<string, string | null>) => Promise<void>;
    onPreviewStyles: (styles: Record<string, string | null>) => Promise<void>;
    onLayoutAction: (action: DesignLayoutAction) => Promise<void>;
  } },
  applyEdit: vi.fn(async (_workspaceId: string, _frame: unknown, intent: unknown) => {
    state.prepared = typeof intent === "function"
      ? await intent({ assertCurrent: () => {} })
      : intent;
    return { result: null };
  }),
  updateStyles: vi.fn(async () => {}),
  state,
  };
});
vi.mock("../../../platform/bridge/design-frame-runtime", () => ({
  designFrameRuntime: mocks.runtime,
  waitForDesignFrameRuntime: vi.fn(),
}));
vi.mock("../../../platform/bridge/active-bridge", () => ({ onActiveBridgeConnected: vi.fn(() => () => {}) }));
vi.mock("../design-style-editor", () => ({
  DesignStyleEditor: (props: NonNullable<typeof mocks.editor.props>) => {
    mocks.editor.props = props;
    return null;
  },
}));
vi.mock("../state/design-workspace-cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/design-workspace-cache")>()),
  applyDesignEditCached: mocks.applyEdit,
  updateDesignNodeStylesCached: mocks.updateStyles,
}));

import { TooltipProvider } from "../../../shared/ui/primitives";
import { DesignInspector } from "../design-inspector";
import { resetDesignRuntimeStoreForTests, useDesignRuntimeStore } from "../state/design-runtime-store";
import { resetDesignHeldStateForTests } from "../state/design-held-state";
import { designWorkspaceSnapshotCache } from "../state/design-workspace-cache";
import { resetDesignWorkspaceUiForTests, useDesignWorkspaceUiStore } from "../state/design-workspace-ui";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
vi.stubGlobal("CSS", { escape: (value: string) => value });

const VERSION = "a".repeat(24);
const FRAME = { file: "home.html", sourceVersion: VERSION, x: 0, y: 0, z: 0, width: 400, height: 300 };

// A frame root that hugs its content: a layout edit refits the frame.
const root: DesignRuntimeNodeDetails = {
  sourceVersion: VERSION, oid: "root", tag: "main", name: "Root", text: null, selector: '[data-oid="root"]',
  visible: true, breadcrumb: [], rect: { x: 0, y: 0, width: 400, height: 300 }, styles: { position: "static" },
  layout: { x: 0, y: 0, parentId: null, parentWidth: 400, parentHeight: 300, parentDisplay: "block", parentPosition: "static",
    isContainingBlock: true, widthValue: "fit-content", heightValue: "fit-content" } as never,
};

function runtime(measured: DesignRuntimeNodeDetails) {
  const getNodeDetails = vi.fn(async (_nodeId: string) => measured);
  return {
    sourceVersion: VERSION,
    supports: (capability: string): boolean => capability === "measureLayout",
    previewGeometry: vi.fn(async (_nodeId: string, _styles: Record<string, string | null> | null) => ({ ...root, rect: { ...root.rect, width: 420 } })),
    previewStyles: vi.fn(async () => ({ ...root, rect: { ...root.rect, width: 420 } })),
    clearPreviewStyles: vi.fn(async () => root),
    getNodeDetails,
    measureLayout: vi.fn(async ({ nodeIds }: { nodeIds: string[] }) =>
      Promise.all(nodeIds.map((nodeId) => getNodeDetails(nodeId))),
    ),
  };
}

let host: HTMLDivElement;
let reactRoot: Root | null = null;

function mount(details = root, selectedDetails?: DesignRuntimeNodeDetails) {
  const snapshot = { sourceVersion: VERSION, revision: 1, tree: [], warnings: [], frame: details,
    viewport: { width: 400, height: 300, scrollX: 0, scrollY: 0 } } as DesignRuntimeSnapshot;
  useDesignRuntimeStore.getState().publishSnapshot("w", "/repo", "home.html", snapshot, VERSION);
  designWorkspaceSnapshotCache.setData("w", { frames: [FRAME] } as never);
  act(() => {
    reactRoot = createRoot(host);
    reactRoot.render(
      React.createElement(TooltipProvider, null,
        React.createElement(DesignInspector, {
          workspaceId: "w", folder: "/repo", frame: FRAME, frameSelected: !selectedDetails,
          selectedNodeId: selectedDetails?.oid ?? null, selectedNodeIds: selectedDetails ? [selectedDetails.oid] : [],
          details: selectedDetails ?? details, lint: null, active: true, canvasBackground: "white", onCanvasBackgroundChange: () => {},
          motionTimelineOpen: false, motionProperties: [], onOpenMotionTimeline: () => {}, zoomActionsRef: { current: null },
        } as never)),
    );
  });
}

describe("a style commit that refits its frame", () => {
  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    resetDesignRuntimeStoreForTests();
    resetDesignHeldStateForTests();
    resetDesignWorkspaceUiForTests();
    mocks.applyEdit.mockClear();
    mocks.updateStyles.mockClear();
    mocks.state.prepared = undefined;
    mocks.editor.props = null;
  });
  afterEach(() => {
    act(() => reactRoot?.unmount());
    reactRoot = null;
    host.remove();
  });

  it("refits the frame from the proposed intrinsic measurement", async () => {
    mocks.runtime.mockReturnValue(runtime({ ...root, rect: { ...root.rect, width: 420 } }));
    mount();
    await act(async () => { await mocks.editor.props!.onCommitStyles({ padding: "12px" }); });
    expect(mocks.applyEdit).toHaveBeenCalledTimes(1);
  });

  it("prepares queued intrinsic P1 atomically without repainting the newer P2 preview", async () => {
    const child = { ...root, oid: "child" };
    const connection = runtime({ ...root, rect: { ...root.rect, width: 420 } });
    connection.measureLayout.mockResolvedValue([{ ...root, rect: { ...root.rect, width: 420 } }, child]);
    connection.supports = (capability) => capability === "measureLayout" || capability === "previewGeometry";
    let paintedPadding: string | null = null;
    connection.previewGeometry.mockImplementation(async (_nodeId, styles) => {
      paintedPadding = styles?.padding ?? null;
      return { ...root, rect: { ...root.rect, width: 480 } };
    });
    mocks.runtime.mockReturnValue(connection);
    let prepare!: () => void;
    const queued = new Promise<void>((resolve) => { prepare = resolve; });
    mocks.applyEdit.mockImplementationOnce(async (_workspaceId, _frame, intent) => {
      await queued;
      mocks.state.prepared = await (intent as (context: { assertCurrent: () => void }) => Promise<unknown>)({ assertCurrent: () => {} });
      return { result: null };
    });
    mount(root, child);
    let committed!: Promise<void>;
    act(() => { committed = mocks.editor.props!.onCommitStyles({ padding: "12px" }); });
    await act(async () => { await mocks.editor.props!.onPreviewStyles({ padding: "24px" }); });
    expect(paintedPadding).toBe("24px");
    connection.previewGeometry.mockClear();
    await act(async () => { prepare(); await committed; });
    expect(connection.previewGeometry).not.toHaveBeenCalled();
    expect(connection.getNodeDetails).not.toHaveBeenCalled();
    expect(connection.measureLayout).toHaveBeenCalledExactlyOnceWith({
      updates: [{ nodeId: "child", styles: { padding: "12px" } }], nodeIds: ["child", "root"],
    });
    expect(mocks.state.prepared).toMatchObject({ operations: [
      { type: "node.set-styles", styles: { padding: "12px" } },
      { type: "frame.set-geometry", geometry: { width: 420 } },
    ] });
    expect(paintedPadding).toBe("24px");
    expect(connection.clearPreviewStyles).not.toHaveBeenCalled();
  });

  it("fails closed on old runtimes before intrinsic Style preparation", async () => {
    const connection = runtime(root);
    connection.supports = () => false;
    mocks.runtime.mockReturnValue(connection);
    mount();
    await act(async () => {
      await expect(mocks.editor.props!.onCommitStyles({ padding: "12px" })).rejects.toThrow(
        "This Design frame cannot safely prepare layout edits. Reload the frame and try again.",
      );
    });
    expect(connection.getNodeDetails).not.toHaveBeenCalled();
    expect(connection.previewStyles).not.toHaveBeenCalled();
    expect(mocks.state.prepared).toBeUndefined();
  });

  function arrangeFixture(count: number) {
    const childIds = Array.from({ length: count }, (_, index) => `child-${index}`);
    const parent: DesignRuntimeNodeDetails = {
      ...root,
      childrenLayout: { count, nodeIds: childIds, x: "start", y: "start", truncated: false },
    };
    const nodes = new Map<string, DesignRuntimeNodeDetails>([[parent.oid, parent]]);
    childIds.forEach((oid, index) => nodes.set(oid, {
      ...root, oid, rect: { x: index, y: 10, width: 10, height: 10 },
      styles: { position: "absolute" },
      layout: { ...root.layout!, parentId: parent.oid, x: index, y: 10 },
    }));
    const connection = runtime(parent);
    connection.getNodeDetails.mockImplementation(async (nodeId) => nodes.get(nodeId)!);
    connection.measureLayout.mockImplementation(async ({ nodeIds }) =>
      nodeIds.flatMap((nodeId) => nodes.has(nodeId) ? [nodes.get(nodeId)!] : []).reverse(),
    );
    mocks.runtime.mockReturnValue(connection);
    mount(parent);
    return { connection, nodes, childIds };
  }

  it("batches a 255-child Arrange through durable inspector preparation", async () => {
    const { connection, childIds } = arrangeFixture(255);
    await act(async () => {
      await mocks.editor.props!.onLayoutAction({ type: "align", axis: "x", value: "start" });
    });
    expect(mocks.applyEdit).toHaveBeenCalledOnce();
    expect(connection.measureLayout).toHaveBeenCalledTimes(6);
    expect(connection.measureLayout.mock.calls.map(([input]) => input.nodeIds.length)).toEqual([1, 64, 64, 64, 63, 1]);
    for (const [input] of connection.measureLayout.mock.calls) {
      expect(input.nodeIds.length).toBeLessThanOrEqual(64);
      expect(new Set(input.nodeIds).size).toBe(input.nodeIds.length);
    }
    const prepared = mocks.state.prepared as { operations: Array<{ nodeId: string }> };
    expect(prepared.operations.map((operation) => operation.nodeId)).toEqual(childIds);
  });

  it("rejects a missing requested Arrange child instead of writing a partial batch", async () => {
    const { nodes } = arrangeFixture(2);
    nodes.delete("child-1");
    await expect(mocks.editor.props!.onLayoutAction({ type: "center" })).rejects.toThrow("child-1");
    expect(mocks.state.prepared).toBeUndefined();
  });

  it("stops between confirmed chunks when the frame generation changes", async () => {
    const { connection } = arrangeFixture(255);
    const measure = connection.measureLayout.getMockImplementation()!;
    let reads = 0;
    connection.measureLayout.mockImplementation(async (input) => {
      const measured = await measure(input);
      if (++reads === 2)
        designWorkspaceSnapshotCache.setData("w", { frames: [{ ...FRAME, sourceVersion: "b".repeat(24) }] } as never);
      return measured;
    });
    await expect(mocks.editor.props!.onLayoutAction({ type: "center" })).rejects.toThrow("Design frame changed");
    expect(connection.measureLayout).toHaveBeenCalledTimes(2);
    expect(mocks.state.prepared).toBeUndefined();
  });

  it("does not write Arrange when a confirmed child read is held", async () => {
    const { nodes } = arrangeFixture(2);
    nodes.set("child-1", { ...nodes.get("child-1")!, heldState: "hover" });
    await act(async () => { await mocks.editor.props!.onLayoutAction({ type: "center" }); });
    expect(mocks.state.prepared).toBeNull();
  });

  it("clears the canvas preview of every layer when a layout save fails", async () => {
    const { connection } = arrangeFixture(2);
    (mocks.applyEdit as unknown as { mockImplementationOnce: (fn: (...args: unknown[]) => Promise<never>) => void })
      .mockImplementationOnce(async (_workspaceId, _frame, intent, _undo, options) => {
      if (typeof intent === "function") await (intent as (input: { assertCurrent: () => void }) => Promise<unknown>)({ assertCurrent: () => {} });
      await (options as { recover: (input: { assertCurrent: () => void }) => Promise<void> })
        .recover({ assertCurrent: () => {} });
      throw new Error("Save failed.");
    });
    await act(async () => {
      await expect(mocks.editor.props!.onLayoutAction({ type: "center" })).rejects.toThrow("Save failed.");
    });
    expect((connection.clearPreviewStyles.mock.calls as unknown[][]).map(([nodeId]) => nodeId).sort()).toEqual(["child-0", "child-1", "root"]);
  });

  it("does not measure an empty Arrange child batch", async () => {
    const { connection } = arrangeFixture(0);
    await act(async () => { await mocks.editor.props!.onLayoutAction({ type: "center" }); });
    expect(connection.measureLayout).toHaveBeenCalledTimes(1);
    expect(mocks.state.prepared).toBeNull();
  });

  it.each<Record<string, string | null>>([{ opacity: "0.4" }, { left: "12px" }])("does not measure an ordinary nonintrinsic style/position edit %j", async (styles) => {
    const fixedRoot = { ...root, layout: { ...root.layout!, widthValue: "400px", heightValue: "300px" } };
    const connection = runtime(fixedRoot);
    mocks.runtime.mockReturnValue(connection);
    mount(fixedRoot);
    await act(async () => { await mocks.editor.props!.onCommitStyles(styles); });
    expect(mocks.applyEdit.mock.calls.length + mocks.updateStyles.mock.calls.length).toBe(1);
    expect(connection.measureLayout).not.toHaveBeenCalled();
  });

  it("writes nothing when that measurement comes back held (a hold began after the preview)", async () => {
    mocks.runtime.mockReturnValue(runtime({ ...root, heldState: "hover", rect: { ...root.rect, width: 900 } }));
    mount();
    await act(async () => { await mocks.editor.props!.onCommitStyles({ padding: "12px" }); });
    expect(mocks.applyEdit).toHaveBeenCalledTimes(1);
    expect(mocks.updateStyles).not.toHaveBeenCalled();
    expect(mocks.state.prepared).toBeNull();
    // The preview of a value never written goes too.
    expect((mocks.runtime.mock.results.at(-1)!.value as ReturnType<typeof runtime>).clearPreviewStyles).toHaveBeenCalled();
  });

  it("does not paint a replacement owner after preview cleanup begins", async () => {
    let releaseClear: (() => void) | undefined;
    const clearGate = new Promise<void>((resolve) => { releaseClear = resolve; });
    const oldRuntime = runtime({ ...root, heldState: "hover" });
    oldRuntime.clearPreviewStyles.mockImplementation(() => clearGate.then(() => root));
    const replacementRuntime = runtime(root);
    mocks.runtime.mockReturnValue(oldRuntime);
    mount();
    await act(async () => { void mocks.editor.props!.onCommitStyles({ padding: "12px" }); });
    await vi.waitFor(() => expect(oldRuntime.clearPreviewStyles).toHaveBeenCalledOnce());
    mocks.runtime.mockReturnValue(replacementRuntime);
    await act(async () => {
      useDesignWorkspaceUiStore.getState().bindDirectory("w", "replacement");
      await Promise.resolve();
    });
    await act(async () => {
      releaseClear?.();
      await Promise.resolve();
    });
    expect(replacementRuntime.clearPreviewStyles).not.toHaveBeenCalled();
    expect(mocks.state.prepared).toBeNull();
  });
});
