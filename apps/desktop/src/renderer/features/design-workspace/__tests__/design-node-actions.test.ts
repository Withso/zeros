import { beforeEach, describe, expect, it, vi } from "vitest";
import { designWorkspaceView, resetDesignWorkspaceUiForTests, useDesignWorkspaceUiStore } from "../state/design-workspace-ui";
import { resetDesignRuntimeStoreForTests } from "../state/design-runtime-store";

const mocks = vi.hoisted(() => ({ edit: vi.fn(), snapshots: new Map(), selectNodes: vi.fn(), selectFrame: vi.fn() }));
vi.mock("../state/design-workspace-cache", () => ({
  applyDesignEditCached: mocks.edit,
  designWorkspaceSnapshotCache: { peekSnapshot: (id: string) => ({ data: mocks.snapshots.get(id) }) },
}));
vi.mock("../state/design-selection", () => ({ selectDesignNodes: mocks.selectNodes, selectDesignFrame: mocks.selectFrame }));
import { applyDesignNodeAction } from "../state/design-node-actions";

const frame = { file: "a.html", sourceVersion: "a".repeat(24), title: "A", x: 0, y: 0, width: 200, height: 100, z: 0, nodeCount: 2, modifiedAt: 1 };
const other = { ...frame, file: "b.html" };
beforeEach(() => {
  vi.resetAllMocks();
  resetDesignWorkspaceUiForTests();
  resetDesignRuntimeStoreForTests();
  mocks.snapshots.clear();
  mocks.snapshots.set("local", { frames: [frame, other] });
  useDesignWorkspaceUiStore.getState().setSelection("local", frame.file, "nested");
  mocks.edit.mockResolvedValue({ snapshot: { frames: [frame, other] } });
  mocks.selectNodes.mockResolvedValue(null);
  mocks.selectFrame.mockResolvedValue(undefined);
});

describe("canvas node commands", () => {
  it("uses the current semantic frame after a transfer, without a rendered-closure fallback", async () => {
    useDesignWorkspaceUiStore.getState().setSelection("local", other.file, "nested");
    await applyDesignNodeAction({ workspaceId: "local", folder: "/design", action: "delete" });
    expect(mocks.edit).toHaveBeenCalledWith("local", other, expect.objectContaining({ operations: [expect.objectContaining({ type: "node.delete", nodeId: "nested" })] }), undefined, undefined);
  });

  it("never substitutes the first frame when the selected frame has disappeared", async () => {
    mocks.snapshots.set("local", { frames: [other] });
    await applyDesignNodeAction({ workspaceId: "local", folder: "/design", action: "delete" });
    expect(mocks.edit).not.toHaveBeenCalled();
  });

  it("admits repeated duplicate intents while an earlier save is held", async () => {
    let release!: (value: unknown) => void;
    mocks.edit.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const first = applyDesignNodeAction({ workspaceId: "local", folder: "/design", action: "duplicate" });
    const second = applyDesignNodeAction({ workspaceId: "local", folder: "/design", action: "duplicate" });
    expect(mocks.edit).toHaveBeenCalledTimes(2);
    await second;
    release({ snapshot: { frames: [frame] } });
    await first;
    expect(mocks.selectNodes).toHaveBeenCalledTimes(1);
    expect(mocks.selectNodes.mock.calls[0]![0].nodeIds).toEqual([mocks.edit.mock.calls[1]![2].operations[0].duplicateNodeId]);
  });

  it("clears a deleted selection immediately and does not submit it again", async () => {
    let release!: (value: unknown) => void;
    mocks.edit.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const first = applyDesignNodeAction({ workspaceId: "local", folder: "/design", action: "delete" });
    expect(designWorkspaceView("local").selectedNodeIds).toEqual([]);
    await applyDesignNodeAction({ workspaceId: "local", folder: "/design", action: "delete" });
    expect(mocks.edit).toHaveBeenCalledTimes(1);
    release({ snapshot: { frames: [frame] } });
    await first;
  });

  it.each([false, true])("deletes the pending copy unless the user explicitly reselected the original (%s)", async reselected => {
    let release!: (value: unknown) => void;
    mocks.edit.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const copying = applyDesignNodeAction({ workspaceId: "local", folder: "/design", action: "duplicate" });
    const copyId = mocks.edit.mock.calls[0]![2].operations[0].duplicateNodeId;
    if (reselected) useDesignWorkspaceUiStore.getState().setSelection("local", frame.file, "nested", undefined, { explicit: true });
    await applyDesignNodeAction({ workspaceId: "local", folder: "/design", action: "delete" });
    try {
      expect(mocks.edit.mock.calls[1]![2].operations).toEqual([expect.objectContaining({ type: "node.delete", nodeId: reselected ? "nested" : copyId })]);
    } finally {
      release({ snapshot: { frames: [frame] } });
      await copying;
    }
    expect(mocks.selectNodes).not.toHaveBeenCalled();
  });

  it.each(["selection", "owner"])("does not steal a later %s when a duplicate confirms", async change => {
    let release!: (value: unknown) => void;
    mocks.edit.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const pending = applyDesignNodeAction({ workspaceId: "local", folder: "/design", action: "duplicate" });
    if (change === "selection") useDesignWorkspaceUiStore.getState().setSelection("local", other.file, "other");
    else useDesignWorkspaceUiStore.setState(state => ({ byWorkspace: { ...state.byWorkspace,
      local: { ...state.byWorkspace.local!, ownerRevision: (state.byWorkspace.local!.ownerRevision ?? 0) + 2 } } }));
    release({ snapshot: { frames: [frame] } });
    await pending;
    expect(mocks.selectNodes).not.toHaveBeenCalled();
    expect(mocks.selectFrame).not.toHaveBeenCalled();
  });

  it("restores the exact selection after a refused deletion", async () => {
    mocks.edit.mockRejectedValue(new Error("conflict"));
    await expect(applyDesignNodeAction({ workspaceId: "local", folder: "/design", action: "delete" })).rejects.toThrow("conflict");
    expect(mocks.selectNodes).toHaveBeenCalledWith(expect.objectContaining({ frame, nodeIds: ["nested"] }));
  });
});
