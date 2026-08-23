import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  allBranchesCache,
  invalidateAllEngineReadCaches,
  invalidateExternalGitRefCaches,
  providerMemorySettingsCache,
  providerQuotaCache,
  PROVIDER_DIAGNOSTIC_MAX_AGE_MS,
  remoteBranchesCache,
} from "../read-caches";

beforeEach(() => {
  allBranchesCache.clear();
  remoteBranchesCache.clear();
  providerMemorySettingsCache.clear();
  providerQuotaCache.clear();
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
