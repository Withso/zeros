import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ geometry: vi.fn(), history: vi.fn(), create: vi.fn(), transaction: vi.fn(), runtime: vi.fn(),
  createPage: vi.fn(), renamePage: vi.fn(), deletePage: vi.fn(), theme: vi.fn() }));
vi.mock("../../../platform/git", async original => ({
  ...(await original<typeof import("../../../platform/git")>()),
  designUpdateCanvas: mocks.geometry, designHistory: mocks.history, designCreateFrame: mocks.create,
  designApplyTransaction: mocks.transaction,
  designCreatePage: mocks.createPage, designRenamePage: mocks.renamePage, designDeletePage: mocks.deletePage,
  designUpdateTheme: mocks.theme,
}));
vi.mock("../../../platform/bridge/active-bridge", () => ({ getActiveBridge: () => null, onActiveBridgeConnected: () => () => {} }));
vi.mock("../../../platform/bridge/design-frame-runtime", () => ({ designFrameRuntime: mocks.runtime }));
import { applyDesignHistoryCached, applyDesignTransactionCached, createDesignFrameAndRefresh, designWorkspaceSnapshotCache,
  observeDesignDirectory, resetDesignWorkspaceCacheForTests, updateDesignFrameGeometryCached } from "../state/design-workspace-cache";
import { createDesignPageCached, renameDesignPageCached, deleteDesignPageCached, updateDesignThemeCached } from "../state/design-workspace-cache";
import { designHistoryTransientStatsForTests } from "../state/design-workspace-cache";
import { designHistoryPresentation, designHistorySelection, presentDesignHistory, presentDesignHistoryRuntime } from "../state/design-history-presentation";
import { designWorkspaceView, resetDesignWorkspaceUiForTests, useDesignWorkspaceUiStore } from "../state/design-workspace-ui";
import type { DesignWorkspaceSnapshotWire } from "../../../platform/git";
import { resetDesignRuntimeStoreForTests, useDesignRuntimeStore } from "../state/design-runtime-store";

const snapshot = (x: number): DesignWorkspaceSnapshotWire => ({ directoryId: "design-a", protocolCapability: "c".repeat(64),
  frames: [{ file: "a.html", title: "A", x, y: 20, width: 100, height: 80, z: 0, sourceVersion: "1".repeat(24), nodeCount: 0, modifiedAt: 1 }],
  tokens: [], tokenSourceVersion: "t", assets: [], lint: { workspacePath: "/personal/Design", checkedFiles: [], violations: [], healedOids: 0 },
});
const pending: Array<Promise<unknown>> = []; const release: Array<() => void> = [];
function hold<T>(value: T) { let done!: () => void; const promise = new Promise<T>(resolve => { done = () => resolve(value); }); release.push(done); return { promise, done }; }
beforeEach(() => { vi.clearAllMocks(); mocks.runtime.mockReturnValue(null); resetDesignWorkspaceCacheForTests(); resetDesignWorkspaceUiForTests(); resetDesignRuntimeStoreForTests(); });
afterEach(async () => { release.splice(0).forEach(done => done()); await Promise.allSettled(pending.splice(0)); });

