import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Workspace } from "../../platform/git";

// The create flow reaches the engine bridge and the workspace-list cache; both
// are stubbed so these cases pin decision logic, not transport.
const peekWorkspacesFor = vi.fn<(slug: string) => Workspace[] | undefined>();
const reloadWorkspacesFor = vi.fn<(slug: string) => Promise<boolean>>();
const reloadWorkspaceRowsFor =
  vi.fn<(slug: string) => Promise<Workspace[] | null>>();
const workspacePrepareCreate = vi.fn();
const workspaceCreate = vi.fn();
const prepareProjectFolder = vi.fn();
vi.mock("../project-folder-setup", () => ({
  prepareProjectFolder: (root: string) => prepareProjectFolder(root),
}));
const spawnPreparedDefaultChat = vi.fn((_args: unknown) => ({
  id: "chat-1",
  agentId: null,
}));
const toastError = vi.fn();
const isNativeRuntime = vi.fn(() => true);
const isExpectedElectron = vi.fn(() => true);
const discardQueuedContextGraphWrites = vi.fn();
const selectedOrganization = vi.fn();
vi.mock("../../features/team/team-store", () => ({
  getActiveOrganizationSnapshot: () => selectedOrganization(),
  getActiveOrganizationIdSnapshot: () => selectedOrganization()?.id ?? null,
}));

vi.mock("../../state/use-projects", () => ({
  peekWorkspacesFor: (slug: string) => peekWorkspacesFor(slug),
  reloadWorkspacesFor: (slug: string) => reloadWorkspacesFor(slug),
  reloadWorkspaceRowsFor: (slug: string) => reloadWorkspaceRowsFor(slug),
  notifyWorkspacesChanged: vi.fn(),
  watchTimedOutWorkspaceCreate: vi.fn(),
}));
vi.mock("../../platform/git", () => ({
  workspacePrepareCreate: (args: unknown) => workspacePrepareCreate(args),
  workspaceCreate: (args: unknown) => workspaceCreate(args),
  isGitErrorShape: (e: unknown) =>
    !!e && typeof e === "object" && "code" in (e as object),
  isWorkspaceOpStillRunning: () => false,
}));
vi.mock("../../shared/ui/primitives/elements", () => ({
  toast: {
    error: (...a: unknown[]) => toastError(...a),
    info: vi.fn(),
    success: vi.fn(),
  },
}));
vi.mock("../../features/agent/agent-history-client", () => ({
  dbDeleteChat: vi.fn(async () => {}),
}));
vi.mock("../../features/agent/composer-editor/context-graph-staging", () => ({
  discardQueuedContextGraphWrites: (cwd: string) =>
    discardQueuedContextGraphWrites(cwd),
}));
vi.mock("../../platform/observability/analytics/agent-events", () => ({
  trackWorkspaceOpened: vi.fn(),
}));
vi.mock("../../state/pending-workspaces", () => ({
  beginPendingCreate: vi.fn(() => "token"),
  finishPendingCreate: vi.fn(),
  markWorkspaceSettling: vi.fn(),
  clearWorkspaceSettling: vi.fn(),
}));
vi.mock("../../state/spawn-default-chat", () => ({
  spawnPreparedDefaultChat: (args: unknown) => spawnPreparedDefaultChat(args),
}));
vi.mock("../../platform/runtime", () => ({
  isNativeRuntime: () => isNativeRuntime(),
  isExpectedElectron: () => isExpectedElectron(),
}));

const { createWorkspaceForProject, repoNeedsFirstWorkspace } =
  await import("../create-workspace");

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
  reloadWorkspacesFor.mockReset();
  reloadWorkspaceRowsFor.mockReset();
  selectedOrganization.mockReturnValue(null);
  prepareProjectFolder
    .mockReset()
    .mockResolvedValue({ isRepo: true, hasCommits: true });
  isNativeRuntime.mockReturnValue(true);
  isExpectedElectron.mockReturnValue(true);
});

