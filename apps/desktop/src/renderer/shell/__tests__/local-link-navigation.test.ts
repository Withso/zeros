import { beforeEach, describe, expect, it, vi } from "vitest";
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
import {
  navigateLocalLink,
  observeLocalLinkNavigation,
} from "../local-link-navigation";

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

describe("Local link navigation commit", () => {
  it("uses the normal Personal owner switch and one selection action", async () => {
    await navigateLocalLink(link, options());
    expect(state.selectOwner).toHaveBeenCalledWith("local-personal", true);
    expect(state.stop.mock.invocationCallOrder[0]).toBeLessThan(
      state.selectOwner.mock.invocationCallOrder[0]!,
    );
    expect(state.selectOwner.mock.invocationCallOrder[0]).toBeLessThan(
      state.dispatch.mock.invocationCallOrder[0]!,
    );
    expect(state.dispatch).toHaveBeenCalledExactlyOnceWith({
      type: "OPEN_LOCAL_LINK",
      workspace: snapshot.workspaces[0],
      folder: "/tree",
      chat: snapshot.chats[0],
    });
    expect(state.publish).toHaveBeenCalledExactlyOnceWith(
      snapshot.workspaces[0], snapshot.workspaces,
    );
    expect(state.publish.mock.invocationCallOrder[0]).toBeLessThan(
      state.dispatch.mock.invocationCallOrder[0]!,
    );
  });

  it("rechecks a link once when a workspace update supersedes its read", async () => {
    state.publish.mockReturnValueOnce(false);
    await navigateLocalLink(link, options());
    expect(state.read).toHaveBeenCalledTimes(2);
    expect(state.dispatch).toHaveBeenCalledOnce();
  });

  it("does not navigate or retry indefinitely through concurrent workspace changes", async () => {
    state.publish.mockReturnValue(false);
    await navigateLocalLink(link, options());
    expect(state.read).toHaveBeenCalledTimes(2);
    expect(state.selectOwner).not.toHaveBeenCalled();
    expect(state.dispatch).not.toHaveBeenCalled();
    expect(state.toast.error).toHaveBeenCalledWith(
      "Couldn't open that Local link. Try again in a moment.",
    );
  });

  it("drops a read after its navigation intent retires", async () => {
    state.read.mockImplementation(async () => {
      state.current = false;
      return snapshot;
    });
    await navigateLocalLink(link, options());
    expect(state.selectOwner).not.toHaveBeenCalled();
    expect(state.dispatch).not.toHaveBeenCalled();
    expect(state.toast.info).not.toHaveBeenCalled();
  });

  it("awaits ordinary project-cache recovery on a cold renderer", async () => {
    const recovered = state.projects;
    state.projects = [];
    state.recover.mockImplementation(async () => {
      state.projects = recovered;
      return true;
    });
    await navigateLocalLink(link, options());
    expect(state.refresh).toHaveBeenCalledOnce();
    expect(state.dispatch).toHaveBeenCalledOnce();
  });

  it("does not register or reveal a project explicitly removed from the renderer", async () => {
    state.projects = [];
    await navigateLocalLink(link, options());
    expect(state.dispatch).not.toHaveBeenCalled();
    expect(state.toast.info).toHaveBeenCalledWith(
      expect.stringContaining("couldn't be found"),
    );
  });

  it("does not reopen a tab closed locally while the native read was in flight", async () => {
    state.read.mockImplementation(async () => {
      state.chats = [{ ...snapshot.chats[0], archived: true }] as ChatThread[];
      return snapshot;
    });
    await navigateLocalLink(link, options());
    expect(state.dispatch).not.toHaveBeenCalled();
    expect(state.toast.info).toHaveBeenCalledWith(
      expect.stringContaining("couldn't be found"),
    );
  });

  it("does not navigate if the owner selection could not persist", async () => {
    state.selectOwner.mockImplementation(() => {});
    await navigateLocalLink(link, options());
    expect(state.dispatch).not.toHaveBeenCalled();
    expect(state.toast.info).toHaveBeenCalledWith(
      "Select Local to open this link.",
    );
  });

  it("drops a result when the rollout is switched off during the read", async () => {
    state.read.mockImplementation(async () => {
      state.enabled = false;
      return snapshot;
    });
    await navigateLocalLink(link, options());
    expect(state.selectOwner).not.toHaveBeenCalled();
    expect(state.dispatch).not.toHaveBeenCalled();
  });

  it("reports unavailable targets and read failures without acting", async () => {
    await navigateLocalLink({ ...link, id: "missing" }, options());
    expect(state.toast.info).toHaveBeenCalledWith(
      expect.stringContaining("couldn't be found"),
    );
    state.read.mockRejectedValue(new Error("internal database details"));
    await navigateLocalLink(link, options());
    expect(state.toast.error).toHaveBeenCalledWith(
      "Couldn't open that Local link. Try again in a moment.",
    );
    expect(state.selectOwner).not.toHaveBeenCalled();
    expect(state.dispatch).not.toHaveBeenCalled();
  });
});

describe("Local link intent retirement", () => {
  function observe() {
    const statuses = new Set<() => void>();
    const runtime = {
      status: "connected",
      onStatusChange: (listener: () => void) => {
        statuses.add(listener);
        return () => statuses.delete(listener);
      },
    };
    state.bridge = runtime as unknown as RuntimeClient;
    const retired = vi.fn();
    return {
      runtime,
      statuses,
      retired,
      observation: observeLocalLinkNavigation(state.bridge, retired),
    };
  }

  it("retires through owner A → B → A and removes every listener on dispose", () => {
    const { observation, statuses } = observe();
    expect(observation.current()).toBe(true);
    for (const owner of ["org-b", "org-one"]) {
      state.owner = owner;
      for (const listener of state.ownerListeners) listener();
    }
    expect(observation.current()).toBe(false);
    observation.dispose();
    expect(
      state.ownerListeners.size +
        state.navigationListeners.size +
        statuses.size,
    ).toBe(0);
  });

  it("allows boot hydration but retires on a later explicit selection", () => {
    const { observation, retired } = observe();
    for (const listener of state.navigationListeners) {
      listener(
        { activeChatId: "restored", navigationVersion: 0 },
        { activeChatId: null, navigationVersion: 0 },
      );
    }
    expect(observation.current()).toBe(true);
    expect(retired).not.toHaveBeenCalled();
    for (const listener of state.navigationListeners)
      listener({ navigationVersion: 1 }, { navigationVersion: 0 });
    expect(observation.current()).toBe(false);
    observation.dispose();
  });

  it("retires across a connection gap even if the same client reconnects", () => {
    const { observation, runtime, statuses } = observe();
    runtime.status = "disconnected";
    for (const listener of statuses) listener();
    runtime.status = "connected";
    expect(observation.current()).toBe(false);
    observation.dispose();
  });

  it.each(["account", "client", "new intent"])(
    "fences %s replacement",
    (change) => {
      const { observation } = observe();
      if (change === "account") state.generation++;
      else if (change === "client") state.bridge = null;
      else observation.dispose();
      expect(observation.current()).toBe(false);
      observation.dispose();
    },
  );
});
