import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudComputerRepository } from "../../../features/settings/cloud-computer-v2-create-gate";
import { computerOrg, computerRepository, computerUser } from "./cloud-computer-fixtures";

vi.mock("react", async original => ({ ...await original<typeof import("react")>(), useLayoutEffect: () => {} }));

const state = vi.hoisted(() => ({
  cloudChannel: true,
  organizationRole: "admin",
  personal: false,
  repositories: undefined as readonly CloudComputerRepository[] | null | undefined,
  error: null as Error | null,
  reads: [] as { key: string | null; enabled: boolean; fetch: (key: string) => unknown }[],
  installed: vi.fn(),
  dispatch: vi.fn(),
}));
vi.mock("../../../config/release-channel", async original => ({
  ...(await original<typeof import("../../../config/release-channel")>()),
  isFeatureEnabled: () => state.cloudChannel,
}));
vi.mock("../../../features/team/team-store", () => ({
  useTeams: () => ({ me: { user: { id: computerUser } } }),
  useActiveOrganization: () => ({
    id: computerOrg,
    isPersonal: state.personal,
    role: state.organizationRole,
    workspaceCapabilities: { local: state.personal, cloud: !state.personal },
  }),
}));
vi.mock("../../../platform/cloud-v2", () => ({ getCloudV2InstalledRepositories: state.installed }));
vi.mock("../../../state/store", () => ({ useWorkspaceDispatch: () => state.dispatch }));
vi.mock("../../../state/use-cached-read", () => ({
  useCachedRead: (_cache: unknown, key: string | null, fetch: (key: string) => unknown, options: { enabled?: boolean }) => {
    state.reads.push({ key, enabled: options.enabled ?? key !== null, fetch });
    if (!key) return { data: undefined, error: null, refresh: vi.fn() };
    return { data: state.repositories, error: state.error, refresh: vi.fn() };
  },
}));
import {
  CloudComputerV2CreateNotice,
  cloudComputerRepositoriesCache,
  useCloudComputerV2CreateGate,
} from "../../../features/settings/cloud-computer-v2-create-gate";

function readGate(active = true) {
  let result!: ReturnType<typeof useCloudComputerV2CreateGate>;
  function Probe() {
    result = useCloudComputerV2CreateGate(active);
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  return result;
}
beforeEach(() => {
  state.cloudChannel = true;
  state.organizationRole = "admin";
  state.personal = false;
  state.repositories = null;
  state.error = null;
  state.reads = [];
  state.installed.mockReset().mockResolvedValue(null);
  for (const key of cloudComputerRepositoriesCache.keys()) cloudComputerRepositoriesCache.forget(key);
});

describe("cloud create admission", () => {
  // Regression: the gate read the retired v1 Cloud Computer route, so every
  // create stayed blocked against the v2 control plane.
  it("reads the member-visible v2 repository list for the exact organization", async () => {
    const gate = readGate();
    expect(gate.key).toBe(JSON.stringify([computerUser, computerOrg]));
    const read = state.reads.find(row => row.key === gate.key)!;
    await read.fetch(gate.key!);
    expect(state.installed).toHaveBeenCalledWith(computerOrg);
  });
  it("keeps reads and warming dormant when the release channel disables cloud", () => {
    state.cloudChannel = false;
    const gate = readGate();
    expect(gate.enabled).toBe(false);
    expect(gate.key).toBeNull();
    gate.warm();
    expect(state.reads.every(read => read.key === null && !read.enabled)).toBe(true);
    expect(state.installed).not.toHaveBeenCalled();
  });
  it("requires a first build and offers admins the Settings destination", () => {
    const gate = readGate();
    expect(gate.reason).toBe("Build your Cloud Computer first");
    expect(gate.required).toBe(true);
    const html = renderToStaticMarkup(createElement(CloudComputerV2CreateNotice, { required: true, canManage: gate.canManage, warm: gate.warm }));
    expect(html).toContain("Open Cloud Computer settings");
  });
  it("directs members to an admin and follows a current demotion", () => {
    expect(readGate().canManage).toBe(true);
    state.organizationRole = "member";
    const gate = readGate();
    expect(gate.canManage).toBe(false);
    expect(gate.required).toBe(true);
    const html = renderToStaticMarkup(createElement(CloudComputerV2CreateNotice, { required: true, canManage: false, warm: vi.fn() }));
    expect(html).toContain("Ask an organization admin");
    expect(html).not.toContain("Open Cloud Computer settings");
  });
  it("admits creation from the live build's repositories", () => {
    state.repositories = [computerRepository("example", "project")];
    const gate = readGate();
    expect(gate.reason).toBeNull();
    expect(gate.repositories).toEqual([computerRepository("example", "project")]);
  });
  it("keeps creation pending while the exact organization is cold or its first read fails", () => {
    state.repositories = undefined;
    expect(readGate().reason).toBe("Checking Cloud Computer…");
    state.error = new Error("offline");
    expect(readGate().reason).toBe("Checking Cloud Computer…");
  });
  it("keeps a confirmed list when revalidation fails", () => {
    state.repositories = [computerRepository("example", "project")];
    state.error = new Error("offline");
    expect(readGate().reason).toBeNull();
  });
  it("gates reads and intent warming on owner and activity", () => {
    for (const [personal, active] of [[true, true], [false, false]] as const) {
      state.personal = personal;
      state.reads = [];
      state.installed.mockClear();
      const gate = readGate(active);
      gate.warm();
      expect(state.reads.every(row => !row.enabled)).toBe(true);
      expect(state.installed).not.toHaveBeenCalled();
      if (personal) expect(gate.reason).toBeNull();
    }
  });
});
