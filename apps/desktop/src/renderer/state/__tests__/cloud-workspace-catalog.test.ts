import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudWorkspaceDocument } from "../../platform/cloud-workspaces";
const api = vi.hoisted(() => ({ list: vi.fn(), lifecycle: vi.fn() }));
vi.mock("../../platform/cloud-workspaces", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../platform/cloud-workspaces")>()),
  listCloudWorkspaceDocuments: api.list,
  changeCloudWorkspaceLifecycle: api.lifecycle,
}));
vi.mock("../projects-store", () => ({ loadProjects: () => [] }));
import {
  acceptCloudWorkspaceDocument,
  clearCloudWorkspaceCatalog,
  cloudWorkspaceDocument,
  getCloudWorkspaceRows,
  getCloudProjects,
  manageCloudWorkspace,
  refreshCloudWorkspaceCatalog,
} from "../cloud-workspace-catalog";
const target = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
};
function doc(version: number, status = "ready"): CloudWorkspaceDocument {
  return {
    id: target.workspaceId,
    organizationId: target.organizationId,
    teamId: target.organizationId,
    name: "Cloud fixture",
    placement: "cloud",
    createdBy: target.organizationId,
    status,
    version,
    error: null,
    createdAt: "2026-09-26T00:00:00Z",
    updatedAt: `2026-09-26T00:00:${String(version).padStart(2, "0")}Z`,
    deletedAt: null,
    capabilities: {
      canWrite: true,
      canManage: true,
      canStart: true,
      startUnavailableReason: null,
    },
    repository: {
      forge: "github.com",
      owner: "example",
      name: "fixture",
      revision: "refs/heads/main",
    },
    generation: {
      number: 1,
      architecture: "x86_64",
      resources: { cpuMillicores: 2000, memoryMiB: 4096, storageMiB: 20480 },
      observedState: "running",
      lastObservedAt: null,
    },
  };
}
beforeEach(() => {
  clearCloudWorkspaceCatalog();
  vi.clearAllMocks();
});
describe("cloud workspace catalog ownership", () => {
  it.each(["failed", "error"])("projects %s setup as failed instead of indefinitely running", (status) => {
    acceptCloudWorkspaceDocument(doc(1, status));
    expect(getCloudWorkspaceRows()[0].setupState).toBe("failed");
  });
  it("moves a cloud-only repository's entry point when its first workspace is deleted", () => {
    const second = { ...doc(1), id: "33333333-3333-4333-8333-333333333333" };
    acceptCloudWorkspaceDocument(doc(1));
    acceptCloudWorkspaceDocument(second);
    acceptCloudWorkspaceDocument({
      ...doc(2, "deleted"),
      deletedAt: "2026-09-26T00:00:02Z",
    });
    expect(getCloudProjects()[0].repoRoot).toContain(second.id);
    expect(getCloudWorkspaceRows()).toHaveLength(1);
  });
  it("keeps the newest version when a detail and a list overlap, with stable row references", async () => {
    acceptCloudWorkspaceDocument(doc(1));
    let finish!: (rows: CloudWorkspaceDocument[]) => void;
    api.list.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const refresh = refreshCloudWorkspaceCatalog();
    acceptCloudWorkspaceDocument(doc(2));
    finish([doc(3)]);
    await refresh;
    expect(cloudWorkspaceDocument(target)?.version).toBe(3);
    const rows = getCloudWorkspaceRows();
    acceptCloudWorkspaceDocument(doc(3));
    expect(getCloudWorkspaceRows()).toBe(rows);
  });
  it("ignores late lists after account changes", async () => {
    let finish!: (rows: CloudWorkspaceDocument[]) => void;
    api.list.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const refresh = refreshCloudWorkspaceCatalog();
    clearCloudWorkspaceCatalog();
    finish([doc(1)]);
    await refresh;
    expect(getCloudWorkspaceRows()).toEqual([]);
  });
  it("reuses an uncertain lifecycle intent but starts a new one after a confirmed operation", async () => {
    api.lifecycle
      .mockRejectedValueOnce(new Error("network lost"))
      .mockResolvedValueOnce(doc(1, "starting"))
      .mockResolvedValueOnce(doc(3, "starting"));
    await expect(manageCloudWorkspace(target, "wake")).rejects.toThrow(
      "network lost",
    );
    await manageCloudWorkspace(target, "wake");
    expect(api.lifecycle.mock.calls[0][2]).toBe(api.lifecycle.mock.calls[1][2]);
    acceptCloudWorkspaceDocument(doc(2, "ready"));
    await manageCloudWorkspace(target, "wake");
    expect(api.lifecycle.mock.calls[2][2]).not.toBe(
      api.lifecycle.mock.calls[1][2],
    );
  });
});