describe("history presentation stays separate from authority", () => {
  it("bounds pending visual vectors from large catalogs after journal entries are evicted", async () => {
    for (let owner = 0; owner < 12; owner++) {
      const workspace = `owner-${owner}`;
      const first = snapshot(10);
      const before = { ...first, frames: Array.from({ length: 256 }, (_, index) => ({ ...first.frames[0]!,
        file: `frame-${index}.html`, title: "T".repeat(120) })) };
      const after = { ...before, frames: before.frames.map(frame => ({ ...frame, x: 90 })) };
      designWorkspaceSnapshotCache.setData(workspace, before); observeDesignDirectory(workspace, before);
      mocks.geometry.mockResolvedValue({ geometry: { x: 90, y: 20, w: 100, h: 80, z: 0 }, snapshot: after });
      await updateDesignFrameGeometryCached(workspace, "frame-0.html", { x: 90, y: 20, w: 100, h: 80, z: 0 });
      const held = hold({ result: null, snapshot: before }); mocks.history.mockReturnValueOnce(held.promise);
      const undo = applyDesignHistoryCached(workspace, "frame-0.html", "undo"); pending.push(undo);
      await Promise.resolve();
      expect(designHistoryTransientStatsForTests().intentBytes).toBeLessThanOrEqual(1024 * 1024);
    }
    expect(designHistoryPresentation("owner-0")).toBeNull();
  });
  it.each(["page", "selection"])("shows an empty restored page without mutating navigation and yields to a newer %s choice", change => {
    const before = snapshot(10); designWorkspaceSnapshotCache.setData("personal", before); observeDesignDirectory("personal", before);
    useDesignWorkspaceUiStore.getState().setActivePage("personal", "main", "design-a");
    const confirmed = designWorkspaceView("personal");
    presentDesignHistory("personal", {}, { selection: { pageId: "empty", frame: null, frameSelected: false } });
    expect(designHistorySelection("personal")).toMatchObject({ activePageId: "empty", selectedFrame: null, selectedTargets: [] });
    expect(designWorkspaceView("personal")).toBe(confirmed);
    if (change === "page") useDesignWorkspaceUiStore.getState().setActivePage("personal", "another", "design-a");
    else useDesignWorkspaceUiStore.getState().setSelection("personal", "a.html", "child");
    expect(designHistorySelection("personal")).toBeNull();
  });

  it("reveals the page and frame of a structural inverse before authority, with no UI-store writes", async () => {
    const page = { id: "main", title: "Main", folder: "", frameFiles: ["a.html"] };
    const second = { id: "second", title: "Second", folder: "second", frameFiles: [] as string[] };
    const before = { ...snapshot(10), pages: [page, second] };
    const after = { ...before, pages: [page] };
    designWorkspaceSnapshotCache.setData("personal", before); observeDesignDirectory("personal", before);
    useDesignWorkspaceUiStore.getState().setActivePage("personal", "main", "design-a");
    mocks.deletePage.mockResolvedValue({ deleted: { pageId: "second" }, snapshot: after });
    await deleteDesignPageCached("personal", "second", []);
    const held = hold({ result: null, historyPageId: "second", historySelection: null, snapshot: before }); mocks.history.mockReturnValueOnce(held.promise);
    const undo = applyDesignHistoryCached("personal", "a.html", "undo"); pending.push(undo);
    expect(designHistorySelection("personal")).toMatchObject({ activePageId: "second", selectedFrame: null, frameSelected: false });
    expect(designWorkspaceView("personal").activePageId).toBe("main");
    held.done(); await undo;
  });
  it.each(["create", "rename", "delete", "theme"])("predicts %s catalog history without publishing an unconfirmed server snapshot", async operation => {
    const page = { id: "main", title: "Main", folder: "", frameFiles: ["a.html"] };
    const second = { id: "second", title: "Second", folder: "second", frameFiles: [] as string[] };
    const before = { ...snapshot(10), pages: [page, second] };
    const after: DesignWorkspaceSnapshotWire = operation === "create" ? { ...before, pages: [...before.pages, { ...second, id: "third", folder: "third" }] }
      : operation === "rename" ? { ...before, pages: [page, { ...second, title: "Renamed" }] }
      : operation === "delete" ? { ...before, pages: [page] }
      : { ...before, themes: [{ id: "dark", label: "Night", base: true }] };
    designWorkspaceSnapshotCache.setData("personal", before); observeDesignDirectory("personal", before);
    if (operation === "create") { mocks.createPage.mockResolvedValue({ page: after.pages![2], snapshot: after }); await createDesignPageCached("personal", "Third"); }
    else if (operation === "rename") { mocks.renamePage.mockResolvedValue({ page: after.pages![1], snapshot: after }); await renameDesignPageCached("personal", "second", "Renamed"); }
    else if (operation === "delete") { mocks.deletePage.mockResolvedValue({ deleted: { pageId: "second" }, snapshot: after }); await deleteDesignPageCached("personal", "second", []); }
    else { mocks.theme.mockResolvedValue({ themes: after.themes, snapshot: after }); await updateDesignThemeCached("personal", after.themes![0]!); }
    const held = hold({ result: null, snapshot: before }); mocks.history.mockReturnValueOnce(held.promise);
    const undo = applyDesignHistoryCached("personal", "a.html", "undo"); pending.push(undo);
    expect(designHistoryPresentation("personal")?.catalog?.deref()).toBe(before);
    expect(designWorkspaceSnapshotCache.peekSnapshot("personal").data?.pages).toEqual(after.pages);
    expect(designWorkspaceSnapshotCache.peekSnapshot("personal").data?.themes ?? []).toEqual(after.themes ?? []);
    held.done(); await undo;
  });
  it("keeps frame geometry with the same inverse as an adopted body-style transaction", async () => {
    const before = snapshot(10), after = { ...before, frames: [{ ...before.frames[0]!, width: 160, sourceVersion: "2".repeat(24) }] };
    const detail = { sourceVersion: "1".repeat(24), oid: "body", tag: "body", name: "Frame", text: null,
      selector: "body", breadcrumb: [], visible: true, styles: {}, rect: { x: 0, y: 0, width: 100, height: 80 } };
    const initial = { sourceVersion: detail.sourceVersion, frame: detail, tree: [], revision: 1, warnings: [],
      viewport: { width: 100, height: 80, scrollX: 0, scrollY: 0 } };
    const runtime = { sourceVersion: initial.sourceVersion, supports: () => true, isActive: () => true,
      commitStyles: vi.fn(async () => {
        runtime.sourceVersion = "2".repeat(24);
        const changed = { ...detail, sourceVersion: runtime.sourceVersion, styles: { width: "160px" } };
        return { sourceVersion: runtime.sourceVersion, treeUnchanged: true, snapshot: { ...initial, sourceVersion: runtime.sourceVersion, frame: changed }, details: [changed] };
      }),
      restoreGeneration: vi.fn(async () => ({ sourceVersion: runtime.sourceVersion, treeUnchanged: true,
        snapshot: { ...initial, sourceVersion: runtime.sourceVersion }, details: [] })), getNodeDetails: vi.fn(),
    };
    mocks.runtime.mockReturnValue(runtime);
    designWorkspaceSnapshotCache.setData("personal", before); observeDesignDirectory("personal", before);
    useDesignRuntimeStore.getState().publishSnapshot("personal", before.lint.workspacePath, "a.html", initial, initial.sourceVersion);
    mocks.transaction.mockResolvedValue({ result: null, snapshot: after });
    await applyDesignTransactionCached("personal", "a.html", { schemaVersion: 1, transactionId: "resize", documentId: "frame:a.html", baseRevision: "r1",
      intent: "Resize frame", actor: { kind: "human", id: "local" }, createdAt: 1, operations: [
        { operationId: "body", type: "node.set-styles", nodeId: "body", styles: { width: "160px" }, scope: "inline", responsiveContext: "base", stateContext: "default" },
        { operationId: "geometry", type: "frame.set-geometry", frame: "a.html", geometry: { x: 10, y: 20, width: 160, height: 80, z: 0 } },
      ] });
    const held = hold({ result: null, historyFrame: "a.html", snapshot: before }); mocks.history.mockReturnValueOnce(held.promise);
    const undo = applyDesignHistoryCached("personal", "a.html", "undo"); pending.push(undo);
    expect(designHistoryPresentation("personal")?.geometry?.frames.get("a.html")?.w).toBe(100);
    expect(designWorkspaceSnapshotCache.peekSnapshot("personal").data?.frames[0]?.width).toBe(160);
    held.done(); await undo;
  });

  it("drops an oversized runtime preview instead of pinning its unbounded strings", () => {
    const before = snapshot(10); designWorkspaceSnapshotCache.setData("personal", before); observeDesignDirectory("personal", before);
    const token = {};
    presentDesignHistory("personal", token, {});
    const detail = { sourceVersion: "1".repeat(24), oid: "node", tag: "div", name: "Node", text: "x".repeat(1024 * 1024),
      selector: "div", breadcrumb: [], visible: true, styles: {}, rect: { x: 0, y: 0, width: 100, height: 100 } };
    presentDesignHistoryRuntime("personal", token, "a.html", { sourceVersion: detail.sourceVersion, snapshot: { frame: detail }, details: [detail] });
    expect(designHistoryPresentation("personal")?.runtime.has("a.html") ?? false).toBe(false);
  });

  it.each(["folder", "capability"])("rejects a preview from a replaced %s even with the same directory id", changed => {
    const before = snapshot(10); designWorkspaceSnapshotCache.setData("personal", before); observeDesignDirectory("personal", before);
    presentDesignHistory("personal", {}, { geometry: new Map([["a.html", { x: 0, y: 0, w: 100, h: 100, z: 0 }]]) });
    const next = changed === "folder" ? { ...before, lint: { ...before.lint, workspacePath: "/organization/Design" } }
      : { ...before, protocolCapability: "d".repeat(64) };
    designWorkspaceSnapshotCache.setData("personal", next);
    expect(designHistoryPresentation("personal")).toBeNull();
  });

  it("paints geometry Undo and Redo before authority while leaving the cache confirmed", async () => {
    const before = snapshot(10); const after = snapshot(90);
    designWorkspaceSnapshotCache.setData("personal", before); observeDesignDirectory("personal", before);
    mocks.geometry.mockResolvedValue({ geometry: { x: 90, y: 20, w: 100, h: 80, z: 0 }, snapshot: after });
    await updateDesignFrameGeometryCached("personal", "a.html", { x: 90, y: 20, w: 100, h: 80, z: 0 });
    const confirmed = designWorkspaceSnapshotCache.peekSnapshot("personal").data;
    const held = hold({ result: null, historyFrame: "a.html", snapshot: before }); mocks.history.mockReturnValueOnce(held.promise);
    const undo = applyDesignHistoryCached("personal", "a.html", "undo"); pending.push(undo);
    expect(designHistoryPresentation("personal")?.geometry?.frames.get("a.html")?.x).toBe(10);
    expect(designWorkspaceSnapshotCache.peekSnapshot("personal").data).toBe(confirmed);
    held.done(); await undo;
    expect(designHistoryPresentation("personal")).toBeNull();
    const redoHeld = hold({ result: null, historyFrame: "a.html", snapshot: after }); mocks.history.mockReturnValueOnce(redoHeld.promise);
    const redo = applyDesignHistoryCached("personal", "a.html", "redo"); pending.push(redo);
    expect(designHistoryPresentation("personal")?.geometry?.frames.get("a.html")?.x).toBe(90);
    expect(designWorkspaceSnapshotCache.peekSnapshot("personal").data?.frames[0]?.x).toBe(10);
    redoHeld.done(); await redo;
  });

  it("removes a newly created frame from presentation before its Undo reply", async () => {
    const before = snapshot(10); const after = { ...before, frames: [...before.frames, { ...before.frames[0]!, file: "b.html", title: "B" }] };
    designWorkspaceSnapshotCache.setData("personal", before); observeDesignDirectory("personal", before);
    mocks.create.mockResolvedValue({ frame: after.frames[1], snapshot: after });
    await createDesignFrameAndRefresh("personal", "B");
    const held = hold({ result: null, historyFrame: "b.html", snapshot: before }); mocks.history.mockReturnValueOnce(held.promise);
    const undo = applyDesignHistoryCached("personal", "b.html", "undo"); pending.push(undo);
    expect(designHistoryPresentation("personal")?.catalog?.deref()?.frames.map(f => f.file)).toEqual(["a.html"]);
    expect(designWorkspaceSnapshotCache.peekSnapshot("personal").data?.frames).toHaveLength(2);
    held.done(); await undo; expect(designHistoryPresentation("personal")).toBeNull();
  });

  it("clears a rejected geometry prediction and cannot expose it to a replacement owner", async () => {
    const before = snapshot(10), after = snapshot(90);
    designWorkspaceSnapshotCache.setData("personal", before); observeDesignDirectory("personal", before);
    mocks.geometry.mockResolvedValue({ geometry: { x: 90, y: 20, w: 100, h: 80, z: 0 }, snapshot: after });
    await updateDesignFrameGeometryCached("personal", "a.html", { x: 90, y: 20, w: 100, h: 80, z: 0 });
    mocks.history.mockRejectedValueOnce(new Error("conflict"));
    await expect(applyDesignHistoryCached("personal", "a.html", "undo")).rejects.toThrow("conflict");
    expect(designHistoryPresentation("personal")).toBeNull();
    expect(designWorkspaceSnapshotCache.peekSnapshot("personal").data?.frames[0]?.x).toBe(90);
  });
});
