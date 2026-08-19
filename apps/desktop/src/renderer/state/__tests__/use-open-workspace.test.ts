import { beforeEach, describe, expect, it, vi } from "vitest";

const dispatch = vi.fn();
const hydrateChat = vi.fn();
const spawnDefaultChatForWorkspace = vi.fn();
const prefetchWorkspaceSurface = vi.fn();
const prepareChatView = vi.fn();
const selectChatToRestoreForFolder = vi.fn();
const useInternalFeatureActive = vi.fn((_feature: string) => true);
const isInternalFeatureActive = vi.fn((_feature: string) => true);

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
  prepareChatView: (...args: unknown[]) =>
    prepareChatView(...args),
}));
vi.mock("../../features/settings/internal-features", () => ({
  useInternalFeatureActive: (feature: string) =>
    useInternalFeatureActive(feature),
  isInternalFeatureActive: (feature: string) =>
    isInternalFeatureActive(feature),
}));

const { useOpenWorkspace } = await import("../use-open-workspace");

beforeEach(() => {
  vi.clearAllMocks();
  useInternalFeatureActive.mockReturnValue(true);
  isInternalFeatureActive.mockReturnValue(true);
});

describe("useOpenWorkspace", () => {
  it("opens a design destination even while the Internal gate is off (route renders the placeholder)", () => {
    // One workspace, two modes: refusing to open trapped the workspace with
    // no way to reach its un-gated "exit design mode" action. The route
    // itself decides between canvas and placeholder; opening never spawns or
    // revives a coding chat for a design destination either way.
    useInternalFeatureActive.mockReturnValue(false);
    isInternalFeatureActive.mockReturnValue(false);

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
