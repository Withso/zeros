import { afterEach, describe, expect, it, vi } from "vitest";

import type { Workspace } from "../../platform/git";

const gitChangeLineCounts = vi.fn();

vi.mock("../../platform/git", () => ({
  gitChangeLineCounts: (workspaceId: string) =>
    gitChangeLineCounts(workspaceId),
}));

const {
  changeLineCountsForGeneration,
  MAX_CONCURRENT_CHANGE_LINE_READS,
  lastConfirmedChangeLines,
  MAX_REMEMBERED_CHANGE_LINE_WORKSPACES,
  NO_CHANGE_LINES,
  rememberChangeLines,
  resetWorkspaceChangeLinesForTests,
  workspaceChangeLinesTarget,
} = await import("../use-workspace-change-lines");

afterEach(() => {
  resetWorkspaceChangeLinesForTests();
  gitChangeLineCounts.mockReset();
});

describe("workspace change-line generations", () => {
  it("serves every caller of one generation from a single engine read", async () => {
    gitChangeLineCounts.mockResolvedValue({ additions: 9, deletions: 2 });

    const [first, second] = await Promise.all([
      changeLineCountsForGeneration("ws-a", 4),
      changeLineCountsForGeneration("ws-a", 4),
    ]);

    expect(gitChangeLineCounts).toHaveBeenCalledTimes(1);
    expect(first).toEqual({ additions: 9, deletions: 2 });
    expect(second).toBe(first);
  });

  it("never lets one workspace's read answer another's", async () => {
    gitChangeLineCounts.mockImplementation(async (workspaceId: string) =>
      workspaceId === "ws-a"
        ? { additions: 1, deletions: 0 }
        : { additions: 0, deletions: 7 },
    );

    await expect(changeLineCountsForGeneration("ws-a", 1)).resolves.toEqual({
      additions: 1,
      deletions: 0,
    });
    await expect(changeLineCountsForGeneration("ws-b", 1)).resolves.toEqual({
      additions: 0,
      deletions: 7,
    });
    expect(gitChangeLineCounts).toHaveBeenCalledTimes(2);
  });

  it("re-reads once the refresh generation advances", async () => {
    gitChangeLineCounts.mockResolvedValue({ additions: 3, deletions: 3 });

    await changeLineCountsForGeneration("ws-a", 1);
    await changeLineCountsForGeneration("ws-a", 2);

    expect(gitChangeLineCounts).toHaveBeenCalledTimes(2);
  });

  it("drops a settled generation so a repeat of it reads again", async () => {
    // The map is in-flight deduplication, never a cache: a coarse refresh that
    // lands on the same key must not be answered from a stale promise.
    gitChangeLineCounts.mockResolvedValue({ additions: 1, deletions: 1 });

    await changeLineCountsForGeneration("ws-a", 1);
    await changeLineCountsForGeneration("ws-a", 1);

    expect(gitChangeLineCounts).toHaveBeenCalledTimes(2);
  });

  it("does not let a failed read poison the next one", async () => {
    gitChangeLineCounts.mockRejectedValueOnce(new Error("bridge down"));
    gitChangeLineCounts.mockResolvedValueOnce({ additions: 5, deletions: 1 });

    await expect(changeLineCountsForGeneration("ws-a", 1)).rejects.toThrow(
      "bridge down",
    );
    await expect(changeLineCountsForGeneration("ws-a", 2)).resolves.toEqual({
      additions: 5,
      deletions: 1,
    });
  });
});

describe("workspace change-line targets", () => {
  it("keeps the established code target while design tabs start no Git read", () => {
    const base = {
      id: "ws-a",
      path: "/repo/worktrees/a",
      repoRoot: "/repo",
      present: true,
    };

    expect(
      workspaceChangeLinesTarget({ ...base, kind: "code" } as Workspace),
    ).toBe("ws-a");
    expect(
      workspaceChangeLinesTarget({ ...base, kind: "design" } as Workspace),
    ).toBeNull();
  });
});

/** Let queued reads advance: a slot hand-off crosses several microtasks. */
async function flushMicrotasks(): Promise<void> {
  for (let tick = 0; tick < 8; tick += 1) await Promise.resolve();
}

