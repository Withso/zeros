import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../../platform/git";
import type { Project } from "../projects-store";

const state = vi.hoisted(() => ({
  enabled: true,
  owner: null as string | null,
  generation: 0,
  bridge: { executionIdentity: { kind: "local" } },
  copy: vi.fn(),
  projects: vi.fn(),
  scheme: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock("../../features/settings/agent-control-rollout", () => ({
  isAgentControlFeatureActive: () => state.enabled,
  useAgentControlFeatureActive: () => state.enabled,
}));
vi.mock("../../features/team/team-store", () => ({
  getActiveOrganizationIdSnapshot: () => state.owner,
  getOrganizationStoreGeneration: () => state.generation,
  useActiveOrganization: () => ({
    id: state.owner,
    isPersonal: state.owner == null,
  }),
}));
vi.mock("../../platform/bridge/active-bridge", () => ({
  getActiveBridge: () => state.bridge,
}));
vi.mock("../../platform/bridge/workspace-bridge", () => ({
  requestProjectList: state.projects,
}));
vi.mock("../../platform/local-links", () => ({
  resolveLocalLinkScheme: state.scheme,
}));
vi.mock("../../shared/lib/clipboard", () => ({
  copyToClipboardWithFallback: state.copy,
}));
vi.mock("../../shared/ui/primitives/elements", () => ({ toast: state.toast }));
import { copyLocalLink, useCanCopyLocalLink } from "../local-link-actions";
import {
  isPersonalLocalLinkWorkspace,
  localLinkWorkspaceId,
} from "../local-link-scope";

const workspace = {
  id: "ws_one",
  path: "/worktree",
  repoRoot: "/repo",
  repoSlug: "repo",
  organizationId: null,
  placement: "local",
  archivedAt: null,
} as Workspace;
const projects = [{ id: "proj_123456789abc", repoRoot: "/repo" }] as Project[];

beforeEach(() => {
  vi.clearAllMocks();
  state.enabled = true;
  state.owner = null;
  state.generation = 0;
  state.bridge = { executionIdentity: { kind: "local" } };
  state.scheme.mockResolvedValue("zeros-alpha");
  state.projects.mockResolvedValue(projects);
  state.copy.mockResolvedValue(true);
});

describe("Copy Local link scope", () => {
  it.each([
    { organizationId: "org-one" },
    { placement: "cloud" },
    { path: "cloud://org/ws" },
    { repoRoot: "cloud://org/ws" },
    { archivedAt: 1 },
    { present: false },
  ])("hides and refuses a non-live Personal Local row: %j", async (patch) => {
    const row = { ...workspace, ...patch } as Workspace;
    expect(isPersonalLocalLinkWorkspace(row)).toBe(false);
    expect(useCanCopyLocalLink(row)).toBe(false);
    await copyLocalLink(row, "chat-one");
    expect(state.copy).not.toHaveBeenCalled();
  });

  it("shows for Local and tracks rollout, cloud transport, and owner switches", () => {
    expect(useCanCopyLocalLink(workspace)).toBe(true);
    state.owner = "org-one";
    expect(useCanCopyLocalLink(workspace)).toBe(false);
    state.owner = null;
    expect(useCanCopyLocalLink(workspace)).toBe(true);
    state.enabled = false;
    expect(useCanCopyLocalLink(workspace)).toBe(false);
    state.enabled = true;
    state.bridge.executionIdentity.kind = "cloud";
    expect(useCanCopyLocalLink(workspace)).toBe(false);
  });

  it("copies a managed workspace or chat with this channel's scheme", async () => {
    await copyLocalLink(workspace);
    expect(state.copy).toHaveBeenLastCalledWith(
      "zeros-alpha://workspace/ws_one",
    );
    await copyLocalLink(workspace, "chat-one");
    expect(state.copy).toHaveBeenLastCalledWith("zeros-alpha://chat/chat-one");
    expect(state.projects).not.toHaveBeenCalled();
  });

  it.each(["local:repo", "local-main"])(
    "maps %s through the engine project registry",
    async (id) => {
      const row = { ...workspace, id, path: "/repo" };
      expect(localLinkWorkspaceId(row, projects)).toBe(
        "folder:proj_123456789abc",
      );
      await copyLocalLink(row);
      expect(state.projects).toHaveBeenCalledWith(state.bridge);
      expect(state.copy).toHaveBeenCalledWith(
        "zeros-alpha://workspace/folder%3Aproj_123456789abc",
      );
    },
  );

  it("fails visibly when a folder no longer has an engine project", async () => {
    state.projects.mockResolvedValue([]);
    await copyLocalLink({ ...workspace, id: "local:repo" });
    expect(state.copy).not.toHaveBeenCalled();
    expect(state.toast.error).toHaveBeenCalled();
  });

  it("drops an asynchronous copy after the owner changes", async () => {
    state.scheme.mockImplementation(async () => {
      state.owner = "org-one";
      return "zeros";
    });
    await copyLocalLink(workspace);
    expect(state.copy).not.toHaveBeenCalled();
  });

  it("reports a failed clipboard write", async () => {
    state.copy.mockResolvedValue(false);
    await copyLocalLink(workspace);
    expect(state.toast.error).toHaveBeenCalled();
    expect(state.toast.success).not.toHaveBeenCalled();
  });
});
