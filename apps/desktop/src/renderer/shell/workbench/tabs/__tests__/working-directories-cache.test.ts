import { beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkingDirectoriesWire } from "@/renderer/platform/git";
import {
  loadWorkingDirectoriesSnapshot,
  workingDirectoriesCache,
  workingDirectoriesCacheKey,
  workingDirectoriesRequest,
} from "../working-directories-cache";

function snapshot(
  included: string[],
  extra: Partial<WorkingDirectoriesWire> = {},
): WorkingDirectoriesWire {
  return {
    all: ["public", "src"],
    locked: [],
    included,
    sparse: included.length < 2,
    supported: true,
    ...extra,
  };
}

describe("working-directories cache", () => {
  beforeEach(() => {
    workingDirectoriesCache.clear();
  });

  it("round-trips every request field in an exact-worktree key", () => {
    const first = workingDirectoriesCacheKey("/repo/worktree", "workspace-a");
    const second = workingDirectoriesCacheKey(
      "/repo/other-worktree",
      "workspace-b",
    );

    expect(first).not.toBe(second);
    expect(workingDirectoriesRequest(first)).toEqual({
      cwd: "/repo/worktree",
      workspaceId: "workspace-a",
    });
  });

  it("restores A instantly after an A → B → A round trip without another read", async () => {
    const firstKey = workingDirectoriesCacheKey("/repo/a", "workspace-a");
    const secondKey = workingDirectoriesCacheKey("/repo/b", "workspace-b");
    const fetcher = vi.fn(async ({ cwd }: { cwd: string }) =>
      cwd.endsWith("/a") ? snapshot(["src"]) : snapshot(["public"]),
    );

    const first = await loadWorkingDirectoriesSnapshot(firstKey, fetcher);
    await loadWorkingDirectoriesSnapshot(secondKey, fetcher);
    const restored = await loadWorkingDirectoriesSnapshot(firstKey, fetcher);

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(restored).toBe(first);
    expect(workingDirectoriesCache.getSnapshot(firstKey).data).toBe(first);
  });

  it("keeps the confirmed rows visible during refresh and reuses an equal result", async () => {
    const key = workingDirectoriesCacheKey("/repo/a", "workspace-a");
    const first = await loadWorkingDirectoriesSnapshot(key, async () =>
      snapshot(["src"]),
    );
    workingDirectoriesCache.invalidate(key);

    let resolve!: (value: WorkingDirectoriesWire) => void;
    const replacement = new Promise<WorkingDirectoriesWire>((done) => {
      resolve = done;
    });
    const pending = loadWorkingDirectoriesSnapshot(key, () => replacement);

    expect(workingDirectoriesCache.getSnapshot(key)).toMatchObject({
      data: first,
      loading: false,
      refreshing: true,
    });

    resolve(snapshot(["src"]));
    await pending;
    expect(workingDirectoriesCache.getSnapshot(key).data).toBe(first);
  });

  it("deduplicates concurrent reads for one worktree", async () => {
    const key = workingDirectoriesCacheKey("/repo/a", "workspace-a");
    let resolve!: (value: WorkingDirectoriesWire) => void;
    const response = new Promise<WorkingDirectoriesWire>((done) => {
      resolve = done;
    });
    const fetcher = vi.fn(() => response);

    const first = loadWorkingDirectoriesSnapshot(key, fetcher);
    const second = loadWorkingDirectoriesSnapshot(key, fetcher);
    resolve(snapshot(["public", "src"]));

    await expect(first).resolves.toEqual(snapshot(["public", "src"]));
    await expect(second).resolves.toEqual(snapshot(["public", "src"]));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects a response invalidated in flight and publishes the queued replacement", async () => {
    const key = workingDirectoriesCacheKey("/repo/a", "workspace-a");
    const confirmed = await loadWorkingDirectoriesSnapshot(key, async () =>
      snapshot(["src"]),
    );
    workingDirectoriesCache.invalidate(key);

    let resolveOld!: (value: WorkingDirectoriesWire) => void;
    let resolveNew!: (value: WorkingDirectoriesWire) => void;
    const oldResponse = new Promise<WorkingDirectoriesWire>((done) => {
      resolveOld = done;
    });
    const newResponse = new Promise<WorkingDirectoriesWire>((done) => {
      resolveNew = done;
    });
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() => oldResponse)
      .mockImplementationOnce(() => newResponse);

    const staleRead = loadWorkingDirectoriesSnapshot(key, fetcher);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    workingDirectoriesCache.invalidate(key);
    const authoritativeRead = loadWorkingDirectoriesSnapshot(key, fetcher);

    resolveOld(snapshot(["public"]));
    await staleRead;
    expect(workingDirectoriesCache.getSnapshot(key).data).toBe(confirmed);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));

    resolveNew(snapshot(["public", "src"]));
    await authoritativeRead;
    expect(workingDirectoriesCache.getSnapshot(key).data?.included).toEqual([
      "public",
      "src",
    ]);
  });
});
