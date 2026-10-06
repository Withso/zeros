import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesignTransaction } from "@zeros/design-core";
import {
  EMPTY_DESIGN_FRAME_DISCLOSURE,
  designFrameDisclosure,
  requestDesignLayerReveal,
  settleDesignLayerReveal,
  toggleDesignFrameTreeExpanded,
  useDesignLayerDisclosureStore,
} from "../state/design-layer-disclosure";

const platformMocks = vi.hoisted(() => ({
  applyTransaction: vi.fn(),
  foundationOpen: vi.fn(),
  frame: vi.fn(),
  history: vi.fn(),
  readSnapshot: vi.fn(),
  setRuntimeAudit: vi.fn(),
  setSelection: vi.fn(),
  updateToken: vi.fn(),
  updateCanvas: vi.fn(),
  updateStyles: vi.fn(),
  writeHtml: vi.fn(),
  createFrame: vi.fn(),
  duplicateFrame: vi.fn(),
  createPage: vi.fn(),
  renamePage: vi.fn(),
  deletePage: vi.fn(),
  uploadAsset: vi.fn(),
}));

const runtimeMocks = vi.hoisted(() => ({
  designFrameRuntime: vi.fn(),
  commitStyles: vi.fn(),
}));

const bridgeMocks = vi.hoisted(() => ({
  connectedListener: null as
    | ((client: unknown, info: { initial: boolean }) => void)
    | null,
}));

vi.mock("../../../platform/git", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../platform/git")>()),
  designApplyTransaction: platformMocks.applyTransaction,
  designFoundationOpen: platformMocks.foundationOpen,
  designFrame: platformMocks.frame,
  designHistory: platformMocks.history,
  designSnapshot: platformMocks.readSnapshot,
  designSetRuntimeAudit: platformMocks.setRuntimeAudit,
  designSetSelection: platformMocks.setSelection,
  designUpdateToken: platformMocks.updateToken,
  designUpdateCanvas: platformMocks.updateCanvas,
  designUpdateStyles: platformMocks.updateStyles,
  designWriteHtml: platformMocks.writeHtml,
  designCreateFrame: platformMocks.createFrame,
  designDuplicateFrame: platformMocks.duplicateFrame,
  designCreatePage: platformMocks.createPage,
  designRenamePage: platformMocks.renamePage,
  designDeletePage: platformMocks.deletePage,
  designUploadAsset: platformMocks.uploadAsset,
}));

vi.mock("../../../platform/bridge/design-frame-runtime", () => ({
  designFrameRuntime: runtimeMocks.designFrameRuntime,
}));

vi.mock("../../../platform/bridge/active-bridge", () => ({
  onActiveBridgeConnected: vi.fn(
    (listener: (client: unknown, info: { initial: boolean }) => void) => {
      bridgeMocks.connectedListener = listener;
      return () => {};
    },
  ),
}));

import type {
  DesignFoundationOpenWire,
  DesignWorkspaceSnapshotWire,
} from "../../../platform/git";
import {
  applyDesignWorkspaceRefreshVersion,
  appendDesignNodeHtmlCached,
  applyDesignHistoryCached,
  applyDesignEditCached,
  applyDesignTransactionCached,
  designFrameDocumentCache,
  designFrameDocumentKey,
  designFoundationCache,
  designFoundationKey,
  designWorkspaceSnapshotCache,
  fetchDesignWorkspaceSnapshot,
  fetchDesignFoundation,
  invalidateDesignWorkspaceSnapshot,
  observeDesignDirectory,
  reconcileDesignWorkspaceRuntimeAudit,
  refreshDesignWorkspaceSnapshot,
  resetDesignWorkspaceCacheForTests,
  stabilizeDesignWorkspaceSnapshot,
  updateDesignNodeStylesCached,
  updateDesignTokenCached,
  updateDesignFrameGeometryCached,
  warmDesignFrameDocument,
  createDesignFrameAndRefresh,
  duplicateDesignFrameCached,
  createDesignPageCached,
  renameDesignPageCached,
  deleteDesignPageCached,
  uploadDesignAssetCached,
} from "../state/design-workspace-cache";
import {
  designWorkspaceSnapshotMatchesPath,
  safeDesignWorkspaceBootSnapshot,
} from "../state/design-workspace-boot-cache";
import { presentDesignWorkspaceSnapshotRead } from "../state/use-design-workspace";
import {
  designRuntimeFrameState,
  resetDesignRuntimeStoreForTests,
  useDesignRuntimeStore,
} from "../state/design-runtime-store";
import {
  designLivePreviewValue,
  publishDesignLivePreviewStyles,
  resetDesignLivePreviewForTests,
} from "../state/design-live-preview";
import {
  resetDesignWorkspaceUiForTests,
  useDesignWorkspaceUiStore,
} from "../state/design-workspace-ui";
import { resetDesignSelectionWorkflowsForTests } from "../state/design-selection";

function snapshot(
  frames: Array<{ file: string; x?: number }> = [{ file: "home.html" }],
): DesignWorkspaceSnapshotWire {
  return {
    protocolCapability: "c".repeat(64),
    frames: frames.map(({ file, x = 0 }, index) => ({
      file,
      title: file.replace(".html", ""),
      width: 1440,
      height: 900,
      x,
      y: 0,
      z: index,
      nodeCount: 1,
      modifiedAt: 10,
      sourceVersion: `${index}`.padStart(24, "0"),
    })),
    tokens: [
      {
        name: "--accent",
        syntax: "<color>",
        inherits: true,
        initialValue: "blue",
        value: "blue",
        themeValues: { dark: "deepskyblue" },
        usageCount: 1,
        line: 1,
      },
    ],
    tokenSourceVersion: "tokens-generation-000001",
    assets: [
      {
        path: "assets/mark.png",
        name: "mark.png",
        mimeType: "image/png",
        size: 4,
        modifiedAt: 10,
        dataUrl: "data:image/png;base64,iVBORw==",
      },
    ],
    lint: {
      workspacePath: "/work/design",
      checkedFiles: frames.map((frame) => frame.file),
      violations: [],
      healedOids: 0,
    },
  };
}

