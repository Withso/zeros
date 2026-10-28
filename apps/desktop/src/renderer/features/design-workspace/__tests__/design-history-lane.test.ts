import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeDesignPagesSnapshot } from "@zeros/protocol/design-pages";

// The cache, mutation lane, preview cursor and runtime store are real; only the
// engine RPCs and the iframe connection are doubles. Undo/Redo predictions must
// never paint under an edit still saving, and must advance in submission order.
const mocks = vi.hoisted(() => ({
  styles: vi.fn(), history: vi.fn(), runtime: vi.fn(),
}));
vi.mock("../../../platform/git", async (original) => ({
  ...(await original<typeof import("../../../platform/git")>()),
  designUpdateStyles: mocks.styles,
  designHistory: mocks.history,
  designSetSelection: vi.fn().mockResolvedValue(undefined),
  designSetRuntimeAudit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../../platform/bridge/design-frame-runtime", () => ({
  designFrameRuntime: mocks.runtime,
}));
vi.mock("../../../platform/bridge/active-bridge", () => ({
  getActiveBridge: () => null,
  onActiveBridgeConnected: vi.fn(() => () => {}),
}));

import {
  applyDesignHistoryCached,
  designHistoryTransientStatsForTests,
  designWorkspaceSnapshotCache,
  observeDesignDirectory,
  resetDesignWorkspaceCacheForTests,
  updateDesignNodeStylesCached,
  waitForPendingDesignEdits,
} from "../state/design-workspace-cache";
import {
  resetDesignRuntimeStoreForTests,
  useDesignRuntimeStore,
} from "../state/design-runtime-store";
import { resetDesignLivePreviewForTests } from "../state/design-live-preview";
import { designHistoryPresentation } from "../state/design-history-presentation";
import {
  resetDesignWorkspaceUiForTests,
  useDesignWorkspaceUiStore,
} from "../state/design-workspace-ui";
import { resetDesignSelectionWorkflowsForTests } from "../state/design-selection";

type Direction = "undo" | "redo";
const version = (generation: number) => generation.toString(16).padStart(24, "0");
const generation = (sourceVersion: string) => Number.parseInt(sourceVersion, 16);
const PERSONAL = "/review/personal/project";
const ORG = "/review/organization/project";
const CLOUD = "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

interface Gate {
  entered: Promise<void>;
  release(error?: Error): void;
  wait(): Promise<void>;
}
const allGates: Gate[] = [];
const pending: Promise<unknown>[] = [];
function gate(): Gate {
  const entered = deferred<void>();
  const released = deferred<Error | undefined>();
  const result = {
    entered: entered.promise,
    release: (error?: Error) => released.resolve(error),
    async wait() {
      entered.resolve();
      const error = await released.promise;
      if (error) throw error;
    },
  };
  allGates.push(result);
  return result;
}
function track<T>(promise: Promise<T>): Promise<T> {
  pending.push(promise);
  void promise.catch(() => {});
  return promise;
}

function workspaceSnapshot(workspace: string, n: number, directoryId = "design-a") {
  return {
    protocolCapability: "c".repeat(64), directoryId,
    frames: [{
      file: "home.html", title: "Home", width: 1440, height: 900,
      x: 0, y: 0, z: 0, nodeCount: 1, modifiedAt: 10 + n,
      sourceVersion: version(n),
    }],
    tokens: [], tokenSourceVersion: "tokens-generation-000001", assets: [],
    lint: { workspacePath: `${workspace}/Design`, checkedFiles: ["home.html"], violations: [], healedOids: 0 },
  };
}

function runtimePayload(confirmed: number, painted = confirmed) {
  const details = {
    sourceVersion: version(confirmed), oid: "hero", tag: "main", name: "Hero",
    text: null, selector: '[data-oid="hero"]', visible: true, breadcrumb: [],
    rect: { x: 0, y: 0, width: 100 + painted, height: 100 },
    styles: { width: `${100 + painted}px` },
  };
  return {
    sourceVersion: version(confirmed), treeUnchanged: true, details: [details],
    snapshot: {
      sourceVersion: version(confirmed), revision: confirmed + 1, tree: [], warnings: [],
      frame: { ...details, oid: "" },
      viewport: { width: 1440, height: 900, scrollX: 0, scrollY: 0 },
    },
  };
}

