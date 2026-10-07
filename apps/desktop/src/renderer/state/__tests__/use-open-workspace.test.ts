import { beforeEach, describe, expect, it, vi } from "vitest";

const dispatch = vi.fn();
const hydrateChat = vi.fn();
const spawnDefaultChatForWorkspace = vi.fn();
const prefetchWorkspaceSurface = vi.fn();
const prepareChatView = vi.fn();
const selectChatToRestoreForFolder = vi.fn();
const pendingWorkspaceMode = vi.fn();
const wake = vi.hoisted(() => ({ enabled: true, signedIn: true, entitled: true, request: vi.fn() }));
vi.mock("../../features/settings/internal-features", () => ({ useInternalFeatureActive: () => wake.enabled }));
vi.mock("../../features/team/team-store", () => ({
  getOrganizationStoreGeneration: () => 0,
  getTeamStoreState: () => ({ me: wake.signedIn ? {
    user: { id: "nonstaff-member", staffRole: null },
    organizations: [{ id: "11111111-1111-4111-8111-111111111111", isPersonal: false, workspaceCapabilities: { cloud: wake.entitled } }],
    teams: [],
  } : null }),
  useTeams: () => ({ me: wake.signedIn ? {
    user: { id: "nonstaff-member", staffRole: null },
    organizations: [{ id: "11111111-1111-4111-8111-111111111111", isPersonal: false, workspaceCapabilities: { cloud: wake.entitled } }],
    teams: [],
  } : null }),
}));
vi.mock("../cloud-workspace-open-intent", () => ({ requestCloudWorkspaceOpen: wake.request }));

vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useCallback: <T extends (...args: never[]) => unknown>(callback: T) =>
    callback,
}));
vi.mock("../../features/agent/sessions-hooks", () => ({
  useAgentSessions: () => ({ hydrateChat }),
}));
vi.mock("../spawn-default-chat", () => ({
  spawnDefaultChatForWorkspace: (...args: unknown[]) =>
    spawnDefaultChatForWorkspace(...args),
}));
vi.mock("../store", () => ({
  selectChatToRestoreForFolder: (...args: unknown[]) =>
    selectChatToRestoreForFolder(...args),
  useWorkspaceDispatch: () => dispatch,
  useWorkspaceStore: { getState: () => ({}) },
}));
vi.mock("../../shell/prefetch-workspace-surface", () => ({
  prefetchWorkspaceSurface: (...args: unknown[]) =>
    prefetchWorkspaceSurface(...args),
}));
vi.mock("../../shell/conversation/chat-intent", () => ({
  prepareChatView: (...args: unknown[]) => prepareChatView(...args),
}));
vi.mock("../pending-workspaces", () => ({
  pendingWorkspaceMode: (...args: unknown[]) => pendingWorkspaceMode(...args),
}));
const { useOpenWorkspace } = await import("../use-open-workspace");

beforeEach(() => {
  vi.clearAllMocks();
  pendingWorkspaceMode.mockReturnValue(null);
  wake.enabled = true; wake.signedIn = true; wake.entitled = true;
});

