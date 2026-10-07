import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ generation: 0, forget: vi.fn(), session: vi.fn() }));
vi.mock("../../features/auth/auth-store", () => ({ getSession: state.session }));
vi.mock("../../features/team/team-store", () => ({ getOrganizationStoreGeneration: () => state.generation }));
vi.mock("../cloud-workspace-access", async importOriginal => ({
  ...await importOriginal<typeof import("../cloud-workspace-access")>(), forgetCloudWorkspacePortForwarding: state.forget,
}));
vi.mock("../../features/team/control-plane", () => ({
  CONTROL_PLANE_URL: "https://api.example.test", ControlPlaneError: class extends Error {
    constructor(public status: number, public code: string, message: string) { super(message); }
  },
}));
import { changeCloudWorkspaceLifecycle } from "../cloud-workspaces";

const id = "11111111-1111-4111-8111-111111111111";
const target = { organizationId: id, workspaceId: id };
const workspace = {
  id, organizationId: id, teamId: id, createdBy: id, name: "Workspace", placement: "cloud", status: "deleting",
  desiredState: "deleted", version: 1, error: null, deletedAt: null,
  createdAt: "2026-10-07T00:00:00Z", updatedAt: "2026-10-07T00:00:00Z",
  capabilities: { canWrite: true, canManage: true, canStart: false, startUnavailableReason: "workspace_not_stopped" },
  repository: { forge: "github.com", owner: "example", name: "repo", revision: "main" },
  generation: { number: 1, architecture: "linux/amd64", resources: { cpuMillicores: 2000, memoryMiB: 4096, storageMiB: 20480 }, observedState: "running", lastObservedAt: null },
};
beforeEach(() => {
  state.generation = 0; state.forget.mockReset().mockResolvedValue(undefined);
  state.session.mockReset().mockResolvedValue({ access_token: "synthetic-session" });
});
afterEach(() => vi.unstubAllGlobals());

describe("confirmed cloud deletion preference cleanup", () => {
  it("forgets exactly the confirmed deletion target and preserves a successful deletion if native cleanup fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ workspace }, { status: 202 })));
    await changeCloudWorkspaceLifecycle(target, "delete", "delete-fixture");
    expect(state.forget).toHaveBeenCalledExactlyOnceWith(target);
    state.forget.mockRejectedValueOnce(new Error("Native runtime retired"));
    await expect(changeCloudWorkspaceLifecycle(target, "delete", "delete-replay")).resolves.toMatchObject({ id });
  });
  it("does not forget preferences for other lifecycle operations or a failed deletion", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ workspace })));
    await changeCloudWorkspaceLifecycle(target, "stop", "stop-fixture");
    expect(state.forget).not.toHaveBeenCalled();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: { code: "forbidden", message: "Access denied" } }, { status: 403 })));
    await expect(changeCloudWorkspaceLifecycle(target, "delete", "delete-denied")).rejects.toThrow();
    expect(state.forget).not.toHaveBeenCalled();
  });
  it("rejects foreign responses and account switches before native cleanup", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ workspace: { ...workspace, id: "22222222-2222-4222-8222-222222222222" } })));
    await expect(changeCloudWorkspaceLifecycle(target, "delete", "delete-foreign")).rejects.toThrow("identity");
    vi.stubGlobal("fetch", vi.fn(async () => { state.generation++; return Response.json({ workspace }); }));
    await expect(changeCloudWorkspaceLifecycle(target, "delete", "delete-late")).rejects.toThrow("account changed");
    expect(state.forget).not.toHaveBeenCalled();
  });
});
