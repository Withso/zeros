import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../../config/release-channel", async (original) => ({
  ...(await original<typeof import("../../config/release-channel")>()),
  isFeatureEnabled: () => true,
}));
import type { RuntimeClient } from "../../platform/bridge/ws-client";
import type { LocalLinkSnapshot } from "../../platform/local-link-snapshot";
import type { ChatThread } from "../../state/store";

const state = vi.hoisted(() => ({
  read: vi.fn(),
  enabled: true,
  owner: "org-one" as string | null,
  current: true,
  generation: 0,
  bridge: null as RuntimeClient | null,
  ownerListeners: new Set<() => void>(),
  navigationListeners: new Set<(next: unknown, previous: unknown) => void>(),
  dispatch: vi.fn(),
  selectOwner: vi.fn(),
  stop: vi.fn(),
  projects: [
    { id: "renderer-uuid", repoRoot: "/repo", repoSlug: "repo", name: "Repo" },
  ],
  recover: vi.fn(),
  refresh: vi.fn(),
  publish: vi.fn(),
  chats: [] as ChatThread[],
  toast: { info: vi.fn(), error: vi.fn() },
}));
vi.mock("../../platform/local-link-snapshot", () => ({
  readLocalLinkSnapshot: state.read,
}));
vi.mock("../../features/settings/agent-control-rollout", () => ({
  isAgentControlFeatureActive: () => state.enabled,
  useAgentControlFeatureActive: () => state.enabled,
}));
vi.mock("../../features/team/active-team", () => ({
  setActiveOrganizationSelection: state.selectOwner,
  subscribeActiveTeam: (listener: () => void) => {
    state.ownerListeners.add(listener);
    return () => state.ownerListeners.delete(listener);
  },
}));
vi.mock("../../features/team/team-store", () => ({
  getActiveOrganizationIdSnapshot: () => state.owner,
  getOrganizationStoreGeneration: () => state.generation,
  useTeams: vi.fn(),
}));
vi.mock("../../platform/bridge/active-bridge", () => ({
  getActiveBridge: () => state.bridge,
}));
vi.mock("../../platform/bridge/use-bridge", () => ({
  useBridge: vi.fn(),
  useBridgeStatus: vi.fn(),
}));
vi.mock("../../state/use-projects", () => ({
  peekProjects: () => state.projects,
  notifyProjectsChanged: state.refresh,
  beginLocalWorkspaceRead: () => state.publish,
}));
vi.mock("../../state/projects-store", async (original) => ({
  ...(await original<typeof import("../../state/projects-store")>()),
  syncProjectsToEngine: state.recover,
}));
vi.mock("../../state/store", () => ({
  useWorkspaceStore: {
    getState: () => ({
      dispatch: state.dispatch,
      chats: state.chats,
      activeChatId: null,
    }),
    subscribe: (listener: (next: unknown, previous: unknown) => void) => {
      state.navigationListeners.add(listener);
      return () => state.navigationListeners.delete(listener);
    },
  },
}));
vi.mock("../../shared/ui/primitives/elements", () => ({ toast: state.toast }));
vi.mock("../../state/use-open-workspace", () => ({ useOpenWorkspace: vi.fn() }));
vi.mock("../cloud-workspace-link-navigation", () => ({
  navigateCloudWorkspaceLink: vi.fn(),
}));
import { navigateLocalLink } from "../local-link-navigation";

const snapshot = {
  projects: [
    {
      id: "proj_123456789abc",
      repoRoot: "/repo",
      repoSlug: "repo",
      name: "Repo",
    },
  ],
  workspaces: [
    {
      id: "ws_one",
      repoRoot: "/repo",
      repoSlug: "repo",
      path: "/tree",
      archivedAt: null,
    },
  ],
  chats: [{ id: "chat_one", folder: "/tree", archived: false, kind: "chat" }],
} as LocalLinkSnapshot;
const bridge = { executionIdentity: { kind: "local" } } as RuntimeClient;
const link = { scheme: "zeros", kind: "chat", id: "chat_one" } as const;
const options = () => ({
  bridge,
  current: () => state.current,
  beforeCommit: state.stop,
  readChat: (row: unknown) => row as ChatThread,
});

beforeEach(() => {
  vi.clearAllMocks();
  state.enabled = true;
  state.owner = "org-one";
  state.current = true;
  state.chats = [];
  state.projects = [
    { id: "renderer-uuid", repoRoot: "/repo", repoSlug: "repo", name: "Repo" },
  ];
  state.generation = 0;
  state.ownerListeners.clear();
  state.navigationListeners.clear();
  state.recover.mockResolvedValue(false);
  state.read.mockResolvedValue(snapshot);
  state.publish.mockReturnValue(true);
  state.selectOwner.mockImplementation(() => {
    state.owner = null;
  });
});

describe("Local link navigation with unified-workspaces", () => {
  it.each(["org-one", null])("opens a Local link without switching the selected owner (%s)", async (owner) => {
    state.owner = owner;
    await navigateLocalLink(link, options());
    expect(state.selectOwner).not.toHaveBeenCalled();
    expect(state.owner).toBe(owner);
    expect(state.dispatch).toHaveBeenCalledExactlyOnceWith({
      type: "OPEN_LOCAL_LINK",
      workspace: snapshot.workspaces[0],
      folder: "/tree",
      chat: snapshot.chats[0],
    });
    expect(state.toast.info).not.toHaveBeenCalled();
  });
});
