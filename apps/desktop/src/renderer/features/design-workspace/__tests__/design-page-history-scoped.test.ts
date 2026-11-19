// Undo/Redo replies prepare only the frames they restore. The renderer must
// still select and reveal a page frame it has only described.
import { afterEach, describe, expect, it, vi } from "vitest";

const platformMocks = vi.hoisted(() => ({
  history: vi.fn(),
  readSnapshot: vi.fn(),
  readNavigation: vi.fn(async () => null),
  setRuntimeAudit: vi.fn(),
  setSelection: vi.fn(async () => {}),
}));

vi.mock("../../../platform/git", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../platform/git")>()),
  designHistory: platformMocks.history,
  designSnapshot: platformMocks.readSnapshot,
  designSetRuntimeAudit: platformMocks.setRuntimeAudit,
  designSetSelection: platformMocks.setSelection,
}));
vi.mock("../../../platform/bridge/design-frame-runtime", () => ({ designFrameRuntime: vi.fn(() => null) }));
vi.mock("../../../platform/bridge/active-bridge", () => ({
  getActiveBridge: () => null,
  onActiveBridgeConnected: vi.fn(() => () => {}),
}));
vi.mock("../state/design-workspace-preparation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/design-workspace-preparation")>()),
  readDesignNavigation: platformMocks.readNavigation,
}));

import type { DesignWorkspaceSnapshotWire } from "../../../platform/git";
import { applyDesignHistoryCached, designWorkspaceSnapshotCache, resetDesignWorkspaceCacheForTests } from "../state/design-workspace-cache";
import { restoreDesignPageHistorySelection } from "../state/design-page-history";
import { bindDesignWorkspacePages, captureDesignPageOwner, designWorkspaceView, resetDesignWorkspaceUiForTests, useDesignWorkspaceUiStore } from "../state/design-workspace-ui";
import { resetDesignSelectionWorkflowsForTests } from "../state/design-selection";
import { designCanvasItemOwner, designCanvasItemSelection, setDesignCanvasItemSelection } from "../state/design-canvas-item-selection";

const DIR = "design-a";
const version = (n: number) => `${n}`.padStart(24, "0");
type Geo = { file: string; id: string; title: string; x: number };
const A: Geo = { file: "a.html", id: "frame-a", title: "A", x: 0 };          // page's first frame, far away
const B: Geo = { file: "b.html", id: "frame-b", title: "B", x: 40_000 };     // the frame the user works on
const COPY: Geo = { file: "b-copy.html", id: "frame-copy", title: "B copy", x: 41_600 };
const prepared = (g: Geo, n: number) => ({ file: g.file, frameId: g.id, pageId: "page", title: g.title, kind: "frame" as const,
  x: g.x, y: 0, width: 1440, height: 900, z: n, nodeCount: 1, modifiedAt: 10, sourceVersion: version(n + 1) });
const description = (g: Geo, n: number) => ({ preparation: "unprepared" as const, file: g.file, frameId: g.id, pageId: "page",
  title: g.title, kind: "frame" as const, x: g.x, y: 0, width: 1440, height: 900, z: n });
const catalogRow = (g: Geo, n: number) => ({ source: g.file, id: g.id, pageId: "page", title: g.title, kind: "html" as const,
  x: g.x, y: 0, width: 1440, height: 900, z: n, order: n });
const page = (frames: Geo[]) => ({ id: "page", title: "Page", folder: "", frameFiles: frames.map(f => f.file), frameIds: frames.map(f => f.id) });
const base = () => ({ directoryId: DIR, directory: "Design", protocolCapability: "c".repeat(64), tokens: [], tokenSourceVersion: "tokens-generation-000001",
  assets: [], lint: { workspacePath: "/work/design", checkedFiles: [], violations: [], healedOids: 0 } });

/** A lazy Local workspace after Cmd+D on B: B and its copy are prepared, the
 * page's first frame A is described but never prepared. */
function lazyCache(): DesignWorkspaceSnapshotWire {
  return { ...base(), pages: [page([A, B, COPY])], frames: [prepared(B, 1), prepared(COPY, 2)],
    preparation: { revision: "a".repeat(64), epoch: 7, current: [B.file, COPY.file], errors: {},
      descriptions: [description(A, 0), description(B, 1), description(COPY, 2)] } } as unknown as DesignWorkspaceSnapshotWire;
}
/** The engine's scoped reply to undoing the copy: nothing is prepared and
 * the page's first frame is the selection. */
