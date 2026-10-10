import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudWorkspaceDocument } from "../../platform/cloud-workspaces";

const api = vi.hoisted(() => ({ create: vi.fn(), list: vi.fn(), account: 0 }));
// Runtime history imports the catalog. Keep that unrelated cycle out of the
// partial API mock so the catalog receives the mocked list function.
vi.mock("../../platform/bridge/workspace-runtime-client", () => ({
  WorkspaceRuntimeClient: class {},
}));
vi.mock("../../platform/cloud-workspaces", async importOriginal => ({
  ...(await importOriginal<typeof import("../../platform/cloud-workspaces")>()),
  createCloudWorkspaceDocument: api.create,
  listCloudWorkspaceDocuments: api.list,
}));
vi.mock("../../features/team/team-store", () => ({
  getOrganizationStoreGeneration: () => api.account,
  getKnownPersonalOrganizationIds: () => [],
}));
vi.mock("../projects-store", () => ({ loadProjects: () => [] }));
import { createCloudWorkspaceWithPending } from "../cloud-workspace-create";
import {
  acceptCloudWorkspaceDocument, clearCloudWorkspaceCatalog, getCloudWorkspaceRows,
  refreshCloudWorkspaceCatalog, subscribeCloudWorkspaces,
} from "../cloud-workspace-catalog";
import { beginPendingCreate, usePendingWorkspacesStore } from "../pending-workspaces";
import { dedupePendingCreates } from "../live-workspace-selectors";
import { filterRowsForOrganization } from "../../features/team/organization-capabilities";
import type { OrganizationSummary } from "../../features/team/control-plane";

const organizationId = "11111111-1111-4111-8111-111111111111";
const request = { organizationId, repository: { forge: "github.com" as const, owner: "example", name: "fixture",
  revision: "refs/heads/main", githubInstallationId: "33333333-3333-4333-8333-333333333333" }, idempotencyKey: "create-request-identity" };
