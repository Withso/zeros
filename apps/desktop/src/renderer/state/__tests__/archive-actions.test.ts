import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  archiveWorkspaceWithFeedback,
  deleteWorkspacePermanently,
} from "../archive-actions";
import { loadProjects } from "../projects-store";
import { selectLiveVisible } from "../live-workspace-selectors";
import {
  beginPendingCreate,
  usePendingWorkspacesStore,
} from "../pending-workspaces";
import { selectActiveFolder, useWorkspaceStore } from "../store";
import { peekWorkspacesFor, setWorkspaceRowsForTesting } from "../use-projects";
import {
  workspaceArchive,
  workspaceDelete,
  workspaceGet,
  workspaceLifecycleStatus,
  type ArchiveResult,
  type Workspace,
} from "../../platform/git";
import { toast } from "../../shared/ui/primitives/elements";
import {
  codeReviewCache,
  codeReviewCacheKey,
} from "../../features/code-review/review-cache";
import {
  hunkReviewCache,
  hunkReviewCacheKey,
} from "../../features/code-review/hunk-review-cache";

vi.mock("../../shared/ui/primitives/elements", () => ({
  toast: { success: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
vi.mock("../../platform/observability/analytics/agent-events", () => ({
  trackGitOp: vi.fn(),
}));
vi.mock("../../platform/git", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../platform/git")>()),
  workspaceArchive: vi.fn(),
  workspaceDelete: vi.fn(),
  workspaceGet: vi.fn(),
  workspaceLifecycleStatus: vi.fn(),
}));
vi.mock("../projects-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../projects-store")>()),
  loadProjects: vi.fn(() => [
    {
      id: "archive-fixture",
      name: "Archive fixture",
      repoRoot: "/repo",
      repoSlug: "archive-fixture",
      originUrl: null,
      addedAt: 1,
    },
  ]),
}));

function workspace(id: string, createdAt: number): Workspace {
  return {
    id,
    repoSlug: "archive-fixture",
    repoRoot: "/repo",
    path: `/repo/worktrees/${id}`,
    branch: `zeros/${id}`,
    baseBranch: "main",
    status: "in-progress",
    createdAt,
    archivedAt: null,
    stashRef: null,
    prNumber: null,
    prState: null,
    prUrl: null,
    agentId: null,
    lastActiveAt: null,
    present: true,
  };
}
const left = workspace("left", 3);
const target = workspace("target", 2);
const right = workspace("right", 1);
const dispatch = useWorkspaceStore.getState().dispatch;
const visible = () =>
  selectLiveVisible(
    peekWorkspacesFor(target.repoSlug) ?? [],
    usePendingWorkspacesStore.getState().archiveIntents,
  );
