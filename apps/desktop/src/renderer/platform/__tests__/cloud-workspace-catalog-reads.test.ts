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
  it("uses the membership route for every page while retaining the advertised watermark", async () => {
    io.fetch.mockResolvedValueOnce(Response.json({ workspaces: [], nextCursor: "next/page", catalogVersion: 7 }))
      .mockResolvedValueOnce(Response.json({ workspaces: [], nextCursor: null, catalogVersion: 8 }));
    await expect(listCloudWorkspaceCatalogSnapshot(org)).resolves.toEqual({ workspaces: [], catalogVersion: 8 });
    expect(io.fetch.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      `/v1/organizations/${org}/cloud-workspaces`, `/v1/organizations/${org}/cloud-workspaces`,
    ]);
    expect(new URL(String(io.fetch.mock.calls[1]![0])).searchParams.get("cursor")).toBe("next/page");
  });

  it("retains the original global list and marks mixed-version pages unproven", async () => {
    io.fetch.mockResolvedValue(Response.json({ workspaces: [], nextCursor: null }));
    await expect(listCloudWorkspaceCatalogSnapshot()).resolves.toEqual({ workspaces: [], catalogVersion: null });
    expect(new URL(String(io.fetch.mock.calls[0]![0])).pathname).toBe("/v1/cloud-workspaces");
    io.fetch.mockResolvedValue(Response.json({ workspaces: [], nextCursor: null }));
    await expect(listCloudWorkspaceDocuments(org)).resolves.toEqual([]);
    expect(new URL(String(io.fetch.mock.calls[1]![0])).pathname).toBe(`/v1/organizations/${org}/cloud-workspaces`);
  });

  it("validates an organization before performing authenticated I/O", async () => {
    await expect(listCloudWorkspaceCatalogSnapshot("foreign/path")).rejects.toThrow();
    expect(io.fetch).not.toHaveBeenCalled();
  });
});