function doc(): CloudWorkspaceDocument {
  return { id: "22222222-2222-4222-8222-222222222222", organizationId, teamId: organizationId,
    name: "Cloud fixture", placement: "cloud", createdBy: organizationId, status: "provisioning", version: 1,
    error: null, deletedAt: null, createdAt: "2026-09-26T00:00:00Z", updatedAt: "2026-09-26T00:00:00Z",
    capabilities: { canWrite: true, canManage: true, canStart: false, startUnavailableReason: "workspace_not_stopped" },
    repository: request.repository, generation: { number: 1, architecture: "x86_64",
      resources: { cpuMillicores: 2000, memoryMiB: 4096, storageMiB: 20480 }, observedState: "pending", lastObservedAt: null } };
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function creates() { return usePendingWorkspacesStore.getState().creates; }
function visibleCount() { return getCloudWorkspaceRows().length + dedupePendingCreates(creates(), getCloudWorkspaceRows()).length; }
beforeEach(() => {
  clearCloudWorkspaceCatalog();
  usePendingWorkspacesStore.setState({ creates: [], settlingFolders: {} });
  vi.clearAllMocks(); api.account += 1;
});

describe("optimistic cloud creation", () => {
  it.each(["code", "design"] as const)("publishes an honest %s placeholder synchronously, scoped to its owner", async kind => {
    const accepted = deferred<CloudWorkspaceDocument>(); api.create.mockReturnValue(accepted.promise);
    const pending = createCloudWorkspaceWithPending(request, kind);
    const first = creates(), rows = getCloudWorkspaceRows();
    accepted.resolve(doc()); await pending;
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ organizationId, placement: "cloud", kind, label: "Creating workspace…" });
    expect(first[0].path).toBeUndefined();
    expect(first[0].branch).toBeUndefined();
    expect(rows).toEqual([]);
    const owner = (id: string, isPersonal = false) => ({ id, isPersonal }) as OrganizationSummary;
    expect(filterRowsForOrganization(first, owner(organizationId))).toEqual(first);
    expect(filterRowsForOrganization(first, owner("other"))).toEqual([]);
    expect(filterRowsForOrganization(first, owner("personal", true))).toEqual([]);
  });

  it("joins the same idempotent create without duplicating the request or placeholder", async () => {
    const accepted = deferred<CloudWorkspaceDocument>(); api.create.mockReturnValue(accepted.promise);
    const first = createCloudWorkspaceWithPending(request, "code");
    const second = createCloudWorkspaceWithPending(request, "code");
    const snapshot = creates();
    accepted.resolve(doc()); await Promise.all([first, second]);
    expect(first).toBe(second);
    expect(snapshot).toHaveLength(1);
    expect(api.create).toHaveBeenCalledExactlyOnceWith(request);
  });

  it("swaps the placeholder to the confirmed identity without an empty or duplicate publication", async () => {
    const accepted = deferred<CloudWorkspaceDocument>(); api.create.mockReturnValue(accepted.promise);
    const counts: number[] = [];
    const offPending = usePendingWorkspacesStore.subscribe(() => counts.push(visibleCount()));
    const offCatalog = subscribeCloudWorkspaces(() => counts.push(visibleCount()));
    try {
      const pending = createCloudWorkspaceWithPending(request, "code");
      accepted.resolve(doc()); await pending;
      expect(counts.length).toBeGreaterThan(1);
      expect(counts.every(count => count === 1)).toBe(true);
      expect(creates()).toEqual([]);
      expect(getCloudWorkspaceRows()[0]).toMatchObject({ placement: "cloud", setupState: "running" });
    } finally { offPending(); offCatalog(); }
  });

  it("removes only the rejected placeholder and reuses its identity on explicit retry", async () => {
    const local = beginPendingCreate({ repoRoot: "/local", repoSlug: "local", organizationId: null, placement: "local" });
    const rejected = deferred<CloudWorkspaceDocument>(); api.create.mockReturnValueOnce(rejected.promise).mockResolvedValue(doc());
    const pending = createCloudWorkspaceWithPending(request, "code");
    const originalToken = creates().find(row => row.placement === "cloud")?.token;
    const failure = expect(pending).rejects.toThrow("lost response");
    rejected.reject(new Error("lost response")); await failure;
    expect(creates().map(row => row.token)).toEqual([local]);
    const retry = createCloudWorkspaceWithPending(request, "code");
    const retryToken = creates().find(row => row.placement === "cloud")?.token;
    await retry;
    expect(originalToken).toBeTypeOf("string");
    expect(retryToken).toBe(originalToken);
    expect(api.create.mock.calls.map(([input]) => input.idempotencyKey)).toEqual([request.idempotencyKey, request.idempotencyKey]);
    expect(creates().map(row => row.token)).toEqual([local]);
  });

  it("preserves the receipt when an older aggregate list arrives late", async () => {
    const list = deferred<CloudWorkspaceDocument[]>(); api.list.mockReturnValue(list.promise);
    const refreshing = refreshCloudWorkspaceCatalog();
    api.create.mockResolvedValue(doc());
    await createCloudWorkspaceWithPending(request, "code");
    expect(api.list).toHaveBeenCalledExactlyOnceWith();
    expect(visibleCount()).toBe(1);
    expect(getCloudWorkspaceRows()[0].id).toContain(doc().id);
    expect(creates()).toEqual([]);
    list.resolve([]); await refreshing;
    expect(visibleCount()).toBe(1);
    expect(getCloudWorkspaceRows()[0].id).toContain(doc().id);
    expect(creates()).toEqual([]);
  });

  it("does not roll back a server row learned from the catalog after a lost create response", async () => {
    const accepted = deferred<CloudWorkspaceDocument>(); api.create.mockReturnValue(accepted.promise);
    const pending = createCloudWorkspaceWithPending(request, "code");
    const failure = expect(pending).rejects.toThrow("lost response");
    acceptCloudWorkspaceDocument(doc());
    accepted.reject(new Error("lost response")); await failure;
    expect(getCloudWorkspaceRows()).toHaveLength(1);
    expect(creates()).toEqual([]);
  });

  it("fences a late old-account receipt and clears only its own placeholder", async () => {
    const old = deferred<CloudWorkspaceDocument>(), current = deferred<CloudWorkspaceDocument>();
    api.create.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const first = createCloudWorkspaceWithPending(request, "code");
    const failed = expect(first).rejects.toThrow(/account changed/i);
    await Promise.resolve();
    api.account += 1; clearCloudWorkspaceCatalog();
    const second = createCloudWorkspaceWithPending(request, "design");
    const replacement = creates();
    old.resolve(doc()); await failed;
    expect(getCloudWorkspaceRows()).toEqual([]);
    expect(creates()).toEqual(replacement);
    expect(replacement).toHaveLength(1);
    expect(replacement[0].kind).toBe("design");
    current.resolve(doc()); await second;
    expect(creates()).toEqual([]);
  });
});