const fixtures = new Map<string, ReturnType<typeof fixture>>();
function fixture(workspace = PERSONAL) {
  let painted = 0;
  let engineCursor = 0;
  const engineHistory = [0];
  const editGates = new Map<number, ReturnType<typeof gate>>();
  const historyGates: Array<ReturnType<typeof gate> | undefined> = [];
  const events: Array<{ kind: string; generation?: number; direction?: Direction; commit?: boolean }> = [];
  const currentEngine = () => engineHistory[engineCursor]!;
  const runtime = {
    sourceVersion: version(0),
    supports: (method: string): boolean => method === "restoreGeneration",
    isActive: () => true,
    commitStyles: vi.fn(async (_updates: unknown, sourceVersion: string) => {
      runtime.sourceVersion = sourceVersion;
      painted = generation(sourceVersion);
      events.push({ kind: "adopt-edit", generation: painted });
      return runtimePayload(painted);
    }),
    restoreGeneration: vi.fn(async (sourceVersion: string, commit: boolean) => {
      if (commit) runtime.sourceVersion = sourceVersion;
      painted = generation(sourceVersion);
      events.push({ kind: "restore", generation: painted, commit });
      return runtimePayload(generation(runtime.sourceVersion), painted);
    }),
    getNodeDetails: vi.fn(async () => runtimePayload(generation(runtime.sourceVersion), painted).details[0]),
  };
  const first = workspaceSnapshot(workspace, 0);
  designWorkspaceSnapshotCache.setData(workspace, first);
  observeDesignDirectory(workspace, first);
  useDesignRuntimeStore.getState().publishSnapshot(
    workspace, first.lint.workspacePath, "home.html", runtimePayload(0).snapshot, version(0),
  );
  const api = {
    workspace, runtime, events, currentEngine,
    get painted() { return painted; },
    get cached() { return generation(designWorkspaceSnapshotCache.peekSnapshot(workspace).data!.frames[0]!.sourceVersion); },
    holdHistory(next: ReturnType<typeof gate>) { historyGates.push(next); },
    async engineEdit(input: { sourceVersion: string; styles: { width: string } }) {
      const n = Number.parseInt(input.styles.width, 10) - 100;
      events.push({ kind: "edit-start", generation: n });
      await editGates.get(n)?.wait();
      expect(input.sourceVersion).toBe(version(currentEngine()));
      engineHistory.splice(engineCursor + 1);
      engineHistory.push(n);
      engineCursor = engineHistory.length - 1;
      const snapshot = workspaceSnapshot(workspace, n);
      return {
        mutation: { changed: true, frame: { ...snapshot.frames[0]!, source: "<main></main>", srcDoc: "<main></main>", tree: [] }, lint: snapshot.lint },
        snapshot,
      };
    },
    async engineHistory(direction: Direction) {
      events.push({ kind: "history-start", direction, generation: currentEngine() });
      await historyGates.shift()?.wait();
      const previous = currentEngine();
      engineCursor = Math.max(0, Math.min(engineHistory.length - 1, engineCursor + (direction === "undo" ? -1 : 1)));
      const next = currentEngine();
      events.push({ kind: "history-finish", direction, generation: next });
      return {
        result: previous === next ? null : {
          revision: `revision-${next}`,
          receipt: { status: "applied", beforeRevision: `revision-${previous}`, afterRevision: `revision-${next}` },
        },
        historyFrame: "home.html", snapshot: workspaceSnapshot(workspace, next),
      };
    },
    edit(n: number, held?: ReturnType<typeof gate>) {
      if (held) editGates.set(n, held);
      return track(updateDesignNodeStylesCached(workspace, {
        frame: "home.html", nodeId: "hero", sourceVersion: version(api.cached), styles: { width: `${100 + n}px` },
      }));
    },
    history(direction: Direction) { return track(applyDesignHistoryCached(workspace, "home.html", direction)); },
    async seed(n: number) {
      for (let i = 1; i <= n; i++) await api.edit(i);
      expect(api.cached).toBe(n);
      expect(generation(runtime.sourceVersion)).toBe(n);
      events.length = 0;
      runtime.restoreGeneration.mockClear();
    },
  };
  fixtures.set(workspace, api);
  return api;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetDesignWorkspaceCacheForTests();
  resetDesignRuntimeStoreForTests();
  resetDesignLivePreviewForTests();
  resetDesignWorkspaceUiForTests();
  resetDesignSelectionWorkflowsForTests();
  fixtures.clear(); allGates.length = 0; pending.length = 0;
  mocks.runtime.mockImplementation((workspace: string) => fixtures.get(workspace)?.runtime ?? null);
  mocks.styles.mockImplementation((workspace: string, input: Parameters<ReturnType<typeof fixture>["engineEdit"]>[0]) => fixtures.get(workspace)!.engineEdit(input));
  mocks.history.mockImplementation((workspace: string, _frame: string, direction: Direction) => fixtures.get(workspace)!.engineHistory(direction));
});
afterEach(async () => {
  for (const held of allGates) held.release();
  await Promise.allSettled(pending);
  for (const workspace of fixtures.keys()) await waitForPendingDesignEdits(workspace);
});