describe("design workspace cache", () => {
  it("retains identical catalogs but publishes changed registered IDs even without rendered frames", () => {
    const previous = { ...snapshot([]), pages: [{ id: "a", title: "A", folder: "a", frameFiles: ["a/missing.html"], frameIds: ["before"] }] };
    expect(stabilizeDesignWorkspaceSnapshot(previous, structuredClone(previous))).toBe(previous);
    const changed = { ...previous, pages: [{ ...previous.pages[0], frameIds: ["after"] }] };
    const published = stabilizeDesignWorkspaceSnapshot(previous, changed);
    expect(published.pages).not.toBe(previous.pages);
    expect(published.pages?.[0]).toBe(changed.pages[0]);
    expect(safeDesignWorkspaceBootSnapshot(previous)?.pages).toEqual(previous.pages);
  });
  it("forwards the submitted page through frame creation and duplicate without a read", async () => {
    const result = { frame: snapshot().frames[0], snapshot: snapshot() };
    platformMocks.createFrame.mockResolvedValue(result);
    platformMocks.duplicateFrame.mockResolvedValue(result);
    await createDesignFrameAndRefresh("workspace-a", "Home", undefined, undefined, "a");
    await duplicateDesignFrameCached("workspace-a", "a/home.html", "a");
    expect(platformMocks.createFrame).toHaveBeenCalledWith("workspace-a", "Home", undefined, undefined, "a");
    expect(platformMocks.duplicateFrame).toHaveBeenCalledWith("workspace-a", "a/home.html", "a");
    expect(platformMocks.readSnapshot).not.toHaveBeenCalled();
  });

  it("publishes confirmed page lifecycle replies without a second snapshot request", async () => {
    const page = { id: "a", title: "A", folder: "a", frameFiles: [], frameIds: [] };
    platformMocks.createPage.mockResolvedValue({ page, snapshot: { ...snapshot(), pages: [page] } });
    platformMocks.renamePage.mockResolvedValue({ page: { ...page, title: "New" }, snapshot: { ...snapshot(), pages: [{ ...page, title: "New" }] } });
    platformMocks.deletePage.mockResolvedValue({ snapshot: snapshot() });
    expect((await createDesignPageCached("workspace-a")).page).toBe(page);
    await renameDesignPageCached("workspace-a", "a", "New");
    await deleteDesignPageCached("workspace-a", "a", ["registered_missing"]);
    expect(platformMocks.deletePage).toHaveBeenCalledWith("workspace-a", "a", ["registered_missing"]);
    expect(platformMocks.readSnapshot).not.toHaveBeenCalled();
  });

  beforeEach(() => {
    platformMocks.applyTransaction.mockReset();
    platformMocks.foundationOpen.mockReset();
    platformMocks.frame.mockReset();
    platformMocks.history.mockReset();
    platformMocks.readSnapshot.mockReset();
    platformMocks.setRuntimeAudit.mockReset();
    platformMocks.setSelection.mockReset().mockResolvedValue(undefined);
    platformMocks.updateToken.mockReset();
    platformMocks.updateCanvas.mockReset();
    platformMocks.updateStyles.mockReset();
    platformMocks.writeHtml.mockReset();
    platformMocks.uploadAsset.mockReset();
    runtimeMocks.designFrameRuntime.mockReset();
    runtimeMocks.commitStyles.mockReset();
    resetDesignWorkspaceCacheForTests();
    resetDesignRuntimeStoreForTests();
    resetDesignLivePreviewForTests();
    resetDesignWorkspaceUiForTests();
    resetDesignSelectionWorkflowsForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("never routes a Local upload or replays an uncertain cloud upload", async () => {
    const input = { directoryId: "design_fixture", frame: "home.html", sourceVersion: "a".repeat(24),
      name: "pixel.png", mimeType: "image/png" as const, data: "image", x: 0, y: 0 };
    await expect(uploadDesignAssetCached("ws_local", input)).rejects.toThrow(/cloud/);
    expect(platformMocks.uploadAsset).not.toHaveBeenCalled();
    platformMocks.uploadAsset.mockRejectedValue(new Error("Request timeout: WORKSPACE_REQUEST"));
    await expect(uploadDesignAssetCached("cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222", input)).rejects.toThrow(/timeout/);
    expect(platformMocks.uploadAsset).toHaveBeenCalledTimes(1);
    expect(platformMocks.readSnapshot).not.toHaveBeenCalled();
  });

  describe("edits with asynchronous document metadata", () => {
    const workspaceId = "ws_loading_edit";
    const draft = (): Omit<
      DesignTransaction,
      "documentId" | "baseRevision"
    > => ({
      schemaVersion: 1,
      transactionId: "desktop:loading-edit",
      actor: { kind: "human", id: "desktop" },
      intent: "Align selected layers",
      createdAt: 1,
      operations: ["heading", "copy"].map((nodeId) => ({
        operationId: `align:${nodeId}`,
        type: "node.set-styles",
        nodeId,
        styles: { left: "20px" },
        scope: "auto",
        responsiveContext: "base",
        stateContext: "default",
      })),
    });
    const opened = (
      documentId: string,
      revision: string,
    ): DesignFoundationOpenWire => ({
      summary: {
        apiVersion: 1,
        documentId,
        revision,
        entryFile: "home.html",
        fileCount: 1,
        nodeCount: 2,
        valid: true,
        diagnostics: [],
        lastValidRevision: revision,
        history: {
          canUndo: false,
          canRedo: false,
          undoDepth: 0,
          redoDepth: 0,
          retainedBytes: 0,
          retainedReceiptBytes: 0,
          revision,
          lastReconciliationReason: null,
        },
      },
      foundation: {
        documentId,
        revision,
        manifest: {
          schemaVersion: 1,
          parameters: [],
          variants: [],
          components: [],
        },
        keyframes: [],
      },
    });

    it("joins the exact in-flight document read before committing the original targets once", async () => {
      const current = snapshot([
        { file: "home.html" },
        { file: "pricing.html" },
      ]);
      const frame = current.frames[0]!;
      const key = designFoundationKey(
        workspaceId,
        frame.file,
        frame.sourceVersion,
      );
      designWorkspaceSnapshotCache.setData(workspaceId, current);
      designFoundationCache.setData(
        designFoundationKey(
          workspaceId,
          "pricing.html",
          current.frames[1]!.sourceVersion,
        ),
        opened("document:pricing", "pricing:1"),
      );
      let finishRead!: (value: DesignFoundationOpenWire) => void;
      platformMocks.foundationOpen.mockReturnValue(
        new Promise((resolve) => {
          finishRead = resolve;
        }),
      );
      platformMocks.applyTransaction.mockResolvedValue({ result: null });
      const projection = designFoundationCache.load(key, () =>
        fetchDesignFoundation(key),
      );
      const intent = draft();
      const edit = applyDesignEditCached(workspaceId, frame, intent);

      await vi.waitFor(() =>
        expect(platformMocks.foundationOpen).toHaveBeenCalledTimes(1),
      );
      expect(platformMocks.applyTransaction).not.toHaveBeenCalled();
      expect(designFoundationCache.getSnapshot(key).data).toBeUndefined();
      finishRead(opened("document:home", "home:1"));
      await Promise.all([projection, edit]);

      expect(platformMocks.foundationOpen).toHaveBeenCalledExactlyOnceWith(
        workspaceId,
        "home.html",
      );
      expect(platformMocks.applyTransaction).toHaveBeenCalledExactlyOnceWith(
        workspaceId,
        "home.html",
        {
          ...intent,
          documentId: "document:home",
          baseRevision: "home:1",
        },
      );
    });

    it("builds a queued edit from the geometry the preceding edit confirmed", async () => {
      const current = snapshot();
      const frame = current.frames[0]!;
      designWorkspaceSnapshotCache.setData(workspaceId, current);
      designFoundationCache.setData(
        designFoundationKey(workspaceId, frame.file, frame.sourceVersion),
        opened("document:home", "home:1"),
      );
      const widened = {
        ...current,
        frames: [{ ...frame, width: 1_600, sourceVersion: "a".repeat(24) }],
      };
      platformMocks.foundationOpen.mockResolvedValue(
        opened("document:home", "home:2"),
      );
      let finishFirst!: () => void;
      platformMocks.applyTransaction
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finishFirst = () => resolve({ result: null, snapshot: widened });
            }),
        )
        .mockResolvedValueOnce({ result: null, snapshot: widened });
      // W and H commit back to back, before the first save replies. Each edit
      // merges only its own axis into the frame the lane has confirmed.
      const resize = (key: "width" | "height", value: number) => () => {
        const latest = designWorkspaceSnapshotCache
          .peekSnapshot(workspaceId)
          .data!.frames.find((candidate) => candidate.file === frame.file)!;
        return {
          ...draft(),
          operations: [
            {
              operationId: `geometry:${key}`,
              type: "frame.set-geometry" as const,
              frame: frame.file,
              geometry: {
                x: latest.x,
                y: latest.y,
                z: latest.z,
                width: latest.width,
                height: latest.height,
                [key]: value,
              },
            },
          ],
        };
      };
      const first = applyDesignEditCached(
        workspaceId,
        frame,
        resize("width", 1_600),
      );
      const second = applyDesignEditCached(
        workspaceId,
        frame,
        resize("height", 1_000),
      );
      await vi.waitFor(() =>
        expect(platformMocks.applyTransaction).toHaveBeenCalledTimes(1),
      );
      finishFirst();
      await Promise.all([first, second]);
      expect(
        platformMocks.applyTransaction.mock.calls[1]![2].operations[0].geometry,
      ).toMatchObject({ width: 1_600, height: 1_000 });
    });

    it("keeps a metadata wait ahead of Undo in the workspace mutation lane", async () => {
      const current = snapshot();
      const frame = current.frames[0]!;
      designWorkspaceSnapshotCache.setData(workspaceId, current);
      let finishRead!: (value: DesignFoundationOpenWire) => void;
      platformMocks.foundationOpen.mockReturnValue(
        new Promise((resolve) => {
          finishRead = resolve;
        }),
      );
      const operations: string[] = [];
      platformMocks.applyTransaction.mockImplementation(async () => {
        operations.push("edit");
        return { result: null, snapshot: current };
      });
      platformMocks.history.mockImplementation(async () => {
        operations.push("undo");
        return { result: null, snapshot: current };
      });

      const edit = applyDesignEditCached(workspaceId, frame, draft());
      const undo = applyDesignHistoryCached(workspaceId, frame.file, "undo");
      await vi.waitFor(() =>
        expect(platformMocks.foundationOpen).toHaveBeenCalledTimes(1),
      );
      expect(platformMocks.history).not.toHaveBeenCalled();
      finishRead(opened("document:home", "home:1"));
      await Promise.all([edit, undo]);
      expect(operations).toEqual(["edit", "undo"]);
    });

    it("isolates same-named files in another workspace without blocking its ready edit", async () => {
      const current = snapshot();
      const frame = current.frames[0]!;
      const otherWorkspaceId = "ws_other_edit";
      for (const owner of [workspaceId, otherWorkspaceId])
        designWorkspaceSnapshotCache.setData(owner, current);
      designFoundationCache.setData(
        designFoundationKey(otherWorkspaceId, frame.file, frame.sourceVersion),
        opened("document:other", "other:1"),
      );
      let finishRead!: (value: DesignFoundationOpenWire) => void;
      platformMocks.foundationOpen.mockReturnValue(
        new Promise((resolve) => {
          finishRead = resolve;
        }),
      );
      platformMocks.applyTransaction.mockResolvedValue({ result: null });
      const pending = applyDesignEditCached(workspaceId, frame, draft());
      await applyDesignEditCached(otherWorkspaceId, frame, draft());
      expect(platformMocks.applyTransaction).toHaveBeenCalledExactlyOnceWith(
        otherWorkspaceId,
        frame.file,
        expect.objectContaining({
          documentId: "document:other",
          baseRevision: "other:1",
        }),
      );
      finishRead(opened("document:home", "home:1"));
      await pending;
      expect(platformMocks.applyTransaction).toHaveBeenLastCalledWith(
        workspaceId,
        frame.file,
        expect.objectContaining({
          documentId: "document:home",
          baseRevision: "home:1",
        }),
      );
      expect(platformMocks.foundationOpen).toHaveBeenCalledExactlyOnceWith(
        workspaceId,
        frame.file,
      );
    });

    it("opens the generation confirmed by a preceding style edit instead of a captured old projection", async () => {
      const current = snapshot();
      const frame = current.frames[0]!;
      const next = {
        ...current,
        frames: [{ ...frame, sourceVersion: "a".repeat(24) }],
      };
      designWorkspaceSnapshotCache.setData(workspaceId, current);
      designFoundationCache.setData(
        designFoundationKey(workspaceId, frame.file, frame.sourceVersion),
        opened("document:home", "home:1"),
      );
      platformMocks.updateStyles.mockResolvedValue({
        mutation: {
          changed: true,
          frame: {
            ...next.frames[0],
            source: "<main></main>",
            srcDoc: "<main></main>",
            tree: [],
          },
          lint: next.lint,
        },
        snapshot: next,
        foundationRevision: { before: "home:1", after: "home:2" },
      });
      platformMocks.foundationOpen.mockResolvedValue(
        opened("document:home", "home:2"),
      );
      platformMocks.applyTransaction.mockResolvedValue({ result: null });

      await Promise.all([
        updateDesignNodeStylesCached(workspaceId, {
          frame: frame.file,
          nodeId: "hero",
          sourceVersion: frame.sourceVersion,
          styles: { width: "320px" },
        }),
        applyDesignEditCached(workspaceId, frame, draft()),
      ]);

      expect(platformMocks.applyTransaction).toHaveBeenCalledExactlyOnceWith(
        workspaceId,
        frame.file,
        expect.objectContaining({ baseRevision: "home:2" }),
      );
      expect(platformMocks.foundationOpen).toHaveBeenCalledTimes(1);
      expect(
        designFoundationCache.getSnapshot(
          designFoundationKey(
            workspaceId,
            frame.file,
            next.frames[0]!.sourceVersion,
          ),
        ).data?.summary.revision,
      ).toBe("home:2");
    });

    it("reuses a warm exact projection without introducing another read", async () => {
      const frame = snapshot().frames[0]!;
      designFoundationCache.setData(
        designFoundationKey(workspaceId, frame.file, frame.sourceVersion),
        opened("document:home", "home:1"),
      );
      platformMocks.applyTransaction.mockResolvedValue({ result: null });
      await applyDesignEditCached(workspaceId, frame, draft());
      expect(platformMocks.foundationOpen).not.toHaveBeenCalled();
      expect(platformMocks.applyTransaction).toHaveBeenCalledTimes(1);
    });

    it("reports a real metadata failure without writing and allows the next edit to recover", async () => {
      const frame = snapshot().frames[0]!;
      platformMocks.foundationOpen
        .mockRejectedValueOnce(new Error("Document read failed."))
        .mockResolvedValue(opened("document:home", "home:1"));
      platformMocks.applyTransaction.mockResolvedValue({ result: null });
      await expect(
        applyDesignEditCached(workspaceId, frame, draft()),
      ).rejects.toThrow("Document read failed.");
      expect(platformMocks.applyTransaction).not.toHaveBeenCalled();
      await applyDesignEditCached(workspaceId, frame, draft());
      expect(platformMocks.foundationOpen).toHaveBeenCalledTimes(2);
      expect(platformMocks.applyTransaction).toHaveBeenCalledTimes(1);
    });

    it("does not replay a write with an ambiguous transport failure after metadata becomes ready", async () => {
      const frame = snapshot().frames[0]!;
      platformMocks.foundationOpen.mockResolvedValue(
        opened("document:home", "home:1"),
      );
      platformMocks.applyTransaction.mockRejectedValue(
        new Error("Request timeout: WORKSPACE_REQUEST"),
      );
      await expect(
        applyDesignEditCached(workspaceId, frame, draft()),
      ).rejects.toThrow("Request timeout: WORKSPACE_REQUEST");
      expect(platformMocks.applyTransaction).toHaveBeenCalledTimes(1);
      expect(platformMocks.readSnapshot).not.toHaveBeenCalled();
    });
  });

  it("does not supersede a cold snapshot already queued for the first bridge connection", async () => {
    const workspaceId = "ws_cold_bridge_connect";
    let finishFirstRead: (value: DesignWorkspaceSnapshotWire) => void = () => {
      throw new Error("The first Design snapshot read did not start.");
    };
    platformMocks.readSnapshot
      .mockImplementationOnce(
        () =>
          new Promise<DesignWorkspaceSnapshotWire>((resolve) => {
            finishFirstRead = resolve;
          }),
      )
      .mockResolvedValue(snapshot());

    const first = designWorkspaceSnapshotCache.load(workspaceId, () =>
      platformMocks.readSnapshot(workspaceId),
    );
    await vi.waitFor(() => {
      expect(platformMocks.readSnapshot).toHaveBeenCalledTimes(1);
    });

    bridgeMocks.connectedListener?.({} as never, { initial: false });
    const observedInvalidation = designWorkspaceSnapshotCache.load(
      workspaceId,
      () => platformMocks.readSnapshot(workspaceId),
    );
    finishFirstRead(snapshot());

    await Promise.all([first, observedInvalidation]);

    expect(platformMocks.readSnapshot).toHaveBeenCalledTimes(1);
    expect(
      designWorkspaceSnapshotCache.peekSnapshot(workspaceId).data,
    ).toBeDefined();
  });

  it("recovers a cold idempotent snapshot read from one transient engine timeout", async () => {
    const expected = snapshot();
    platformMocks.readSnapshot
      .mockRejectedValueOnce(new Error("Request timeout: WORKSPACE_REQUEST"))
      .mockResolvedValueOnce(expected);

    await expect(
      fetchDesignWorkspaceSnapshot("ws_cold_timeout"),
    ).resolves.toEqual(expected);
    expect(platformMocks.readSnapshot).toHaveBeenCalledTimes(2);
  });

  it("retains the confirmed canvas during a partial native save and recovers on the next file event", async () => {
    const workspaceId = "ws_native_save";
    const confirmed = snapshot();
    const repaired = snapshot([{ file: "welcome.html" }]);
    platformMocks.readSnapshot.mockResolvedValueOnce(confirmed)
      .mockRejectedValueOnce(new Error("Design canvas metadata contains invalid JSON."))
      .mockResolvedValueOnce(repaired);
    await fetchDesignWorkspaceSnapshot(workspaceId);
    const previous = designWorkspaceSnapshotCache.peekSnapshot(workspaceId).data;
    applyDesignWorkspaceRefreshVersion(workspaceId, 1);
    await expect(refreshDesignWorkspaceSnapshot(workspaceId)).rejects.toThrow(/invalid JSON/);
    expect(designWorkspaceSnapshotCache.peekSnapshot(workspaceId).data).toBe(previous);
    expect(designWorkspaceSnapshotCache.peekSnapshot("another-workspace").data).toBeUndefined();
    applyDesignWorkspaceRefreshVersion(workspaceId, 2);
    await refreshDesignWorkspaceSnapshot(workspaceId);
    expect(designWorkspaceSnapshotCache.peekSnapshot(workspaceId).data?.frames[0].file).toBe("welcome.html");
  });

  it("re-reads a stale generation and replays the rejected mutation once", async () => {
    const workspaceId = "ws_stale_generation_retry";
    const stale = snapshot();
    const staleFrame = stale.frames[0]!;
    const freshSourceVersion = "f".repeat(24);
    const fresh = {
      ...snapshot(),
      frames: [{ ...staleFrame, sourceVersion: freshSourceVersion }],
    };
    const committed = {
      ...snapshot(),
      frames: [{ ...staleFrame, sourceVersion: "a".repeat(24) }],
    };
    designWorkspaceSnapshotCache.setData(workspaceId, stale);
    runtimeMocks.designFrameRuntime.mockReturnValue(null);
    platformMocks.readSnapshot.mockResolvedValue(fresh);
    platformMocks.updateStyles
      .mockRejectedValueOnce(
        new Error(
          "Design frame changed before the mutation: home.html. Re-read it and retry.",
        ),
      )
      .mockImplementationOnce(async (_workspaceId, input) => {
        // The replay must carry the freshly confirmed generation, not the
        // stale lineage-resolved one that was just rejected.
        expect(input.sourceVersion).toBe(freshSourceVersion);
        return {
          mutation: {
            changed: true,
            frame: {
              ...committed.frames[0]!,
              source: "<main></main>",
              srcDoc: "<main></main>",
              tree: [],
            },
            lint: committed.lint,
          },
          snapshot: committed,
          foundationRevision: { before: "revision:1", after: "revision:2" },
        };
      });

    const mutation = await updateDesignNodeStylesCached(workspaceId, {
      frame: staleFrame.file,
      nodeId: "hero",
      sourceVersion: staleFrame.sourceVersion,
      styles: { color: "red" },
    });

    expect(mutation.changed).toBe(true);
    expect(platformMocks.updateStyles).toHaveBeenCalledTimes(2);
    expect(platformMocks.readSnapshot).toHaveBeenCalledTimes(1);
    expect(
      designWorkspaceSnapshotCache.peekSnapshot(workspaceId).data?.frames[0]
        ?.sourceVersion,
    ).toBe("a".repeat(24));
  });

  it("never replays failures whose write may have landed", async () => {
    const workspaceId = "ws_transport_no_retry";
    const current = snapshot();
    designWorkspaceSnapshotCache.setData(workspaceId, current);
    runtimeMocks.designFrameRuntime.mockReturnValue(null);
    platformMocks.updateStyles.mockRejectedValue(
      new Error("Request timeout: WORKSPACE_REQUEST"),
    );

    await expect(
      updateDesignNodeStylesCached(workspaceId, {
        frame: current.frames[0]!.file,
        nodeId: "hero",
        sourceVersion: current.frames[0]!.sourceVersion,
        styles: { color: "red" },
      }),
    ).rejects.toThrow("Request timeout: WORKSPACE_REQUEST");

    expect(platformMocks.updateStyles).toHaveBeenCalledTimes(1);
    expect(platformMocks.readSnapshot).not.toHaveBeenCalled();
  });

  it("serializes rapid local style writes and rebases their source generation", async () => {
    const workspaceId = "ws_rapid_styles";
    let current = snapshot();
    const frame = current.frames[0]!;
    let expectedSourceVersion = frame.sourceVersion;
    let write = 0;
    designWorkspaceSnapshotCache.setData(workspaceId, current);
    runtimeMocks.designFrameRuntime.mockReturnValue(null);
    platformMocks.updateStyles.mockImplementation(
      async (_workspaceId, input) => {
        expect(input.sourceVersion).toBe(expectedSourceVersion);
        write += 1;
        const nextSourceVersion = (write === 1 ? "a" : "b").repeat(24);
        current = {
          ...current,
          frames: current.frames.map((candidate) =>
            candidate.file === frame.file
              ? {
                  ...candidate,
                  sourceVersion: nextSourceVersion,
                  modifiedAt: candidate.modifiedAt + 1,
                }
              : candidate,
          ),
        };
        expectedSourceVersion = nextSourceVersion;
        return {
          mutation: {
            changed: true,
            frame: {
              ...current.frames[0]!,
              source: "<main></main>",
              srcDoc: "<main></main>",
              tree: [],
            },
            lint: current.lint,
          },
          snapshot: current,
        };
      },
    );

    await Promise.all([
      updateDesignNodeStylesCached(workspaceId, {
        frame: frame.file,
        nodeId: "hero",
        sourceVersion: frame.sourceVersion,
        styles: { width: "320px" },
      }),
      updateDesignNodeStylesCached(workspaceId, {
        frame: frame.file,
        nodeId: "hero",
        sourceVersion: frame.sourceVersion,
        styles: { height: "180px" },
      }),
    ]);

    expect(platformMocks.updateStyles).toHaveBeenCalledTimes(2);
    expect(
      designWorkspaceSnapshotCache.getSnapshot(workspaceId).data?.frames[0]
        ?.sourceVersion,
    ).toBe("b".repeat(24));
  });

  it("starts a replacement directory's Layers folded, without the old directory's pending reveal", () => {
    const workspaceId = "ws_replaced_directory_layers";
    const current = { ...snapshot(), directoryId: "design_original" };
    observeDesignDirectory(workspaceId, current);
    toggleDesignFrameTreeExpanded(workspaceId, "same.html");
    requestDesignLayerReveal({
      workspaceId,
      frame: "same.html",
      nodeIds: ["same-child"],
      tree: undefined,
    });
    // A rename keeps the stable ID, so nothing is forgotten.
    observeDesignDirectory(workspaceId, current);
    expect(designFrameDisclosure(workspaceId, "same.html").treeExpanded).toBe(
      true,
    );

    observeDesignDirectory(workspaceId, {
      ...current,
      directoryId: "design_replacement",
    });
    expect(designFrameDisclosure(workspaceId, "same.html")).toBe(
      EMPTY_DESIGN_FRAME_DISCLOSURE,
    );
    expect(
      useDesignLayerDisclosureStore.getState().revealByWorkspace[workspaceId],
    ).toBeUndefined();
    // A colliding tree in the new directory opens nothing on its own.
    settleDesignLayerReveal(workspaceId, "same.html", [
      {
        oid: "new-parent",
        tag: "div",
        name: "new-parent",
        text: null,
        visible: true,
        children: [
          {
            oid: "same-child",
            tag: "div",
            name: "same-child",
            text: null,
            visible: true,
            children: [],
          },
        ],
      },
    ]);
    expect(designFrameDisclosure(workspaceId, "same.html")).toBe(
      EMPTY_DESIGN_FRAME_DISCLOSURE,
    );
  });

  it("does not retarget a queued edit when a different directory has identical frame source", async () => {
    const workspaceId = "ws_replaced_directory_queue";
    const current = { ...snapshot(), directoryId: "design_original" };
    const frame = current.frames[0]!;
    designWorkspaceSnapshotCache.setData(workspaceId, current);
    observeDesignDirectory(workspaceId, current);
    runtimeMocks.designFrameRuntime.mockReturnValue(null);
    platformMocks.updateStyles.mockResolvedValue({
      mutation: { changed: false, frame: { ...frame, source: "<main></main>", srcDoc: "<main></main>", tree: [] }, lint: current.lint },
      snapshot: current,
    });

    const edit = updateDesignNodeStylesCached(workspaceId, {
      frame: frame.file, nodeId: "hero", sourceVersion: frame.sourceVersion,
      styles: { color: "red" },
    });
    observeDesignDirectory(workspaceId, { ...current, directoryId: "design_replacement" });

    await expect(edit).rejects.toThrow("Design directory changed");
    expect(platformMocks.updateStyles).not.toHaveBeenCalled();
  });

  it("publishes one exact structural snapshot for a canvas text insertion", async () => {
    const workspaceId = "ws_text_insert";
    const current = snapshot();
    const frame = current.frames[0]!;
    const next = snapshot();
    next.frames[0] = {
      ...next.frames[0]!,
      sourceVersion: "f".repeat(24),
      modifiedAt: 20,
    };
    designWorkspaceSnapshotCache.setData(workspaceId, current);
    platformMocks.writeHtml.mockResolvedValue({
      mutation: {
        changed: true,
        frame: {
          ...next.frames[0]!,
          source: '<main><div data-oid="text-new">Hello</div></main>',
          srcDoc: '<main><div data-oid="text-new">Hello</div></main>',
          tree: [],
        },
        lint: next.lint,
      },
      snapshot: next,
    });

    const result = await appendDesignNodeHtmlCached(workspaceId, {
      frame: frame.file,
      nodeId: "root",
      sourceVersion: frame.sourceVersion,
      html: '<div data-oid="text-new">Hello</div>',
    });

    expect(platformMocks.writeHtml).toHaveBeenCalledWith(workspaceId, {
      frame: frame.file,
      nodeId: "root",
      sourceVersion: frame.sourceVersion,
      html: '<div data-oid="text-new">Hello</div>',
      mode: "append",
    });
    expect(result.snapshot).toBe(
      designWorkspaceSnapshotCache.getSnapshot(workspaceId).data,
    );
    expect(result.snapshot.frames[0]?.sourceVersion).toBe("f".repeat(24));
    expect(platformMocks.readSnapshot).not.toHaveBeenCalled();
  });

  it("rebases a queued Foundation write through the exact compatibility-edit receipt", async () => {
    const workspaceId = "ws_compatibility_then_foundation";
    const current = snapshot();
    const frame = current.frames[0]!;
    const afterStyle = snapshot();
    afterStyle.frames[0] = {
      ...afterStyle.frames[0]!,
      sourceVersion: "a".repeat(24),
      modifiedAt: 20,
    };
    const afterTransaction = snapshot();
    afterTransaction.frames[0] = {
      ...afterTransaction.frames[0]!,
      sourceVersion: "b".repeat(24),
      modifiedAt: 30,
    };
    const afterSecondTransaction = snapshot();
    afterSecondTransaction.frames[0] = {
      ...afterSecondTransaction.frames[0]!,
      sourceVersion: "c".repeat(24),
      modifiedAt: 40,
    };
    designWorkspaceSnapshotCache.setData(workspaceId, current);
    const previousFoundationKey = designFoundationKey(
      workspaceId,
      frame.file,
      frame.sourceVersion,
    );
    const currentFoundationKey = designFoundationKey(
      workspaceId,
      frame.file,
      afterStyle.frames[0]!.sourceVersion,
    );
    designFoundationCache.setData(previousFoundationKey, {
      summary: { revision: "revision:1" },
    } as never);
    designFoundationCache.setData(currentFoundationKey, {
      summary: { revision: "revision:2" },
    } as never);
    const previousInvalidation = designFoundationCache.getSnapshot(
      previousFoundationKey,
    ).invalidationVersion;
    const currentInvalidation =
      designFoundationCache.getSnapshot(
        currentFoundationKey,
      ).invalidationVersion;
    runtimeMocks.designFrameRuntime.mockReturnValue(null);
    platformMocks.updateStyles.mockResolvedValue({
      mutation: {
        changed: true,
        frame: {
          ...afterStyle.frames[0]!,
          source: "<main></main>",
          srcDoc: "<main></main>",
          tree: [],
        },
        lint: afterStyle.lint,
      },
      snapshot: afterStyle,
      foundationRevision: {
        before: "revision:1",
        after: "revision:2",
      },
    });
    platformMocks.foundationOpen.mockResolvedValue({
      summary: { revision: "revision:2" },
      foundation: {
        documentId: "document:home",
        revision: "revision:2",
        manifest: {},
        keyframes: [],
      },
    });
    let transactionWrite = 0;
    platformMocks.applyTransaction.mockImplementation(
      async (_workspaceId, _frame, transaction) => {
        transactionWrite += 1;
        const before = `revision:${transactionWrite + 1}`;
        const after = `revision:${transactionWrite + 2}`;
        expect(transaction.baseRevision).toBe(before);
        return {
          result: {
            revision: after,
            receipt: {
              status: "applied",
              beforeRevision: before,
              afterRevision: after,
            },
          },
          snapshot:
            transactionWrite === 1 ? afterTransaction : afterSecondTransaction,
        };
      },
    );

    const compatibilityWrite = updateDesignNodeStylesCached(workspaceId, {
      frame: frame.file,
      nodeId: "hero",
      sourceVersion: frame.sourceVersion,
      styles: { width: "320px" },
    });
    const foundationWrite = applyDesignTransactionCached(
      workspaceId,
      frame.file,
      {
        schemaVersion: 1,
        transactionId: "desktop:after-compatibility",
        documentId: "document:home",
        baseRevision: "revision:1",
        actor: { kind: "human", id: "desktop" },
        intent: "Update the selected elements",
        createdAt: 1,
        operations: [],
      },
    );
    const secondFoundationWrite = applyDesignTransactionCached(
      workspaceId,
      frame.file,
      {
        schemaVersion: 1,
        transactionId: "desktop:after-first-foundation",
        documentId: "document:home",
        baseRevision: "revision:1",
        actor: { kind: "human", id: "desktop" },
        intent: "Update the selected elements again",
        createdAt: 2,
        operations: [],
      },
    );

    await Promise.all([
      compatibilityWrite,
      foundationWrite,
      secondFoundationWrite,
    ]);

    expect(platformMocks.foundationOpen).not.toHaveBeenCalled();
    expect(platformMocks.applyTransaction).toHaveBeenCalledTimes(2);
    expect(
      designFoundationCache.getSnapshot(previousFoundationKey)
        .invalidationVersion,
    ).toBe(previousInvalidation);
    expect(
      designFoundationCache.getSnapshot(currentFoundationKey)
        .invalidationVersion,
    ).toBe(currentInvalidation + 1);
  });

  it("refreshes a sibling frame revision after a shared authored file changes", async () => {
    const workspaceId = "ws_shared_foundation_revision";
    const current = snapshot([{ file: "home.html" }, { file: "pricing.html" }]);
    const home = current.frames[0]!;
    const pricing = current.frames[1]!;
    const afterStyle = {
      ...current,
      frames: current.frames.map((candidate) =>
        candidate.file === home.file
          ? {
              ...candidate,
              sourceVersion: "a".repeat(24),
              modifiedAt: 20,
            }
          : candidate,
      ),
    };
    designWorkspaceSnapshotCache.setData(workspaceId, current);
    runtimeMocks.designFrameRuntime.mockReturnValue(null);
    platformMocks.updateStyles.mockResolvedValue({
      mutation: {
        changed: true,
        frame: {
          ...afterStyle.frames[0]!,
          source: "<main></main>",
          srcDoc: "<main></main>",
          tree: [],
        },
        lint: afterStyle.lint,
      },
      snapshot: afterStyle,
      foundationRevision: {
        before: "home:revision:1",
        after: "home:revision:2",
      },
    });
    platformMocks.foundationOpen.mockResolvedValue({
      summary: { revision: "pricing:revision:2" },
      foundation: {
        documentId: "document:pricing",
        revision: "pricing:revision:2",
        manifest: {},
        keyframes: [],
      },
    });
    platformMocks.applyTransaction.mockImplementation(
      async (_workspaceId, frame, transaction) => {
        expect(frame).toBe(pricing.file);
        expect(transaction.baseRevision).toBe("pricing:revision:2");
        return {
          result: {
            revision: "pricing:revision:3",
            receipt: {
              status: "applied",
              beforeRevision: "pricing:revision:2",
              afterRevision: "pricing:revision:3",
            },
          },
          snapshot: afterStyle,
        };
      },
    );

    await Promise.all([
      updateDesignNodeStylesCached(workspaceId, {
        frame: home.file,
        nodeId: "hero",
        sourceVersion: home.sourceVersion,
        styles: { color: "red" },
      }),
      applyDesignTransactionCached(workspaceId, pricing.file, {
        schemaVersion: 1,
        transactionId: "desktop:shared-file-sibling",
        documentId: "document:pricing",
        baseRevision: "pricing:revision:1",
        actor: { kind: "human", id: "desktop" },
        intent: "Update pricing",
        createdAt: 1,
        operations: [],
      }),
    ]);

    expect(platformMocks.foundationOpen).toHaveBeenCalledTimes(1);
    expect(platformMocks.applyTransaction).toHaveBeenCalledTimes(1);
  });

  it("clears only committed live properties and preserves a newer field preview", async () => {
    const workspaceId = "ws_overlapping_previews";
    const current = snapshot();
    const frame = current.frames[0]!;
    const nextSourceVersion = "c".repeat(24);
    const next = {
      ...current,
      frames: current.frames.map((candidate) => ({
        ...candidate,
        sourceVersion: nextSourceVersion,
        modifiedAt: candidate.modifiedAt + 1,
      })),
    };
    designWorkspaceSnapshotCache.setData(workspaceId, current);
    runtimeMocks.designFrameRuntime.mockReturnValue(null);
    publishDesignLivePreviewStyles(workspaceId, frame.file, "hero", {
      width: "320px",
    });
    publishDesignLivePreviewStyles(workspaceId, frame.file, "hero", {
      height: "180px",
    });
    platformMocks.updateStyles.mockResolvedValue({
      mutation: {
        changed: true,
        frame: {
          ...next.frames[0]!,
          source: "<main></main>",
          srcDoc: "<main></main>",
          tree: [],
        },
        lint: next.lint,
      },
      snapshot: next,
    });

    await updateDesignNodeStylesCached(workspaceId, {
      frame: frame.file,
      nodeId: "hero",
      sourceVersion: frame.sourceVersion,
      styles: { width: "320px" },
    });

    expect(
      designLivePreviewValue(workspaceId, frame.file, "hero", "width"),
    ).toBeUndefined();
    expect(
      designLivePreviewValue(workspaceId, frame.file, "hero", "height"),
    ).toBe("180px");
  });

  it("reuses the complete snapshot when an aggregate refresh is equal", () => {
    const previous = snapshot();
    const stable = stabilizeDesignWorkspaceSnapshot(previous, snapshot());
    expect(stable).toBe(previous);
  });

  it("retains page catalog references and publishes page-only changes", () => {
    const previous = snapshot([{ file: "page-1/home.html" }]);
    previous.pages = [{ id: "screens", title: "Screens", folder: "page-1", frameFiles: ["page-1/home.html"] }];
    previous.frames[0].pageId = "screens";
    const next = structuredClone(previous);
    expect(stabilizeDesignWorkspaceSnapshot(previous, next)).toBe(previous);
    next.pages![0].title = "New title";
    const changed = stabilizeDesignWorkspaceSnapshot(previous, next);
    expect(changed.pages?.[0].title).toBe("New title");
    expect(changed.frames).toBe(previous.frames);
    next.frames[0].pageId = "new-owner";
    expect(stabilizeDesignWorkspaceSnapshot(changed, next).frames[0].pageId).toBe("new-owner");
  });

  it("replaces only the changed frame and retains every unaffected collection", () => {
    const previous = snapshot([
      { file: "home.html" },
      { file: "pricing.html" },
    ]);
    const next = snapshot([
      { file: "home.html", x: 40 },
      { file: "pricing.html" },
    ]);

    const stable = stabilizeDesignWorkspaceSnapshot(previous, next);

    expect(stable).not.toBe(previous);
    expect(stable.frames[0]).not.toBe(previous.frames[0]);
    expect(stable.frames[1]).toBe(previous.frames[1]);
    expect(stable.tokens).toBe(previous.tokens);
    expect(stable.assets).toBe(previous.assets);
    expect(stable.lint).toBe(previous.lint);
  });

  it("does not reuse a frame from another rendered source generation", () => {
    const previous = snapshot();
    const next = snapshot();
    next.frames[0] = {
      ...next.frames[0]!,
      sourceVersion: "ffffffffffffffffffffffff",
    };

    const stable = stabilizeDesignWorkspaceSnapshot(previous, next);

    expect(stable.frames[0]).not.toBe(previous.frames[0]);
    expect(stable.frames[0]?.sourceVersion).toBe("ffffffffffffffffffffffff");
  });

  it.each([undefined, "frame_old"])("adopts a frame identity replacing %s without discarding unchanged rows", (frameId) => {
    const previous = snapshot([{ file: "home.html" }, { file: "pricing.html" }]);
    previous.frames[0]!.frameId = frameId;
    const next = snapshot([{ file: "home.html" }, { file: "pricing.html" }]);
    next.frames[0]!.frameId = "frame_replacement";

    const stable = stabilizeDesignWorkspaceSnapshot(previous, next);

    expect(stable.frames[0]?.frameId).toBe("frame_replacement");
    expect(stable.frames[0]).not.toBe(previous.frames[0]);
    expect(stable.frames[1]).toBe(previous.frames[1]);
    expect(stable.tokens).toBe(previous.tokens);
    expect(stabilizeDesignWorkspaceSnapshot(stable, next)).toBe(stable);
  });

  it("does not reuse a snapshot from another protocol capability generation", () => {
    const previous = snapshot();
    const next = snapshot();
    next.protocolCapability = "d".repeat(64);

    const stable = stabilizeDesignWorkspaceSnapshot(previous, next);

    expect(stable).not.toBe(previous);
    expect(stable.frames).toBe(previous.frames);
    expect(stable.protocolCapability).toBe("d".repeat(64));
  });

  it("adopts a confirmed style generation and refreshed container pins before publishing its workspace snapshot", async () => {
    const workspaceId = "ws_design";
    const previous = snapshot();
    const previousFrame = previous.frames[0]!;
    const nextSourceVersion = "f".repeat(24);
    const next = snapshot();
    next.frames[0] = {
      ...next.frames[0]!,
      sourceVersion: nextSourceVersion,
      modifiedAt: 20,
    };
    const nodeDetails = {
      sourceVersion: nextSourceVersion,
      oid: "hero",
      tag: "main",
      name: "Hero",
      text: null,
      selector: '[data-oid="hero"]',
      visible: true,
      breadcrumb: ["main · Hero"],
      rect: { x: 0, y: 0, width: 240, height: 80 },
      styles: { width: "240px" },
    };
    const runtimeSnapshot = {
      sourceVersion: nextSourceVersion,
      revision: 2,
      tree: [],
      warnings: [],
      frame: { ...nodeDetails, oid: "" },
      viewport: { width: 240, height: 80, scrollX: 0, scrollY: 0 },
    };
    designWorkspaceSnapshotCache.setData(workspaceId, previous);
    useDesignRuntimeStore.getState().publishSnapshot(
      workspaceId,
      "/design/a",
      previousFrame.file,
      {
        ...runtimeSnapshot,
        sourceVersion: previousFrame.sourceVersion,
        revision: 1,
        frame: {
          ...runtimeSnapshot.frame,
          sourceVersion: previousFrame.sourceVersion,
        },
      },
      previousFrame.sourceVersion,
    );
    const parentDetails = {
      ...nodeDetails,
      oid: "parent",
      sourceVersion: previousFrame.sourceVersion,
      childrenLayout: {
        count: 1,
        nodeIds: ["hero"],
        x: "start" as const,
        y: "start" as const,
        truncated: false,
      },
    };
    useDesignRuntimeStore
      .getState()
      .publishNodeDetails(
        workspaceId,
        "/design/a",
        previousFrame.file,
        parentDetails,
        previousFrame.sourceVersion,
      );
    const refreshedParent = {
      ...parentDetails,
      sourceVersion: nextSourceVersion,
      childrenLayout: { ...parentDetails.childrenLayout, x: "end" as const },
    };
    const getNodeDetails = vi.fn().mockResolvedValue(refreshedParent);
    runtimeMocks.designFrameRuntime.mockReturnValue({
      sourceVersion: previousFrame.sourceVersion,
      commitStyles: runtimeMocks.commitStyles,
      getNodeDetails,
    });
    runtimeMocks.commitStyles.mockImplementation(async () => {
      expect(
        designWorkspaceSnapshotCache.getSnapshot(workspaceId).data?.frames[0]
          ?.sourceVersion,
      ).toBe(previousFrame.sourceVersion);
      return {
        sourceVersion: nextSourceVersion,
        treeUnchanged: true,
        snapshot: runtimeSnapshot,
        details: [nodeDetails],
      };
    });
    platformMocks.updateStyles.mockResolvedValue({
      mutation: {
        changed: true,
        frame: {
          ...next.frames[0]!,
          source: '<main data-oid="hero" style="width:240px"></main>',
          srcDoc: '<main data-oid="hero" style="width:240px"></main>',
          tree: [],
        },
        lint: next.lint,
      },
      snapshot: next,
    });

    await updateDesignNodeStylesCached(workspaceId, {
      frame: previousFrame.file,
      nodeId: "hero",
      sourceVersion: previousFrame.sourceVersion,
      styles: { width: "240px" },
    });

    expect(runtimeMocks.commitStyles).toHaveBeenCalledWith(
      [{ nodeId: "hero", styles: { width: "240px" } }],
      nextSourceVersion,
    );
    expect(
      designWorkspaceSnapshotCache.getSnapshot(workspaceId).data?.frames[0]
        ?.sourceVersion,
    ).toBe(nextSourceVersion);
    expect(
      designRuntimeFrameState(workspaceId, previousFrame.file)?.sourceVersion,
    ).toBe(nextSourceVersion);
    expect(getNodeDetails).toHaveBeenCalledExactlyOnceWith("parent");
    expect(
      designRuntimeFrameState(workspaceId, previousFrame.file)?.detailsByNode
        .parent,
    ).toBe(refreshedParent);
  });

  it.each([
    { phase: "commit", selectedFrame: "home.html", active: true },
    { phase: "readback", selectedFrame: "home.html", active: true },
    { phase: "readback", selectedFrame: "pricing.html", active: true },
    { phase: "readback", selectedFrame: "home.html", active: false },
  ])(
    "retains an uncached $selectedFrame selection during $phase adoption (active: $active)",
    async ({ phase, selectedFrame, active }) => {
      const workspaceId = "ws_selection_adoption";
      const previous = snapshot([
        { file: "home.html" },
        { file: "pricing.html" },
      ]);
      const previousFrame = previous.frames[0]!;
      const nextSourceVersion = "f".repeat(24);
      const next = {
        ...previous,
        frames: previous.frames.map((frame) =>
          frame.file === previousFrame.file
            ? { ...frame, sourceVersion: nextSourceVersion, modifiedAt: 20 }
            : frame,
        ),
      };
      const nodeDetails = {
        sourceVersion: nextSourceVersion,
        oid: "hero",
        tag: "div",
        name: "Hero",
        text: null,
        selector: '[data-oid="hero"]',
        visible: true,
        breadcrumb: ["div · Hero"],
        rect: { x: 0, y: 0, width: 300, height: 240 },
        styles: { paddingRight: "24px" },
      };
      const runtimeSnapshot = {
        sourceVersion: nextSourceVersion,
        revision: 2,
        tree: [],
        warnings: [],
        frame: { ...nodeDetails, oid: "" },
        viewport: { width: 1440, height: 900, scrollX: 0, scrollY: 0 },
      };
      const parentDetails = {
        ...nodeDetails,
        oid: "parent",
        sourceVersion: previousFrame.sourceVersion,
        childrenLayout: {
          count: 1,
          nodeIds: ["hero"],
          x: "start" as const,
          y: "start" as const,
          truncated: false,
        },
      };
      const headingDetails = {
        ...nodeDetails,
        oid: "heading",
        tag: "h1",
        name: "Heading",
        selector: '[data-oid="heading"]',
        breadcrumb: ["h1 · Heading"],
      };
      const copyDetails = {
        ...nodeDetails,
        oid: "copy",
        tag: "p",
        name: "Copy",
        selector: '[data-oid="copy"]',
        breadcrumb: ["p · Copy"],
      };
      const chooseLatestSelection = () =>
        useDesignWorkspaceUiStore
          .getState()
          .setSelection(workspaceId, selectedFrame, "heading", [
            "heading",
            "copy",
          ]);
      useDesignWorkspaceUiStore
        .getState()
        .setSelection(workspaceId, previousFrame.file, "hero");
      designWorkspaceSnapshotCache.setData(workspaceId, previous);
      useDesignRuntimeStore.getState().publishSnapshot(
        workspaceId,
        "/design/a",
        previousFrame.file,
        {
          ...runtimeSnapshot,
          sourceVersion: previousFrame.sourceVersion,
          frame: {
            ...runtimeSnapshot.frame,
            sourceVersion: previousFrame.sourceVersion,
          },
        },
        previousFrame.sourceVersion,
      );
      useDesignRuntimeStore
        .getState()
        .publishNodeDetails(
          workspaceId,
          "/design/a",
          previousFrame.file,
          parentDetails,
          previousFrame.sourceVersion,
        );
      const getNodeDetails = vi.fn(async (nodeId: string) => {
        if (nodeId === "parent") {
          if (phase === "readback") chooseLatestSelection();
          return { ...parentDetails, sourceVersion: nextSourceVersion };
        }
        return nodeId === "heading" ? headingDetails : copyDetails;
      });
      const runtime = {
        sourceVersion: previousFrame.sourceVersion,
        commitStyles: runtimeMocks.commitStyles,
        getNodeDetails,
        isActive: () => active,
      };
      runtimeMocks.designFrameRuntime.mockReturnValue(runtime);
      runtimeMocks.commitStyles.mockImplementation(async () => {
        runtime.sourceVersion = nextSourceVersion;
        if (phase === "commit") chooseLatestSelection();
        return {
          sourceVersion: nextSourceVersion,
          treeUnchanged: true,
          snapshot: runtimeSnapshot,
          details: [nodeDetails],
        };
      });
      platformMocks.updateStyles.mockResolvedValue({
        mutation: { changed: true, frame: next.frames[0], lint: next.lint },
        snapshot: next,
      });

      await updateDesignNodeStylesCached(workspaceId, {
        frame: previousFrame.file,
        nodeId: "hero",
        sourceVersion: previousFrame.sourceVersion,
        styles: { "padding-right": "24px" },
      });

      expect(
        useDesignWorkspaceUiStore.getState().byWorkspace[workspaceId],
      ).toMatchObject({
        selectedFrame,
        selectedNodeId: "heading",
        selectedNodeIds: ["heading", "copy"],
      });
      if (selectedFrame === previousFrame.file && active) {
        await vi.waitFor(() => {
          expect(
            designRuntimeFrameState(workspaceId, previousFrame.file)
              ?.detailsByNode.heading,
          ).toEqual(headingDetails);
          expect(
            designRuntimeFrameState(workspaceId, previousFrame.file)
              ?.detailsByNode.copy,
          ).toEqual(copyDetails);
        });
        expect(getNodeDetails.mock.calls.map(([nodeId]) => nodeId)).toEqual([
          "parent",
          "heading",
          "copy",
        ]);
        expect(platformMocks.setSelection).toHaveBeenCalledTimes(1);
      } else {
        expect(getNodeDetails).toHaveBeenCalledExactlyOnceWith("parent");
        expect(platformMocks.setSelection).not.toHaveBeenCalled();
      }
    },
  );

  it("keeps motion keyframe transactions on the mounted runtime generation", async () => {
    const workspaceId = "ws_motion";
    const previous = snapshot();
    const previousFrame = previous.frames[0]!;
    const nextSourceVersion = "e".repeat(24);
    const next = snapshot();
    next.frames[0] = {
      ...next.frames[0]!,
      sourceVersion: nextSourceVersion,
      modifiedAt: 20,
    };
    const nodeDetails = {
      sourceVersion: nextSourceVersion,
      oid: "hero",
      tag: "main",
      name: "Hero",
      text: null,
      selector: '[data-oid="hero"]',
      visible: true,
      breadcrumb: ["main · Hero"],
      rect: { x: 0, y: 0, width: 240, height: 80 },
      styles: { animationName: "hero-enter" },
    };
    const runtimeSnapshot = {
      sourceVersion: nextSourceVersion,
      revision: 2,
      tree: [],
      warnings: [],
      frame: { ...nodeDetails, oid: "" },
      viewport: { width: 240, height: 80, scrollX: 0, scrollY: 0 },
    };
    designWorkspaceSnapshotCache.setData(workspaceId, previous);
    useDesignRuntimeStore.getState().publishSnapshot(
      workspaceId,
      "/design/motion",
      previousFrame.file,
      {
        ...runtimeSnapshot,
        sourceVersion: previousFrame.sourceVersion,
        revision: 1,
        frame: {
          ...runtimeSnapshot.frame,
          sourceVersion: previousFrame.sourceVersion,
        },
      },
      previousFrame.sourceVersion,
    );
    runtimeMocks.designFrameRuntime.mockReturnValue({
      sourceVersion: previousFrame.sourceVersion,
      commitStyles: runtimeMocks.commitStyles,
    });
    runtimeMocks.commitStyles.mockResolvedValue({
      sourceVersion: nextSourceVersion,
      treeUnchanged: true,
      snapshot: runtimeSnapshot,
      details: [nodeDetails],
    });
    platformMocks.applyTransaction.mockResolvedValue({
      result: null,
      snapshot: next,
    });

    await applyDesignTransactionCached(workspaceId, previousFrame.file, {
      schemaVersion: 1,
      transactionId: "desktop:motion-hot-generation",
      documentId: "document:home",
      baseRevision: "revision:1",
      actor: { kind: "human", id: "desktop" },
      intent: "Set hero motion",
      createdAt: 1,
      operations: [
        {
          operationId: "keyframes:hero-enter",
          type: "keyframes.set",
          file: "styles.css",
          name: "hero-enter",
          keyframes: [
            { offset: 0, styles: { opacity: "0" } },
            { offset: 100, styles: { opacity: "1" } },
          ],
        },
        {
          operationId: "styles:hero-enter",
          type: "node.set-styles",
          nodeId: "hero",
          styles: { "animation-name": "hero-enter" },
          scope: "auto",
          responsiveContext: "base",
          stateContext: "default",
        },
      ],
    });

    expect(runtimeMocks.commitStyles).toHaveBeenCalledWith(
      [{ nodeId: "hero", styles: { "animation-name": "hero-enter" } }],
      nextSourceVersion,
      {
        keyframes: [
          {
            name: "hero-enter",
            keyframes: [
              { offset: 0, styles: { opacity: "0" } },
              { offset: 100, styles: { opacity: "1" } },
            ],
          },
        ],
      },
    );
    expect(
      designRuntimeFrameState(workspaceId, previousFrame.file)?.sourceVersion,
    ).toBe(nextSourceVersion);
  });

  it("adopts theme token generations across the live canvas without navigation", async () => {
    const workspaceId = "ws_theme";
    const previous = snapshot();
    const previousFrame = previous.frames[0]!;
    const nextSourceVersion = "d".repeat(24);
    const next = snapshot();
    next.frames[0] = {
      ...next.frames[0]!,
      sourceVersion: nextSourceVersion,
      modifiedAt: 20,
    };
    next.tokenSourceVersion = "tokens-generation-000002";
    next.tokens[0] = { ...next.tokens[0]!, value: "orchid" };
    const runtimeSnapshot = {
      sourceVersion: nextSourceVersion,
      revision: 2,
      tree: [],
      warnings: [],
      frame: {
        sourceVersion: nextSourceVersion,
        oid: "",
        tag: "html",
        name: "Frame",
        text: null,
        selector: "html",
        visible: true,
        breadcrumb: ["html · Frame"],
        rect: { x: 0, y: 0, width: 1440, height: 900 },
        styles: {},
      },
      viewport: { width: 1440, height: 900, scrollX: 0, scrollY: 0 },
    };
    designWorkspaceSnapshotCache.setData(workspaceId, previous);
    useDesignRuntimeStore.getState().publishSnapshot(
      workspaceId,
      "/design/theme",
      previousFrame.file,
      {
        ...runtimeSnapshot,
        sourceVersion: previousFrame.sourceVersion,
        revision: 1,
        frame: {
          ...runtimeSnapshot.frame,
          sourceVersion: previousFrame.sourceVersion,
        },
      },
      previousFrame.sourceVersion,
    );
    runtimeMocks.designFrameRuntime.mockReturnValue({
      sourceVersion: previousFrame.sourceVersion,
      commitStyles: runtimeMocks.commitStyles,
    });
    runtimeMocks.commitStyles.mockResolvedValue({
      sourceVersion: nextSourceVersion,
      treeUnchanged: true,
      snapshot: runtimeSnapshot,
      details: [],
    });
    platformMocks.updateToken.mockResolvedValue({ snapshot: next });

    await updateDesignTokenCached(workspaceId, {
      frame: previousFrame.file,
      name: "--accent",
      theme: "dark",
      value: "orchid",
      sourceVersion: previous.tokenSourceVersion,
    });

    expect(runtimeMocks.commitStyles).toHaveBeenCalledWith(
      [],
      nextSourceVersion,
      { tokens: [{ name: "--accent", theme: "dark", value: "orchid" }] },
    );
    expect(
      designRuntimeFrameState(workspaceId, previousFrame.file)?.sourceVersion,
    ).toBe(nextSourceVersion);
  });

  it("holds a watcher refresh and the last runtime audit until a local style generation is adopted", async () => {
    const workspaceId = "ws_design";
    const previous = snapshot();
    const previousFrame = previous.frames[0]!;
    const nextSourceVersion = "e".repeat(24);
    const runtimeWarning = {
      ruleId: "contrast",
      severity: "warning" as const,
      message: "Text contrast needs review.",
      file: previousFrame.file,
      line: 1,
      column: 1,
      oid: "hero",
      fix: "Increase text contrast.",
    };
    previous.lint = {
      ...previous.lint,
      violations: [runtimeWarning],
    };
    const next = snapshot();
    next.frames[0] = {
      ...next.frames[0]!,
      sourceVersion: nextSourceVersion,
      modifiedAt: 20,
    };
    const nodeDetails = {
      sourceVersion: nextSourceVersion,
      oid: "hero",
      tag: "main",
      name: "Hero",
      text: "Hero",
      selector: '[data-oid="hero"]',
      visible: true,
      breadcrumb: ["main · Hero"],
      rect: { x: 0, y: 0, width: 241, height: 80 },
      styles: { width: "241px" },
    };
    const runtimeSnapshot = {
      sourceVersion: nextSourceVersion,
      revision: 2,
      tree: [],
      warnings: [
        {
          ruleId: "contrast" as const,
          oid: "hero",
          message: runtimeWarning.message,
          fix: runtimeWarning.fix,
        },
      ],
      frame: { ...nodeDetails, oid: "" },
      viewport: { width: 241, height: 80, scrollX: 0, scrollY: 0 },
    };
    designWorkspaceSnapshotCache.setData(workspaceId, previous);
    useDesignRuntimeStore.getState().publishSnapshot(
      workspaceId,
      "/design/a",
      previousFrame.file,
      {
        ...runtimeSnapshot,
        sourceVersion: previousFrame.sourceVersion,
        revision: 1,
        frame: {
          ...runtimeSnapshot.frame,
          sourceVersion: previousFrame.sourceVersion,
        },
      },
      previousFrame.sourceVersion,
    );
    runtimeMocks.designFrameRuntime.mockReturnValue({
      sourceVersion: previousFrame.sourceVersion,
      commitStyles: runtimeMocks.commitStyles,
    });
    runtimeMocks.commitStyles.mockResolvedValue({
      sourceVersion: nextSourceVersion,
      treeUnchanged: true,
      snapshot: runtimeSnapshot,
      details: [nodeDetails],
    });

    let finishEngineWrite!: (value: unknown) => void;
    platformMocks.updateStyles.mockReturnValue(
      new Promise((resolve) => {
        finishEngineWrite = resolve;
      }),
    );
    applyDesignWorkspaceRefreshVersion(workspaceId, 1);
    const invalidationBefore =
      designWorkspaceSnapshotCache.getSnapshot(workspaceId).invalidationVersion;

    const mutation = updateDesignNodeStylesCached(workspaceId, {
      frame: previousFrame.file,
      nodeId: "hero",
      sourceVersion: previousFrame.sourceVersion,
      styles: { width: "241px" },
    });
    applyDesignWorkspaceRefreshVersion(workspaceId, 2);

    expect(
      designWorkspaceSnapshotCache.getSnapshot(workspaceId).invalidationVersion,
    ).toBe(invalidationBefore);

    finishEngineWrite({
      mutation: {
        changed: true,
        frame: {
          ...next.frames[0]!,
          source: '<main data-oid="hero" style="width:241px"></main>',
          srcDoc: '<main data-oid="hero" style="width:241px"></main>',
          tree: [],
        },
        lint: next.lint,
      },
      snapshot: next,
    });
    await mutation;

    const published = designWorkspaceSnapshotCache.getSnapshot(workspaceId);
    expect(published.data?.frames[0]?.sourceVersion).toBe(nextSourceVersion);
    expect(published.data?.lint.violations).toEqual([runtimeWarning]);
    expect(published.invalidationVersion).toBe(invalidationBefore + 1);

    platformMocks.readSnapshot.mockResolvedValue(next);
    await refreshDesignWorkspaceSnapshot(workspaceId);
    expect(
      designWorkspaceSnapshotCache.getSnapshot(workspaceId).data?.lint
        .violations,
    ).toEqual([runtimeWarning]);
  });

  it("does not let a watcher publish between a Foundation write and its aggregate reply", async () => {
    const workspaceId = "ws_design";
    const current = snapshot();
    designWorkspaceSnapshotCache.setData(workspaceId, current);
    applyDesignWorkspaceRefreshVersion(workspaceId, 1);
    const invalidationBefore =
      designWorkspaceSnapshotCache.getSnapshot(workspaceId).invalidationVersion;
    let finishEngineWrite!: (value: unknown) => void;
    platformMocks.applyTransaction.mockReturnValue(
      new Promise((resolve) => {
        finishEngineWrite = resolve;
      }),
    );

    const mutation = applyDesignTransactionCached(
      workspaceId,
      current.frames[0]!.file,
      {
        schemaVersion: 1,
        transactionId: "desktop:foundation-race",
        documentId: "document:home",
        baseRevision: "revision:1",
        actor: { kind: "human", id: "desktop" },
        intent: "Update the selected component",
        createdAt: 1,
        operations: [],
      },
    );
    applyDesignWorkspaceRefreshVersion(workspaceId, 2);

    expect(
      designWorkspaceSnapshotCache.getSnapshot(workspaceId).invalidationVersion,
    ).toBe(invalidationBefore);

    finishEngineWrite({ result: null, snapshot: current });
    await mutation;
    expect(
      designWorkspaceSnapshotCache.getSnapshot(workspaceId).invalidationVersion,
    ).toBe(invalidationBefore + 1);
  });

  it("keeps a structural mutation audit stable until the new document publishes its exact audit", async () => {
    const workspaceId = "ws_design";
    const previous = snapshot();
    const frame = previous.frames[0]!;
    const warning = {
      ruleId: "spacing-scale" as const,
      severity: "warning" as const,
      message: "Spacing needs review.",
      file: frame.file,
      line: 1,
      column: 1,
      oid: "hero",
      fix: "Use a spacing token.",
    };
    previous.lint = { ...previous.lint, violations: [warning] };
    const next = snapshot();
    next.frames[0] = {
      ...next.frames[0]!,
      sourceVersion: "d".repeat(24),
      modifiedAt: 20,
    };
    designWorkspaceSnapshotCache.setData(workspaceId, previous);
    platformMocks.updateToken.mockResolvedValue({ snapshot: next });

    await updateDesignTokenCached(workspaceId, {
      frame: frame.file,
      name: "--accent",
      theme: null,
      value: "orchid",
      sourceVersion: previous.tokenSourceVersion,
    });

    expect(
      designWorkspaceSnapshotCache.getSnapshot(workspaceId).data?.lint
        .violations,
    ).toEqual([warning]);

    platformMocks.setRuntimeAudit.mockResolvedValue(undefined);
    platformMocks.readSnapshot.mockResolvedValue(next);
    await reconcileDesignWorkspaceRuntimeAudit({
      workspaceId,
      frame: frame.file,
      sourceVersion: next.frames[0]!.sourceVersion,
      warnings: [],
    });

    expect(platformMocks.setRuntimeAudit).toHaveBeenCalledWith(workspaceId, {
      frame: frame.file,
      sourceVersion: next.frames[0]!.sourceVersion,
      warnings: [],
    });
    expect(
      designWorkspaceSnapshotCache.getSnapshot(workspaceId).data?.lint
        .violations,
    ).toEqual([]);
  });

  it("does not reuse tokens from another token source generation or theme value", () => {
    const previous = snapshot();
    const next = snapshot();
    next.tokenSourceVersion = "tokens-generation-000002";
    next.tokens[0] = {
      ...next.tokens[0]!,
      themeValues: { dark: "cyan" },
    };

    const stable = stabilizeDesignWorkspaceSnapshot(previous, next);

    expect(stable).not.toBe(previous);
    expect(stable.tokens[0]).not.toBe(previous.tokens[0]);
    expect(stable.tokenSourceVersion).toBe("tokens-generation-000002");
  });

  it("coalesces sibling observers of one refresh generation", () => {
    designWorkspaceSnapshotCache.setData("ws_design", snapshot());
    const initial =
      designWorkspaceSnapshotCache.getSnapshot("ws_design").invalidationVersion;

    applyDesignWorkspaceRefreshVersion("ws_design", 4);
    applyDesignWorkspaceRefreshVersion("ws_design", 4);
    expect(
      designWorkspaceSnapshotCache.getSnapshot("ws_design").invalidationVersion,
    ).toBe(initial);

    applyDesignWorkspaceRefreshVersion("ws_design", 5);
    applyDesignWorkspaceRefreshVersion("ws_design", 5);
    expect(
      designWorkspaceSnapshotCache.getSnapshot("ws_design").invalidationVersion,
    ).toBe(initial + 1);
  });

  it("invalidates every frame foundation after a geometry transaction", async () => {
    const workspaceId = "ws_design";
    const frame = "home.html";
    const current = snapshot([{ file: frame }, { file: "pricing.html" }]);
    const keys = current.frames.map((candidate) =>
      designFoundationKey(workspaceId, candidate.file, candidate.sourceVersion),
    );
    for (const key of keys) {
      designFoundationCache.setData(key, {
        summary: { revision: "old" },
      } as never);
    }
    const before = keys.map(
      (key) => designFoundationCache.getSnapshot(key).invalidationVersion,
    );
    const geometry = { x: 40, y: 20, w: 1_440, h: 900, z: 0 };
    platformMocks.updateCanvas.mockResolvedValue({
      geometry,
      snapshot: current,
    });

    await updateDesignFrameGeometryCached(workspaceId, frame, geometry);

    expect(
      keys.map(
        (key) => designFoundationCache.getSnapshot(key).invalidationVersion,
      ),
    ).toEqual(before.map((version) => version + 1));
  });

  it("invalidates sibling foundations after every Foundation mutation path", async () => {
    const workspaceId = "ws_design";
    const current = snapshot([{ file: "home.html" }, { file: "pricing.html" }]);
    platformMocks.applyTransaction.mockResolvedValue({
      result: null,
      snapshot: current,
    });
    platformMocks.history.mockResolvedValue({
      result: null,
      snapshot: current,
    });
    platformMocks.updateToken.mockResolvedValue({ snapshot: current });
    const mutations = [
      () => applyDesignTransactionCached(workspaceId, "home.html", {} as never),
      () => applyDesignHistoryCached(workspaceId, "home.html", "undo"),
      () =>
        updateDesignTokenCached(workspaceId, {
          frame: "home.html",
          name: "--accent",
          theme: null,
          value: "orchid",
          sourceVersion: current.tokenSourceVersion,
        }),
    ];

    for (const mutate of mutations) {
      resetDesignWorkspaceCacheForTests();
      const keys = current.frames.map((frame) =>
        designFoundationKey(workspaceId, frame.file, frame.sourceVersion),
      );
      for (const key of keys) {
        designFoundationCache.setData(key, {
          summary: { revision: "old" },
        } as never);
      }
      const before = keys.map(
        (key) => designFoundationCache.getSnapshot(key).invalidationVersion,
      );

      await mutate();

      expect(
        keys.map(
          (key) => designFoundationCache.getSnapshot(key).invalidationVersion,
        ),
      ).toEqual(before.map((version) => version + 1));
    }
  });

  it("warms one exact frame document and deduplicates intent reads", async () => {
    const current = snapshot();
    const frame = current.frames[0]!;
    const document = {
      ...frame,
      source: "<!doctype html><html></html>",
      srcDoc: "<!doctype html><html></html>",
      tree: [],
    };
    platformMocks.frame.mockResolvedValue(document);

    warmDesignFrameDocument("ws_design", frame.file, frame.sourceVersion);
    warmDesignFrameDocument("ws_design", frame.file, frame.sourceVersion);

    await vi.waitFor(() =>
      expect(platformMocks.frame).toHaveBeenCalledTimes(1),
    );
    expect(
      designFrameDocumentCache.getSnapshot(
        designFrameDocumentKey("ws_design", frame.file, frame.sourceVersion),
      ).data,
    ).toBe(document);
  });

  it("invalidates retained foundations when external workspace state changes", () => {
    const workspaceId = "ws_design";
    const key = designFoundationKey(
      workspaceId,
      "home.html",
      snapshot().frames[0]!.sourceVersion,
    );
    designFoundationCache.setData(key, {
      summary: { revision: "old" },
    } as never);
    const before = designFoundationCache.getSnapshot(key).invalidationVersion;

    invalidateDesignWorkspaceSnapshot(workspaceId);

    expect(designFoundationCache.getSnapshot(key).invalidationVersion).toBe(
      before + 1,
    );
  });

  it("hydrates a bounded safe preview across a renderer reload", async () => {
    const workspaceId = "ws_boot_preview";
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
      clear: () => storage.clear(),
      key: (index: number) => [...storage.keys()][index] ?? null,
      get length() {
        return storage.size;
      },
    } satisfies Storage);
    const expected = snapshot();
    platformMocks.readSnapshot.mockResolvedValue(expected);

    await refreshDesignWorkspaceSnapshot(workspaceId);
    expect(storage.size).toBeGreaterThan(0);

    vi.resetModules();
    const reloaded = await import("../state/design-workspace-cache");
    const boot =
      reloaded.designWorkspaceSnapshotCache.peekSnapshot(workspaceId);

    expect(boot.data?.frames).toEqual(expected.frames.map((frame) => ({ ...frame, pageId: "main" })));
    expect(boot.data?.pages).toEqual([{ id: "main", title: "Design", folder: "", frameFiles: expected.frames.map((frame) => frame.file) }]);
    expect(boot.data?.tokens).toEqual(expected.tokens);
    // The HTTP capability is derived from the engine's per-process secret and
    // embedded asset bytes can be large; neither belongs in a renderer boot
    // cache. The connected exact-key refresh restores both.
    expect(boot.data?.protocolCapability).toBeNull();
    expect(boot.data?.assets[0]?.dataUrl).toBeNull();
    expect(boot.invalidationVersion).toBeGreaterThan(0);
  });

  it("never reuses a persisted preview for an adapted workspace path", () => {
    const cached = snapshot();
    expect(designWorkspaceSnapshotMatchesPath(cached, "/work/design")).toBe(
      true,
    );
    expect(
      designWorkspaceSnapshotMatchesPath(cached, "/private/work/design"),
    ).toBe(false);
    expect(
      designWorkspaceSnapshotMatchesPath(cached, "/work/restored-design"),
    ).toBe(false);
  });

  it("sends every confirmed cloud frame generation for history independently of focus", async () => {
    const workspaceId = "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
    const current = snapshot([{ file: "home.html" }, { file: "pricing.html" }]);
    platformMocks.readSnapshot.mockResolvedValue(current);
    await refreshDesignWorkspaceSnapshot(workspaceId);
    platformMocks.history.mockResolvedValue({ result: null, snapshot: current });

    await applyDesignHistoryCached(workspaceId, "pricing.html", "undo");

    expect(platformMocks.history).toHaveBeenCalledWith(workspaceId, "pricing.html", "undo",
      Object.fromEntries(current.frames.map(frame => [frame.file, frame.sourceVersion])));
  });

  it("surfaces an exact refresh failure after hiding a mismatched boot preview", () => {
    const cached = snapshot();
    const error = new Error("restored checkout is unavailable");
    const presented = presentDesignWorkspaceSnapshotRead(
      {
        data: cached,
        loading: false,
        refreshing: false,
        error,
        updatedAt: 1,
        invalidationVersion: 1,
        refresh: vi.fn(),
      },
      "/work/restored-design",
      true,
    );

    expect(presented.data).toBeUndefined();
    expect(presented.loading).toBe(false);
    expect(presented.error).toBe(error);
  });

  it("rejects malformed persisted snapshots instead of partially hydrating", () => {
    const malformed = snapshot();
    malformed.frames[0] = {
      ...malformed.frames[0]!,
      sourceVersion: "not-a-generation",
    };
    expect(safeDesignWorkspaceBootSnapshot(malformed)).toBeNull();

    const unsafeGeometry = snapshot();
    unsafeGeometry.frames[0] = {
      ...unsafeGeometry.frames[0]!,
      width: -1,
    };
    expect(safeDesignWorkspaceBootSnapshot(unsafeGeometry)).toBeNull();
  });
  it("preserves directory identity across boot and refuses to share a replacement's snapshot", () => {
    const previous = { ...snapshot(), directoryId: "design_first", directory: "First Design" };
    const next = { ...snapshot(), directoryId: "design_second", directory: "Second Design" };
    expect(stabilizeDesignWorkspaceSnapshot(previous, next)).toBe(next);
    expect(safeDesignWorkspaceBootSnapshot(next)).toMatchObject({ directoryId: "design_second", directory: "Second Design", protocolCapability: null });
    expect(safeDesignWorkspaceBootSnapshot({ ...next, directoryId: "bad\0id" })).toBeNull();
  });

});
