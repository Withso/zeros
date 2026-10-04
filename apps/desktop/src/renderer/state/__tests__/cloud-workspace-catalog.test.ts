import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudWorkspaceDocument } from "../../platform/cloud-workspaces";
const api = vi.hoisted(() => ({ list: vi.fn(), lifecycle: vi.fn(), recover: vi.fn(), projects: vi.fn(() => [] as unknown[]) }));
vi.mock("../../platform/cloud-workspaces", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../platform/cloud-workspaces")>()),
  listCloudWorkspaceDocuments: api.list,
  changeCloudWorkspaceLifecycle: api.lifecycle,
  recoverCloudWorkspace: api.recover,
}));
vi.mock("../projects-store", () => ({ loadProjects: api.projects }));
import {
  acceptCloudWorkspaceDocument,
  clearCloudWorkspaceCatalog,
  cloudCatalogNeedsFastRefresh,
  cloudWorkspaceDocument,
  canReadCloudWorkspace,
  getCloudWorkspaceRows,
  getCloudProjects,
  cloudProjectForFolder,
  manageCloudWorkspace,
  cloudWorkspaceOperation,
  refreshCloudWorkspaceCatalog,
  cloudWorkspaceDetails,
  subscribeCloudWorkspaces,
  subscribeCloudWorkspaceRows,
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
  api.projects.mockReturnValue([]);
});
describe("cloud workspace catalog ownership", () => {
  it.each(["account", "removed", "generation", "target"])("rejects a late wake response after its %s changes", async reason => {
    acceptCloudWorkspaceDocument(doc(1, "stopped"));
    let finish!: (document: CloudWorkspaceDocument) => void;
    api.lifecycle.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const waking = manageCloudWorkspace(target, "wake");
    const rejected = expect(waking).rejects.toThrow(/changed|removed|different/i);
    if (reason === "account") clearCloudWorkspaceCatalog();
    if (reason === "removed") {
      api.list.mockResolvedValue([]);
      await refreshCloudWorkspaceCatalog();
    }
    if (reason === "generation") acceptCloudWorkspaceDocument({ ...doc(3), generation: { ...doc(3).generation, number: 2 } });
    finish({ ...doc(2, "waking"), ...(reason === "target" ? { organizationId: "33333333-3333-4333-8333-333333333333" } : {}) });
    await rejected;
    if (["account", "removed"].includes(reason)) expect(cloudWorkspaceDocument(target)).toBeUndefined();
    if (reason === "generation") expect(cloudWorkspaceDocument(target)?.generation.number).toBe(2);
    if (reason === "target") expect(getCloudProjects()).toHaveLength(1);
  });
  it("returns a newer stop instead of the late wake receipt", async () => {
    acceptCloudWorkspaceDocument(doc(1, "stopped"));
    let finish!: (document: CloudWorkspaceDocument) => void;
    api.lifecycle.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const waking = manageCloudWorkspace(target, "wake");
    acceptCloudWorkspaceDocument(doc(3, "stopping"));
    finish(doc(2, "waking"));
    expect((await waking).status).toBe("stopping");
  });
  it("sends recover to the generation recovery route with its exact checkpoint", async () => {
    const recovery = { sourceGeneration: 1, checkpointId: "33333333-3333-4333-8333-333333333333" };
    api.recover.mockResolvedValue(doc(2, "ready"));
    api.lifecycle.mockResolvedValue(doc(2, "ready"));
    await cloudWorkspaceOperation(target, "workspace.recover", { workspaceId: target.workspaceId, ...recovery });
    expect(api.recover).toHaveBeenCalledWith(target, recovery, expect.any(String));
    expect(api.lifecycle).not.toHaveBeenCalled();
  });
  it.each(["deleting", "deleted"])("retires %s workspaces before provider storage removal finishes", (status) => {
    acceptCloudWorkspaceDocument(doc(1));
    const second = { ...doc(1), id: "33333333-3333-4333-8333-333333333333" };
    acceptCloudWorkspaceDocument(second);
    acceptCloudWorkspaceDocument(doc(2, status));
    expect(getCloudWorkspaceRows()).toHaveLength(1);
    expect(getCloudProjects()[0].repoRoot).toContain(second.id);
    expect(cloudProjectForFolder(`cloud://${target.organizationId}/${target.workspaceId}`)).toBeNull();
    expect(canReadCloudWorkspace(cloudWorkspaceDocument(target))).toBe(false);
  });
  it.each(["ready", "busy", "stopped", "archived", "failed"])("allows %s history without requiring a running VM", status => {
    expect(canReadCloudWorkspace(doc(1, status))).toBe(true);
    expect(canReadCloudWorkspace({ ...doc(1, status), deletedAt: doc(1).updatedAt })).toBe(false);
    expect(canReadCloudWorkspace(undefined)).toBe(false);
  });
  it("does not keep every workspace on fast polling while provider storage deletion is pending", () => {
    expect(cloudCatalogNeedsFastRefresh()).toBe(false);
    acceptCloudWorkspaceDocument(doc(1, "deleting"));
    expect(cloudCatalogNeedsFastRefresh()).toBe(false);
    acceptCloudWorkspaceDocument({ ...doc(1, "starting"), id: "33333333-3333-4333-8333-333333333333" });
    expect(cloudCatalogNeedsFastRefresh()).toBe(true);
    acceptCloudWorkspaceDocument({ ...doc(2, "ready"), id: "33333333-3333-4333-8333-333333333333" });
    expect(cloudCatalogNeedsFastRefresh()).toBe(false);
  });
  it.each(["ready", "busy", "stopped", "archived", "failed", "error", "deleted"])("polls settled %s state at the normal cadence", status => {
    acceptCloudWorkspaceDocument(doc(1, status));
    expect(cloudCatalogNeedsFastRefresh()).toBe(false);
  });
  it("ignores tombstoned transitions and clears polling state on account replacement", () => {
    acceptCloudWorkspaceDocument({ ...doc(1, "starting"), deletedAt: doc(1).updatedAt });
    expect(cloudCatalogNeedsFastRefresh()).toBe(false);
    acceptCloudWorkspaceDocument(doc(2, "starting"));
    expect(cloudCatalogNeedsFastRefresh()).toBe(true);
    clearCloudWorkspaceCatalog();
    expect(cloudCatalogNeedsFastRefresh()).toBe(false);
  });
  it("keeps organization repository ownership separate from a matching local checkout", () => {
    api.projects.mockReturnValue([{id:"local-project",name:"fixture",repoRoot:"/local/fixture",repoSlug:"fixture",originUrl:"https://github.com/example/fixture.git",addedAt:1}]);
    acceptCloudWorkspaceDocument(doc(1));
    expect(getCloudProjects()).toHaveLength(1);
    const project = cloudProjectForFolder(`cloud://${target.organizationId}/${target.workspaceId}`);
    expect(project?.repoRoot).toMatch(/^cloud:\/\//);
    expect(project?.id).not.toBe("local-project");
  });
  it.each(["failed", "error"])("projects %s setup as failed instead of indefinitely running", (status) => {
    acceptCloudWorkspaceDocument(doc(1, status));
    expect(getCloudWorkspaceRows()[0].setupState).toBe("failed");
  });
  it("treats an archived workspace as settled instead of keeping fast setup polling active", () => {
    acceptCloudWorkspaceDocument(doc(1, "archived"));
    expect(getCloudWorkspaceRows()[0]).toMatchObject({
      setupState: "passed", archivedAt: Date.parse(doc(1, "archived").updatedAt),
    });
    acceptCloudWorkspaceDocument(doc(2, "starting"));
    expect(getCloudWorkspaceRows()[0]).toMatchObject({ setupState: "running", archivedAt: null });
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


it("unchanged list polls retain details while status-only changes notify document observers", async () => {
  const initial = doc(1);
  acceptCloudWorkspaceDocument(initial);
  const key = getCloudWorkspaceRows()[0].id;
  const details = cloudWorkspaceDetails.peekSnapshot(key);
  const detailListener = vi.fn(), documents = vi.fn(), rows = vi.fn();
  const off = [cloudWorkspaceDetails.subscribe(key, detailListener), subscribeCloudWorkspaces(documents), subscribeCloudWorkspaceRows(rows)];
  try {
    api.list.mockResolvedValue([initial]);
    await refreshCloudWorkspaceCatalog();
    expect(cloudWorkspaceDetails.peekSnapshot(key)).toBe(details);
    expect(detailListener).not.toHaveBeenCalled();
    expect(documents).not.toHaveBeenCalled();
    acceptCloudWorkspaceDocument(doc(2, "stopped"));
    expect(documents).toHaveBeenCalledOnce();
    expect(rows).not.toHaveBeenCalled();
  } finally { off.forEach(stop => stop()); }
});
