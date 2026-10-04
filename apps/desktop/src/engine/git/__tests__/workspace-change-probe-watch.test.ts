import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Workspace } from "../types";
import { startGitWatcher, type GitWatchChange, type GitWatcher } from "../watch";
import { shareWorkspaceChangeProbe } from "../workspace-change-probe";

const roots: string[] = [];
const watchers: GitWatcher[] = [];
const options = {
  usePolling: true,
  pollIntervalMs: 25,
  worktreePollIntervalMs: 25,
  worktreeDebounceMs: 10,
  awaitWriteFinishMs: 10,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function workspace(id: string, root: string): Workspace {
  return {
    id,
    repoRoot: root,
    repoSlug: "fixture",
    path: root,
    branch: "feature",
    baseBranch: "main",
    createdAt: 1,
    archivedAt: null,
    stashRef: null,
    status: "in-progress",
    prNumber: null,
    prState: null,
    prUrl: null,
    agentId: null,
    lastActiveAt: null,
  };
}

async function waitFor(predicate: () => boolean) {
  await vi.waitFor(() => expect(predicate()).toBe(true), { timeout: 5_000 });
}

afterEach(async () => {
  await Promise.all(watchers.splice(0).map((watcher) => watcher.stop()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("watcher invalidation of in-flight workspace change probes", () => {
  it.each([false, true])("refreshes after a worktree change before publishing its callback (coarse: %s)", async (coarse) => {
    const root = await mkdtemp(path.join(tmpdir(), "zeros-change-probe-watch-"));
    roots.push(root);
    const owner = workspace("workspace-a", root);
    const pending = deferred<boolean>();
    const read = vi.fn().mockImplementationOnce(() => pending.promise).mockResolvedValue(true);
    const first = shareWorkspaceChangeProbe(owner, "origin", read);
    let refreshed: Promise<boolean> | undefined;
    const watcher = startGitWatcher(
      () => [{ root, workspaceId: coarse ? null : owner.id }],
      (change) => {
        expect(change.coarse).toBe(coarse);
        refreshed = shareWorkspaceChangeProbe(owner, "origin", read);
      },
      options,
    );
    watchers.push(watcher);
    try {
      await watcher.ready;
      await writeFile(path.join(root, "source.txt"), "new source\n");
      await waitFor(() => refreshed !== undefined);
      await watcher.stop();
      pending.resolve(false);
      expect(await first).toBe(false);
      expect(await refreshed).toBe(true);
      expect(read).toHaveBeenCalledTimes(2);
    } finally {
      pending.resolve(false);
      await Promise.all([first, refreshed]);
    }
  });

  it("invalidates every shared-ref owner without invalidating a separate repository", async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "zeros-change-probe-refs-"));
    roots.push(temp);
    const firstRoot = path.join(temp, "first");
    const secondRoot = path.join(temp, "second");
    const otherRoot = path.join(temp, "other");
    const common = path.join(firstRoot, ".git");
    const linked = path.join(common, "worktrees", "second");
    await mkdir(path.join(common, "refs", "heads"), { recursive: true });
    await mkdir(linked, { recursive: true });
    await mkdir(secondRoot);
    await mkdir(otherRoot);
    await writeFile(path.join(common, "HEAD"), "ref: refs/heads/main\n");
    await writeFile(path.join(common, "refs", "heads", "main"), "1\n");
    await writeFile(path.join(linked, "HEAD"), "ref: refs/heads/feature\n");
    await writeFile(path.join(linked, "commondir"), "../..\n");
    await writeFile(path.join(secondRoot, ".git"), `gitdir: ${linked}\n`);
    const owners = [workspace("workspace-a", firstRoot), workspace("workspace-b", secondRoot)];
    const other = workspace("workspace-c", otherRoot);
    const pending = deferred<boolean>();
    const reads = owners.map(() => vi.fn().mockImplementationOnce(() => pending.promise).mockResolvedValue(true));
    const otherRead = vi.fn(() => pending.promise);
    const first = owners.map((owner, index) => shareWorkspaceChangeProbe(owner, "origin", reads[index]!));
    const otherFirst = shareWorkspaceChangeProbe(other, "origin", otherRead);
    let refresh: Promise<boolean>[] = [];
    let change: GitWatchChange | undefined;
    const watcher = startGitWatcher(
      () => [...owners, other].map((owner) => ({ root: owner.path, workspaceId: owner.id })),
      (event) => {
        if (!event.gitRefsChanged) return;
        change = event;
        refresh = owners.map((owner, index) => shareWorkspaceChangeProbe(owner, "origin", reads[index]!));
      },
      options,
    );
    watchers.push(watcher);
    try {
      await watcher.ready;
      await writeFile(path.join(common, "refs", "heads", "main"), "2\n");
      await waitFor(() => refresh.length === 2);
      await watcher.stop();
      const otherSecond = shareWorkspaceChangeProbe(other, "origin", otherRead);
      pending.resolve(false);
      expect(change?.workspaceIds.sort()).toEqual(["workspace-a", "workspace-b"]);
      expect(change?.coarse).toBe(false);
      expect(await Promise.all(first)).toEqual([false, false]);
      expect(await Promise.all(refresh)).toEqual([true, true]);
      expect(await Promise.all([otherFirst, otherSecond])).toEqual([false, false]);
      for (const read of reads) expect(read).toHaveBeenCalledTimes(2);
      expect(otherRead).toHaveBeenCalledTimes(1);
    } finally {
      pending.resolve(false);
      await Promise.all([...first, ...refresh, otherFirst]);
    }
  });

  it("fences a suspended checkout's probe without crossing a nested owner", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "zeros-change-probe-suspend-"));
    roots.push(root);
    const child = path.join(root, "nested");
    await mkdir(child);
    const owner = workspace("workspace-a", root);
    const nested = workspace("workspace-b", child);
    const pending = deferred<boolean>();
    const read = vi.fn().mockImplementationOnce(() => pending.promise).mockResolvedValue(true);
    const nestedRead = vi.fn(() => pending.promise);
    const first = shareWorkspaceChangeProbe(owner, "origin", read);
    const nestedFirst = shareWorkspaceChangeProbe(nested, "origin", nestedRead);
    const watcher = startGitWatcher(
      () => [owner, nested].map((target) => ({ root: target.path, workspaceId: target.id })),
      vi.fn(),
      options,
    );
    watchers.push(watcher);
    let refreshed: Promise<boolean> | undefined;
    try {
      await watcher.ready;
      const suspension = await watcher.suspendRoot(root);
      refreshed = shareWorkspaceChangeProbe(owner, "origin", read);
      const nestedSecond = shareWorkspaceChangeProbe(nested, "origin", nestedRead);
      await watcher.stop();
      pending.resolve(false);
      expect(await first).toBe(false);
      expect(await refreshed).toBe(true);
      expect(await Promise.all([nestedFirst, nestedSecond])).toEqual([false, false]);
      expect(nestedRead).toHaveBeenCalledTimes(1);
      suspension.retire();
    } finally {
      pending.resolve(false);
      await Promise.all([first, nestedFirst, refreshed]);
    }
  });
});
