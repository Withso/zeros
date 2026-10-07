import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ generation: 0, session: vi.fn() }));
vi.mock("../../features/auth/auth-store", () => ({ getSession: state.session }));
vi.mock("../../features/team/team-store", () => ({ getOrganizationStoreGeneration: () => state.generation }));
vi.mock("../../features/team/control-plane", () => ({
  CONTROL_PLANE_URL: "https://api.example.test", ControlPlaneError: class extends Error {
    constructor(public status: number, public code: string, message: string) { super(message); }
  },
}));
import { getCloudWorkspaceDetectedPorts, renameCloudWorkspace } from "../cloud-workspaces";
const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
const path = `https://api.example.test/v1/organizations/${target.organizationId}/cloud-workspaces/${target.workspaceId}`;
const ports = { version: 1, ...target, generation: 7, status: "ready", observedAt: null, ports: null };
const workspace = {
  id: target.workspaceId, organizationId: target.organizationId, teamId: target.organizationId, createdBy: target.organizationId,
  name: "New name", placement: "cloud", status: "ready", version: 2, error: null, deletedAt: null,
  createdAt: "2026-10-07T00:00:00Z", updatedAt: "2026-10-07T00:00:00Z",
  capabilities: { canWrite: true, canManage: true, canStart: false, startUnavailableReason: null },
  repository: { forge: "github.com", owner: "example", name: "repo", revision: "main" },
  generation: { number: 7, architecture: "linux/amd64", resources: { cpuMillicores: 2000, memoryMiB: 4096, storageMiB: 20480 }, observedState: "running", lastObservedAt: null },
};
beforeEach(() => { state.generation = 0; state.session.mockReset().mockResolvedValue({ access_token: "synthetic-session" }); });
afterEach(() => vi.unstubAllGlobals());
describe("cloud UI metadata HTTP facades", () => {
  it("uses the narrow persisted generation read and rejects foreign-generation replies", async () => {
    const fetcher = vi.fn(async () => Response.json(ports)); vi.stubGlobal("fetch", fetcher);
    expect(await getCloudWorkspaceDetectedPorts(target, 7)).toEqual(ports);
    expect(fetcher).toHaveBeenCalledWith(`${path}/detected-ports?generation=7`, expect.objectContaining({ method: "GET", cache: "no-store" }));
    fetcher.mockImplementation(async () => Response.json({ ...ports, generation: 8 }));
    await expect(getCloudWorkspaceDetectedPorts(target, 7)).rejects.toThrow("identity");
  });
  it("sends normalized metadata with CAS and a retry key to the workspace resource", async () => {
    const fetcher = vi.fn().mockImplementation(async () => Response.json({ workspace })); vi.stubGlobal("fetch", fetcher);
    expect(await renameCloudWorkspace(target, { name: "  New name  ", version: 1 }, "rename-fixture")).toMatchObject({ name: "New name", version: 2 });
    expect(fetcher).toHaveBeenCalledWith(path, expect.objectContaining({ method: "PATCH",
      body: JSON.stringify({ name: "New name", version: 1 }) }));
    expect(new Headers(fetcher.mock.calls[0][1].headers).get("Idempotency-Key")).toBe("rename-fixture");
    fetcher.mockImplementation(async () => Response.json({ workspace: { ...workspace, id: target.organizationId } }));
    await expect(renameCloudWorkspace(target, { name: "New name", version: 1 }, "rename-fixture")).rejects.toThrow("identity");
  });
  it("rejects Local placements and invalid names, versions, generations and retry keys before authentication", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const local = { organizationId: "local", workspaceId: "/local/checkout" };
    await expect(getCloudWorkspaceDetectedPorts(local, 1)).rejects.toThrow();
    await expect(renameCloudWorkspace(local, { name: "New", version: 1 }, "rename-fixture")).rejects.toThrow();
    await expect(getCloudWorkspaceDetectedPorts(target, 0)).rejects.toThrow();
    await expect(renameCloudWorkspace(target, { name: "New\t", version: 1 }, "rename-fixture")).rejects.toThrow();
    await expect(renameCloudWorkspace(target, { name: "New", version: -1 }, "rename-fixture")).rejects.toThrow();
    await expect(renameCloudWorkspace(target, { name: "New", version: 1 }, "bad key")).rejects.toThrow();
    expect(state.session).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
  });
  it("rejects replies after an account switch for either read or mutation", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { state.generation++; return Response.json(ports); }));
    await expect(getCloudWorkspaceDetectedPorts(target, 7)).rejects.toThrow("account changed");
    vi.stubGlobal("fetch", vi.fn(async () => { state.generation++; return Response.json({ workspace }); }));
    await expect(renameCloudWorkspace(target, { name: "New", version: 1 }, "rename-fixture")).rejects.toThrow("account changed");
  });
});
