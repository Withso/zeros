import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Me, OrganizationSummary } from "../../features/team/control-plane";

const fixture = vi.hoisted(() => ({ session: vi.fn(), fetch: vi.fn(), native: vi.fn(), me: null as Me | null }));
vi.mock("../../features/auth/auth-store", () => ({ getSession: fixture.session }));
vi.mock("../../features/update/control-plane-fetch", () => ({ controlPlaneFetch: fixture.fetch }));
vi.mock("../../features/team/team-store", () => ({
  getOrganizationStoreGeneration: () => 1,
  getTeamStoreState: () => ({ me: fixture.me }),
  useTeams: () => ({ me: fixture.me }),
}));
vi.mock("../runtime", () => ({ nativeInvoke: fixture.native }));

const org = { id: "11111111-1111-4111-8111-111111111111", isPersonal: false,
  workspaceCapabilities: { local: true, cloud: true } } as OrganizationSummary;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv("VITE_CONTROL_PLANE_URL", "https://api.example.test");
  fixture.session.mockResolvedValue({ access_token: "synthetic-session" });
  fixture.fetch.mockImplementation(async () => Response.json({ ok: true }));
  fixture.native.mockResolvedValue({ enabled: true });
  fixture.me = { user: { id: "synthetic-user" }, organizations: [org], teams: [org] } as Me;
});
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

describe.each(["beta", "stable"])("%s renderer cloud boundary", releaseChannel => {
  beforeEach(() => vi.stubEnv("VITE_ZEROS_CHANNEL", releaseChannel));

  it("denies account and guest cloud admission plus new cloud workspace creation", async () => {
    const { hasCloudWorkspaceAccountAccess } = await import("../../features/team/cloud-workspace-account-access");
    const { canCreateWorkspaceIn } = await import("../../features/team/organization-capabilities");
    expect(hasCloudWorkspaceAccountAccess(org.id)).toBe(false);
    fixture.me!.organizations = [];
    expect(hasCloudWorkspaceAccountAccess(org.id)).toBe(false);
    expect(canCreateWorkspaceIn(org, "cloud")).toBe(false);
    expect(canCreateWorkspaceIn(null, "local")).toBe(true);
    expect(canCreateWorkspaceIn({ ...org, isPersonal: true }, "local")).toBe(true);
  });

  it("refuses cloud requests before resolving a session or touching the network", async () => {
    const { cloudAccountRequest } = await import("../cloud-workspaces");
    for (const endpoint of ["/v1/cloud-agent-credentials", `/v1/organizations/${org.id}/cloud-computer/v2`,
      `/v1/organizations/${org.id}/cloud-workspaces`, "/v1/me"]) {
      await expect(cloudAccountRequest(endpoint, z.unknown())).rejects.toThrow(/not available.*channel/i);
    }
    expect(fixture.session).not.toHaveBeenCalled();
    expect(fixture.fetch).not.toHaveBeenCalled();
  });

  it("reports the native cloud capability as off without an IPC read", async () => {
    const { cloudWorkspaceCapability } = await import("../cloud-capability");
    await expect(cloudWorkspaceCapability()).resolves.toEqual({ enabled: false });
    expect(fixture.native).not.toHaveBeenCalled();
  });

  it("filters cached cloud rows without hiding Local or organization-local workspaces", async () => {
    const { filterRowsForOrganization } = await import("../../features/team/organization-capabilities");
    const local = { id: "local", organizationId: org.id, placement: "local" as const };
    const rows = [local, { id: "cloud", organizationId: org.id, placement: "cloud" as const }];
    expect(filterRowsForOrganization(rows, org)).toEqual([local]);
    expect(filterRowsForOrganization(rows, null)).toEqual([local]);
    expect(filterRowsForOrganization([local], org)).toEqual([local]);
  });
});

it.each(["dev", "alpha"])("keeps authenticated cloud reads available on %s", async releaseChannel => {
  vi.stubEnv("VITE_ZEROS_CHANNEL", releaseChannel);
  const { cloudAccountRequest } = await import("../cloud-workspaces");
  await expect(cloudAccountRequest(`/v1/organizations/${org.id}/cloud-workspaces`, z.object({ ok: z.literal(true) })))
    .resolves.toEqual({ ok: true });
  expect(fixture.fetch).toHaveBeenCalledOnce();
});
