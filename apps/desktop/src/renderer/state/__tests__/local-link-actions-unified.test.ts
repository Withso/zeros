import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../../config/release-channel", async (original) => ({
  ...(await original<typeof import("../../config/release-channel")>()),
  isFeatureEnabled: () => true,
}));
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

describe("Copy Local link with unified-workspaces", () => {
  it("offers and copies a Personal Local workspace's link under any organization", async () => {
    state.owner = "org-one";
    expect(useCanCopyLocalLink(workspace)).toBe(true);
    await copyLocalLink({ ...workspace, number: 310 } as Workspace);
    expect(state.copy).toHaveBeenLastCalledWith("zeros-alpha://local/w/310");
  });

  it.each([{ organizationId: "org-one" }, { placement: "cloud" }, { path: "cloud://org/ws" }])(
    "still refuses an organization-owned or cloud row: %j",
    async (patch) => {
      state.owner = "org-one";
      const row = { ...workspace, ...patch } as Workspace;
      expect(useCanCopyLocalLink(row)).toBe(false);
      await copyLocalLink(row);
      expect(state.copy).not.toHaveBeenCalled();
    },
  );

  it("still refuses over a cloud transport", () => {
    state.owner = "org-one";
    state.bridge.executionIdentity.kind = "cloud";
    expect(useCanCopyLocalLink(workspace)).toBe(false);
  });
});
