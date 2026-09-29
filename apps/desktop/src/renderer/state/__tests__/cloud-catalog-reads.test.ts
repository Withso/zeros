import { beforeEach, describe, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("../../platform/cloud-workspaces", async original => ({
  ...await original<typeof import("../../platform/cloud-workspaces")>(), getCloudWorkspaceDocument: api.read,
}));
import { acceptCloudWorkspaceDocument, clearCloudWorkspaceCatalog, refreshCloudWorkspace } from "../cloud-workspace-catalog";
import type { CloudWorkspaceDocument } from "../../platform/cloud-workspaces";
const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
function doc(generation = 1): CloudWorkspaceDocument {
  return { id: target.workspaceId, organizationId: target.organizationId, teamId: target.organizationId, createdBy: target.organizationId,
    name: "Fixture", placement: "cloud", status: "ready", version: generation,
    createdAt: "2026-09-26T00:00:00Z", updatedAt: "2026-09-26T00:00:00Z", deletedAt: null, error: null,
    capabilities: { canWrite: true, canManage: true, canStart: true, startUnavailableReason: null },
    repository: { forge: "github.com", owner: "example", name: "fixture", revision: "main" },
    generation: { number: generation, architecture: "x86_64", resources: { cpuMillicores: 2000, memoryMiB: 4096, storageMiB: 20480 }, observedState: "running", lastObservedAt: null },
  };
}
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
beforeEach(() => { clearCloudWorkspaceCatalog(); api.read.mockReset(); });
describe("cloud catalog detail reads", () => {
  it("coalesces concurrent exact-owner detail reads without caching admission", async () => {
    const read = deferred<CloudWorkspaceDocument>(); api.read.mockReturnValue(read.promise);
    acceptCloudWorkspaceDocument(doc());
    const first = refreshCloudWorkspace(target), second = refreshCloudWorkspace(target);
    read.resolve(doc());
    await Promise.all([first, second]);
    expect(api.read).toHaveBeenCalledTimes(1);
    await refreshCloudWorkspace(target);
    expect(api.read).toHaveBeenCalledTimes(2);
  });
  it("rejects a stale generation response instead of returning it to runtime admission", async () => {
    const read = deferred<CloudWorkspaceDocument>(); api.read.mockReturnValue(read.promise);
    acceptCloudWorkspaceDocument(doc());
    const first = refreshCloudWorkspace(target);
    const rejected = expect(first).rejects.toThrow(/generation|changed/i);
    acceptCloudWorkspaceDocument(doc(2));
    read.resolve(doc());
    await rejected;
  });
  it("keeps account replacement reads independent and fences the old response", async () => {
    const old = deferred<CloudWorkspaceDocument>();
    api.read.mockReturnValueOnce(old.promise).mockResolvedValue(doc());
    const first = refreshCloudWorkspace(target);
    const rejected = expect(first).rejects.toThrow(/account/i);
    clearCloudWorkspaceCatalog();
    await refreshCloudWorkspace(target);
    old.resolve(doc());
    await rejected;
    expect(api.read).toHaveBeenCalledTimes(2);
  });
  it("isolates organization and workspace keys", async () => {
    api.read.mockImplementation(async t => ({ ...doc(), id: t.workspaceId, organizationId: t.organizationId }));
    await Promise.all([refreshCloudWorkspace(target),
      refreshCloudWorkspace({ ...target, organizationId: "33333333-3333-4333-8333-333333333333" }),
      refreshCloudWorkspace({ ...target, workspaceId: "44444444-4444-4444-8444-444444444444" })]);
    expect(api.read).toHaveBeenCalledTimes(3);
  });
  it("starts a new generation read while its retired read is still in flight", async () => {
    const old = deferred<CloudWorkspaceDocument>();
    api.read.mockReturnValueOnce(old.promise).mockResolvedValue(doc(2));
    acceptCloudWorkspaceDocument(doc());
    const first = refreshCloudWorkspace(target);
    const rejected = expect(first).rejects.toThrow(/generation|changed/i);
    acceptCloudWorkspaceDocument(doc(2));
    expect((await refreshCloudWorkspace(target)).generation.number).toBe(2);
    old.resolve(doc()); await rejected;
    expect(api.read).toHaveBeenCalledTimes(2);
  });
});