describe("a432388d independent cache/lane review", () => {
  it.each([PERSONAL, ORG])("defers Undo until the pending edit adopts in %s", async (workspace) => {
    const f = fixture(workspace);
    await f.seed(3);
    const editGate = gate(); const historyGate = gate();
    f.holdHistory(historyGate);
    const edit = f.edit(4, editGate);
    await editGate.entered;
    const undo = f.history("undo");
    expect(f.runtime.restoreGeneration).not.toHaveBeenCalled();
    expect(f.painted).toBe(3);
    editGate.release(); await edit; await historyGate.entered;
    expect(f.painted).toBe(3);
    expect(f.runtime.restoreGeneration).toHaveBeenCalledWith(version(3), false);
    expect(f.events.findIndex((event) => event.kind === "adopt-edit")).toBeLessThan(f.events.findIndex((event) => event.kind === "restore"));
    historyGate.release(); await undo;
    expect(f.cached).toBe(3); expect(f.painted).toBe(3);
  });

  it("keeps two eager Undo and two eager Redo predictions in submission order", async () => {
    const f = fixture(); await f.seed(3);
    const firstGate = gate(); f.holdHistory(firstGate);
    const first = f.history("undo"); await firstGate.entered;
    expect(f.painted).toBe(2);
    const second = f.history("undo");
    expect(f.painted).toBe(1);
    firstGate.release(); await Promise.all([first, second]);
    expect(f.cached).toBe(1); expect(f.painted).toBe(1);
    const redoGate = gate(); f.holdHistory(redoGate);
    const redo1 = f.history("redo"); await redoGate.entered;
    expect(f.painted).toBe(2);
    const redo2 = f.history("redo"); expect(f.painted).toBe(3);
    redoGate.release(); await Promise.all([redo1, redo2]);
    expect(f.cached).toBe(3); expect(f.painted).toBe(3);
  });

  it.each([
    { directions: ["undo", "undo", "redo"] as const, expected: 3 },
    { directions: ["undo", "redo", "undo"] as const, expected: 3 },
  ])("does not let $directions[2] overtake an older deferred $directions[1] prediction", async ({ directions, expected }) => {
    const f = fixture(); await f.seed(3);
    const editGate = gate(); const firstHistoryGate = gate();
    f.holdHistory(firstHistoryGate);
    const edit = f.edit(4, editGate); await editGate.entered;
    const first = f.history(directions[0]);
    const second = f.history(directions[1]);
    expect(f.runtime.restoreGeneration).not.toHaveBeenCalled();
    editGate.release(); await edit; await firstHistoryGate.entered;
    expect(f.painted).toBe(3);
    const third = f.history(directions[2]);
    // These two opposite trailing commands cancel. Whether the older deferred
    // command is still waiting or both are predicted, neither may paint 2/4.
    const observed = f.painted;
    const dispatches = f.events.filter((event) => event.kind === "restore");
    firstHistoryGate.release(); await Promise.all([first, second, third]);
    expect(f.cached).toBe(expected);
    expect(f.painted).toBe(expected);
    expect(observed, JSON.stringify({ directions, dispatches, events: f.events })).toBe(expected);
  });

  it("does not preview a discarded redo branch under a new pending edit", async () => {
    const f = fixture(); await f.seed(3); await f.history("undo");
    const editGate = gate(); const historyGate = gate(); f.holdHistory(historyGate);
    f.runtime.restoreGeneration.mockClear();
    const edit = f.edit(4, editGate); await editGate.entered;
    const redo = f.history("redo");
    expect(f.runtime.restoreGeneration).not.toHaveBeenCalled();
    editGate.release(); await edit; await historyGate.entered;
    expect(f.painted).toBe(4);
    expect(f.runtime.restoreGeneration).not.toHaveBeenCalled();
    historyGate.release(); await redo;
    expect(f.cached).toBe(4); expect(f.painted).toBe(4);
  });

  it("preserves source order for Undo, queued edit, Undo", async () => {
    const f = fixture(); await f.seed(3);
    const firstGate = gate(); const editGate = gate(); const lastGate = gate();
    f.holdHistory(firstGate); f.holdHistory(lastGate);
    const first = f.history("undo"); await firstGate.entered;
    const edit = f.edit(4, editGate);
    const last = f.history("undo");
    expect(f.painted).toBe(2);
    firstGate.release(); await first; await editGate.entered;
    expect(f.painted).toBe(2);
    editGate.release(); await edit; await lastGate.entered;
    expect(f.painted).toBe(2);
    lastGate.release(); await last;
    expect(f.cached).toBe(2); expect(f.painted).toBe(2);
    expect(f.events.filter((event) => event.kind.endsWith("-start")).map((event) => event.direction ?? "edit")).toEqual(["undo", "edit", "undo"]);
  });

  it("drains a failed edit before queued history and leaves later history eager", async () => {
    const f = fixture(); await f.seed(3);
    const editGate = gate(); const historyGate = gate(); f.holdHistory(historyGate);
    const edit = f.edit(4, editGate); await editGate.entered;
    const undo = f.history("undo");
    expect(f.runtime.restoreGeneration).not.toHaveBeenCalled();
    editGate.release(new Error("style save refused"));
    await expect(edit).rejects.toThrow("style save refused");
    await historyGate.entered; expect(f.painted).toBe(2);
    historyGate.release(); await undo;
    const redoGate = gate(); f.holdHistory(redoGate);
    const redo = f.history("redo");
    expect(f.painted).toBe(3);
    redoGate.release(); await redo;
    expect(f.cached).toBe(3); expect(f.painted).toBe(3);
  });

  it("rolls back a rejected history prediction and accepts a later edit/history", async () => {
    const f = fixture(); await f.seed(3);
    const historyGate = gate(); f.holdHistory(historyGate);
    const undo = f.history("undo"); await historyGate.entered;
    expect(f.painted).toBe(2);
    historyGate.release(new Error("history refused"));
    await expect(undo).rejects.toThrow("history refused");
    expect(f.cached).toBe(3); expect(f.painted).toBe(3);
    await f.edit(4);
    const nextGate = gate(); f.holdHistory(nextGate);
    const next = f.history("undo"); expect(f.painted).toBe(3);
    nextGate.release(); await next;
    expect(f.cached).toBe(3); expect(f.painted).toBe(3);
  });

  it("invalidates a rejected deferred history step before the next queued step predicts", async () => {
    const f = fixture(); await f.seed(3);
    const editGate = gate(); const firstGate = gate(); const secondGate = gate();
    f.holdHistory(firstGate); f.holdHistory(secondGate);
    const edit = f.edit(4, editGate); await editGate.entered;
    const first = f.history("undo"); const second = f.history("undo");
    editGate.release(); await edit; await firstGate.entered;
    expect(f.painted).toBe(3);
    firstGate.release(new Error("first Undo refused"));
    await expect(first).rejects.toThrow("first Undo refused");
    await secondGate.entered;
    const beforeConfirmation = f.events.filter((event) => event.kind === "restore");
    secondGate.release(); await second;
    expect(f.cached).toBe(3); expect(f.painted).toBe(3);
    // The first Undo never committed. The second may wait for authority or
    // correctly predict 3, but it must not use the failed cursor to paint 2.
    expect(beforeConfirmation.some((event) => event.generation === 2), JSON.stringify(beforeConfirmation)).toBe(false);
  });

  it("drains history rejection before a queued edit and the following Undo", async () => {
    const f = fixture(); await f.seed(3);
    const firstGate = gate(); const editGate = gate(); const lastGate = gate();
    f.holdHistory(firstGate); f.holdHistory(lastGate);
    const first = f.history("undo"); await firstGate.entered;
    const edit = f.edit(4, editGate); const last = f.history("undo");
    firstGate.release(new Error("first Undo refused"));
    await expect(first).rejects.toThrow("first Undo refused");
    await editGate.entered; expect(f.painted).toBe(3);
    editGate.release(); await edit; await lastGate.entered;
    expect(f.painted).toBe(3);
    lastGate.release(); await last;
    expect(f.cached).toBe(3); expect(f.painted).toBe(3);
    const redoGate = gate(); f.holdHistory(redoGate);
    const redo = f.history("redo"); expect(f.painted).toBe(4);
    redoGate.release(); await redo;
  });

  it("counts a second queued edit until it finishes, then restores eager history", async () => {
    const f = fixture(); await f.seed(3);
    const firstEditGate = gate(); const secondEditGate = gate(); const historyGate = gate();
    f.holdHistory(historyGate);
    const firstEdit = f.edit(4, firstEditGate); await firstEditGate.entered;
    const secondEdit = f.edit(5, secondEditGate);
    firstEditGate.release(); await firstEdit; await secondEditGate.entered;
    const undo = f.history("undo");
    expect(f.runtime.restoreGeneration).not.toHaveBeenCalled();
    secondEditGate.release(); await secondEdit; await historyGate.entered;
    expect(f.painted).toBe(4);
    historyGate.release(); await undo;
    const nextGate = gate(); f.holdHistory(nextGate);
    const next = f.history("undo"); expect(f.painted).toBe(3);
    nextGate.release(); await next;
    expect(f.cached).toBe(3); expect(f.painted).toBe(3);
  });

  it("falls back to authority if speculative runtime restore rejects", async () => {
    const f = fixture(); await f.seed(3);
    const editGate = gate(); const historyGate = gate(); f.holdHistory(historyGate);
    const edit = f.edit(4, editGate); await editGate.entered;
    const undo = f.history("undo");
    f.runtime.restoreGeneration.mockRejectedValueOnce(new Error("unknown runtime generation"));
    editGate.release(); await edit; await historyGate.entered;
    expect(f.painted).toBe(4);
    historyGate.release(); await undo;
    expect(f.cached).toBe(3); expect(f.painted).toBe(3);
    await f.edit(5); await f.history("undo");
    expect(f.cached).toBe(3); expect(f.painted).toBe(3);
  });

  it("keeps Personal and organization lanes independent across A to B to A", async () => {
    const a = fixture(PERSONAL); const b = fixture(ORG);
    await a.seed(3); await b.seed(3);
    const editGate = gate(); const aHistoryGate = gate(); a.holdHistory(aHistoryGate);
    const edit = a.edit(4, editGate); await editGate.entered;
    const aUndo = a.history("undo");
    const bHistoryGate = gate(); b.holdHistory(bHistoryGate);
    const bUndo = b.history("undo"); expect(b.painted).toBe(2);
    bHistoryGate.release(); await bUndo;
    expect(a.cached).toBe(3); expect(a.runtime.restoreGeneration).not.toHaveBeenCalled();
    editGate.release(); await edit; await aHistoryGate.entered;
    aHistoryGate.release(); await aUndo;
    expect(a.cached).toBe(3); expect(b.cached).toBe(2);
    const redo = a.history("redo"); expect(a.painted).toBe(4); await redo;
    expect(a.cached).toBe(4); expect(b.cached).toBe(2);
  });

  it("does not predict another directory's history when its frame catalog is identical", async () => {
    const f = fixture(); await f.seed(3);
    const replacement = workspaceSnapshot(PERSONAL, 3, "design-b");
    designWorkspaceSnapshotCache.setData(PERSONAL, replacement);
    observeDesignDirectory(PERSONAL, replacement);
    const replacementRuntime = {
      sourceVersion: version(3), supports: () => true,
      restoreGeneration: vi.fn().mockRejectedValue(new Error("No history in the replacement runtime")),
    };
    mocks.runtime.mockReturnValue(replacementRuntime);
    mocks.history.mockResolvedValue({ result: null, snapshot: replacement });
    const undo = f.history("undo");
    const speculativeCalls = replacementRuntime.restoreGeneration.mock.calls.slice();
    await undo;
    expect(speculativeCalls).toEqual([]);
    expect(f.cached).toBe(3);
  });

  it("rejects queued history and edit after a directory replacement and drains their counts", async () => {
    const f = fixture(); await f.seed(3);
    const edit = f.edit(4);
    const undo = f.history("undo");
    const replacement = workspaceSnapshot(PERSONAL, 3, "design-b");
    designWorkspaceSnapshotCache.setData(PERSONAL, replacement);
    observeDesignDirectory(PERSONAL, replacement);
    await expect(edit).rejects.toThrow("Design directory changed");
    await expect(undo).rejects.toThrow("Design directory changed");
    expect(mocks.history).not.toHaveBeenCalled();
    expect(f.runtime.restoreGeneration).not.toHaveBeenCalled();
    expect(f.cached).toBe(3);
    expect(useDesignWorkspaceUiStore.getState().byWorkspace[PERSONAL]?.directoryId).toBe("design-b");
    // Empty lane must settle even though both callbacks were refused.
    await waitForPendingDesignEdits(PERSONAL);
  });

  it("rejects the old queued history after directory change during an earlier RPC", async () => {
    const f = fixture(); await f.seed(3);
    const editGate = gate();
    const edit = f.edit(4, editGate); await editGate.entered;
    const first = f.history("undo"); const second = f.history("redo");
    const replacement = workspaceSnapshot(PERSONAL, 30, "design-b");
    designWorkspaceSnapshotCache.setData(PERSONAL, replacement);
    observeDesignDirectory(PERSONAL, replacement);
    // Model a rejected owner-pinned write, leaving the replacement authoritative.
    editGate.release(new Error("old directory write refused"));
    await expect(edit).rejects.toThrow("old directory write refused");
    await expect(first).rejects.toThrow("Design directory changed");
    await expect(second).rejects.toThrow("Design directory changed");
    expect(mocks.history).not.toHaveBeenCalled();
    expect(f.runtime.restoreGeneration).not.toHaveBeenCalled();
    expect(f.cached).toBe(30);
    // Re-enter a fresh owner and prove both edit and deferred-history counters
    // have drained by observing an immediate prediction for its first Undo.
    const fresh = fixture(PERSONAL); await fresh.seed(3);
    const nextGate = gate(); fresh.holdHistory(nextGate);
    const next = fresh.history("undo"); expect(fresh.painted).toBe(2);
    nextGate.release(); await next;
  });


  it("does not repaint the replacement directory while draining refused eager predictions", async () => {
    const f = fixture(); await f.seed(3);
    const firstGate = gate(); f.holdHistory(firstGate);
    const first = f.history("undo"); await firstGate.entered;
    const second = f.history("undo"); expect(f.painted).toBe(1);
    const replacement = workspaceSnapshot(PERSONAL, 3, "design-b");
    designWorkspaceSnapshotCache.setData(PERSONAL, replacement);
    observeDesignDirectory(PERSONAL, replacement);
    const replacementRestore = vi.fn();
    mocks.runtime.mockReturnValue({ ...f.runtime, restoreGeneration: replacementRestore });
    firstGate.release(new Error("old directory history refused"));
    await expect(first).rejects.toThrow("old directory history refused");
    await expect(second).rejects.toThrow("Design directory changed");
    expect(mocks.history).toHaveBeenCalledTimes(1);
    // The abandoned runtime is no longer this owner's presentation. Recovery
    // must neither paint its generation into B nor clear B's fresh journal.
    expect(replacementRestore).not.toHaveBeenCalled();
    expect(designWorkspaceSnapshotCache.peekSnapshot(PERSONAL).data).toBe(replacement);
    expect(f.events.filter((event) => event.kind === "restore").map((event) => event.generation)).toEqual([2, 1]);
  });

  it("reads cloud history preconditions inside the lane after the edit lands", async () => {
    // Compatibility cache path only. Cloud v2 still exposes no Design surface.
    const f = fixture(CLOUD); await f.seed(3);
    const snapshot = designWorkspaceSnapshotCache.peekSnapshot(CLOUD).data!;
    snapshot.frames.push({ ...snapshot.frames[0]!, file: "pricing.html", sourceVersion: version(99) });
    const originalEdit = f.engineEdit;
    f.engineEdit = async (input) => {
      const result = await originalEdit(input);
      result.snapshot.frames.push({ ...result.snapshot.frames[0]!, file: "pricing.html", sourceVersion: version(99) });
      return result;
    };
    const editGate = gate(); const historyGate = gate(); f.holdHistory(historyGate);
    const edit = f.edit(4, editGate); await editGate.entered;
    const undo = f.history("undo"); expect(mocks.history).not.toHaveBeenCalled();
    editGate.release(); await edit; await historyGate.entered;
    expect(mocks.history).toHaveBeenCalledWith(CLOUD, "home.html", "undo", { "home.html": version(4), "pricing.html": version(99) });
    historyGate.release(); await undo;
  });
});

