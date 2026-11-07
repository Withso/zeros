import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DesignWorkspaceSnapshotWire } from "../../../platform/git";

function snapshot(file: string): DesignWorkspaceSnapshotWire {
  return {
    protocolCapability: "c".repeat(64),
    frames: [
      {
        file,
        title: file,
        width: 1440,
        height: 900,
        x: 0,
        y: 0,
        z: 0,
        nodeCount: 1,
        modifiedAt: 1,
        sourceVersion: "a".repeat(24),
      },
    ],
    tokens: [],
    tokenSourceVersion: "b".repeat(24),
    assets: [],
    lint: {
      workspacePath: `/work/${file}`,
      checkedFiles: [file],
      violations: [],
      healedOids: 0,
    },
  };
}

describe("Design workspace boot cache", () => {
  it("retains the page catalog and exact nested ownership while dropping capability", async () => {
    const cache = await import("../state/design-workspace-boot-cache");
    const current = snapshot("page-1/home.html");
    current.pages = [{ id: "screens", title: "Screens", folder: "page-1", frameFiles: ["page-1/home.html"] }];
    current.frames[0].pageId = "screens";
    const safe = cache.safeDesignWorkspaceBootSnapshot(current);
    expect(safe?.pages).toEqual(current.pages);
    expect(safe?.frames[0].pageId).toBe("screens");
    expect(safe?.protocolCapability).toBeNull();
    expect(cache.safeDesignWorkspaceBootSnapshot({ ...current, pages: [{ ...current.pages[0], folder: "../escape" }] })).toBeNull();
    expect(cache.safeDesignWorkspaceBootSnapshot({ ...current, frames: [{ ...current.frames[0], pageId: "wrong" }] })).toBeNull();
  });
  beforeEach(() => {
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
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const pagedSnapshot = (pages: number, perPage: number, prepared: number) => {
    const current = snapshot("page-1/frame-0.html");
    current.pages = Array.from({ length: pages }, (_, page) => ({
      id: `page_${page}`, title: `Page ${page + 1}`, folder: `page-${page + 1}`,
      frameFiles: Array.from({ length: perPage }, (_, frame) => `page-${page + 1}/frame-${frame}.html`),
      frameIds: Array.from({ length: perPage }, (_, frame) => `frame_${page}_${frame}`),
    }));
    current.frames = Array.from({ length: prepared }, (_, frame) => ({
      ...current.frames[0]!, file: `page-1/frame-${frame}.html`, frameId: `frame_0_${frame}`, pageId: "page_0", z: frame,
    }));
    current.lint.checkedFiles = current.frames.map((frame) => frame.file);
    return current;
  };

  it("mirrors a full page past the old 256 frames with per-page stacking up to the cap", async () => {
    const cache = await import("../state/design-workspace-boot-cache");
    const full = pagedSnapshot(2, 1_000, 1_000);
    full.frames[999]!.z = 1_000;
    expect(cache.safeDesignWorkspaceBootSnapshot(full)?.frames).toHaveLength(1_000);
    cache.queueDesignWorkspaceBootSnapshot("ws_full", full);
    vi.runAllTimers();
    cache.resetDesignWorkspaceBootCacheForTests();
    expect(cache.readDesignWorkspaceBootSnapshots().get("ws_full")?.frames).toHaveLength(1_000);
    full.frames[999]!.z = 1_001;
    expect(cache.safeDesignWorkspaceBootSnapshot(full)).toBeNull();
  });

  it("validates a 26-page catalog and drops a stored entry its size no longer fits", async () => {
    const cache = await import("../state/design-workspace-boot-cache");
    const large = pagedSnapshot(26, 1_000, 1_000);
    expect(cache.safeDesignWorkspaceBootSnapshot(large)?.pages).toHaveLength(26);
    cache.queueDesignWorkspaceBootSnapshot("ws_large", pagedSnapshot(1, 10, 10));
    vi.runAllTimers();
    expect(cache.readDesignWorkspaceBootSnapshots().has("ws_large")).toBe(true);
    cache.queueDesignWorkspaceBootSnapshot("ws_large", large);
    vi.runAllTimers();
    cache.resetDesignWorkspaceBootCacheForTests();
    expect(cache.readDesignWorkspaceBootSnapshots().has("ws_large")).toBe(false);
  });

  it("evicts the oldest workspace even when several snapshots settle in one millisecond", async () => {
    const cache = await import("../state/design-workspace-boot-cache");
    for (let index = 0; index < 5; index += 1) {
      cache.queueDesignWorkspaceBootSnapshot(
        `ws_${index}`,
        snapshot(`frame-${index}.html`),
      );
    }

    expect([...cache.readDesignWorkspaceBootSnapshots().keys()]).toEqual([
      "ws_4",
      "ws_3",
      "ws_2",
      "ws_1",
    ]);
  });

  it("keeps a valid layer count and drops one that cannot be true", async () => {
    const cache = await import("../state/design-workspace-boot-cache");
    const withLayers = (layerCount: unknown) => {
      const value = snapshot("layers.html");
      return {
        ...value,
        frames: [{ ...value.frames[0]!, layerCount }],
      } as unknown as DesignWorkspaceSnapshotWire;
    };
    expect(
      cache.safeDesignWorkspaceBootSnapshot(withLayers(0))?.frames[0],
    ).toMatchObject({ nodeCount: 1, layerCount: 0 });
    for (const invalid of [-1, 2, 0.5, "0", null])
      expect(
        cache.safeDesignWorkspaceBootSnapshot(withLayers(invalid))?.frames[0],
      ).not.toHaveProperty("layerCount");
  });

  it("restores frame IDs while retaining compatibility with records predating frame identity", async () => {
    const cache = await import("../state/design-workspace-boot-cache");
    const current = snapshot("phone.html");
    current.frames[0]!.frameId = "frame_phone";
    cache.queueDesignWorkspaceBootSnapshot("workspace", current);
    cache.resetDesignWorkspaceBootCacheForTests();
    expect(cache.readDesignWorkspaceBootSnapshots().get("workspace")?.frames[0]?.frameId).toBe("frame_phone");
    expect(cache.safeDesignWorkspaceBootSnapshot(snapshot("legacy.html"))?.frames[0]).not.toHaveProperty("frameId");
    for (const frameId of ["", "a".repeat(257), "bad\nidentity", null, 123]) {
      expect(cache.safeDesignWorkspaceBootSnapshot({ ...current, frames: [{ ...current.frames[0], frameId }] })).toBeNull();
    }
  });

  it("cancels an idle flush only through the scheduler that created it", async () => {
    let flush: (() => void) | undefined;
    const cancelIdleCallback = vi.fn();
    const clearTimeout = vi.fn();
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      requestIdleCallback: vi.fn((callback: () => void) => {
        flush = callback;
        return 7;
      }),
      cancelIdleCallback,
      setTimeout: vi.fn(() => 11),
      clearTimeout,
    });
    vi.resetModules();
    const cache = await import("../state/design-workspace-boot-cache");

    cache.queueDesignWorkspaceBootSnapshot("ws_idle", snapshot("idle.html"));
    flush?.();

    expect(cancelIdleCallback).toHaveBeenCalledWith(7);
    expect(clearTimeout).not.toHaveBeenCalled();
  });
});