function result(row = target): ArchiveResult {
  return {
    archivedAt: 100,
    stashRef: null,
    archiveSnapshot: "a".repeat(40),
    workspace: { ...row, archivedAt: 100, present: false },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
  codeReviewCache.clear();
  hunkReviewCache.clear();
  vi.mocked(loadProjects).mockReturnValue([
    {
      id: "archive-fixture",
      name: "Archive fixture",
      repoRoot: "/repo",
      repoSlug: "archive-fixture",
      originUrl: null,
      addedAt: 1,
    },
  ]);
  usePendingWorkspacesStore.setState(
    usePendingWorkspacesStore.getInitialState(),
    true,
  );
  useWorkspaceStore.setState(useWorkspaceStore.getInitialState(), true);
  useWorkspaceStore.setState({ workspaceListFilter: "ungrouped" });
  setWorkspaceRowsForTesting(target.repoSlug, [left, target, right]);
  dispatch({
    type: "OPEN_WORKSPACE",
    folder: target.path,
    repoRoot: target.repoRoot,
    chatId: null,
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function seedReviewCaches(folder: string, workspaceId = target.id) {
  const reviewKey = codeReviewCacheKey(folder, workspaceId);
  const hunkKey = hunkReviewCacheKey("engine", folder, "file.ts");
  const review = {
    workspaceId,
    threads: [],
    partial: true,
    nextCursor: "retained-history",
  };
  const hunks = [
    {
      key: "a".repeat(64),
      path: "file.ts",
      comparison: "worktree-vs-head" as const,
      decision: "accepted" as const,
      updatedAt: 1,
    },
  ];
  codeReviewCache.setData(reviewKey, review);
  hunkReviewCache.setData(hunkKey, hunks);
  return { reviewKey, hunkKey, review, hunks };
}

function expectReviewCachesRetained(
  entries: ReturnType<typeof seedReviewCaches>[],
) {
  for (const entry of entries) {
    expect(codeReviewCache.peekSnapshot(entry.reviewKey).data).toBe(
      entry.review,
    );
    expect(hunkReviewCache.peekSnapshot(entry.hunkKey).data).toBe(entry.hunks);
  }
}

describe("confirmed workspace deletion review caches", () => {
  it("retains pending or failed deletion snapshots, then purges owned normalized descendants only", async () => {
    const deleting = {
      ...target,
      repoRoot: "/var/repo",
      path: "/var/repo/worktrees/target",
    };
    const project = { ...loadProjects()[0]!, repoRoot: deleting.repoRoot };
    vi.mocked(loadProjects).mockReturnValue([
      project,
      {
        ...project,
        id: "nested-project",
        repoSlug: "nested-project",
        repoRoot: `${deleting.path}/nested`,
      },
    ]);
    const owned = [
      seedReviewCaches(`${deleting.path}/`),
      seedReviewCaches("/private/var/repo/worktrees/target///"),
      seedReviewCaches("/private/var/repo/worktrees/target/packages/app//"),
    ];
    const preserved = [
      seedReviewCaches(
        "/private/var/repo/worktrees/target/nested/src//",
        "nested-workspace",
      ),
      seedReviewCaches(`${deleting.path}-sibling/src`, "sibling-workspace"),
      seedReviewCaches(right.path, right.id),
    ];
    const failed = deferred<void>();
    vi.mocked(workspaceDelete).mockReturnValueOnce(failed.promise);
    const failure = deleteWorkspacePermanently(deleting, dispatch);
    expectReviewCachesRetained([...owned, ...preserved]);
    failed.reject(new Error("worktree is busy"));
    expect(await failure).toBe("failed");
    expectReviewCachesRetained([...owned, ...preserved]);

    const confirmed = deferred<void>();
    vi.mocked(workspaceDelete).mockReturnValueOnce(confirmed.promise);
    const deletion = deleteWorkspacePermanently(deleting, dispatch);
    expectReviewCachesRetained([...owned, ...preserved]);
    confirmed.resolve();
    expect(await deletion).toBe("deleted");
    for (const entry of owned) {
      expect(
        codeReviewCache.peekSnapshot(entry.reviewKey).data,
      ).toBeUndefined();
      expect(hunkReviewCache.peekSnapshot(entry.hunkKey).data).toBeUndefined();
    }
    expectReviewCachesRetained(preserved);
  });

  it("preserves review and hunk history on archive for restoration under the same owner", async () => {
    const entries = [
      seedReviewCaches(target.path),
      seedReviewCaches(`${target.path}/packages/app`),
    ];
    vi.mocked(workspaceArchive).mockResolvedValueOnce(result());
    await archiveWorkspaceWithFeedback(target, dispatch);
    expectReviewCachesRetained(entries);
  });
});

describe("immediate archive presentation", () => {
  it("hides and navigates before the RPC settles, retaining confirmed data until success", async () => {
    const flight = deferred<ArchiveResult>();
    vi.mocked(workspaceArchive).mockReturnValueOnce(flight.promise);
    const before = peekWorkspacesFor(target.repoSlug);
    const onArchived = vi.fn();
    const navigation: (string | null)[] = [];
    const unsubscribe = useWorkspaceStore.subscribe((state) =>
      navigation.push(selectActiveFolder(state)),
    );
    const archive = archiveWorkspaceWithFeedback(target, dispatch, {
      onArchived,
    });

    expect(visible()).toEqual([left, right]);
    expect(navigation).toEqual([left.path]);
    expect(peekWorkspacesFor(target.repoSlug)).toBe(before);
    expect(onArchived).not.toHaveBeenCalled();
    expect(toast.info).not.toHaveBeenCalled();

    dispatch({
      type: "OPEN_WORKSPACE",
      folder: right.path,
      repoRoot: right.repoRoot,
      chatId: null,
    });
    flight.resolve(result());
    await archive;
    unsubscribe();
    expect(peekWorkspacesFor(target.repoSlug)).toEqual([left, right]);
    expect(usePendingWorkspacesStore.getState().archiveIntents).toEqual({});
    expect(onArchived).toHaveBeenCalledOnce();
    expect(toast.success).not.toHaveBeenCalled();
    expect(selectActiveFolder(useWorkspaceStore.getState())).toBe(right.path);
  });

  it("restores visibility after failure without overwriting navigation or newer server rows", async () => {
    const flight = deferred<ArchiveResult>();
    vi.mocked(workspaceArchive).mockReturnValueOnce(flight.promise);
    const archive = archiveWorkspaceWithFeedback(target, dispatch);
    const updated = { ...target, branch: "zeros/renamed" };
    setWorkspaceRowsForTesting(target.repoSlug, [left, updated, right]);
    expect(visible()).toEqual([left, right]);
    dispatch({
      type: "OPEN_WORKSPACE",
      folder: right.path,
      repoRoot: right.repoRoot,
      chatId: null,
    });
    flight.reject(new Error("checkpoint failed"));
    await archive;
    expect(visible()).toEqual([left, updated, right]);
    expect(selectActiveFolder(useWorkspaceStore.getState())).toBe(right.path);
    expect(toast.error).toHaveBeenCalledWith("Couldn't archive workspace", {
      description: "checkpoint failed",
    });
  });

  it("coalesces duplicate archive clicks and skips hidden neighbors during a burst", async () => {
    setWorkspaceRowsForTesting(target.repoSlug, [left, target]);
    // Its confirmed row arrived, but create reconciliation has not cleared the
    // placeholder yet. Hiding that row must not resurrect its pending tab.
    beginPendingCreate({
      repoRoot: target.repoRoot,
      repoSlug: target.repoSlug,
      path: target.path,
      branch: target.branch,
    });
    const first = deferred<ArchiveResult>();
    const second = deferred<ArchiveResult>();
    vi.mocked(workspaceArchive)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const archiveTarget = archiveWorkspaceWithFeedback(target, dispatch);
    await archiveWorkspaceWithFeedback(target, dispatch);
    expect(workspaceArchive).toHaveBeenCalledTimes(1);
    const archiveLeft = archiveWorkspaceWithFeedback(left, dispatch);
    expect(visible()).toEqual([]);
    expect(useWorkspaceStore.getState().activePage).toBe("create");
    expect(selectActiveFolder(useWorkspaceStore.getState())).toBeNull();
    second.resolve(result(left));
    first.resolve(result());
    await Promise.all([archiveTarget, archiveLeft]);
    expect(useWorkspaceStore.getState().activePage).toBe("create");
  });

  it("keeps a timed-out archive hidden through stale reads until exact confirmation, without a toast", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    vi.mocked(workspaceArchive).mockRejectedValueOnce(
      new Error("Request timeout: WORKSPACE_REQUEST"),
    );
    vi.mocked(workspaceGet).mockResolvedValue(target);
    vi.mocked(workspaceLifecycleStatus).mockResolvedValue({
      active: true,
      operation: "archive",
      phase: null,
      startedAt: 1,
    });
    await archiveWorkspaceWithFeedback(target, dispatch);
    await vi.advanceTimersByTimeAsync(0);
    expect(visible()).toEqual([left, right]);
    expect(toast.info).not.toHaveBeenCalled();
    vi.mocked(workspaceGet).mockResolvedValue(result().workspace!);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(usePendingWorkspacesStore.getState().archiveIntents).toEqual({});
    expect(peekWorkspacesFor(target.repoSlug)).toEqual([left, right]);
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("reveals a stopped timed-out archive only after closing the row/status race", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    vi.mocked(workspaceArchive).mockRejectedValueOnce(
      new Error("Request timeout: engine disconnected"),
    );
    vi.mocked(workspaceGet).mockResolvedValue(target);
    vi.mocked(workspaceLifecycleStatus).mockResolvedValue({
      active: false,
      operation: null,
      phase: null,
      startedAt: null,
    });
    await archiveWorkspaceWithFeedback(target, dispatch);
    await vi.advanceTimersByTimeAsync(0);
    expect(workspaceGet).toHaveBeenCalledTimes(2);
    expect(visible()).toEqual([left, target, right]);
    expect(selectActiveFolder(useWorkspaceStore.getState())).toBe(left.path);
    expect(toast.error).toHaveBeenCalledOnce();
    expect(usePendingWorkspacesStore.getState().archivingIds).toEqual({});
  });
});
