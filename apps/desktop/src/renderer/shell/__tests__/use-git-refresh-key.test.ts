import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../state/use-projects", () => ({
  notifyWorkspacesChanged: vi.fn(),
  notifyWorkspacesChangedForIds: vi.fn(),
}));

import {
  notifyWorkspacesChanged,
  notifyWorkspacesChangedForIds,
} from "../../state/use-projects";
import { ghOwnersCache, remoteBranchesCache } from "../../state/read-caches";
import { loadAgents } from "../../features/agent/agents-cache";
import {
  workingDirectoriesCache,
  workingDirectoriesCacheKey,
} from "../workbench/tabs/working-directories-cache";
import {
  finishedStreamingChatIds,
  getGitRefreshKeyForTests,
  resetGitRefreshKeysForTests,
  subscribeGitRefreshForTests,
  triggerGitRefresh,
  triggerGitBridgeConnectionForTests,
  triggerGitRefreshForWorkspaceIdsForTests,
} from "../use-git-refresh-key";

beforeEach(() => {
  vi.clearAllMocks();
  resetGitRefreshKeysForTests();
  workingDirectoriesCache.clear();
});

describe("finishedStreamingChatIds", () => {
  it("detects completions in inactive chats and ignores continuing streams", () => {
    expect(
      finishedStreamingChatIds(
        ["active-chat", "background-chat"],
        ["active-chat"],
      ),
    ).toEqual(["background-chat"]);
  });

  it("handles several completions atomically", () => {
    expect(
      finishedStreamingChatIds(["one", "two", "three"], ["three", "four"]),
    ).toEqual(["one", "two"]);
  });

  it("does not treat a newly streaming chat as a completion", () => {
    expect(finishedStreamingChatIds([], ["new-chat"])).toEqual([]);
  });
});

describe("git refresh scope generations", () => {
  it("advances only the changed cwd and normalizes trailing separators", () => {
    const beforeA = getGitRefreshKeyForTests("/repo/a");
    const beforeB = getGitRefreshKeyForTests("/repo/b");

    triggerGitRefresh("/repo/a///");

    expect(getGitRefreshKeyForTests("/repo/a")).toBeGreaterThan(beforeA);
    expect(getGitRefreshKeyForTests("/repo/b")).toBe(beforeB);
  });

  it("invalidates only the changed worktree's cached Working folders", () => {
    const keyA = workingDirectoriesCacheKey("/repo/a", "workspace-a");
    const keyB = workingDirectoriesCacheKey("/repo/b", "workspace-b");
    const value = {
      all: ["src"],
      locked: [],
      included: ["src"],
      sparse: false,
      supported: true,
    };
    workingDirectoriesCache.setData(keyA, value);
    workingDirectoriesCache.setData(keyB, value);
    const beforeA = workingDirectoriesCache.getSnapshot(keyA);
    const beforeB = workingDirectoriesCache.getSnapshot(keyB);

    triggerGitRefresh("/repo/a/");

    expect(workingDirectoriesCache.getSnapshot(keyA)).toMatchObject({
      data: value,
      invalidationVersion: beforeA.invalidationVersion + 1,
    });
    expect(workingDirectoriesCache.getSnapshot(keyB)).toBe(beforeB);
  });

  it("notifies exact and unscoped listeners without waking another cwd", () => {
    const listenerA = vi.fn();
    const listenerB = vi.fn();
    const listenerAll = vi.fn();
    const unsubscribe = [
      subscribeGitRefreshForTests("/repo/a", listenerA),
      subscribeGitRefreshForTests("/repo/b", listenerB),
      subscribeGitRefreshForTests(undefined, listenerAll),
    ];

    triggerGitRefresh("/repo/a/");

    expect(listenerA).toHaveBeenCalledOnce();
    expect(listenerB).not.toHaveBeenCalled();
    expect(listenerAll).toHaveBeenCalledOnce();
    for (const release of unsubscribe) release();
  });

  it("routes an opaque workspace event only to its matching cwd subscriber", () => {
    const listenerA = vi.fn();
    const listenerB = vi.fn();
    const unsubscribe = [
      subscribeGitRefreshForTests("/repo/a", listenerA, "workspace-a"),
      subscribeGitRefreshForTests("/repo/b", listenerB, "workspace-b"),
    ];
    const beforeA = getGitRefreshKeyForTests("/repo/a", "workspace-a");
    const beforeB = getGitRefreshKeyForTests("/repo/b", "workspace-b");

    triggerGitRefreshForWorkspaceIdsForTests(["workspace-b"]);

    expect(getGitRefreshKeyForTests("/repo/a", "workspace-a")).toBe(beforeA);
    expect(getGitRefreshKeyForTests("/repo/b", "workspace-b")).toBeGreaterThan(
      beforeB,
    );
    expect(listenerA).not.toHaveBeenCalled();
    expect(listenerB).toHaveBeenCalledOnce();
    // A named-id event now scopes the workspace-list refresh to the mapped
    // repo(s) instead of the blanket "*" invalidate-storm.
    expect(notifyWorkspacesChangedForIds).toHaveBeenCalledOnce();
    expect(notifyWorkspacesChangedForIds).toHaveBeenCalledWith(["workspace-b"]);
    expect(notifyWorkspacesChanged).not.toHaveBeenCalled();
    for (const release of unsubscribe) release();
  });

  it("batches several opaque workspace ids without waking unrelated scopes", () => {
    const listeners = [vi.fn(), vi.fn(), vi.fn()];
    const unsubscribe = [
      subscribeGitRefreshForTests("/repo/a", listeners[0], "workspace-a"),
      subscribeGitRefreshForTests("/repo/b", listeners[1], "workspace-b"),
      subscribeGitRefreshForTests("/repo/c", listeners[2], "workspace-c"),
    ];

    triggerGitRefreshForWorkspaceIdsForTests([
      "workspace-a",
      "workspace-b",
      "workspace-a",
    ]);

    expect(listeners[0]).toHaveBeenCalledOnce();
    expect(listeners[1]).toHaveBeenCalledOnce();
    expect(listeners[2]).not.toHaveBeenCalled();
    for (const release of unsubscribe) release();
  });

  it("uses an explicit coarse publication when the changed cwd is unknown", () => {
    const beforeA = getGitRefreshKeyForTests("/repo/a");
    const beforeB = getGitRefreshKeyForTests("/repo/b");

    triggerGitRefresh();

    expect(getGitRefreshKeyForTests("/repo/a")).toBeGreaterThan(beforeA);
    expect(getGitRefreshKeyForTests("/repo/b")).toBeGreaterThan(beforeB);
  });

  it("refreshes every exact scope after a cold connect or reconnect only", () => {
    const beforeA = getGitRefreshKeyForTests("/repo/a", "workspace-a");
    const beforeB = getGitRefreshKeyForTests("/repo/b", "workspace-b");

    triggerGitBridgeConnectionForTests(true);
    expect(getGitRefreshKeyForTests("/repo/a", "workspace-a")).toBe(beforeA);
    expect(getGitRefreshKeyForTests("/repo/b", "workspace-b")).toBe(beforeB);

    triggerGitBridgeConnectionForTests(false);
    expect(getGitRefreshKeyForTests("/repo/a", "workspace-a")).toBeGreaterThan(
      beforeA,
    );
    expect(getGitRefreshKeyForTests("/repo/b", "workspace-b")).toBeGreaterThan(
      beforeB,
    );
  });
});