describe("Design history exact-owner presentation", () => {
  it("predicts across legacy page normalization from a later navigation read", async () => {
    const f = fixture(); await f.seed(3);
    const snapshot = designWorkspaceSnapshotCache.peekSnapshot(PERSONAL).data!;
    // Legacy mutation replies omit pages; bridge navigation reads add the
    // synthetic main page. The same authored state must keep its inverse.
    designWorkspaceSnapshotCache.setData(PERSONAL, normalizeDesignPagesSnapshot(snapshot));
    const held = gate(); f.holdHistory(held);
    const undo = f.history("undo"); await held.entered;
    expect(f.painted).toBe(2);
    expect(f.cached).toBe(3);
    held.release(); await undo;
    expect(f.cached).toBe(2);
  });

  it("projects the predicted inspector values before the held authority reply without adopting them", async () => {
    const f = fixture(); await f.seed(3);
    const held = gate(); f.holdHistory(held);
    const undo = f.history("undo"); await held.entered;
    expect(designHistoryPresentation(PERSONAL)?.runtime.get("home.html")?.details.get("hero")?.styles.width).toBe("102px");
    expect(useDesignRuntimeStore.getState().byWorkspace[PERSONAL]?.frames["home.html"]?.detailsByNode.hero?.styles.width).toBe("103px");
    expect(f.cached).toBe(3);
    held.release(); await undo;
    expect(designHistoryPresentation(PERSONAL)).toBeNull();
  });
  it("does not let a completed old-directory edit overwrite the replacement before Undo", async () => {
    const f = fixture(); await f.seed(3);
    const replyGate = gate();
    const original = f.engineEdit;
    f.engineEdit = async (input) => { const result = await original(input); await replyGate.wait(); return result; };
    const edit = f.edit(4); await replyGate.entered;
    const replacement = workspaceSnapshot(PERSONAL, 30, "design-b");
    designWorkspaceSnapshotCache.setData(PERSONAL, replacement); observeDesignDirectory(PERSONAL, replacement);
    replyGate.release();
    await expect(edit).rejects.toThrow("Design directory changed");
    expect(designWorkspaceSnapshotCache.peekSnapshot(PERSONAL).data).toBe(replacement);
  });

  it("keeps workspace history valid when only the selected page changes", async () => {
    const f = fixture(); await f.seed(3);
    useDesignWorkspaceUiStore.getState().setActivePage(PERSONAL, "page-one", "design-a");
    const undo = f.history("undo");
    useDesignWorkspaceUiStore.getState().setActivePage(PERSONAL, "page-two", "design-a");
    await undo;
    expect(f.cached).toBe(2); expect(f.painted).toBe(2);
  });

  it("ignores a completed old-directory reply delivered after directory replacement", async () => {
    const f = fixture(); await f.seed(3);
    const replyGate = gate();
    mocks.history.mockImplementationOnce(async (_workspace: string, _frame: string, direction: Direction) => {
      const reply = await f.engineHistory(direction);
      // The old directory's write has already succeeded. Only its transport
      // response is delayed while the renderer adopts the replacement owner.
      await replyGate.wait();
      return reply;
    });
    const undo = f.history("undo"); await replyGate.entered;
    const replacement = workspaceSnapshot(PERSONAL, 30, "design-b");
    designWorkspaceSnapshotCache.setData(PERSONAL, replacement);
    observeDesignDirectory(PERSONAL, replacement);
    const replacementRuntime = {
      sourceVersion: version(30), supports: () => true, isActive: () => true,
      restoreGeneration: vi.fn().mockRejectedValue(new Error("Foreign generation")),
    };
    mocks.runtime.mockReturnValue(replacementRuntime);
    replyGate.release();
    await undo.catch(() => undefined);
    expect(replacementRuntime.restoreGeneration).not.toHaveBeenCalled();
    expect(designWorkspaceSnapshotCache.peekSnapshot(PERSONAL).data).toBe(replacement);
    expect(useDesignWorkspaceUiStore.getState().byWorkspace[PERSONAL]?.directoryId).toBe("design-b");
  });

  it("rejects a queued history intent after directory A to B to A", async () => {
    const f = fixture(); await f.seed(3);
    const undo = f.history("undo");
    const away = workspaceSnapshot(PERSONAL, 3, "design-b");
    designWorkspaceSnapshotCache.setData(PERSONAL, away);
    observeDesignDirectory(PERSONAL, away);
    const returned = workspaceSnapshot(PERSONAL, 3, "design-a");
    designWorkspaceSnapshotCache.setData(PERSONAL, returned);
    observeDesignDirectory(PERSONAL, returned);
    await expect(undo).rejects.toThrow("Design directory changed");
    expect(mocks.history).not.toHaveBeenCalled();
    expect(designWorkspaceSnapshotCache.peekSnapshot(PERSONAL).data).toBe(returned);
  });

  it("retains confirmed history data without painting a runtime hidden during the request", async () => {
    const f = fixture(); await f.seed(3);
    const historyGate = gate(); f.holdHistory(historyGate);
    const undo = f.history("undo"); await historyGate.entered;
    f.runtime.isActive = () => false;
    f.runtime.restoreGeneration.mockClear();
    historyGate.release(); await undo;
    expect(f.cached).toBe(2);
    expect(f.runtime.restoreGeneration).not.toHaveBeenCalled();
  });

  it("uses structural historyFrame metadata even when there is no document transaction receipt", async () => {
    const f = fixture(); await f.seed(3);
    const untrackedGeometry = workspaceSnapshot(PERSONAL, 3);
    untrackedGeometry.frames[0]!.x = 10;
    designWorkspaceSnapshotCache.setData(PERSONAL, untrackedGeometry);
    mocks.history.mockResolvedValueOnce({
      result: null, historyFrame: "home.html", snapshot: workspaceSnapshot(PERSONAL, 2),
    });
    await f.history("undo");
    expect(f.cached).toBe(2);
    expect(f.runtime.restoreGeneration).toHaveBeenCalledWith(version(2), true, undefined, []);
    expect(f.painted).toBe(2);
  });
});

