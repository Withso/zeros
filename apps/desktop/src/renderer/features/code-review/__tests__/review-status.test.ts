import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gitStatus, type StatusResult } from "@/renderer/platform/git";
import { statusForGeneration } from "@/renderer/shell/workbench/tabs/changes-tab";
import { folderIsOwnedByProject } from "@/renderer/state/workspace-resolution";
import { forgetReviewCachesForFolders } from "../review-cache-forget";
import {
  WorkspaceReviewStatusStore,
  workspaceReviewStatusStore,
} from "../use-workspace-review-status";

vi.mock("@/renderer/platform/git", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/renderer/platform/git")>()),
  gitStatus: vi.fn(),
}));

const clean: StatusResult = {
  staged: [],
  unstaged: [],
  untracked: [],
  conflicted: [],
  conflictState: null,
};
const conflicted: StatusResult = {
  ...clean,
  conflicted: [{ path: "src/auth.ts", status: "conflicted" }],
};
const statusKey = (cwd: string, workspaceId = cwd) =>
  JSON.stringify([cwd, workspaceId]);

async function settle() {
  for (let index = 0; index < 20; index++) await Promise.resolve();
}

beforeEach(() => {
  vi.mocked(gitStatus).mockReset().mockResolvedValue(clean);
});
afterEach(() => forgetReviewCachesForFolders(() => true));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("viewer aggregate conflict status", () => {
  it("shares a generation read across viewers and restores another exact owner immediately", async () => {
    const store = new WorkspaceReviewStatusStore();
    const keyA = statusKey("/cwd-a", "workspace-a");
    const keyB = statusKey("/cwd-b", "workspace-b");
    const pending = deferred<StatusResult>();
    const read = vi.fn(() => pending.promise);
    const first = store.load(keyA, "workspace-a", 1, read);
    const same = store.load(keyA, "workspace-a", 1, read);
    await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(1);
    await store.load(keyB, "workspace-b", 1, async () => clean);
    const b = store.cache.getSnapshot(keyB).data;
    pending.resolve(clean);
    expect(await first).toBe(clean);
    expect(await same).toBe(clean);
    expect(store.cache.getSnapshot(keyB).data).toBe(b);
  });

  it("fences a late generation and retains confirmed metadata while refreshing", async () => {
    const store = new WorkspaceReviewStatusStore();
    const key = statusKey("/cwd-a", "workspace-a");
    await store.load(key, "workspace-a", 0, async () => clean);
    const pending = deferred<StatusResult>();
    const newer = { ...clean, ahead: 2 };
    const read = vi.fn((_workspaceId: string, generation: number) =>
      generation === 1 ? pending.promise : Promise.resolve(newer),
    );
    const old = store.load(key, "workspace-a", 1, read);
    await Promise.resolve();
    const latest = store.load(key, "workspace-a", 2, read);
    expect(store.cache.getSnapshot(key).data).toBe(clean);
    pending.resolve({ ...clean, ahead: 1 });
    await old;
    await latest;
    expect(read.mock.calls.map((call) => call[1])).toEqual([1, 2]);
    expect(store.cache.getSnapshot(key).data).toBe(newer);
    await store.load(key, "workspace-a", 1, read);
    expect(read).toHaveBeenCalledTimes(2);
  });
});

