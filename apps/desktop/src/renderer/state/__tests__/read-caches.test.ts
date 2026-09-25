import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  allBranchesCache,
  createLocalBranchesCache,
  createBranchCatalogCache,
  createRemoteCatalogCache,
  invalidateAllEngineReadCaches,
  invalidateExternalGitRefCaches,
  providerMemorySettingsCache,
  providerQuotaCache,
  PROVIDER_DIAGNOSTIC_MAX_AGE_MS,
  remoteBranchesCache,
  designDirectoryListingCache,
  invalidateDesignDirectoryTargetReadCache,
} from "../read-caches";

beforeEach(() => {
  allBranchesCache.clear();
  createLocalBranchesCache.clear();
  createBranchCatalogCache.clear();
  createRemoteCatalogCache.clear();
  remoteBranchesCache.clear();
  providerMemorySettingsCache.clear();
  providerQuotaCache.clear();
  designDirectoryListingCache.clear();
});

describe("Create source snapshots", () => {
  it("isolates checkouts sharing a slug, deduplicates reads, and retains rows through failed refreshes", async () => {
    const a = JSON.stringify(["/first", "same-slug"]);
    const b = JSON.stringify(["/second", "same-slug"]);
    const first = [{ name: "first" }] as import("../../platform/git").Branch[];
    const second = [{ name: "second" }] as import("../../platform/git").Branch[];
    let finish!: (rows: typeof first) => void;
    const fetcher = vi.fn(() => new Promise<typeof first>((resolve) => { finish = resolve; }));
    const one = createLocalBranchesCache.load(a, fetcher);
    const two = createLocalBranchesCache.load(a, fetcher);
    await createLocalBranchesCache.load(b, async () => second);
    finish(first);
    await Promise.all([one, two]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(createLocalBranchesCache.getSnapshot(b).data).toBe(second);
    expect(createLocalBranchesCache.getSnapshot(a).data).toBe(first);
    await expect(createLocalBranchesCache.load(a, async () => { throw new Error("offline"); }, { force: true })).rejects.toThrow("offline");
    expect(createLocalBranchesCache.getSnapshot(a).data).toBe(first);
  });

  it("rejects stale ref results without turning fetch notifications into a network loop", async () => {
    const key = JSON.stringify(["/first", "https://github.com/example/project.git"]);
    const catalog = { branches: [{ name: "main" }] } as import("../../platform/git").RepoBranchCatalog;
    createBranchCatalogCache.setData(key, catalog);
    createRemoteCatalogCache.setData(key, catalog);
    let finish!: (value: typeof catalog) => void;
    const pending = createBranchCatalogCache.load(key, () => new Promise<typeof catalog>((resolve) => { finish = resolve; }), { force: true });
    await Promise.resolve();
    const networkSnapshot = createRemoteCatalogCache.getSnapshot(key);
    invalidateExternalGitRefCaches(["workspace"]);
    finish({ ...catalog, effectiveBase: "obsolete" });
    await pending;
    expect(createBranchCatalogCache.getSnapshot(key).data).toBe(catalog);
    expect(createRemoteCatalogCache.getSnapshot(key)).toBe(networkSnapshot);
    invalidateAllEngineReadCaches();
    expect(createRemoteCatalogCache.getSnapshot(key).invalidationVersion).toBe(networkSnapshot.invalidationVersion + 1);
  });
});

it("keeps Design directory IDs isolated by checkout and retains confirmed rows after a failed refresh", async () => {
  const first = {
    directories: ["First"],
    pointer: "First",
    active: "First",
    directoryIds: { First: "design_first" },
  };
  const second = {
    directories: ["Second"],
    pointer: "Second",
    active: "Second",
    directoryIds: { Second: "design_second" },
  };
  designDirectoryListingCache.setData("/first", first);
  designDirectoryListingCache.setData("/second", second);
  let finish!: (value: typeof first) => void;
  const pending = designDirectoryListingCache.load(
    "/first",
    () =>
      new Promise<typeof first>((resolve) => {
        finish = resolve;
      }),
    { force: true },
  );
  await Promise.resolve();
  expect(designDirectoryListingCache.getSnapshot("/second").data).toBe(second);
  expect(designDirectoryListingCache.getSnapshot("/first").data).toBe(first);
  invalidateDesignDirectoryTargetReadCache();
  finish({ ...first, pointer: "stale" });
  await pending;
  expect(designDirectoryListingCache.getSnapshot("/first").data).toBe(first);
  await expect(
    designDirectoryListingCache.load("/first", async () => {
      throw new Error("conflicted registry");
    }),
  ).rejects.toThrow();
  expect(designDirectoryListingCache.getSnapshot("/first").data).toBe(first);
});

describe("external Git ref cache invalidation", () => {
  it("invalidates the exact workspace target catalog and retained repo catalogs", () => {
    remoteBranchesCache.setData("workspace-a", []);
    remoteBranchesCache.setData("workspace-b", []);
    allBranchesCache.setData("repo-a", []);
    const beforeA = remoteBranchesCache.getSnapshot("workspace-a");
    const beforeB = remoteBranchesCache.getSnapshot("workspace-b");
    const beforeRepo = allBranchesCache.getSnapshot("repo-a");

    invalidateExternalGitRefCaches(["workspace-a"]);

    expect(remoteBranchesCache.getSnapshot("workspace-a")).not.toBe(beforeA);
    expect(remoteBranchesCache.getSnapshot("workspace-b")).toBe(beforeB);
    expect(allBranchesCache.getSnapshot("repo-a")).not.toBe(beforeRepo);
    expect(remoteBranchesCache.getSnapshot("workspace-a").data).toEqual([]);
  });
});

describe("provider diagnostic read caches", () => {
  it("reuses settled quota and memory snapshots while they are fresh", async () => {
    const quotaFetcher = vi.fn(async () => ({
      providerId: "codex",
      fetchedAt: 1,
    }));
    const memoryFetcher = vi.fn(async () => ({
      providerId: "codex",
      localMemoriesEnabled: true,
      canReset: true,
    }));

    await providerQuotaCache.load("codex", quotaFetcher, {
      maxAgeMs: PROVIDER_DIAGNOSTIC_MAX_AGE_MS,
    });
    await providerMemorySettingsCache.load("codex", memoryFetcher, {
      maxAgeMs: PROVIDER_DIAGNOSTIC_MAX_AGE_MS,
    });
    await providerQuotaCache.load("codex", quotaFetcher, {
      maxAgeMs: PROVIDER_DIAGNOSTIC_MAX_AGE_MS,
    });
    await providerMemorySettingsCache.load("codex", memoryFetcher, {
      maxAgeMs: PROVIDER_DIAGNOSTIC_MAX_AGE_MS,
    });

    expect(quotaFetcher).toHaveBeenCalledOnce();
    expect(memoryFetcher).toHaveBeenCalledOnce();
  });

  it("retains provider snapshots but marks them stale after an engine swap", () => {
    const memory = {
      providerId: "codex",
      localMemoriesEnabled: true,
      canReset: true,
    };
    providerMemorySettingsCache.setData("codex", memory);
    providerQuotaCache.setData("codex", null);
    const memoryBefore = providerMemorySettingsCache.getSnapshot("codex");
    const quotaBefore = providerQuotaCache.getSnapshot("codex");

    invalidateAllEngineReadCaches();

    expect(providerMemorySettingsCache.getSnapshot("codex")).toMatchObject({
      data: memory,
      invalidationVersion: memoryBefore.invalidationVersion + 1,
    });
    expect(providerQuotaCache.getSnapshot("codex")).toMatchObject({
      data: null,
      invalidationVersion: quotaBefore.invalidationVersion + 1,
    });
  });
});
