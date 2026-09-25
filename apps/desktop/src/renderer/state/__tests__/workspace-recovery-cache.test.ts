import { afterEach, expect, it, vi } from "vitest";
import type { Workspace, WorkspaceRecoveryInfo } from "../../platform/git";

const request = vi.hoisted(() => vi.fn());
vi.mock("../../platform/git", () => ({ workspaceRecoveryInfo: request }));
import {
  prefetchWorkspaceRecovery,
  readWorkspaceRecovery,
  workspaceRecoveryCache,
  workspaceRecoveryKey,
} from "../workspace-recovery-cache";

const missing = (id: string, patch: Partial<Workspace> = {}) =>
  ({
    id,
    path: `/workspace/${id}`,
    repoRoot: "/repo",
    present: false,
    archivedAt: null,
    ...patch,
  }) as Workspace;
afterEach(() => {
  request.mockReset();
});

it("deduplicates intent and activation for the same exact recovery identity", async () => {
  let finish!: (value: WorkspaceRecoveryInfo) => void;
  request.mockImplementationOnce(
    () =>
      new Promise<WorkspaceRecoveryInfo>((resolve) => {
        finish = resolve;
      }),
  );
  const row = missing("shared");
  const key = workspaceRecoveryKey(row)!;
  prefetchWorkspaceRecovery(row);
  const opened = workspaceRecoveryCache.load(key, () =>
    readWorkspaceRecovery(key),
  );
  await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
  finish({ action: "restore", snapshotAt: 10 });
  expect(await opened).toEqual({ action: "restore", snapshotAt: 10 });
  expect(request).toHaveBeenCalledWith("shared");
});

it("isolates A → B → A and a changed path or snapshot from delayed recovery reads", async () => {
  let finishA!: (value: WorkspaceRecoveryInfo) => void;
  request.mockImplementation((id: string) =>
    id === "a"
      ? new Promise<WorkspaceRecoveryInfo>((resolve) => {
          finishA = resolve;
        })
      : Promise.resolve({ action: "none", snapshotAt: null }),
  );
  const a = workspaceRecoveryKey(missing("a"))!;
  const b = workspaceRecoveryKey(missing("b"))!;
  const pendingA = workspaceRecoveryCache.load(a, () =>
    readWorkspaceRecovery(a),
  );
  await workspaceRecoveryCache.load(b, () => readWorkspaceRecovery(b));
  finishA({ action: "locate", snapshotAt: null });
  await pendingA;
  expect(workspaceRecoveryCache.getSnapshot(b).data?.action).toBe("none");
  expect(workspaceRecoveryCache.getSnapshot(a).data?.action).toBe("locate");
  expect(workspaceRecoveryKey(missing("a", { path: "/relocated" }))).not.toBe(
    a,
  );
  expect(
    workspaceRecoveryKey(missing("a", { archiveSnapshot: "new" })),
  ).not.toBe(a);
  expect(workspaceRecoveryKey(missing("a", { present: true }))).toBeNull();
  expect(workspaceRecoveryKey(missing("a", { archivedAt: 10 }))).toBeNull();
});