describe("production review status deletion lifetime", () => {
  it("does not start a deleted reader while its cache fetch is still deferred", async () => {
    const cwd = "/status-deferred-start";
    const key = statusKey(cwd);
    const oldRead = vi.fn(statusForGeneration);
    const old = workspaceReviewStatusStore
      .load(key, cwd, 5, oldRead)
      .catch((error: unknown) => error);
    forgetReviewCachesForFolders((folder) => folder === cwd);
    await settle();
    expect(oldRead).not.toHaveBeenCalled();
    expect(gitStatus).not.toHaveBeenCalled();
    expect(await old).toBeInstanceOf(Error);

    vi.mocked(gitStatus).mockResolvedValue(conflicted);
    const reopened = await workspaceReviewStatusStore.load(
      key,
      cwd,
      0,
      statusForGeneration,
    );
    expect(reopened).toBe(conflicted);
    expect(gitStatus).toHaveBeenCalledTimes(1);
  });

  it.each([5, 0])(
    "reloads a removed warm owner at generation %i through the registered singleton",
    async (generation) => {
      const cwd = `/status-warm-${generation}`;
      const key = statusKey(cwd);
      await workspaceReviewStatusStore.load(key, cwd, 5, async () => clean);
      forgetReviewCachesForFolders((folder) => folder === cwd);

      const read = vi.fn(async () => conflicted);
      const reopened = await workspaceReviewStatusStore.load(
        key,
        cwd,
        generation,
        read,
      );
      expect(read).toHaveBeenCalledTimes(1);
      expect(read).toHaveBeenCalledWith(cwd, generation, cwd);
      expect(reopened.conflicted).toHaveLength(1);
      expect(workspaceReviewStatusStore.cache.peekSnapshot(key).data).toBe(
        conflicted,
      );
    },
  );

  it.each([5, 0])(
    "detaches pending reads before reopening generation %i and preserves the new shared request",
    async (generation) => {
      const cwd = `/status-pending-${generation}`;
      const workspaceId = `status-workspace-${generation}`;
      const key = statusKey(cwd, workspaceId);
      const oldResponse = deferred<StatusResult>();
      const newResponse = deferred<StatusResult>();
      vi.mocked(gitStatus)
        .mockReturnValueOnce(oldResponse.promise)
        .mockReturnValueOnce(newResponse.promise);
      const old = workspaceReviewStatusStore.load(
        key,
        workspaceId,
        5,
        statusForGeneration,
      );
      await settle();
      expect(gitStatus).toHaveBeenCalledTimes(1);

      forgetReviewCachesForFolders((folder) => folder === cwd);
      const reopened = workspaceReviewStatusStore.load(
        key,
        workspaceId,
        generation,
        statusForGeneration,
      );
      await settle();
      expect(gitStatus).toHaveBeenCalledTimes(2);

      oldResponse.resolve(clean);
      await old;
      expect(
        workspaceReviewStatusStore.cache.peekSnapshot(key).data,
      ).toBeUndefined();
      const same = workspaceReviewStatusStore.load(
        key,
        workspaceId,
        generation,
        statusForGeneration,
      );
      await settle();
      expect(gitStatus).toHaveBeenCalledTimes(2);
      newResponse.resolve(conflicted);
      expect(await reopened).toBe(conflicted);
      expect(await same).toBe(conflicted);
      expect(workspaceReviewStatusStore.cache.peekSnapshot(key).data).toBe(
        conflicted,
      );
    },
  );

  it("forgets a shared shell read and its queue before any file viewer subscribes", async () => {
    const cwd = "/status-shell-only";
    const oldResponse = deferred<StatusResult>();
    const newResponse = deferred<StatusResult>();
    vi.mocked(gitStatus)
      .mockReturnValueOnce(oldResponse.promise)
      .mockReturnValueOnce(newResponse.promise);
    const old = statusForGeneration(cwd, 5, cwd);
    await settle();
    const queued = statusForGeneration(cwd, 6, cwd).catch(
      (error: unknown) => error,
    );
    forgetReviewCachesForFolders((folder) => folder === cwd);
    const reopened = statusForGeneration(cwd, 0, cwd);
    await settle();
    expect(gitStatus).toHaveBeenCalledTimes(2);
    expect(await queued).toBeInstanceOf(Error);

    oldResponse.resolve(clean);
    await old;
    expect(statusForGeneration(cwd, 0, cwd)).toBe(reopened);
    newResponse.resolve(conflicted);
    expect(await reopened).toBe(conflicted);
    expect(gitStatus).toHaveBeenCalledTimes(2);
  });

  it("prunes owned descendants while preserving a registered nested owner's snapshot and pending flight", async () => {
    const root = "/status-nested";
    const nested = `${root}/nested`;
    const projects = [root, nested].map((repoRoot) => ({
      id: repoRoot,
      repoRoot,
      name: repoRoot,
      repoSlug: repoRoot,
      originUrl: null,
      addedAt: 1,
    }));
    for (const cwd of [root, `${root}/src`, nested]) {
      await workspaceReviewStatusStore.load(
        statusKey(cwd),
        cwd,
        5,
        statusForGeneration,
      );
    }
    const nestedResponse = deferred<StatusResult>();
    vi.mocked(gitStatus).mockReturnValueOnce(nestedResponse.promise);
    const pending = workspaceReviewStatusStore.load(
      statusKey(nested),
      nested,
      6,
      statusForGeneration,
    );
    await settle();
    forgetReviewCachesForFolders((folder) =>
      folderIsOwnedByProject(folder, root, projects, [root]),
    );
    expect(
      workspaceReviewStatusStore.cache.peekSnapshot(statusKey(root)).data,
    ).toBeUndefined();
    expect(
      workspaceReviewStatusStore.cache.peekSnapshot(statusKey(`${root}/src`))
        .data,
    ).toBeUndefined();
    expect(
      workspaceReviewStatusStore.cache.peekSnapshot(statusKey(nested)).data,
    ).toBe(clean);

    const same = workspaceReviewStatusStore.load(
      statusKey(nested),
      nested,
      0,
      statusForGeneration,
    );
    await settle();
    expect(gitStatus).toHaveBeenCalledTimes(4);
    nestedResponse.resolve(conflicted);
    expect(await pending).toBe(conflicted);
    expect(await same).toBe(conflicted);
  });
});
