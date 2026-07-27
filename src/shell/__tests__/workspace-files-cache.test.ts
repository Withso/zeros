import { beforeEach, describe, expect, it, vi } from "vitest";

import { listWorkspaceFiles } from "@/native/git";
import {
  invalidateAllWorkspaceFiles,
  invalidateWorkspaceFiles,
  loadWorkspaceFiles,
  peekWorkspaceFiles,
  resetWorkspaceFilesCacheForTests,
} from "../workspace-files-cache";

vi.mock("@/native/git", () => ({
  listWorkspaceFiles: vi.fn(),
}));

const listFiles = vi.mocked(listWorkspaceFiles);

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("workspace-files-cache invalidation", () => {
  beforeEach(() => {
    resetWorkspaceFilesCacheForTests();
    listFiles.mockReset();
  });

  it("bypasses a fresh TTL entry after a workspace refresh", async () => {
    listFiles.mockResolvedValueOnce(["old.txt"]);
    await expect(loadWorkspaceFiles("/repo")).resolves.toEqual(["old.txt"]);

    // Async callers may capture a trailing slash; it is the same cache scope.
    invalidateWorkspaceFiles("/repo/");
    // Stale-while-revalidate: the next exact destination can still seed its
    // first paint from the last complete listing.
    expect(peekWorkspaceFiles("/repo")).toEqual(["old.txt"]);
    listFiles.mockResolvedValueOnce(["new.txt"]);
    await expect(loadWorkspaceFiles("/repo")).resolves.toEqual(["new.txt"]);
    expect(listFiles).toHaveBeenCalledTimes(2);
  });

  it("preserves array identity when a refresh returns the same file list", async () => {
    listFiles.mockResolvedValueOnce(["a.ts", "b.ts"]);
    const first = await loadWorkspaceFiles("/repo");
    invalidateWorkspaceFiles("/repo");
    listFiles.mockResolvedValueOnce(["a.ts", "b.ts"]);
    const refreshed = await loadWorkspaceFiles("/repo");
    expect(refreshed).toBe(first);
    expect(peekWorkspaceFiles("/repo")).toBe(first);
  });

  it("never converts a cold transport failure into an authoritative empty list", async () => {
    listFiles.mockRejectedValueOnce(new Error("engine reconnecting"));

    await expect(loadWorkspaceFiles("/repo")).rejects.toThrow(
      "engine reconnecting",
    );
    expect(peekWorkspaceFiles("/repo")).toBeNull();
  });

  it("retains the confirmed exact-key list when revalidation fails", async () => {
    listFiles.mockResolvedValueOnce(["kept.ts"]);
    const confirmed = await loadWorkspaceFiles("/repo");
    invalidateWorkspaceFiles("/repo");
    listFiles.mockRejectedValueOnce(new Error("engine reconnecting"));

    await expect(loadWorkspaceFiles("/repo")).resolves.toBe(confirmed);
    expect(peekWorkspaceFiles("/repo")).toBe(confirmed);
  });

  it("cannot let an older in-flight response resurrect a deleted file", async () => {
    const old = deferred<string[]>();
    const fresh = deferred<string[]>();
    listFiles
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(fresh.promise);

    const oldLoad = loadWorkspaceFiles("/repo");
    invalidateWorkspaceFiles("/repo");
    const freshLoad = loadWorkspaceFiles("/repo");

    fresh.resolve(["kept.txt"]);
    await expect(freshLoad).resolves.toEqual(["kept.txt"]);
    old.resolve(["deleted.txt", "kept.txt"]);
    await expect(oldLoad).resolves.toEqual(["deleted.txt", "kept.txt"]);

    // The shared cache remains the fresh generation; no third disk read.
    await expect(loadWorkspaceFiles("/repo")).resolves.toEqual(["kept.txt"]);
    expect(listFiles).toHaveBeenCalledTimes(2);
  });

  it("invalidates cached inactive workspaces for a coarse DB change", async () => {
    listFiles
      .mockResolvedValueOnce(["a-old.txt"])
      .mockResolvedValueOnce(["b-old.txt"]);
    await loadWorkspaceFiles("/repo-a");
    await loadWorkspaceFiles("/repo-b");

    invalidateAllWorkspaceFiles();
    listFiles
      .mockResolvedValueOnce(["a-new.txt"])
      .mockResolvedValueOnce(["b-new.txt"]);
    await expect(loadWorkspaceFiles("/repo-a")).resolves.toEqual(["a-new.txt"]);
    await expect(loadWorkspaceFiles("/repo-b")).resolves.toEqual(["b-new.txt"]);
    expect(listFiles).toHaveBeenCalledTimes(4);
  });

  it("retains a recently read workspace when idle warming reaches the bound", async () => {
    listFiles.mockImplementation(async (cwd) => [`${cwd}/file.ts`]);
    for (let index = 0; index < 12; index += 1) {
      await loadWorkspaceFiles(`/repo-${index}`);
    }

    // A cache hit promotes repo-0 above the otherwise newer inactive entries.
    await loadWorkspaceFiles("/repo-0");
    await loadWorkspaceFiles("/repo-12");

    expect(peekWorkspaceFiles("/repo-1")).toBeNull();
    expect(peekWorkspaceFiles("/repo-0")).toEqual(["/repo-0/file.ts"]);
  });
});