describe("change-line read concurrency", () => {
  it("keeps a whole strip's cold start off one spawn storm", async () => {
    // Every visible tab probes at once on mount; only a few may reach the
    // engine before the rest have to wait for a slot.
    const settle: Array<(counts: unknown) => void> = [];
    gitChangeLineCounts.mockImplementation(
      () => new Promise((resolve) => settle.push(resolve)),
    );

    const reads = Array.from({ length: 12 }, (_, index) =>
      changeLineCountsForGeneration(`ws-${index}`, 1),
    );
    await flushMicrotasks();
    expect(gitChangeLineCounts).toHaveBeenCalledTimes(
      MAX_CONCURRENT_CHANGE_LINE_READS,
    );

    // Nothing may be dropped — every queued read still has to reach the engine.
    while (settle.length > 0) {
      settle.shift()?.({ additions: 1, deletions: 0 });
      await flushMicrotasks();
    }
    await expect(Promise.all(reads)).resolves.toHaveLength(12);
    expect(gitChangeLineCounts).toHaveBeenCalledTimes(12);
  });

  it("frees its slot when a read fails, so the queue still drains", async () => {
    gitChangeLineCounts.mockRejectedValue(new Error("bridge down"));

    const reads = Array.from({ length: 8 }, (_, index) =>
      changeLineCountsForGeneration(`ws-${index}`, 1).catch(() => "failed"),
    );

    await expect(Promise.all(reads)).resolves.toEqual(Array(8).fill("failed"));
    expect(gitChangeLineCounts).toHaveBeenCalledTimes(8);
  });
});

describe("last confirmed change lines", () => {
  it("reads as nothing-to-show until a workspace has resolved once", () => {
    expect(lastConfirmedChangeLines("ws-a")).toBe(NO_CHANGE_LINES);
    expect(lastConfirmedChangeLines(null)).toBe(NO_CHANGE_LINES);
  });

  it("keeps each workspace's own last confirmed pair", () => {
    rememberChangeLines("ws-a", { additions: 4, deletions: 0 });
    rememberChangeLines("ws-b", { additions: 0, deletions: 9 });

    expect(lastConfirmedChangeLines("ws-a")).toEqual({
      additions: 4,
      deletions: 0,
    });
    expect(lastConfirmedChangeLines("ws-b")).toEqual({
      additions: 0,
      deletions: 9,
    });
  });

  it("returns a stable reference so a tab does not re-render on a fresh object", () => {
    rememberChangeLines("ws-a", { additions: 4, deletions: 0 });
    expect(lastConfirmedChangeLines("ws-a")).toBe(
      lastConfirmedChangeLines("ws-a"),
    );
  });

  it("keeps an unchanged pair's identity across refresh generations", () => {
    // Every generation re-reads every visible workspace and almost none have
    // moved; a fresh object each time would re-render the whole strip.
    const first = rememberChangeLines("ws-a", { additions: 4, deletions: 1 });
    const second = rememberChangeLines("ws-a", { additions: 4, deletions: 1 });
    expect(second).toBe(first);

    const moved = rememberChangeLines("ws-a", { additions: 5, deletions: 1 });
    expect(moved).not.toBe(first);
    expect(lastConfirmedChangeLines("ws-a")).toBe(moved);
  });

  it("evicts the least-recently-confirmed workspace at the bound", () => {
    const total = MAX_REMEMBERED_CHANGE_LINE_WORKSPACES + 2;
    for (let index = 0; index < total; index += 1) {
      rememberChangeLines(`ws-${index}`, { additions: index, deletions: 0 });
    }
    // Re-confirming ws-2 moves it back to the head of the eviction queue.
    rememberChangeLines("ws-2", { additions: 99, deletions: 0 });
    rememberChangeLines("ws-extra", { additions: 1, deletions: 0 });

    expect(lastConfirmedChangeLines("ws-0")).toBe(NO_CHANGE_LINES);
    expect(lastConfirmedChangeLines("ws-2")).toEqual({
      additions: 99,
      deletions: 0,
    });
    expect(lastConfirmedChangeLines(`ws-${total - 1}`)).toEqual({
      additions: total - 1,
      deletions: 0,
    });
  });
});
