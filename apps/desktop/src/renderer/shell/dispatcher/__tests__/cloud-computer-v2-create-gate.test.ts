import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "../../../state/projects-store";
import type { CloudComputerV2State } from "@zeros/protocol/cloud-computer-v2";
import {
  computerBuild,
  computerOrg,
  computerState,
  computerUser,
} from "../../../features/settings/__tests__/cloud-computer-v2-fixtures";

const state = vi.hoisted(() => ({
  feature: true,
  role: "developer" as string | null,
  organizationRole: "admin",
  personal: false,
  snapshot: undefined as CloudComputerV2State | undefined,
  error: null as Error | null,
  reads: [] as { key: string | null; enabled: boolean }[],
  warm: vi.fn(),
  dispatch: vi.fn(),
}));
vi.mock("../../../features/team/team-store", () => ({
  useTeams: () => ({
    me: { user: { id: computerUser, staffRole: state.role } },
  }),
  useActiveOrganization: () => ({
    id: computerOrg,
    isPersonal: state.personal,
    role: state.organizationRole,
    workspaceCapabilities: { local: state.personal, cloud: !state.personal },
  }),
  getTeamStoreState: () => ({ me: { user: { id: computerUser } } }),
  getOrganizationStoreGeneration: () => 0,
}));
vi.mock("../../../features/settings/internal-features", () => ({
  useInternalFeatureActive: () =>
    state.feature &&
    (state.role === "developer" || state.role === "platform_owner"),
}));
vi.mock(
  "../../../features/settings/cloud-computer-v2-client",
  async (original) => ({
    ...(await original<
      typeof import("../../../features/settings/cloud-computer-v2-client")
    >()),
    prefetchCloudComputerV2: state.warm,
  }),
);
vi.mock("../../../platform/cloud-workspaces", () => ({
  cloudAccountRequest: vi.fn(),
  getCloudWorkspaceCreateOptions: vi.fn(),
}));
vi.mock("../../../state/store", () => ({
  useWorkspaceDispatch: () => state.dispatch,
}));
vi.mock("../../../state/use-cached-read", () => ({
  useCachedRead: (
    _cache: unknown,
    key: string | null,
    _fetch: unknown,
    options: { enabled?: boolean },
  ) => {
    state.reads.push({ key, enabled: options.enabled ?? key !== null });
    if (key === "desktop") return { data: { enabled: true } };
    if (key && [4, 6].includes(JSON.parse(key).length))
      return {
        data: {
          configured: true,
          installations: [{ id: computerOrg }],
          repository: {
            owner: "example",
            name: "project",
            defaultBranch: "main",
          },
        },
      };
    if (!key) return { data: undefined, error: null };
    return { data: state.snapshot, error: state.error };
  },
}));
import { useCloudCreate } from "../cloud-create";
import {
  CloudComputerV2CreateNotice,
  useCloudComputerV2CreateGate,
} from "../../../features/settings/cloud-computer-v2-create-gate";

const project = {
  id: "project",
  repoRoot: `cloud://${computerOrg}/22222222-2222-4222-8222-222222222222`,
  originUrl: "https://github.com/example/project.git",
} as Project;
function readGate(active = true) {
  let result!: ReturnType<typeof useCloudComputerV2CreateGate>;
  function Probe() {
    result = useCloudComputerV2CreateGate(active);
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  return result;
}
function create(active = true) {
  let result!: ReturnType<typeof useCloudCreate>;
  function Probe() {
    result = useCloudCreate(project, null, active);
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  return result;
}
beforeEach(() => {
  state.feature = true;
  state.role = "developer";
  state.organizationRole = "admin";
  state.personal = false;
  state.snapshot = computerState();
  state.error = null;
  state.reads = [];
  state.warm.mockReset();
});

describe("first-build cloud create admission", () => {
  it("removes the admin Settings action on current organization demotion despite a warm canManage", () => {
    expect(readGate().canManage).toBe(true);
    state.organizationRole = "member";
    expect(readGate().canManage).toBe(false);
    expect(readGate().required).toBe(true);
  });
  it("disables both create modes before a first successful active template and offers admins the Settings destination", () => {
    const result = create();
    expect(result.reason).toBe("Build your Cloud Computer first");
    expect(result.computerRequired).toBe(true);
    const html = renderToStaticMarkup(
      createElement(CloudComputerV2CreateNotice, {
        required: true,
        canManage: true,
        warm: result.warmComputer,
      }),
    );
    expect(html).toContain("Open Cloud Computer settings");
    state.snapshot = computerState({
      state: "failed",
      latestBuild: computerBuild({ state: "failed" }),
    });
    expect(create().reason).toBe("Build your Cloud Computer first");
  });

  it("keeps active vN creation available during unbuilt changes and another build", () => {
    state.snapshot = computerState({
      state: "building",
      active: computerBuild(),
      activeRepositories: [{ id: "123", owner: "example", name: "project", installationId: computerOrg }],
      unbuiltChanges: true,
      latestBuild: computerBuild({ state: "running" }),
    });
    expect(create().reason).toBeNull();
  });

  it("fails closed while the exact org is cold or its first read fails", () => {
    state.snapshot = undefined;
    expect(create().reason).toBe("Checking Cloud Computer…");
    state.error = new Error("offline");
    expect(create().reason).toContain("could not be checked");
  });

  it("retains a confirmed active snapshot when revalidation fails", () => {
    state.snapshot = computerState({
      state: "active",
      active: computerBuild(),
      activeRepositories: [{ id: "123", owner: "example", name: "project", installationId: computerOrg }],
    });
    state.error = new Error("offline");
    expect(create().reason).toBeNull();
  });

  it("gates v2 reads, intent warming and guidance on staff, flag, owner, and activity", () => {
    readGate().warm();
    expect(state.warm).toHaveBeenCalledWith(computerUser, computerOrg);
    for (const [feature, role, personal, active] of [
      [false, "developer", false, true],
      [true, null, false, true],
      [true, "support_admin", false, true],
      [true, "developer", true, true],
      [true, "developer", false, false],
    ] as const) {
      state.feature = feature;
      state.role = role;
      state.personal = personal;
      state.reads = [];
      state.warm.mockReset();
      const gate = readGate(active);
      gate.warm();
      expect(state.reads.every((row) => !row.enabled)).toBe(true);
      expect(state.warm).not.toHaveBeenCalled();
      if (!feature || !role || role === "support_admin" || personal)
        expect(gate.reason).toBeNull();
    }
  });

  it("keeps legacy creation unchanged when v2 is off and directs members to an admin", () => {
    state.feature = false;
    expect(create().reason).toBeNull();
    state.feature = true;
    const html = renderToStaticMarkup(
      createElement(CloudComputerV2CreateNotice, {
        required: true,
        canManage: false,
        warm: vi.fn(),
      }),
    );
    expect(html).toContain("Ask an organization admin");
    expect(html).not.toContain("Open Cloud Computer settings");
  });
});
