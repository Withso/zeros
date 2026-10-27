import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const io = vi.hoisted(() => ({ fetch: vi.fn(), epoch: 1, me: null as import("../../features/team/control-plane").Me | null }));
vi.mock("../../features/auth/auth-store", () => ({ getSession: async () => ({ access_token: "fixture-session" }) }));
vi.mock("../../features/update/control-plane-fetch", () => ({ controlPlaneFetch: io.fetch }));
vi.mock("../../features/team/control-plane", async original => ({
  ...await original<typeof import("../../features/team/control-plane")>(), CONTROL_PLANE_URL: "https://api.example.test",
}));
vi.mock("../../features/team/team-store", async original => ({
  ...await original<typeof import("../../features/team/team-store")>(), getOrganizationStoreGeneration: () => io.epoch,
  getTeamStoreState: () => ({ me: io.me }),
}));
import { listCloudWorkspaceCatalogSnapshot, listCloudWorkspaceDocuments } from "../cloud-workspaces";

const org = "11111111-1111-4111-8111-111111111111";
beforeEach(() => { io.fetch.mockReset(); io.epoch++; io.me = null; });
afterEach(() => vi.restoreAllMocks());
describe("scoped catalog HTTP reads", () => {
  it("does not turn cold membership into a confirmed empty catalog", async () => {
    await expect(listCloudWorkspaceCatalogSnapshot()).rejects.toThrow(/organization|membership/i);
    expect(io.fetch).not.toHaveBeenCalled();
  });

  it("reads every cloud-enabled organization beyond the old sixteen-owner cap", async () => {
    const organizations = Array.from({ length: 20 }, (_, index) => ({
      id: `${String(index + 1).padStart(8, "0")}-1111-4111-8111-111111111111`,
      name: `Organization ${index}`, slug: `org-${index}`, logo: null, role: "member" as const,
      isPersonal: false, defaultTeamId: null,
      workspaceCapabilities: { local: false, cloud: index !== 2 },
      teamCapabilities: { multiple: false as const, canCreate: false as const },
    }));
    io.me = { user: { id: "account", email: "account@example.test", displayName: null, staffRole: null }, organizations, teams: organizations };
    io.fetch.mockImplementation(() => Promise.resolve(Response.json({ workspaces: [] })));
    await listCloudWorkspaceCatalogSnapshot();
    expect(io.fetch.mock.calls.map(([url]) => new URL(String(url)).searchParams.get("organizationId")))
      .toEqual(organizations.filter(row => row.workspaceCapabilities.cloud).map(row => row.id));
  });
  it("reads each organization's v2 workspaces and maps them into shared documents", async () => {
    const row = { id: org, organizationId: org, creatorUserId: org, name: "zeros", repository: "withso/zeros", branch: "zeros/w",
      baseBranch: "main", state: "stopped", errorCode: null, createdAt: "2026-10-21T00:00:00Z", updatedAt: "2026-10-21T00:00:00Z",
      version: 2, capabilities: { design: false, browser: false, simulators: false, terminal: true, files: true, git: true, agents: ["codex"] } };
    io.fetch.mockResolvedValueOnce(Response.json({ workspaces: [row] }));
    const snapshot = await listCloudWorkspaceCatalogSnapshot(org);
    expect(snapshot.catalogVersion).toBeNull();
    expect(snapshot.workspaces.map(doc => [doc.id, doc.status, doc.capabilities.canStart])).toEqual([[org, "stopped", true]]);
    const url = new URL(String(io.fetch.mock.calls[0]![0]));
    expect([url.pathname, url.searchParams.get("organizationId")]).toEqual(["/v1/cloud-v2/workspaces", org]);
  });

  it("rejects a v2 page that returns another organization's workspace", async () => {
    io.fetch.mockResolvedValueOnce(Response.json({ workspaces: [{ id: org, organizationId: "22222222-2222-4222-8222-222222222222",
      creatorUserId: org, name: "x", repository: "o/r", branch: "b", baseBranch: "main", state: "running", errorCode: null,
      createdAt: "2026-10-21T00:00:00Z", updatedAt: "2026-10-21T00:00:00Z", version: 2,
      capabilities: { design: false, browser: false, simulators: false, terminal: true, files: true, git: true, agents: [] } }] }));
    await expect(listCloudWorkspaceDocuments(org)).rejects.toThrow("another organization");
  });

  it("marks a capped two-hundred-row observation incomplete", async () => {
    const rows = Array.from({ length: 200 }, (_, index) => ({
      id: `${String(index + 1).padStart(8, "0")}-2222-4222-8222-222222222222`, organizationId: org,
      creatorUserId: org, name: `Workspace ${index}`, repository: "example/fixture", branch: "b", baseBranch: "main",
      state: "stopped", errorCode: null, createdAt: "2026-10-21T00:00:00Z", updatedAt: "2026-10-21T00:00:00Z", version: 2,
      capabilities: { design: false, browser: false, simulators: false, terminal: true, files: true, git: true, agents: [] },
    }));
    io.fetch.mockResolvedValueOnce(Response.json({ workspaces: rows }));
    const snapshot = await listCloudWorkspaceCatalogSnapshot(org);
    expect(snapshot.workspaces).toHaveLength(200);
    expect(snapshot.complete).toBe(false);
  });

  it("rejects membership replacement while a global list is pending", async () => {
    const organizations = [{ id: org, slug: "fixture", name: "Fixture", logo: null, isPersonal: false, role: "member" as const,
      defaultTeamId: null, workspaceCapabilities: { local: false, cloud: true }, teamCapabilities: { multiple: false as const, canCreate: false as const } }];
    io.me = { user: { id: "account", email: "account@example.test", displayName: null, staffRole: null }, organizations, teams: organizations };
    let finish!: (response: Response) => void;
    io.fetch.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = listCloudWorkspaceCatalogSnapshot();
    await vi.waitFor(() => expect(io.fetch).toHaveBeenCalledOnce());
    io.me = { ...io.me, organizations: [], teams: [] };
    finish(Response.json({ workspaces: [] }));
    await expect(pending).rejects.toThrow("memberships changed");
  });

  it("validates an organization before performing authenticated I/O", async () => {
    await expect(listCloudWorkspaceCatalogSnapshot("foreign/path")).rejects.toThrow();
    expect(io.fetch).not.toHaveBeenCalled();
  });
});
