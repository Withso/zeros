import { afterEach, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ detail: vi.fn(), list: vi.fn() }));
vi.mock("@/renderer/platform/cloud-workspaces", () => ({
  CloudWorkspaceDocumentSchema: { parse: (x: unknown) => x },
  CloudWorkspaceRecoveryInputSchema: { parse: (x: unknown) => x },
  listCloudWorkspaceDocuments: api.list,
  getCloudWorkspaceDocument: api.detail,
  changeCloudWorkspaceLifecycle: vi.fn(), recoverCloudWorkspace: vi.fn(),
}));
import { acceptCloudWorkspaceDocument, canReadCloudWorkspace, clearCloudWorkspaceCatalog, cloudWorkspaceDocument, getCloudWorkspaceRows, refreshCloudWorkspace, refreshCloudWorkspaceCatalog } from "@/renderer/state/cloud-workspace-catalog";
import type { CloudWorkspaceDocument } from "@/renderer/platform/cloud-workspaces";
const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
const doc = { id: target.workspaceId, organizationId: target.organizationId, name: "Fixture", placement: "cloud", status: "ready", deletedAt: null,
  version: 1, createdAt: "2026-09-26T00:00:00Z", updatedAt: "2026-09-26T00:00:00Z", generation: { number: 1 },
  repository: { forge: "github.com", owner: "example", name: "fixture", revision: "main" } } as CloudWorkspaceDocument;
afterEach(() => {
  clearCloudWorkspaceCatalog();
  api.detail.mockReset();
  api.list.mockReset();
});
it("a ready detail read begun before authoritative catalog removal cannot revive that owner", async () => {
  clearCloudWorkspaceCatalog(); acceptCloudWorkspaceDocument(doc);
  let finish!: (value: CloudWorkspaceDocument) => void;
  api.detail.mockReturnValue(new Promise<CloudWorkspaceDocument>(resolve => { finish = resolve; }));
  const reading = refreshCloudWorkspace(target).catch(() => undefined);
  api.list.mockResolvedValue([]);
  await refreshCloudWorkspaceCatalog();
  expect(getCloudWorkspaceRows()).toEqual([]);
  finish(doc); await reading;
  expect.soft(getCloudWorkspaceRows()).toEqual([]);
  expect.soft(canReadCloudWorkspace(cloudWorkspaceDocument(target))).toBe(false);
});

it.each(["missing", "reappeared"])("an exact-owner removal fence survives a %s current document and leaves other owners live", async mode => {
  const { cloudWorkspaceDetails } = await import("../cloud-workspace-catalog");
  const { cloudWorkspaceKey } = await import("../../platform/bridge/cloud-workspace-key");
  clearCloudWorkspaceCatalog();
  const other = { ...target, workspaceId: "33333333-3333-4333-8333-333333333333" };
  const otherDoc = { ...doc, id: other.workspaceId };
  acceptCloudWorkspaceDocument(doc); acceptCloudWorkspaceDocument(otherDoc);
  let finishRemoved!: (value: CloudWorkspaceDocument) => void;
  let finishOther!: (value: CloudWorkspaceDocument) => void;
  api.detail.mockImplementation((scope: typeof target) => new Promise<CloudWorkspaceDocument>(resolve => {
    if (scope.workspaceId === target.workspaceId) finishRemoved = resolve;
    else finishOther = resolve;
  }));
  const removedRead = refreshCloudWorkspace(target).then(() => "accepted", () => "rejected");
  const otherRead = refreshCloudWorkspace(other);
  api.list.mockResolvedValue([otherDoc]);
  await refreshCloudWorkspaceCatalog();
  expect(cloudWorkspaceDetails.peekSnapshot(cloudWorkspaceKey(target)).data).toBeUndefined();
  expect(canReadCloudWorkspace(cloudWorkspaceDocument(other))).toBe(true);
  if (mode === "reappeared") {
    // A later authorized catalog owns this identity again. Its new content
    // must not be replaced by a pre-removal read with the same wire version.
    api.list.mockResolvedValue([otherDoc, { ...doc, name: "Authorized again" }]);
    await refreshCloudWorkspaceCatalog();
  }
  finishRemoved(doc);
  finishOther({ ...otherDoc, version: 2, name: "Other updated" });
  expect(await removedRead).toBe("rejected");
  expect((await otherRead).name).toBe("Other updated");
  expect(cloudWorkspaceDocument(target)?.name).toBe(mode === "missing" ? undefined : "Authorized again");
});

it("a pending detail for an absent owner is fenced by a newer complete catalog", async () => {
  clearCloudWorkspaceCatalog();
  let finish!: (value: CloudWorkspaceDocument) => void;
  api.detail.mockReturnValue(new Promise<CloudWorkspaceDocument>(resolve => { finish = resolve; }));
  const read = refreshCloudWorkspace(target).then(() => "accepted", () => "rejected");
  api.list.mockResolvedValue([]);
  await refreshCloudWorkspaceCatalog();
  finish(doc);
  expect(await read).toBe("rejected");
  expect(getCloudWorkspaceRows()).toEqual([]);
});

it("a post-removal authorized detail read does not share the obsolete pending generation", async () => {
  clearCloudWorkspaceCatalog(); acceptCloudWorkspaceDocument(doc);
  let finish!: (value: CloudWorkspaceDocument) => void;
  api.detail.mockReturnValueOnce(new Promise<CloudWorkspaceDocument>(resolve => { finish = resolve; }));
  const old = refreshCloudWorkspace(target).then(() => "accepted", () => "rejected");
  api.list.mockResolvedValue([]); await refreshCloudWorkspaceCatalog();
  api.list.mockResolvedValue([{ ...doc, name: "Reauthorized" }]); await refreshCloudWorkspaceCatalog();
  api.detail.mockResolvedValueOnce({ ...doc, name: "Current detail", version: 2 });
  const fresh = refreshCloudWorkspace(target).then(value => value.name, () => "rejected");
  await Promise.resolve();
  expect(api.detail).toHaveBeenCalledTimes(2);
  finish(doc);
  expect(await old).toBe("rejected");
  expect(await fresh).toBe("Current detail");
  expect(cloudWorkspaceDocument(target)?.name).toBe("Current detail");
});
