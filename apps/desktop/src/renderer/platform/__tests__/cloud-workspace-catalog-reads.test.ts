import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const io = vi.hoisted(() => ({ fetch: vi.fn(), epoch: 1 }));
vi.mock("../../features/auth/auth-store", () => ({ getSession: async () => ({ access_token: "fixture-session" }) }));
vi.mock("../../features/update/control-plane-fetch", () => ({ controlPlaneFetch: io.fetch }));
vi.mock("../../features/team/control-plane", async original => ({
  ...await original<typeof import("../../features/team/control-plane")>(), CONTROL_PLANE_URL: "https://api.example.test",
}));
vi.mock("../../features/team/team-store", async original => ({
  ...await original<typeof import("../../features/team/team-store")>(), getOrganizationStoreGeneration: () => io.epoch,
}));
import { listCloudWorkspaceCatalogSnapshot, listCloudWorkspaceDocuments } from "../cloud-workspaces";

const org = "11111111-1111-4111-8111-111111111111";
beforeEach(() => { io.fetch.mockReset(); io.epoch++; });
afterEach(() => vi.restoreAllMocks());
describe("scoped catalog HTTP reads", () => {
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

  it("validates an organization before performing authenticated I/O", async () => {
    await expect(listCloudWorkspaceCatalogSnapshot("foreign/path")).rejects.toThrow();
    expect(io.fetch).not.toHaveBeenCalled();
  });
});
