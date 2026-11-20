import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../../config/release-channel", async (original) => ({
  ...(await original<typeof import("../../config/release-channel")>()),
  isFeatureEnabled: () => true,
}));

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

const { createWorkspaceForProject } =
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

describe("createWorkspaceForProject with unified-workspaces", () => {
  it("creates an owner-less Local workspace for a local project under an organization", async () => {
    selectedOrganization.mockReturnValue({ id: "org_test", isPersonal: false });
    workspacePrepareCreate.mockResolvedValue({
      workspaceId: "ws_1",
      path: "/worktrees/echium",
      repoSlug: "zeros",
      branch: "zeros/echium-a872",
    });
    workspaceCreate.mockResolvedValue({ status: "in-progress" });
    reloadWorkspacesFor.mockResolvedValue(true);
    peekWorkspacesFor.mockReturnValue([workspace({ id: "ws_1" })]);
    const dispatch = vi.fn();
    expect(await createWorkspaceForProject({ project, dispatch })).toBe(true);
    expect(dispatch).not.toHaveBeenCalledWith({ type: "OPEN_CREATE_PAGE", projectId: project.id });
    expect(workspaceCreate).toHaveBeenCalledWith(
      expect.objectContaining({ preparedId: "ws_1", organizationId: null, placement: "local" }),
    );
  });

  it("still opens the cloud composer for a cloud project", async () => {
    selectedOrganization.mockReturnValue({ id: "org_test", isPersonal: false });
    const cloudProject = { ...project, repoRoot: "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222" };
    const dispatch = vi.fn();
    expect(await createWorkspaceForProject({ project: cloudProject, dispatch })).toBe(true);
    expect(dispatch).toHaveBeenCalledWith({ type: "OPEN_CREATE_PAGE", projectId: project.id });
    expect(workspacePrepareCreate).not.toHaveBeenCalled();
  });
});
