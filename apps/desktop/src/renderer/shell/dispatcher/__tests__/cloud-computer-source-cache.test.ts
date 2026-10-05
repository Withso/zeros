import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  computerOrg,
  computerUser,
  deferred,
  otherComputerOrg,
} from "../../../features/settings/__tests__/cloud-computer-v2-fixtures";
import type { GithubBranch } from "../../../platform/git";
const transport = vi.hoisted(() => ({ branches: vi.fn(), prs: vi.fn() }));
vi.mock("../../../platform/git", () => ({
  ghBranchList: transport.branches,
  ghPrList: transport.prs,
  isGitErrorShape: () => false,
}));
import {
  computerBranchesCache,
  computerPrsCache,
} from "../../../state/read-caches";
import {
  computerBranchRows,
  computerSourceReadKey,
  readComputerBranches,
  readComputerPrs,
  warmComputerSources,
} from "../cloud-computer-source";
const repository = {
  id: "123",
  owner: "example",
  name: "project",
  installationId: computerOrg,
};
const key = computerSourceReadKey(
  JSON.stringify([computerUser, computerOrg]),
  repository,
);
beforeEach(() => {
  for (const cache of [computerBranchesCache, computerPrsCache])
    for (const key of cache.keys()) cache.forget(key);
  transport.branches
    .mockReset()
    .mockResolvedValue([{ name: "main", isDefault: true }]);
  transport.prs.mockReset().mockResolvedValue([]);
});
describe("checkout-free source caches", () => {
  it("shares intent with reads, derives every request from its exact key, and preserves warm rows on failure", async () => {
    const pending = deferred<GithubBranch[]>();
    transport.branches.mockReturnValueOnce(pending.promise);
    warmComputerSources(key);
    const read = computerBranchesCache.load(key, () =>
      readComputerBranches(key),
    );
    await Promise.resolve();
    expect(transport.branches).toHaveBeenCalledOnce();
    expect(transport.branches).toHaveBeenCalledWith({
      owner: "example",
      repo: "project",
    });
    expect(transport.prs).toHaveBeenCalledWith({
      owner: "example",
      repo: "project",
      state: "open",
    });
    pending.resolve([{ name: "main", isDefault: true }]);
    const rows = await read;
    const b = computerSourceReadKey(
      JSON.stringify([computerUser, otherComputerOrg]),
      { ...repository, name: "second" },
    );
    await computerBranchesCache.load(b, () => readComputerBranches(b));
    expect(transport.branches).toHaveBeenLastCalledWith({
      owner: "example",
      repo: "second",
    });
    expect(computerBranchesCache.getSnapshot(key).data).toBe(rows);
    transport.branches.mockRejectedValueOnce(new Error("offline"));
    await expect(
      computerBranchesCache.load(key, () => readComputerBranches(key), {
        force: true,
      }),
    ).rejects.toThrow("offline");
    expect(computerBranchesCache.getSnapshot(key).data).toBe(rows);
    expect(computerPrsCache.keys()).toContain(key);
  });
  it("isolates late A responses from B, preserves references, and bounds inactive source owners", async () => {
    const pending = deferred<GithubBranch[]>();
    transport.branches.mockReturnValueOnce(pending.promise);
    const a = computerBranchesCache.load(key, () => readComputerBranches(key));
    const b = computerSourceReadKey(
      JSON.stringify([otherComputerOrg, computerOrg]),
      repository,
    );
    const confirmed = await computerBranchesCache.load(b, () =>
      readComputerBranches(b),
    );
    pending.resolve([{ name: "old-a", isDefault: false }]);
    await a;
    expect(computerBranchesCache.getSnapshot(b).data).toBe(confirmed);
    await computerBranchesCache.load(b, () => readComputerBranches(b), {
      force: true,
    });
    expect(computerBranchesCache.getSnapshot(b).data).toBe(confirmed);
    for (let i = 0; i < 35; i++) {
      const next = computerSourceReadKey(
        JSON.stringify([computerUser, computerOrg]),
        { ...repository, id: String(i + 1000) },
      );
      await computerBranchesCache.load(next, () => readComputerBranches(next));
      await computerPrsCache.load(next, () => readComputerPrs(next));
    }
    expect(computerBranchesCache.keys()).toHaveLength(32);
    expect(computerPrsCache.keys()).toHaveLength(32);
  });
  it("shows the create-options default even outside the first GitHub page, within the row bound", () => {
    const rows = computerBranchRows(
      Array.from({ length: 100 }, (_, i) => ({
        name: `branch-${i}`,
        isDefault: false,
      })),
      "trunk",
    );
    expect(rows).toHaveLength(100);
    expect(rows[0]).toEqual({ name: "trunk", isDefault: true });
  });
});
