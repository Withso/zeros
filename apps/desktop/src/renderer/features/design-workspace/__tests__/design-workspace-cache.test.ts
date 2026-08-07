import { beforeEach, describe, expect, it, vi } from "vitest";

const platformMocks = vi.hoisted(() => ({
  applyTransaction: vi.fn(),
  frame: vi.fn(),
  history: vi.fn(),
  updateToken: vi.fn(),
  updateCanvas: vi.fn(),
}));

vi.mock("../../../platform/git", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../platform/git")>()),
  designApplyTransaction: platformMocks.applyTransaction,
  designFrame: platformMocks.frame,
  designHistory: platformMocks.history,
  designUpdateToken: platformMocks.updateToken,
  designUpdateCanvas: platformMocks.updateCanvas,
}));

import type { DesignWorkspaceSnapshotWire } from "../../../platform/git";
import {
  applyDesignWorkspaceRefreshVersion,
  applyDesignHistoryCached,
  applyDesignTransactionCached,
  designFrameDocumentCache,
  designFrameDocumentKey,
  designFoundationCache,
  designFoundationKey,
  designWorkspaceSnapshotCache,
  invalidateDesignWorkspaceSnapshot,
  resetDesignWorkspaceCacheForTests,
  stabilizeDesignWorkspaceSnapshot,
  updateDesignTokenCached,
  updateDesignFrameGeometryCached,
  warmDesignFrameDocument,
} from "../state/design-workspace-cache";

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
  beforeEach(() => {
    platformMocks.applyTransaction.mockReset();
    platformMocks.frame.mockReset();
    platformMocks.history.mockReset();
    platformMocks.updateToken.mockReset();
    platformMocks.updateCanvas.mockReset();
    resetDesignWorkspaceCacheForTests();
  });

  it("reuses the complete snapshot when an aggregate refresh is equal", () => {
    const previous = snapshot();
    const stable = stabilizeDesignWorkspaceSnapshot(previous, snapshot());
    expect(stable).toBe(previous);
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

  it("does not reuse a snapshot from another protocol capability generation", () => {
    const previous = snapshot();
    const next = snapshot();
    next.protocolCapability = "d".repeat(64);

    const stable = stabilizeDesignWorkspaceSnapshot(previous, next);

    expect(stable).not.toBe(previous);
    expect(stable.frames).toBe(previous.frames);
    expect(stable.protocolCapability).toBe("d".repeat(64));
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
});
