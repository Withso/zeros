import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ proof: vi.fn(), fetch: vi.fn() }));
vi.mock("../cloud-github", () => ({ authorizeCloudGithubSource: api.proof }));
vi.mock("../../features/auth/auth-store", () => ({
  getSession: async () => ({ access_token: "fixture-session" }),
}));
vi.mock("../../features/team/team-store", () => ({
  getOrganizationStoreGeneration: () => 1,
}));
vi.mock("../../features/team/control-plane", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../features/team/control-plane")
  >()),
  CONTROL_PLANE_URL: "https://api.example.test",
}));
vi.mock("../../features/update/control-plane-fetch", () => ({
  controlPlaneFetch: api.fetch,
}));
import { getCloudWorkspaceCreateOptions } from "../cloud-workspaces";

const org = "11111111-1111-4111-8111-111111111111";
const options = {
  configured: true,
  installations: [{ id: org, accountLogin: "example" }],
  repository: { owner: "example", name: "project", defaultBranch: "trunk" },
};
beforeEach(() => {
  api.proof.mockReset();
  api.fetch.mockReset();
  api.fetch.mockImplementation(async () => Response.json(options));
});
describe("Cloud create source metadata", () => {
  it("uses the active computer org grant without requiring desktop GitHub access", async () => {
    api.proof.mockRejectedValue(
      new Error("Desktop GitHub access is unavailable"),
    );
    await expect(
      getCloudWorkspaceCreateOptions(org, "example", "project"),
    ).resolves.toEqual(options);
    expect(api.proof).not.toHaveBeenCalled();
    expect(api.fetch.mock.calls[0][0]).toBe(
      `https://api.example.test/v1/organizations/${org}/cloud-workspaces/create-options?owner=example&repository=project&cloudComputerV2=true`,
    );
  });
  it("uses the organization computer grant by default without a desktop GitHub proof", async () => {
    api.proof.mockRejectedValue(new Error("proof missing"));
    await expect(
      getCloudWorkspaceCreateOptions(org, "example", "project"),
    ).resolves.toEqual(options);
    expect(api.proof).not.toHaveBeenCalled();
    expect(api.fetch.mock.calls[0][0]).toContain("cloudComputerV2=true");
    expect(api.fetch).toHaveBeenCalledOnce();
  });
});
