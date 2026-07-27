import { beforeEach, describe, expect, it } from "vitest";

import {
  allBranchesCache,
  invalidateExternalGitRefCaches,
  remoteBranchesCache,
} from "../read-caches";

beforeEach(() => {
  allBranchesCache.clear();
  remoteBranchesCache.clear();
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