const scopedReply = () => ({ result: null, historySelection: A.file, historyFrame: COPY.file,
  snapshot: { ...base(), pages: [page([A, B])], frames: [], mutationCatalog: { revision: "b".repeat(64), frames: [catalogRow(A, 0), catalogRow(B, 1)] } } });
function seed(workspaceId: string) {
  designWorkspaceSnapshotCache.setData(workspaceId, lazyCache());
  bindDesignWorkspacePages(workspaceId, DIR, [page([A, B, COPY])]);
  useDesignWorkspaceUiStore.getState().setSelection(workspaceId, COPY.file, null, undefined, { frameSelected: true });
}

afterEach(() => {
  resetDesignWorkspaceCacheForTests();
  resetDesignWorkspaceUiForTests();
  resetDesignSelectionWorkflowsForTests();
  platformMocks.history.mockReset();
  setDesignCanvasItemSelection("test", null);
});

describe("Undo in a lazily prepared Local workspace", () => {
  it.each(["personal-local", "org-local"])("selects the page's unprepared first frame after a scoped reply (%s)", async (workspaceId) => {
    seed(workspaceId);
    platformMocks.history.mockResolvedValue(scopedReply());
    const owner = captureDesignPageOwner(workspaceId);
    const result = await applyDesignHistoryCached(workspaceId, COPY.file, "undo");
    expect(result.snapshot!.frames.map((frame) => frame.file)).not.toContain(A.file);

    await restoreDesignPageHistorySelection(workspaceId, owner, result, "undo");

    const view = designWorkspaceView(workspaceId);
    expect(view.selectedFrame).toBe(A.file);
    expect(view.frameSelected).toBe(true);
  });

  it("reveals the item's page and restores generation-sensitive selection across undo and redo", async () => {
    const workspaceId = "personal-items";
    const note = { id: "note_1", kind: "note" as const, x: 0, y: 0, width: 200, height: 100, text: "Note" };
    const pagesWithout = [
      { id: "a", title: "A", folder: "a", frameFiles: [], frameIds: [], items: [] },
      { id: "b", title: "B", folder: "b", frameFiles: [], frameIds: [], items: [] },
    ];
    const pagesWith = [pagesWithout[0]!, { ...pagesWithout[1]!, items: [note] }];
    designWorkspaceSnapshotCache.setData(workspaceId, { ...base(), pages: pagesWithout, frames: [] });
    bindDesignWorkspacePages(workspaceId, DIR, pagesWithout);
    const itemOwner = designCanvasItemOwner(workspaceId, DIR, "b");
    const restoreItem = (itemId: string | null) => setDesignCanvasItemSelection(itemOwner, itemId);

    platformMocks.history.mockResolvedValueOnce({ result: null, historyPageId: "b", historyItemId: note.id, historySelection: null,
      snapshot: { ...base(), pages: pagesWith, frames: [] } });
    const undoOwner = captureDesignPageOwner(workspaceId);
    const undo = await applyDesignHistoryCached(workspaceId, null, "undo");
    await restoreDesignPageHistorySelection(workspaceId, undoOwner, undo, "undo", restoreItem);
    expect(designWorkspaceView(workspaceId).activePageId).toBe("b");
    expect(designWorkspaceView(workspaceId).frameSelected).toBe(false);
    expect(designCanvasItemSelection(itemOwner)).toBe(note.id);

    useDesignWorkspaceUiStore.getState().setActivePage(workspaceId, "a", DIR);
    platformMocks.history.mockResolvedValueOnce({ result: null, historyPageId: "b", historyItemId: null, historySelection: null,
      snapshot: { ...base(), pages: pagesWithout, frames: [] } });
    const redoOwner = captureDesignPageOwner(workspaceId);
    const redo = await applyDesignHistoryCached(workspaceId, null, "redo");
    await restoreDesignPageHistorySelection(workspaceId, redoOwner, redo, "redo", restoreItem);
    expect(designWorkspaceView(workspaceId).activePageId).toBe("b");
    expect(designCanvasItemSelection(itemOwner)).toBeNull();
  });
});