describe("bridge reconnection cache boundary", () => {
  it("invalidates engine-derived read caches on reconnect, not on cold connect", () => {
    // Seed two representative caches (workspace-keyed git read + single-key
    // GitHub read) with authoritative data, then observe invalidationVersion —
    // the KeyedAsyncCache signal mounted consumers key their silent
    // revalidation to.
    remoteBranchesCache.setData("workspace-a", []);
    ghOwnersCache.setData("owners", []);
    const directoriesKey = workingDirectoriesCacheKey("/repo/a", "workspace-a");
    workingDirectoriesCache.setData(directoriesKey, {
      all: ["src"],
      locked: [],
      included: ["src"],
      sparse: false,
      supported: true,
    });
    const branchesBefore =
      remoteBranchesCache.getSnapshot("workspace-a").invalidationVersion;
    const ownersBefore =
      ghOwnersCache.getSnapshot("owners").invalidationVersion;
    const directoriesBefore =
      workingDirectoriesCache.getSnapshot(directoriesKey).invalidationVersion;

    // Initial connection: only a mount — cached engine reads stay fresh.
    triggerGitBridgeConnectionForTests(true);
    expect(
      remoteBranchesCache.getSnapshot("workspace-a").invalidationVersion,
    ).toBe(branchesBefore);
    expect(ghOwnersCache.getSnapshot("owners").invalidationVersion).toBe(
      ownersBefore,
    );
    expect(
      workingDirectoriesCache.getSnapshot(directoriesKey).invalidationVersion,
    ).toBe(directoriesBefore);

    // Reconnect: the engine may have restarted — every retained key goes
    // stale so pre-restart snapshots can't shadow the fresh engine.
    triggerGitBridgeConnectionForTests(false);
    expect(
      remoteBranchesCache.getSnapshot("workspace-a").invalidationVersion,
    ).toBe(branchesBefore + 1);
    expect(ghOwnersCache.getSnapshot("owners").invalidationVersion).toBe(
      ownersBefore + 1,
    );
    expect(
      workingDirectoriesCache.getSnapshot(directoriesKey).invalidationVersion,
    ).toBe(directoriesBefore + 1);
  });

  it("forces the agent registry to reload after a reconnect", async () => {
    const loadFn = vi.fn(async () => []);
    // First load populates; a second call inside the freshness window is
    // served from the snapshot.
    await loadAgents(loadFn, 60_000);
    await loadAgents(loadFn, 60_000);
    expect(loadFn).toHaveBeenCalledTimes(1);

    // Reconnect invalidates (without refetching), so the NEXT consumer load
    // actually hits the engine again.
    triggerGitBridgeConnectionForTests(false);
    await loadAgents(loadFn, 60_000);
    expect(loadFn).toHaveBeenCalledTimes(2);
  });
});