describe("repoNeedsFirstWorkspace — the auto-create-on-add guard", () => {
  it("says no when a warm list already has a live row", async () => {
    peekWorkspacesFor.mockReturnValue([workspace()]);
    expect(await repoNeedsFirstWorkspace("zeros")).toBe(false);
    expect(reloadWorkspacesFor).not.toHaveBeenCalled();
  });

  it("needs a first workspace when the warm row belongs to another root", async () => {
    const left = workspace({
      repoSlug: "same-name",
      repoRoot: "/var/projects/left/same-name",
    });
    peekWorkspacesFor.mockReturnValue([left]);
    reloadWorkspaceRowsFor.mockResolvedValue([left]);
    expect(
      await repoNeedsFirstWorkspace(
        "same-name",
        "/private/var/projects/right/same-name",
      ),
    ).toBe(true);
    expect(reloadWorkspaceRowsFor).toHaveBeenCalledWith("same-name");
  });

  it("does not create when the authoritative refresh finds the requested root", async () => {
    const left = workspace({
      repoSlug: "same-name",
      repoRoot: "/var/projects/left/same-name",
    });
    const right = workspace({
      id: "ws_right",
      repoSlug: "same-name",
      repoRoot: "/var/projects/right/same-name",
    });
    peekWorkspacesFor
      .mockReturnValueOnce([left])
      .mockReturnValue([left, right]);
    reloadWorkspaceRowsFor.mockResolvedValue([left, right]);

    expect(
      await repoNeedsFirstWorkspace(
        "same-name",
        "/private/var/projects/right/same-name",
      ),
    ).toBe(false);
    expect(reloadWorkspaceRowsFor).toHaveBeenCalledOnce();
  });

  it("allows creation only after authoritative refresh confirms the root is missing", async () => {
    const left = workspace({
      repoSlug: "same-name",
      repoRoot: "/var/projects/left/same-name",
    });
    peekWorkspacesFor.mockReturnValue([left]);
    reloadWorkspaceRowsFor.mockResolvedValue([left]);

    expect(
      await repoNeedsFirstWorkspace(
        "same-name",
        "/var/projects/right/same-name",
      ),
    ).toBe(true);
    expect(reloadWorkspaceRowsFor).toHaveBeenCalledOnce();
  });

  it("uses authoritative rows when a concurrent destination read narrows the slug cache", async () => {
    const left = workspace({
      repoSlug: "same-name",
      repoRoot: "/var/projects/left/same-name",
    });
    const right = workspace({
      id: "ws_right",
      repoSlug: "same-name",
      repoRoot: "/var/projects/right/same-name",
    });
    peekWorkspacesFor.mockReturnValue([left]);
    reloadWorkspacesFor.mockImplementation(async () => {
      peekWorkspacesFor.mockReturnValue([left]);
      return true;
    });
    reloadWorkspaceRowsFor.mockImplementation(async () => {
      peekWorkspacesFor.mockReturnValue([left]);
      return [left, right];
    });

    await expect(
      repoNeedsFirstWorkspace("same-name", right.repoRoot),
    ).resolves.toBe(false);
    expect(reloadWorkspaceRowsFor).toHaveBeenCalledOnce();
  });

  it("fails closed when refreshing a partial root cache fails", async () => {
    const left = workspace({
      repoSlug: "same-name",
      repoRoot: "/var/projects/left/same-name",
    });
    peekWorkspacesFor.mockReturnValue([left]);
    reloadWorkspaceRowsFor.mockRejectedValue(new Error("offline"));
    vi.useFakeTimers();

    try {
      const decision = repoNeedsFirstWorkspace(
        "same-name",
        "/var/projects/right/same-name",
      );
      await vi.runAllTimersAsync();
      await expect(decision).resolves.toBe(false);
      expect(reloadWorkspaceRowsFor).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("recognizes canonical aliases in a warm root-specific cache", async () => {
    peekWorkspacesFor.mockReturnValue([
      workspace({
        repoSlug: "same-name",
        repoRoot: "/private/var/projects/right/same-name",
      }),
    ]);

    expect(
      await repoNeedsFirstWorkspace(
        "same-name",
        "/var/projects/right/same-name",
      ),
    ).toBe(false);
    expect(reloadWorkspacesFor).not.toHaveBeenCalled();
  });

  it("says yes for an all-archived repo", async () => {
    // Archiving the last workspace deliberately leaves the repo empty — but a
    // later re-add should still be allowed to fork a fresh one.
    peekWorkspacesFor.mockReturnValue([workspace({ archivedAt: 123 })]);
    expect(await repoNeedsFirstWorkspace("zeros")).toBe(true);
  });

  it("ignores a live Design row when deciding whether the code create flow needs its first workspace", async () => {
    peekWorkspacesFor.mockReturnValue([
      workspace({ id: "ws_design", kind: "design" }),
    ]);
    expect(await repoNeedsFirstWorkspace("zeros")).toBe(true);
    expect(reloadWorkspacesFor).not.toHaveBeenCalled();
  });

  it("distinguishes a warm-but-empty list from a cold one", async () => {
    // Warm and empty answers immediately; cold MUST load first, or "cache not
    // populated yet" would read as "no workspaces" and fork a duplicate.
    peekWorkspacesFor.mockReturnValue([]);
    expect(await repoNeedsFirstWorkspace("zeros")).toBe(true);
    expect(reloadWorkspacesFor).not.toHaveBeenCalled();

    vi.clearAllMocks();
    peekWorkspacesFor
      .mockReturnValueOnce(undefined)
      .mockReturnValue([workspace()]);
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
  it("routes organization creation to the cloud composer before local preparation", async () => {
    selectedOrganization.mockReturnValue({ id: "org_test", isPersonal: false });
    const dispatch = vi.fn();
    expect(await createWorkspaceForProject({ project, dispatch })).toBe(true);
    expect(dispatch).toHaveBeenCalledWith({ type: "OPEN_CREATE_PAGE", projectId: project.id });
    expect(workspacePrepareCreate).not.toHaveBeenCalled();
    expect(workspaceCreate).not.toHaveBeenCalled();
    expect(prepareProjectFolder).not.toHaveBeenCalled();
    expect(spawnPreparedDefaultChat).not.toHaveBeenCalled();
  });
  it("does not reserve, navigate or spawn a chat when automatic Git setup fails", async () => {
    prepareProjectFolder.mockRejectedValue(new Error("Git unavailable"));
    const dispatch = vi.fn();
    expect(await createWorkspaceForProject({ project, dispatch })).toBe(false);
    expect(workspacePrepareCreate).not.toHaveBeenCalled();
    expect(spawnPreparedDefaultChat).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith(
      expect.stringContaining("Git unavailable"),
    );
  });

  it("refuses Design creation outside the desktop runtime", async () => {
    isNativeRuntime.mockReturnValue(false);
    isExpectedElectron.mockReturnValue(false);

    expect(
      await createWorkspaceForProject({
        project,
        dispatch: vi.fn(),
        kind: "design",
      }),
    ).toBe(false);
    expect(workspacePrepareCreate).not.toHaveBeenCalled();
    expect(workspaceCreate).not.toHaveBeenCalled();
  });

  it("rechecks desktop availability after the asynchronous prepare boundary", async () => {
    workspacePrepareCreate.mockImplementation(async () => {
      isNativeRuntime.mockReturnValue(false);
      isExpectedElectron.mockReturnValue(false);
      return {
        workspaceId: "ws_design",
        path: "/design workspaces/zeros/landing-page",
        repoSlug: "zeros",
        branch: "zeros/design-landing-page",
      };
    });
    const dispatch = vi.fn();

    expect(
      await createWorkspaceForProject({ project, dispatch, kind: "design" }),
    ).toBe(false);
    expect(workspaceCreate).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("reports not-navigated and publishes nothing when prepare fails", async () => {
    // The contract the add paths depend on: a false return means the user was
    // never moved, so the caller still owns where they land. Prepare is where
    // an unborn HEAD / not-a-repo / no-engine is rejected, before any optimistic UI.
    workspacePrepareCreate.mockRejectedValue({
      code: "VALIDATION_FAILED",
      message: "this repository has no commits yet",
    });
    expect(
      await createWorkspaceForProject({ project, dispatch: vi.fn() }),
    ).toBe(false);
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
    expect(
      await createWorkspaceForProject({ project, dispatch: vi.fn() }),
    ).toBe(true);
    expect(workspaceCreate).toHaveBeenCalledWith(
      expect.objectContaining({ preparedId: "ws_1" }),
    );
    expect(workspacePrepareCreate.mock.calls[0]?.[0]).not.toHaveProperty(
      "kind",
    );
    expect(workspaceCreate.mock.calls[0]?.[0]).not.toHaveProperty("kind");
  });

  it("keeps concurrent same-slug creates scoped to their exact repository roots", async () => {
    const leftRoot = "/projects/left/same-name";
    const rightRoot = "/projects/right/same-name";
    const leftProject = {
      ...project,
      repoRoot: leftRoot,
      repoSlug: "same-name",
    };
    const rightProject = {
      ...project,
      repoRoot: rightRoot,
      repoSlug: "same-name",
    };
    workspacePrepareCreate.mockImplementation(
      async ({ repoRoot }: { repoRoot: string }) => ({
        workspaceId: repoRoot === leftRoot ? "ws_left" : "ws_right",
        path: repoRoot === leftRoot ? "/worktrees/left" : "/worktrees/right",
        repoSlug: "same-name",
        branch: repoRoot === leftRoot ? "zeros/left" : "zeros/right",
      }),
    );
    workspaceCreate.mockResolvedValue({ status: "in-progress" });
    reloadWorkspacesFor.mockResolvedValue(true);
    peekWorkspacesFor.mockReturnValue([
      workspace({ id: "ws_left", repoSlug: "same-name", repoRoot: leftRoot }),
      workspace({ id: "ws_right", repoSlug: "same-name", repoRoot: rightRoot }),
    ]);

    await expect(
      Promise.all([
        createWorkspaceForProject({
          project: leftProject,
          dispatch: vi.fn(),
          gitSetupComplete: true,
        }),
        createWorkspaceForProject({
          project: rightProject,
          dispatch: vi.fn(),
          gitSetupComplete: true,
        }),
      ]),
    ).resolves.toEqual([true, true]);
    expect(workspacePrepareCreate).toHaveBeenCalledWith({
      repoRoot: leftRoot,
      repoSlug: "same-name",
    });
    expect(workspacePrepareCreate).toHaveBeenCalledWith({
      repoRoot: rightRoot,
      repoSlug: "same-name",
    });
    expect(workspaceCreate).toHaveBeenCalledTimes(2);
    expect(workspaceCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        repoRoot: leftRoot,
        repoSlug: "same-name",
        preparedId: "ws_left",
      }),
    );
    expect(workspaceCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        repoRoot: rightRoot,
        repoSlug: "same-name",
        preparedId: "ws_right",
      }),
    );
  });

  it("discards context-graph bytes queued for a create that rolls back", async () => {
    workspacePrepareCreate.mockResolvedValue({
      workspaceId: "ws_failed",
      path: "/worktrees/failed",
      repoSlug: "zeros",
      branch: "zeros/failed-a872",
    });
    workspaceCreate.mockRejectedValue(new Error("checkout failed"));

    expect(
      await createWorkspaceForProject({ project, dispatch: vi.fn() }),
    ).toBe(true);
    expect(discardQueuedContextGraphWrites).toHaveBeenCalledWith(
      "/worktrees/failed",
    );
  });

  it("opens a design workspace without creating or attaching a coding-agent chat", async () => {
    workspacePrepareCreate.mockResolvedValue({
      workspaceId: "ws_design",
      path: "/design workspaces/zeros/landing-page",
      repoSlug: "zeros",
      branch: "zeros/design-landing-page",
    });
    workspaceCreate.mockResolvedValue({ status: "in-progress" });
    reloadWorkspacesFor.mockResolvedValue(true);
    peekWorkspacesFor.mockReturnValue([
      workspace({
        id: "ws_design",
        kind: "design",
        path: "/design workspaces/zeros/landing-page",
      }),
    ]);
    const dispatch = vi.fn();

    expect(
      await createWorkspaceForProject({ project, dispatch, kind: "design" }),
    ).toBe(true);

    expect(spawnPreparedDefaultChat).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith({
      type: "OPEN_WORKSPACE",
      folder: "/design workspaces/zeros/landing-page",
      repoRoot: "/repo",
      chatId: null,
      validationPending: true,
    });
    expect(workspaceCreate).toHaveBeenCalledWith(
      expect.not.objectContaining({ optimisticChatId: expect.anything() }),
    );
    expect(workspaceCreate).toHaveBeenCalledWith(
      expect.not.objectContaining({ agentId: expect.anything() }),
    );
    expect(workspacePrepareCreate).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "design" }),
    );
    expect(workspaceCreate).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "design" }),
    );
  });

  it("passes the dispatcher's selected base through a Design create", async () => {
    workspacePrepareCreate.mockResolvedValue({
      workspaceId: "ws_design",
      path: "/worktrees/design",
      repoSlug: "zeros",
      branch: "zeros/design",
    });
    workspaceCreate.mockResolvedValue({ status: "in-progress" });
    reloadWorkspacesFor.mockResolvedValue(true);
    peekWorkspacesFor.mockReturnValue([
      workspace({ id: "ws_design", kind: "design" }),
    ]);

    await createWorkspaceForProject({
      project,
      dispatch: vi.fn(),
      kind: "design",
      baseBranch: "feature/design-system",
    });

    expect(workspaceCreate).toHaveBeenCalledWith(
      expect.objectContaining({ baseBranch: "feature/design-system" }),
    );
  });
});
