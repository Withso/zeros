import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudWorkspaceDocument } from "../../platform/cloud-workspaces";
import { describeWorkspaceAvailability } from "../../shell/workbench/tab-status-model";

const api = vi.hoisted(() => ({ lifecycle: vi.fn(), recover: vi.fn() }));
vi.mock("../../platform/cloud-workspaces", async importOriginal => ({
  ...await importOriginal<typeof import("../../platform/cloud-workspaces")>(),
  changeCloudWorkspaceLifecycle: api.lifecycle, recoverCloudWorkspace: api.recover,
}));
import {
  acceptCloudWorkspaceDocument, canBackgroundSyncCloudWorkspace, canReadCloudWorkspace,
  clearCloudWorkspaceCatalog, cloudCatalogNeedsFastRefresh, getCloudWorkspaceRows,
  manageCloudWorkspace, manageCloudWorkspaceRecovery,
} from "../cloud-workspace-catalog";

const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
const refusal = { code: "cloud_workspace_v2_required", message: "This workspace uses a retired cloud runtime — create a new workspace." };
function document(status = "ready"): CloudWorkspaceDocument {
  return {
    id: target.workspaceId, organizationId: target.organizationId, teamId: target.organizationId,
    name: "Retained workspace", createdBy: target.organizationId, placement: "cloud", status, version: 1,
    capabilities: { canWrite: true, canManage: true, canStart: false, startUnavailableReason: refusal.code },
    error: refusal, setupFailure: null, deletedAt: null,
    createdAt: "2026-09-26T00:00:00Z", updatedAt: "2026-09-26T00:00:00Z",
    repository: { forge: "github.com", owner: "example", name: "fixture", revision: "main" },
    generation: { number: 1, architecture: "linux/amd64", observedState: "running", lastObservedAt: null,
      resources: { cpuMillicores: 2000, memoryMiB: 4096, storageMiB: 20480 } },
  };
}

beforeEach(() => { clearCloudWorkspaceCatalog(); vi.clearAllMocks(); });
describe("retired cloud runtime representation", () => {
  it("retains catalog/history identity while refusing background engine sync", () => {
    const doc = document(); acceptCloudWorkspaceDocument(doc);
    expect(canReadCloudWorkspace(doc)).toBe(true);
    expect(getCloudWorkspaceRows()).toHaveLength(1);
    expect(canBackgroundSyncCloudWorkspace(target)).toBe(false);
  });
  it("does not keep an unsupported queued setup on fast polling", () => {
    acceptCloudWorkspaceDocument(document("setting_up"));
    expect(cloudCatalogNeedsFastRefresh()).toBe(false);
  });
  it("refuses wake and recovery before submitting execution actions", async () => {
    acceptCloudWorkspaceDocument(document("stopped"));
    await expect(manageCloudWorkspace(target, "wake")).rejects.toMatchObject({ code: refusal.code });
    await expect(manageCloudWorkspaceRecovery(target, { sourceGeneration: 1, checkpointId: target.workspaceId })).rejects.toMatchObject({ code: refusal.code });
    expect(api.lifecycle).not.toHaveBeenCalled(); expect(api.recover).not.toHaveBeenCalled();
  });
  it("preserves explicit resource deletion for a retired generation", async () => {
    acceptCloudWorkspaceDocument(document("stopped"));
    api.lifecycle.mockResolvedValue({ ...document("deleted"), deletedAt: "2026-09-26T00:01:00Z", version: 2 });
    await manageCloudWorkspace(target, "delete");
    expect(api.lifecycle).toHaveBeenCalledWith(target, "delete", expect.any(String));
  });
  it.each(["ready", "setting_up", "stopped", "failed", "archived"])("shows a terminal banner without Retry for %s", state => {
    expect(describeWorkspaceAvailability({ cloud: true, state, stopError: refusal, setupFailed: true, connection: "disconnected", since: 0 }, 60_000))
      .toEqual({ tone: "error", message: refusal.message });
  });
  it("preserves Local connection handling for the same foreign error code", () => {
    expect(describeWorkspaceAvailability({ cloud: false, stopError: refusal, connection: "disconnected", since: 0 }, 60_000))
      .toMatchObject({ action: "Retry", message: "Can't reach the Zeros engine." });
  });
});
