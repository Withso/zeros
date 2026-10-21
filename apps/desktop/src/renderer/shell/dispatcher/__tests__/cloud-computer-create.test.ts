import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudComputerRepository } from "../../../features/settings/cloud-computer-v2-create-gate";
import { ControlPlaneError } from "../../../features/team/control-plane";
import { computerOrg, computerRepository, computerUser, otherComputerOrg } from "./cloud-computer-fixtures";

const state = vi.hoisted(() => ({
  repositories: [] as CloudComputerRepository[] | null,
  enabled: true,
  personal: false,
  org: "",
  user: "",
  refresh: vi.fn(),
}));
vi.mock("../../../features/team/team-store", () => ({
  useActiveOrganization: () => ({
    id: state.org,
    isPersonal: state.personal,
    workspaceCapabilities: { cloud: !state.personal, local: state.personal },
  }),
  useTeams: () => ({ me: { user: { id: state.user } } }),
}));
vi.mock("../../../features/settings/cloud-computer-v2-create-gate", () => ({
  useCloudComputerV2CreateGate: () => {
    const enabled = state.enabled && !state.personal;
    return {
      enabled,
      key: enabled ? JSON.stringify([state.user, state.org]) : null,
      reason: !enabled ? null : state.repositories === null ? "Build your Cloud Computer first" : null,
      required: enabled && state.repositories === null,
      canManage: true,
      warm: vi.fn(),
      refresh: state.refresh,
      repositories: enabled ? state.repositories : undefined,
    };
  },
}));
vi.mock("../../../state/use-cached-read", () => ({
  useCachedRead: (_cache: unknown, key: string | null) => (key === "desktop" ? { data: { enabled: true } } : { data: undefined }),
}));
import { useCloudCreate } from "../cloud-create";
import { cloudCreateRequest, createCloudComputerRecovery, refreshChangedCloudComputer } from "../cloud-create-request";
import { computerBranchBase, computerPrBase } from "../cloud-computer-source";
import { parseComputerRepositorySelections, rememberComputerRepository } from "../cloud-computer-repository-selection";

const first = computerRepository("example", "project", "trunk");
const second = computerRepository("Example", "Another");
function create(source: Parameters<typeof useCloudCreate>[1] = null) {
  let result!: ReturnType<typeof useCloudCreate>;
  function Probe() {
    result = useCloudCreate(true, source);
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
  state.repositories = [first, second];
  state.refresh.mockReset();
  rememberComputerRepository(JSON.stringify([computerUser, computerOrg]), null);
});
describe("Create from the active Cloud Computer", () => {
  it("creates without a local project from the installed repositories and leaves the default branch to the server", () => {
    const result = create();
    expect(result).toMatchObject({
      reason: null,
      computerMode: true,
      computerRepository: first,
      computerRepositories: [first, second],
      baseBranch: null,
      defaultBranch: "trunk",
    });
    expect(cloudCreateRequest(result)).toEqual({
      organizationId: computerOrg,
      repository: { owner: "example", name: "project" },
    });
  });
  it("blocks creation until the organization has a live build or a repository", () => {
    state.repositories = null;
    expect(create().reason).toBe("Build your Cloud Computer first");
    expect(cloudCreateRequest(create())).toBeNull();
    state.repositories = [];
    expect(create().reason).toBe("Add a repository to your Cloud Computer.");
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
    state.repositories = [first];
    expect(create().computerRepository).toBe(first);
  });
  it("sends picked branches and pull requests as plain branch names, fenced by repository owner", () => {
    const owner = create().sourceOwner!;
    const branch = create({ owner, base: computerBranchBase("feature/topic") });
    expect(branch.baseBranch).toBe("feature/topic");
    expect(cloudCreateRequest(branch)).toEqual({
      organizationId: computerOrg,
      repository: { owner: "example", name: "project" },
      baseBranch: "feature/topic",
    });
    const pr = { owner, base: computerPrBase({ number: 7, title: "Topic", url: "https://github.com/example/project/pull/7", headBranch: "topic" }) };
    expect(create(pr).baseBranch).toBe("topic");
    state.org = otherComputerOrg;
    expect(create(pr).baseBranch).toBeNull();
  });
  it("hides computer mode for Personal", () => {
    state.personal = true;
    const result = create();
    expect(result.computerMode).toBe(false);
    expect(cloudCreateRequest(result)).toBeNull();
  });
  it.each(["cloud_computer_build_required", "repository_not_installed"])("maps %s to an inline refresh message and revalidates", code => {
    expect(refreshChangedCloudComputer(new ControlPlaneError(409, code, "changed"), state.refresh)).toBe("Cloud Computer changed — refresh");
    expect(state.refresh).toHaveBeenCalledOnce();
  });
  it("preserves other error handling", () => {
    for (const error of [
      new Error("offline"),
      new ControlPlaneError(403, "repository_not_installed", "forbidden"),
      new ControlPlaneError(409, "other", "other"),
    ])
      expect(refreshChangedCloudComputer(error, state.refresh)).toBeNull();
    expect(state.refresh).not.toHaveBeenCalled();
  });
  it("defers a hidden submit conflict and recovers once when its owner is visible", () => {
    const recovery = createCloudComputerRecovery();
    const owner = "repository-owner";
    const current = { active: false, owner, refresh: state.refresh };
    const error = new ControlPlaneError(409, "repository_not_installed", "changed");
    expect(recovery.recover(error, owner, current)).toBe("Cloud Computer changed — refresh");
    recovery.resume(current);
    expect(state.refresh).not.toHaveBeenCalled();
    recovery.resume({ ...current, active: true });
    expect(state.refresh).toHaveBeenCalledOnce();
    recovery.resume({ ...current, active: true });
    expect(state.refresh).toHaveBeenCalledOnce();
  });
  it("discards pending recovery across owner changes and fences late conflicts", () => {
    const recovery = createCloudComputerRecovery();
    const error = new ControlPlaneError(409, "cloud_computer_build_required", "changed");
    const current = { active: false, owner: "first-owner", refresh: state.refresh };
    recovery.recover(error, current.owner, current);
    recovery.resume({ ...current, active: true, owner: "second-owner" });
    recovery.recover(error, "first-owner", { ...current, active: true, owner: "second-owner" });
    recovery.resume({ ...current, active: true });
    expect(state.refresh).not.toHaveBeenCalled();
  });
  it("bounds and type-guards persisted owner selections", () => {
    const rows = Array.from({ length: 150 }, (_, i) => [
      JSON.stringify([computerUser, `11111111-1111-4111-8111-${String(i).padStart(12, "0")}`]),
      `example/repo-${i}`,
    ]);
    const parsed = parseComputerRepositorySelections([
      ...rows,
      ["invalid", "example/repo"],
      [JSON.stringify([computerUser, computerOrg]), "not a slug"],
      // Ids from the retired v1 Computer were numeric GitHub repository ids.
      [JSON.stringify([computerUser, computerOrg]), "123"],
      null,
    ]);
    expect(parsed.size).toBe(128);
    expect([...parsed.values()][0]).toBe("example/repo-22");
    expect(parseComputerRepositorySelections({})).toEqual(new Map());
  });
});