function enablePendingHistoryPresentation(f: ReturnType<typeof fixture>) {
  let target: string | null = null;
  const commit = f.runtime.commitStyles.getMockImplementation()!;
  const restore = f.runtime.restoreGeneration.getMockImplementation()!;
  f.runtime.supports = method => method === "restoreGeneration" || method === "previewHistory";
  f.runtime.commitStyles.mockImplementation(async (...args) => {
    const result = await commit(...args);
    if (target) await restore(target, false);
    return result;
  });
  f.runtime.restoreGeneration.mockImplementation(async (source, confirmed) => {
    const result = await restore(source, confirmed);
    if (confirmed && target) await restore(target, false);
    return result;
  });
  const previewHistory = vi.fn(async (source: string | null) => {
    target = source;
    return restore(source ?? f.runtime.sourceVersion, false);
  });
  Object.assign(f.runtime, { previewHistory });
  return previewHistory;
}

describe("pending history with isolated runtime presentation", () => {
  it("bounds in-flight visual intent metadata across workspace owners", async () => {
    for (let index = 0; index < 17; index++) {
      const f = fixture(`/review/owner-${index}/project`);
      await f.seed(1); enablePendingHistoryPresentation(f);
      const held = gate(); f.holdHistory(held);
      f.history("undo"); await held.entered;
    }
    expect(designHistoryTransientStatsForTests().intentOwners).toBeLessThanOrEqual(16);
    expect(designHistoryTransientStatsForTests().intentBytes).toBeLessThanOrEqual(1024 * 1024);
  });
  it("keeps rapid Undo/Redo authority ordered with an isolated inverse", async () => {
    const f = fixture(); await f.seed(3); enablePendingHistoryPresentation(f);
    const held = gate(); f.holdHistory(held);
    const undo = f.history("undo"); await held.entered; expect(f.painted).toBe(2);
    const redo = f.history("redo"); expect(f.painted).toBe(3);
    held.release(); await Promise.all([undo, redo]);
    expect(f.cached).toBe(3); expect(f.painted).toBe(3);
    expect(designHistoryPresentation(PERSONAL)).toBeNull();
  });
  it("clears a refused inverse on the same retained port after it becomes hidden", async () => {
    const f = fixture(); await f.seed(3); const preview = enablePendingHistoryPresentation(f);
    const held = gate(); f.holdHistory(held);
    const undo = f.history("undo"); await held.entered; expect(f.painted).toBe(2);
    f.runtime.isActive = () => false;
    held.release(new Error("history refused")); await expect(undo).rejects.toThrow("history refused");
    expect(preview).toHaveBeenLastCalledWith(null);
    expect(f.runtime.getNodeDetails).not.toHaveBeenCalled();
    expect(f.painted).toBe(3); expect(f.cached).toBe(3);
  });

  it("paints Undo while a style write is held and keeps confirmed inspector data authoritative", async () => {
    const f = fixture(); await f.seed(3); const preview = enablePendingHistoryPresentation(f);
    const heldEdit = gate(), heldHistory = gate(); f.holdHistory(heldHistory);
    const edit = f.edit(4, heldEdit); await heldEdit.entered;
    await f.runtime.restoreGeneration(version(4), false); // gesture preview
    const undo = f.history("undo");
    expect(preview).toHaveBeenCalledWith(version(3), []);
    expect(f.painted).toBe(3); expect(f.currentEngine()).toBe(3);
    heldEdit.release(); await edit; await heldHistory.entered;
    expect(f.cached).toBe(4); expect(f.painted).toBe(3);
    expect(useDesignRuntimeStore.getState().byWorkspace[PERSONAL]?.frames["home.html"]?.detailsByNode.hero?.styles.width).toBe("104px");
    heldHistory.release(); await undo; expect(f.cached).toBe(3); expect(f.painted).toBe(3);
  });

  it("keeps the second pending Undo painted as the edit and first Undo confirm", async () => {
    const f = fixture(); await f.seed(3); enablePendingHistoryPresentation(f);
    const heldEdit = gate(), heldFirst = gate(), heldSecond = gate(); f.holdHistory(heldFirst); f.holdHistory(heldSecond);
    const edit = f.edit(4, heldEdit); await heldEdit.entered;
    const first = f.history("undo"); expect(f.painted).toBe(3);
    const second = f.history("undo"); expect(f.painted).toBe(2);
    heldEdit.release(); await edit; await heldFirst.entered; expect(f.painted).toBe(2);
    heldFirst.release(); await first; await heldSecond.entered; expect(f.painted).toBe(2); expect(f.cached).toBe(3);
    heldSecond.release(); await second; expect(f.cached).toBe(2); expect(f.painted).toBe(2);
  });

  it("preserves a mixed pending edit, Undo, edit, Undo chain", async () => {
    const f = fixture(); await f.seed(3); enablePendingHistoryPresentation(f);
    const held = gate(); const firstEdit = f.edit(4, held); await held.entered;
    const firstUndo = f.history("undo"); const secondEdit = f.edit(5); const secondUndo = f.history("undo");
    expect(f.painted).toBe(3);
    held.release(); await Promise.all([firstEdit, firstUndo, secondEdit, secondUndo]);
    expect(f.cached).toBe(3); expect(f.painted).toBe(3);
    expect(designHistoryPresentation(PERSONAL)).toBeNull();
  });

  it("corrects an early inverse if its pending edit is refused", async () => {
    const f = fixture(); await f.seed(3); enablePendingHistoryPresentation(f);
    const held = gate(); const edit = f.edit(4, held); await held.entered;
    const undo = f.history("undo"); expect(f.painted).toBe(3);
    held.release(new Error("edit refused")); await expect(edit).rejects.toThrow("edit refused"); await undo;
    expect(f.cached).toBe(2); expect(f.painted).toBe(2);
  });
});
