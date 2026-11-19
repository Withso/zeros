import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  listWorkspaceFiles,
  listWorkspaceFileListing,
} from "@/renderer/platform/git";
import {
  invalidateAllWorkspaceFiles,
  invalidateWorkspaceFiles,
  loadWorkspaceFiles,
  loadWorkspaceFileListing,
  peekWorkspaceFiles,
  peekWorkspaceFileListing,
  type WorkspaceFileListing,
  resetWorkspaceFilesCacheForTests,
  workspaceFileListingFailure,
  subscribeWorkspaceFileListingFailure,
} from "../workspace-files-cache";
import { bindAccountPresentationOwner } from "../../platform/account-presentation-cache";
import { cloudWorkspaceKey } from "../../platform/bridge/cloud-workspace-key";

const cloud = vi.hoisted(() => ({
  epoch: 0,
  listeners: new Set<() => void>(),
  docs: new Map<string, {
    organizationId: string;
    status: string;
    capabilities: { canWrite: boolean };
    generation: { number: number };
    sharing?: { readOnly: boolean };
  }>(),
}));
vi.mock("../../state/cloud-workspace-catalog", () => ({
  cloudCatalogGeneration: () => cloud.epoch,
  cloudWorkspaceDocument: ({ organizationId, workspaceId }: { organizationId: string; workspaceId: string }) => {
    const doc = cloud.docs.get(workspaceId);
    return doc?.organizationId === organizationId ? doc : undefined;
  },
  cloudWorkspaceOwnerGeneration: () => 1,
  cloudWorkspaceStopVersion: () => 0,
  subscribeCloudWorkspaces: (listener: () => void) => {
    cloud.listeners.add(listener);
    return () => { cloud.listeners.delete(listener); };
  },
  canReadCloudWorkspace: Boolean,
}));

