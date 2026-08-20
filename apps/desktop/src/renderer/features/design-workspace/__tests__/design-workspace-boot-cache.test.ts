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
