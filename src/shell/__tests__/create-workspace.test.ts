import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Workspace } from "../../native/git";

// The create flow reaches the engine bridge and the workspace-list cache; both
// are stubbed so these cases pin decision logic, not transport.
const peekWorkspacesFor = vi.fn<(slug: string) => Workspace[] | undefined>();
const reloadWorkspacesFor = vi.fn<(slug: string) => Promise<boolean>>();
const workspacePrepareCreate = vi.fn();
const workspaceCreate = vi.fn();
const toastError = vi.fn();

vi.mock("../../zeros/store/use-projects", () => ({
  peekWorkspacesFor: (slug: string) => peekWorkspacesFor(slug),
  reloadWorkspacesFor: (slug: string) => reloadWorkspacesFor(slug),
  notifyWorkspacesChanged: vi.fn(),
  watchTimedOutWorkspaceCreate: vi.fn(),
}));
vi.mock("../../native/git", () => ({
  workspacePrepareCreate: (args: unknown) => workspacePrepareCreate(args),
  workspaceCreate: (args: unknown) => workspaceCreate(args),
  isGitErrorShape: (e: unknown) =>
    !!e && typeof e === "object" && "code" in (e as object),
  isWorkspaceOpStillRunning: () => false,
}));
vi.mock("../../zeros/ui/primitives/elements", () => ({
  toast: {
    error: (...a: unknown[]) => toastError(...a),
    info: vi.fn(),
    success: vi.fn(),
  },
}));
vi.mock("../../zeros/agent/agent-history-client", () => ({
  dbDeleteChat: vi.fn(async () => {}),
}));
vi.mock("../../zeros/analytics/agent-events", () => ({
  trackWorkspaceOpened: vi.fn(),
}));
vi.mock("../../zeros/store/pending-workspaces", () => ({
  beginPendingCreate: vi.fn(() => "token"),
  finishPendingCreate: vi.fn(),
  markWorkspaceSettling: vi.fn(),
  clearWorkspaceSettling: vi.fn(),
}));
vi.mock("../../zeros/store/spawn-default-chat", () => ({
  spawnPreparedDefaultChat: vi.fn(() => ({ id: "chat-1", agentId: null })),
}));

const { createWorkspaceForProject, repoNeedsFirstWorkspace } = await import(
  "../create-workspace"
);

function workspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: "ws_1",
    repoSlug: "zeros",
    repoRoot: "/repo",
    branch: "zeros/echium-a872",
    baseBranch: "main",
    path: "/worktrees/echium",
    status: "in-progress",
    createdAt: 1,
    archivedAt: null,
    stashRef: null,
    prNumber: null,
    prState: null,
    prUrl: null,
    agentId: null,
    lastActiveAt: null,
    ...overrides,
  } as Workspace;
}

const project = {
  id: "proj_1",
  name: "Zeros",
  repoRoot: "/repo",
  repoSlug: "zeros",
  originUrl: null,
  addedAt: 1,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("repoNeedsFirstWorkspace — the auto-create-on-add guard", () => {
  it("says no when a warm list already has a live row", async () => {
    peekWorkspacesFor.mockReturnValue([workspace()]);
    expect(await repoNeedsFirstWorkspace("zeros")).toBe(false);
    expect(reloadWorkspacesFor).not.toHaveBeenCalled();
  });

  it("says yes for an all-archived repo", async () => {
    // Archiving the last workspace deliberately leaves the repo empty — but a
    // later re-add should still be allowed to fork a fresh one.
    peekWorkspacesFor.mockReturnValue([workspace({ archivedAt: 123 })]);
    expect(await repoNeedsFirstWorkspace("zeros")).toBe(true);
  });

  it("distinguishes a warm-but-empty list from a cold one", async () => {
    // Warm and empty answers immediately; cold MUST load first, or "cache not
    // populated yet" would read as "no workspaces" and fork a duplicate.
    peekWorkspacesFor.mockReturnValue([]);
    expect(await repoNeedsFirstWorkspace("zeros")).toBe(true);
    expect(reloadWorkspacesFor).not.toHaveBeenCalled();

    vi.clearAllMocks();
    peekWorkspacesFor.mockReturnValueOnce(undefined).mockReturnValue([
      workspace(),
    ]);
    reloadWorkspacesFor.mockResolvedValue(true);
    expect(await repoNeedsFirstWorkspace("zeros")).toBe(false);
    expect(reloadWorkspacesFor).toHaveBeenCalledWith("zeros");
  });

  it("retries a mid-reconnect read instead of guessing", async () => {
    // A zeros:// deep link force-reconnects the bridge in the same tick, so the
    // first list read genuinely lands while the socket is down.
    peekWorkspacesFor.mockReturnValue(undefined);
    reloadWorkspacesFor
      .mockRejectedValueOnce(new Error("disconnected"))
      .mockImplementation(async () => {
        peekWorkspacesFor.mockReturnValue([]);
        return true;
      });
    expect(await repoNeedsFirstWorkspace("zeros")).toBe(true);
    expect(reloadWorkspacesFor.mock.calls.length).toBeGreaterThan(1);
  });

  it("fails CLOSED when the list stays unreadable", async () => {
    // Never create on a guess: a spurious worktree is a real directory and a
    // real branch to clean up, while a missed auto-create is one "+" click.
    peekWorkspacesFor.mockReturnValue(undefined);
    reloadWorkspacesFor.mockRejectedValue(new Error("disconnected"));
    expect(await repoNeedsFirstWorkspace("zeros")).toBe(false);
  });
});

describe("createWorkspaceForProject", () => {
  it("reports not-navigated and publishes nothing when prepare fails", async () => {
    // The contract the add paths depend on: a false return means the user was
    // never moved, so the caller still owns where they land. Prepare is where
    // an unborn HEAD / not-a-repo / no-engine is rejected, before any optimistic UI.
    workspacePrepareCreate.mockRejectedValue({
      code: "VALIDATION_FAILED",
      message: "this repository has no commits yet",
    });
    expect(await createWorkspaceForProject({ project, dispatch: vi.fn() })).toBe(
      false,
    );
    expect(workspaceCreate).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith(
      expect.stringContaining("no commits yet"),
      expect.anything(),
    );
  });

  it("reports navigated once the destination is published", async () => {
    workspacePrepareCreate.mockResolvedValue({
      workspaceId: "ws_1",
      path: "/worktrees/echium",
      repoSlug: "zeros",
      branch: "zeros/echium-a872",
    });
    workspaceCreate.mockResolvedValue({ status: "in-progress" });
    reloadWorkspacesFor.mockResolvedValue(true);
    peekWorkspacesFor.mockReturnValue([workspace({ id: "ws_1" })]);
    expect(await createWorkspaceForProject({ project, dispatch: vi.fn() })).toBe(
      true,
    );
    expect(workspaceCreate).toHaveBeenCalledWith(
      expect.objectContaining({ preparedId: "ws_1" }),
    );
  });
});
