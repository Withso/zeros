import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudComputerV2State } from "@zeros/protocol/cloud-computer-v2";
import {
  computerBuild,
  computerOrg,
  computerState,
  computerUser,
  otherComputerOrg,
} from "../../../features/settings/__tests__/cloud-computer-v2-fixtures";
import { ControlPlaneError } from "../../../features/team/control-plane";
import type { Project } from "../../../state/projects-store";

const state = vi.hoisted(() => ({
  snapshot: undefined as CloudComputerV2State | undefined,
  enabled: true,
  personal: false,
  org: "",
  user: "",
  reads: [] as (string | null)[],
  refresh: vi.fn(),
}));
vi.mock("../../../features/team/team-store", () => ({
  useActiveOrganization: () => ({
    id: state.org,
    defaultTeamId: state.org,
    isPersonal: state.personal,
    workspaceCapabilities: { cloud: !state.personal, local: state.personal },
  }),
  useTeams: () => ({ me: { user: { id: state.user } } }),
}));
vi.mock("../../../features/settings/cloud-computer-v2-create-gate", () => ({
  useCloudComputerV2CreateGate: () => ({
    enabled: state.enabled && !state.personal,
    key:
      state.enabled && !state.personal
        ? JSON.stringify([state.user, state.org])
        : null,
    reason: null,
    required: false,
    canManage: true,
    warm: vi.fn(),
    snapshot: { data: state.snapshot, refresh: state.refresh },
  }),
}));
vi.mock("../../../state/use-cached-read", () => ({
  useCachedRead: (_cache: unknown, key: string | null) => {
    state.reads.push(key);
    return key === "desktop"
      ? { data: { enabled: true } }
        : key && [4, 6].includes(JSON.parse(key).length)
        ? {
            data: {
              configured: true,
              installations: [{ id: "other-installation" }],
              repository: {
                owner: "example",
                name: "project",
                defaultBranch: "trunk",
              },
            },
          }
        : { data: undefined };
  },
}));
import { useCloudCreate } from "../cloud-create";
import {
  cloudCreateRequest,
  refreshChangedCloudComputer,
} from "../cloud-create-request";
import { computerBranchBase } from "../cloud-computer-source";
import {
  parseComputerRepositorySelections,
  rememberComputerRepository,
} from "../cloud-computer-repository-selection";