vi.mock("@/renderer/platform/git", () => ({
  listWorkspaceFiles: vi.fn(),
  listWorkspaceFileListing: vi.fn(),
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
    vi.mocked(listWorkspaceFileListing)
      .mockReset()
      .mockImplementation(async (cwd) => ({ files: await listFiles(cwd) }));
  });

  it("reopens the exact cloud file list after a renderer reload without reading a sleeping worker", async () => {
    const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
    const folder = cloudWorkspaceKey(target);
    const doc = { organizationId: target.organizationId, status: "ready", capabilities: { canWrite: true }, generation: { number: 1 }, sharing: { readOnly: false } };
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
    bindAccountPresentationOwner("test-cloud-list-owner");
    cloud.docs.set(target.workspaceId, doc);
    try {
      listFiles.mockResolvedValueOnce(["cached.ts"]);
      await loadWorkspaceFiles(folder);
      resetWorkspaceFilesCacheForTests();
      doc.status = "stopped";

      expect(peekWorkspaceFiles(folder)).toEqual(["cached.ts"]);
      await expect(loadWorkspaceFiles(folder)).resolves.toEqual(["cached.ts"]);
      expect(listFiles).toHaveBeenCalledTimes(1);
      expect(peekWorkspaceFiles(cloudWorkspaceKey({ ...target, organizationId: target.workspaceId }))).toBeNull();

      doc.status = "ready";
      const worker = deferred<string[]>();
      listFiles.mockReturnValueOnce(worker.promise);
      const refreshing = loadWorkspaceFiles(folder);
      expect(peekWorkspaceFiles(folder)).toEqual(["cached.ts"]);
      worker.resolve(["fresh.ts"]);
      await expect(refreshing).resolves.toEqual(["fresh.ts"]);
      expect(peekWorkspaceFiles(folder)).toEqual(["fresh.ts"]);

      invalidateWorkspaceFiles(folder);
      const interrupted = deferred<string[]>();
      listFiles.mockReturnValueOnce(interrupted.promise);
      const pending = loadWorkspaceFiles(folder);
      const rejected = expect(pending).rejects.toThrow("access changed");
      doc.status = "stopped";
      for (const listener of cloud.listeners) listener();
      doc.status = "ready";
      interrupted.resolve(["late.ts"]);
      await rejected;
      expect(peekWorkspaceFiles(folder)).toEqual(["fresh.ts"]);

      doc.generation.number++;
      expect(peekWorkspaceFiles(folder)).toBeNull();
      listFiles.mockResolvedValueOnce(["new-generation.ts"]);
      await loadWorkspaceFiles(folder);
      doc.sharing.readOnly = true;
      expect(peekWorkspaceFiles(folder)).toBeNull();
      await expect(loadWorkspaceFiles(folder)).rejects.toThrow("access changed");
      doc.sharing.readOnly = false;
      bindAccountPresentationOwner("another-owner");
      expect(peekWorkspaceFiles(folder)).toBeNull();
      bindAccountPresentationOwner("test-cloud-list-owner");
      expect(peekWorkspaceFiles(folder)).toBeNull();
    } finally {
      bindAccountPresentationOwner(null);
      cloud.docs.clear();
      vi.unstubAllGlobals();
    }
  });

  it.each([
    { count: 13, pathLength: 10, retained: 12 },
    { count: 4, pathLength: 185_000, retained: 2 },
  ])("bounds persisted cloud lists independently of the memory cache ($retained retained)", async ({ count, pathLength, retained }) => {
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
    bindAccountPresentationOwner("bounded-cloud-lists");
    try {
      const organizationId = "11111111-1111-4111-8111-111111111111";
      const folders: string[] = [];
      for (let i = 0; i < count; i++) {
        const workspaceId = `22222222-2222-4222-8222-${String(i).padStart(12, "0")}`;
        const folder = cloudWorkspaceKey({ organizationId, workspaceId });
        cloud.docs.set(workspaceId, { organizationId, status: "ready", capabilities: { canWrite: true }, generation: { number: 1 } });
        listFiles.mockResolvedValueOnce([`${i}-${"a".repeat(pathLength)}.ts`]);
        await loadWorkspaceFiles(folder);
        folders.push(folder);
      }
      resetWorkspaceFilesCacheForTests();
      expect(folders.filter(folder => peekWorkspaceFiles(folder) !== null)).toEqual(folders.slice(-retained));
    } finally {
      bindAccountPresentationOwner(null);
      cloud.docs.clear();
      vi.unstubAllGlobals();
    }
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

  it("publishes failure beside retained rows and clears it on successful revalidation", async () => {
    const changed = vi.fn();
    const stop = subscribeWorkspaceFileListingFailure("/repo/", changed);
    listFiles.mockResolvedValueOnce(["kept.ts"]);
    const confirmed = await loadWorkspaceFiles("/repo");
    invalidateWorkspaceFiles("/repo");
    const failure = new Error("engine disconnected");
    listFiles.mockRejectedValueOnce(failure);
    await expect(loadWorkspaceFiles("/repo")).resolves.toBe(confirmed);
    expect(workspaceFileListingFailure("/repo/")).toBe(failure);
    expect(workspaceFileListingFailure("/other")).toBeNull();
    expect(changed).toHaveBeenCalled();
    invalidateWorkspaceFiles("/repo");
    listFiles.mockResolvedValueOnce(["recovered.ts"]);
    await loadWorkspaceFiles("/repo");
    expect(workspaceFileListingFailure("/repo")).toBeNull();
    stop();
  });

  it("ignores an obsolete failure after a newer generation has recovered", async () => {
    let reject!: (error: Error) => void;
    listFiles
      .mockReturnValueOnce(
      new Promise((_, fail) => {
        reject = fail;
      }),
    );
    const old = loadWorkspaceFiles("/repo").catch(() => {});
    invalidateWorkspaceFiles("/repo");
    listFiles.mockResolvedValueOnce(["fresh.ts"]);
    await loadWorkspaceFiles("/repo");
    reject(new Error("late failure"));
    await old;
    expect(workspaceFileListingFailure("/repo")).toBeNull();
    expect(peekWorkspaceFiles("/repo")).toEqual(["fresh.ts"]);
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

  it("publishes changed Design ownership even when every filename is unchanged", async () => {
    const listing = vi.mocked(listWorkspaceFileListing);
    listing.mockResolvedValueOnce({
      files: ["Brand/design.toml"],
      designDirectories: ["Brand"],
    });
    const first = await loadWorkspaceFileListing("/repo");
    invalidateWorkspaceFiles("/repo");
    listing.mockResolvedValueOnce({
      files: ["Brand/design.toml"],
      designDirectories: ["Brand"],
    });
    expect(await loadWorkspaceFileListing("/repo")).toBe(first);
    invalidateWorkspaceFiles("/repo");
    listing.mockResolvedValueOnce({
      files: ["Brand/design.toml"],
      designDirectories: [],
    });
    const refreshed = await loadWorkspaceFileListing("/repo");
    expect(refreshed.files).toBe(first.files);
    expect(refreshed.designDirectories).toEqual([]);
    expect(refreshed).not.toBe(first);
  });

  it("deduplicates file and Design reads, isolates workspaces, and rejects stale registration responses", async () => {
    const listing = vi.mocked(listWorkspaceFileListing);
    const old = deferred<WorkspaceFileListing>();
    listing.mockReturnValueOnce(old.promise);
    const oldLoad = loadWorkspaceFileListing("/a");
    const filesLoad = loadWorkspaceFiles("/a");
    expect(listing).toHaveBeenCalledTimes(1);
    listing.mockResolvedValueOnce({ files: ["b.ts"], designDirectories: [] });
    const other = await loadWorkspaceFileListing("/b");
    expect(peekWorkspaceFileListing("/a")).toBeNull();
    invalidateWorkspaceFiles("/a");
    listing.mockResolvedValueOnce({
      files: ["Brand/home.html"],
      designDirectories: [],
    });
    const fresh = await loadWorkspaceFileListing("/a");
    old.resolve({ files: ["Brand/design.toml"], designDirectories: ["Brand"] });
    await Promise.all([oldLoad, filesLoad]);
    expect(peekWorkspaceFileListing("/a")).toBe(fresh);
    expect(peekWorkspaceFileListing("/b")).toBe(other);
    invalidateWorkspaceFiles("/a");
    listing.mockRejectedValueOnce(new Error("reconnecting"));
    expect(await loadWorkspaceFileListing("/a")).toBe(fresh);
  });
});
