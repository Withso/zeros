import { beforeEach, describe, expect, it, vi } from "vitest";

const dispatch = vi.fn();
const hydrateChat = vi.fn();
const spawnDefaultChatForWorkspace = vi.fn();
const prefetchWorkspaceSurface = vi.fn();
const prepareColumn2ChatView = vi.fn();
const selectChatToRestoreForFolder = vi.fn();
const useInternalFeatureActive = vi.fn((_feature: string) => true);
const isInternalFeatureActive = vi.fn((_feature: string) => true);

vi.mock("react", () => ({
  useCallback: <T extends (...args: never[]) => unknown>(callback: T) =>
    callback,
}));
vi.mock("../../agent/sessions-hooks", () => ({
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
vi.mock("../../../shell/prefetch-workspace-surface", () => ({
  prefetchWorkspaceSurface: (...args: unknown[]) =>
    prefetchWorkspaceSurface(...args),
}));
vi.mock("../../../shell/column2-chat-intent", () => ({
  prepareColumn2ChatView: (...args: unknown[]) =>
    prepareColumn2ChatView(...args),
}));
vi.mock("../../settings/internal-features", () => ({
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
  it("keeps a design destination completely inert while its Internal gate is off", () => {
    useInternalFeatureActive.mockReturnValue(false);

    useOpenWorkspace()({
      id: "ws_design",
      kind: "design",
      path: "/design workspaces/zeros/landing-page",
      repoRoot: "/repo",
    });

    expect(useInternalFeatureActive).toHaveBeenCalledWith("designWorkspaces");
    expect(prefetchWorkspaceSurface).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(selectChatToRestoreForFolder).not.toHaveBeenCalled();
    expect(hydrateChat).not.toHaveBeenCalled();
    expect(spawnDefaultChatForWorkspace).not.toHaveBeenCalled();
  });

  it("rechecks the live gate when a previously-rendered callback runs", () => {
    isInternalFeatureActive.mockReturnValue(false);

    useOpenWorkspace()({
      id: "ws_design",
      kind: "design",
      path: "/design workspaces/zeros/landing-page",
      repoRoot: "/repo",
    });

    expect(isInternalFeatureActive).toHaveBeenCalledWith("designWorkspaces");
    expect(prefetchWorkspaceSurface).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
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
    expect(prepareColumn2ChatView).not.toHaveBeenCalled();
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
    expect(prepareColumn2ChatView).toHaveBeenCalledWith("code-chat");
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: "code-chat" }),
    );
    expect(spawnDefaultChatForWorkspace).not.toHaveBeenCalled();
  });
});