describe("useOpenWorkspace", () => {
  it.each(["code", "design"] as const)("keeps Local %s navigation free of Cloud open intents for a signed-in member", kind => {
    selectChatToRestoreForFolder.mockReturnValue("saved-chat");
    const open = useOpenWorkspace();
    for (const path of ["/personal/local", "/organization/local"]) {
      open({ id: path, path, repoRoot: path, kind });
    }
    expect(wake.request).not.toHaveBeenCalled();
  });
  it("publishes a nonstaff member's cloud open intent without enabling the retired preference", () => {
    wake.enabled = false;
    const folder = "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
    selectChatToRestoreForFolder.mockReturnValue("saved-chat");
    useOpenWorkspace()({ id: folder, path: folder, repoRoot: folder, kind: "code" });
    expect(wake.request).toHaveBeenCalledExactlyOnceWith(folder);
  });
  it("publishes the exact destination before requesting a wake on explicit cloud open", () => {
    const folder = "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
    selectChatToRestoreForFolder.mockReturnValue("saved-chat");
    const open = useOpenWorkspace();
    expect(wake.request).not.toHaveBeenCalled();
    open({ id: folder, path: folder, repoRoot: folder, kind: "code" });
    expect(wake.request).toHaveBeenCalledExactlyOnceWith(folder);
    expect(dispatch.mock.invocationCallOrder[0]).toBeLessThan(wake.request.mock.invocationCallOrder[0]);
  });
  it.each(["signed-out", "no-entitlement", "archive"])("does not request compute for a cloud open blocked by %s", reason => {
    const folder = "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
    wake.signedIn = reason !== "signed-out";
    wake.entitled = reason !== "no-entitlement";
    selectChatToRestoreForFolder.mockReturnValue("saved-chat");
    useOpenWorkspace()({ id: folder, path: folder, repoRoot: folder, ...(reason === "archive" ? { archivedAt: 100 } : {}) });
    expect(wake.request).not.toHaveBeenCalled();
  });
  it("waits for cloud conversation discovery before creating an Untitled tab", () => {
    const folder = "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
    selectChatToRestoreForFolder.mockReturnValue(null);
    useOpenWorkspace()({ id: folder, path: folder, repoRoot: folder, kind: "code" });
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "OPEN_WORKSPACE", folder, chatHydrationPending: true }));
    expect(spawnDefaultChatForWorkspace).not.toHaveBeenCalled();
  });
  it.each([{ archivedAt: 100 }, { present: false }])(
    "opens history without creating a chat or preparing a live surface: %j",
    (availability) => {
      selectChatToRestoreForFolder.mockReturnValue(null);
      useOpenWorkspace()({
        id: "history",
        kind: "code",
        path: "/workspaces/history",
        repoRoot: "/repo",
        ...availability,
      });
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "OPEN_WORKSPACE",
          folder: "/workspaces/history",
          chatId: null,
        }),
      );
      expect(spawnDefaultChatForWorkspace).not.toHaveBeenCalled();
      expect(prefetchWorkspaceSurface).not.toHaveBeenCalled();
      expect(prepareChatView).not.toHaveBeenCalled();
    },
  );

  it("hydrates the saved chat for a missing workspace without preparing an agent view", () => {
    selectChatToRestoreForFolder.mockReturnValue("saved-chat");
    useOpenWorkspace()({
      id: "history",
      path: "/workspaces/history",
      repoRoot: "/repo",
      present: false,
    });
    expect(hydrateChat).toHaveBeenCalledWith("saved-chat");
    expect(prepareChatView).not.toHaveBeenCalled();
    expect(spawnDefaultChatForWorkspace).not.toHaveBeenCalled();
  });

  it("opens a public Design destination directly", () => {
    useOpenWorkspace()({
      id: "ws_design",
      kind: "design",
      path: "/design workspaces/zeros/landing-page",
      repoRoot: "/repo",
    });

    expect(prefetchWorkspaceSurface).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledWith({
      type: "OPEN_WORKSPACE",
      folder: "/design workspaces/zeros/landing-page",
      repoRoot: "/repo",
      chatId: null,
      validationPending: undefined,
    });
    expect(selectChatToRestoreForFolder).not.toHaveBeenCalled();
    expect(hydrateChat).not.toHaveBeenCalled();
    expect(spawnDefaultChatForWorkspace).not.toHaveBeenCalled();
  });

  it("never restores, hydrates, or spawns coding chat for a design destination", () => {
    // Old builds may have persisted a chat against this path. It stays dormant:
    // a design route must not revive the coding harness while chat is hidden.
    selectChatToRestoreForFolder.mockReturnValue("legacy-design-chat");

    useOpenWorkspace()({
      id: "ws_design",
      kind: "design",
      path: "/design workspaces/zeros/landing-page",
      repoRoot: "/repo",
    });

    expect(prefetchWorkspaceSurface).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledWith({
      type: "OPEN_WORKSPACE",
      folder: "/design workspaces/zeros/landing-page",
      repoRoot: "/repo",
      chatId: null,
      validationPending: undefined,
    });
    expect(selectChatToRestoreForFolder).not.toHaveBeenCalled();
    expect(hydrateChat).not.toHaveBeenCalled();
    expect(prepareChatView).not.toHaveBeenCalled();
    expect(spawnDefaultChatForWorkspace).not.toHaveBeenCalled();
  });

  it("keeps coding chat mounted while a Code-to-Design request is in flight", () => {
    pendingWorkspaceMode.mockReturnValue("design");
    selectChatToRestoreForFolder.mockReturnValue("stale-code-chat");

    useOpenWorkspace()({
      id: "ws_switching_design",
      kind: "code",
      path: "/workspaces/zeros/switching-design",
      repoRoot: "/repo",
    });

    expect(pendingWorkspaceMode).toHaveBeenCalledWith("ws_switching_design");
    expect(dispatch).toHaveBeenCalledWith({
      type: "OPEN_WORKSPACE",
      folder: "/workspaces/zeros/switching-design",
      repoRoot: "/repo",
      chatId: "stale-code-chat",
      validationPending: undefined,
      workspaceListFilter: undefined,
    });
    expect(selectChatToRestoreForFolder).toHaveBeenCalledOnce();
    expect(hydrateChat).toHaveBeenCalledWith("stale-code-chat");
    expect(prepareChatView).toHaveBeenCalledWith("stale-code-chat");
    expect(spawnDefaultChatForWorkspace).not.toHaveBeenCalled();
  });

  it("preserves the existing exact-chat restoration behavior for code workspaces", () => {
    selectChatToRestoreForFolder.mockReturnValue("code-chat");

    useOpenWorkspace()({
      id: "ws_code",
      kind: "code",
      path: "/workspaces/zeros/code-workspace",
      repoRoot: "/repo",
    });

    expect(selectChatToRestoreForFolder).toHaveBeenCalledOnce();
    expect(hydrateChat).toHaveBeenCalledWith("code-chat");
    expect(prepareChatView).toHaveBeenCalledWith("code-chat");
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: "code-chat" }),
    );
    expect(spawnDefaultChatForWorkspace).not.toHaveBeenCalled();
  });
});
