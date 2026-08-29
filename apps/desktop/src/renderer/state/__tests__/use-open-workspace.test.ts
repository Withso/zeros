import { beforeEach, describe, expect, it, vi } from "vitest";

const dispatch = vi.fn();
const hydrateChat = vi.fn();
const spawnDefaultChatForWorkspace = vi.fn();
const prefetchWorkspaceSurface = vi.fn();
const prepareChatView = vi.fn();
const selectChatToRestoreForFolder = vi.fn();
const pendingWorkspaceMode = vi.fn();

vi.mock("react", () => ({
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
});

describe("useOpenWorkspace", () => {
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

  it("opens an in-flight Code-to-Design request without reviving coding chat", () => {
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
      chatId: null,
      validationPending: undefined,
    });
    expect(selectChatToRestoreForFolder).not.toHaveBeenCalled();
    expect(hydrateChat).not.toHaveBeenCalled();
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
