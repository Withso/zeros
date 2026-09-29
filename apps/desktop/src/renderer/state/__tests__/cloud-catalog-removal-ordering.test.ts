import { afterEach, expect, it, vi } from "vitest";
import type { CloudWorkspaceDocument } from "../../platform/cloud-workspaces";
import { cloudWorkspaceKey } from "../../platform/bridge/cloud-workspace-key";
import {
  acceptCloudWorkspaceDocument,
  canReadCloudWorkspace,
  clearCloudWorkspaceCatalog,
  cloudWorkspaceDetails,
  cloudWorkspaceDocument,
  getCloudWorkspaceRows,
  refreshCloudWorkspace,
  refreshCloudWorkspaceCatalog,
} from "../cloud-workspace-catalog";

const api = vi.hoisted(() => ({ detail: vi.fn(), list: vi.fn() }));
vi.mock("../../platform/cloud-workspaces", () => ({
  CloudWorkspaceDocumentSchema: { parse: (value: unknown) => value },
  CloudWorkspaceRecoveryInputSchema: { parse: (value: unknown) => value },
  listCloudWorkspaceDocuments: api.list,
  getCloudWorkspaceDocument: api.detail,
  changeCloudWorkspaceLifecycle: vi.fn(),
  recoverCloudWorkspace: vi.fn(),
}));

const target = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
};
const doc = {
  id: target.workspaceId, organizationId: target.organizationId,
  name: "Fixture", placement: "cloud", status: "ready", deletedAt: null,
  version: 1, createdAt: "2026-09-26T00:00:00Z", updatedAt: "2026-09-26T00:00:00Z",
  generation: { number: 1 },
  repository: { forge: "github.com", owner: "example", name: "fixture", revision: "main" },
} as CloudWorkspaceDocument;

function deferred<T>() {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>(done => { resolve = done; }), resolve: (value: T) => resolve(value) };
}

afterEach(() => { clearCloudWorkspaceCatalog(); vi.resetAllMocks(); });

it.each(["before", "after"])("an old detail completing %s a newer removal list cannot retain the owner", async order => {
  acceptCloudWorkspaceDocument(doc);
  const detail = deferred<CloudWorkspaceDocument>();
  const list = deferred<CloudWorkspaceDocument[]>();
  api.detail.mockReturnValue(detail.promise);
  api.list.mockReturnValue(list.promise);
  // This read captured v2 before deletion/access withdrawal.
  const reading = refreshCloudWorkspace(target).catch(() => undefined);
  const listing = refreshCloudWorkspaceCatalog();
  const oldReady = { ...doc, name: "Pre-removal update", version: 2, updatedAt: "2026-09-26T00:00:01Z" };
  if (order === "before") { detail.resolve(oldReady); await reading; }
  list.resolve([]);
  await listing;
  if (order === "after") { detail.resolve(oldReady); await reading; }
  expect.soft(getCloudWorkspaceRows()).toEqual([]);
  expect.soft(cloudWorkspaceDocument(target)).toBeUndefined();
  expect.soft(cloudWorkspaceDetails.peekSnapshot(cloudWorkspaceKey(target)).data).toBeUndefined();
  expect.soft(canReadCloudWorkspace(cloudWorkspaceDocument(target))).toBe(false);
  api.list.mockResolvedValue([]);
  await refreshCloudWorkspaceCatalog();
  expect(getCloudWorkspaceRows()).toEqual([]);
});

it("preserves an explicit concurrent creation when an older catalog omits it", async () => {
  const list = deferred<CloudWorkspaceDocument[]>();
  api.list.mockReturnValue(list.promise);
  const listing = refreshCloudWorkspaceCatalog();
  acceptCloudWorkspaceDocument(doc);
  list.resolve([]);
  await listing;
  expect(cloudWorkspaceDocument(target)).toEqual(doc);
  expect(getCloudWorkspaceRows()).toHaveLength(1);
});