const first = {
  id: "123",
  owner: "example",
  name: "project",
  installationId: computerOrg,
};
const second = {
  id: "456",
  owner: "example",
  name: "another",
  installationId: otherComputerOrg,
};
function create(
  project: Project | null = null,
  source: Parameters<typeof useCloudCreate>[3] = null,
) {
  let result!: ReturnType<typeof useCloudCreate>;
  function Probe() {
    result = useCloudCreate(project, null, true, source);
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  return result;
}
beforeEach(() => {
  state.enabled = true;
  state.personal = false;
  state.org = computerOrg;
  state.user = computerUser;
  state.snapshot = computerState({
    state: "active",
    active: computerBuild(),
    activeRepositories: [first, second],
    draft: {
      ...computerState().draft,
      repositories: [
        { ...first, requestedRef: null },
        { ...second, requestedRef: null },
        {
          id: "789",
          owner: "example",
          name: "unbuilt",
          installationId: computerOrg,
          requestedRef: null,
        },
      ],
    },
  });
  state.reads = [];
  state.refresh.mockReset();
  rememberComputerRepository(JSON.stringify([computerUser, computerOrg]), null);
});
describe("Create from the active Cloud Computer", () => {
  it("creates without a local project, lists only active repositories, and defaults to the remote default", () => {
    const result = create();
    expect(result).toMatchObject({
      reason: null,
      computerMode: true,
      computerRepository: first,
      computerRepositories: [first, second],
      revision: "refs/heads/trunk",
      installationId: first.installationId,
    });
    expect(state.reads.at(-1)).toBeNull();
    expect(cloudCreateRequest(result)).toEqual({
      organizationId: computerOrg,
      teamId: computerOrg,
      repository: {
        forge: "github.com",
        owner: "example",
        name: "project",
        revision: "refs/heads/trunk",
        githubInstallationId: first.installationId,
      },
    });
  });
  it("restores by user and organization synchronously and falls back when the saved repository is removed", () => {
    create().selectComputerRepository(second.id);
    expect(create().computerRepository).toBe(second);
    state.org = otherComputerOrg;
    expect(create().computerRepository).toBe(first);
    state.org = computerOrg;
    expect(create().computerRepository).toBe(second);
    state.user = otherComputerOrg;
    expect(create().computerRepository).toBe(first);
    state.user = computerUser;
    state.snapshot!.activeRepositories = [first];
    expect(create().computerRepository).toBe(first);
  });
  it("maps remote branches and PRs, retains source intent through rebuilds, and fences it by repository owner", () => {
    const initial = create();
    expect(
      create(null, {
        owner: initial.sourceOwner!,
        base: computerBranchBase("feature/topic"),
      }).revision,
    ).toBe("refs/heads/feature/topic");
    const source = {
      owner: initial.sourceOwner!,
      base: {
        kind: "pr",
        source: "github",
        branch: "topic",
        label: "#7",
        prNumber: 7,
      },
    } as const;
    expect(cloudCreateRequest(create(null, source))?.repository.revision).toBe(
      "refs/pull/7/head",
    );
    state.snapshot!.active = computerBuild({
      version: 2,
      id: otherComputerOrg,
    });
    expect(create(null, source).revision).toBe("refs/pull/7/head");
    state.org = otherComputerOrg;
    expect(create(null, source).revision).toBe("refs/heads/trunk");
  });
  it("keeps legacy project creation when the flag is off and hides computer mode for Personal", () => {
    state.enabled = false;
    const project = {
      repoRoot: `cloud://${computerOrg}/${computerOrg}`,
      originUrl: "https://github.com/example/project.git",
    } as Project;
    const result = create(project);
    expect(result).toMatchObject({
      reason: null,
      computerMode: false,
      installationId: "other-installation",
    });
    expect(cloudCreateRequest(result)).not.toHaveProperty("cloudComputerBuild");
    state.enabled = true;
    state.personal = true;
    expect(create().computerMode).toBe(false);
  });
  it.each([
    "cloud_computer_repository_not_configured",
    "cloud_computer_build_required",
    "cloud_computer_template_unavailable",
    "cloud_computer_changed",
  ])("maps %s to an inline refresh message and revalidates", (code) => {
    expect(
      refreshChangedCloudComputer(
        new ControlPlaneError(409, code, "changed"),
        state.refresh,
      ),
    ).toBe("Cloud Computer changed — refresh");
    expect(state.refresh).toHaveBeenCalledOnce();
  });
  it("preserves other error handling", () => {
    for (const error of [
      new Error("offline"),
      new ControlPlaneError(403, "cloud_computer_changed", "forbidden"),
      new ControlPlaneError(409, "other", "other"),
    ])
      expect(refreshChangedCloudComputer(error, state.refresh)).toBeNull();
    expect(state.refresh).not.toHaveBeenCalled();
  });
  it("bounds and type-guards persisted owner selections", () => {
    const rows = Array.from({ length: 150 }, (_, i) => [
      JSON.stringify([
        computerUser,
        `11111111-1111-4111-8111-${String(i).padStart(12, "0")}`,
      ]),
      String(i + 1),
    ]);
    const parsed = parseComputerRepositorySelections([
      ...rows,
      ["invalid", "1"],
      [JSON.stringify([computerUser, computerOrg]), "bad"],
      null,
    ]);
    expect(parsed.size).toBe(128);
    expect([...parsed.values()][0]).toBe("23");
    expect(parseComputerRepositorySelections({})).toEqual(new Map());
  });
});
