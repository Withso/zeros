import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { ControlPlaneError } from "../../features/team/control-plane";
import type { CloudWorkspaceCollaborators, listCloudWorkspaceCollaborators } from "../../platform/cloud-workspace-collaboration";
import type { CloudWorkspaceDocument } from "../../platform/cloud-workspaces";

const account = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock("../../features/team/team-store", () => ({ getOrganizationStoreGeneration: () => 1, getTeamStoreState: () => ({ me: account.userId ? { user: { id: account.userId } } : null }) }));
vi.mock("../../features/team/cloud-workspace-account-access", () => ({ hasCloudWorkspaceAccountAccess: () => false }));
vi.mock("../cloud-workspace-catalog", () => ({
  cloudCatalogGeneration: () => 1, cloudWorkspaceCatalogConfirmed: () => true, cloudWorkspaceDocument: vi.fn(),
  refreshCloudWorkspace: vi.fn(), subscribeCloudWorkspaces: vi.fn(), subscribeCloudWorkspaceRefresh: vi.fn(),
}));
import {
  CloudWorkspaceCollaborationCache, cloudWorkspaceCollaboration, cloudWorkspaceCollaborationKey,
  cloudWorkspaceCollaborationOwner, type CloudWorkspaceCollaborationOwner,
} from "../cloud-workspace-collaboration-cache";
import { cloudWorkspaceDocument, subscribeCloudWorkspaces } from "../cloud-workspace-catalog";

const owner: CloudWorkspaceCollaborationOwner = {
  accountId: "33333333-3333-4333-8333-333333333333", accountGeneration: 1, deviceScopeId: "device-a", catalogGeneration: 1,
  organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222",
};
const id = (n: number) => `44444444-4444-4444-8444-${String(n).padStart(12, "0")}`;
const key = cloudWorkspaceCollaborationKey(owner);
const guest = (n: number) => ({ id: id(n), userId: id(n + 100), role: "developer" as const, revision: 1, expiresAt: "2026-11-01T00:00:00Z" });
function page(overrides: Partial<CloudWorkspaceCollaborators> = {}): CloudWorkspaceCollaborators {
  return { workspaceId: owner.workspaceId, organizationId: owner.organizationId, accessRevision: 2,
    writers: { limit: 10, used: 2, available: 8 }, guests: [guest(1)], invitations: [], members: [{ userId: owner.accountId, role: "owner" }],
    guestCursor: null, invitationCursor: null, memberCursor: null, ...overrides };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
let list: Mock<typeof listCloudWorkspaceCollaborators>;
let current: Mock<(owner: CloudWorkspaceCollaborationOwner) => boolean>;
let afterMutation: Mock<(owner: CloudWorkspaceCollaborationOwner) => Promise<unknown>>;
let cache: CloudWorkspaceCollaborationCache;
beforeEach(() => {
  account.userId = null; cloudWorkspaceCollaboration.snapshots.clear();
  list = vi.fn().mockResolvedValue(page()); current = vi.fn(() => true); afterMutation = vi.fn().mockResolvedValue(undefined);
  cache = new CloudWorkspaceCollaborationCache({ list, isCurrent: current, afterMutation });
});

describe("cloud collaborator exact-owner cache", () => {
  it("keeps a cold intent read when workspace details arrive before its response", async () => {
    account.userId = owner.accountId;
    const warmedOwner = cloudWorkspaceCollaborationOwner(owner)!;
    const warmedKey = cloudWorkspaceCollaborationKey(warmedOwner);
    const pending = deferred<CloudWorkspaceCollaborators>();
    const warm = cloudWorkspaceCollaboration.snapshots.load(warmedKey, () => pending.promise);
    const before = cloudWorkspaceCollaboration.snapshots.peekSnapshot(warmedKey);
    vi.mocked(cloudWorkspaceDocument).mockReturnValue({
      actorRole: "owner", accessRevision: 2, capabilities: { canManage: true },
    } as CloudWorkspaceDocument);
    const changed = vi.mocked(subscribeCloudWorkspaces).mock.calls[0]![0];
    changed();
    expect(cloudWorkspaceCollaboration.snapshots.peekSnapshot(warmedKey).invalidationVersion).toBe(before.invalidationVersion);
    pending.resolve(page());
    await warm;
    expect(cloudWorkspaceCollaboration.snapshots.peekSnapshot(warmedKey).data).toEqual(page());
    vi.mocked(cloudWorkspaceDocument).mockReturnValue({
      actorRole: "owner", accessRevision: 3, capabilities: { canManage: true },
    } as CloudWorkspaceDocument);
    changed();
    expect(cloudWorkspaceCollaboration.snapshots.peekSnapshot(warmedKey).invalidationVersion).toBeGreaterThan(before.invalidationVersion);
  });
  it("shares reads and preserves equal collections during revalidation and A → B → A", async () => {
    const pending = deferred<CloudWorkspaceCollaborators>();
    list.mockReturnValueOnce(pending.promise);
    const first = cache.load(key);
    expect(cache.load(key)).toBe(first);
    pending.resolve(page());
    await first;
    const a = cache.snapshots.getSnapshot(key).data;
    const b = cloudWorkspaceCollaborationKey({ ...owner, workspaceId: id(8) });
    list.mockResolvedValueOnce(page({ workspaceId: id(8) }));
    await cache.load(b);
    expect(await cache.load(key)).toBe(a);
    expect(list).toHaveBeenCalledTimes(2);
    await cache.load(key, true);
    expect(cache.snapshots.getSnapshot(key).data).toBe(a);
    expect(cache.snapshots.getSnapshot(key).data!.guests).toBe(a!.guests);
  });
  it("isolates account, device, catalog and workspace owners", async () => {
    const scopes = [owner, { ...owner, accountId: id(10) }, { ...owner, accountGeneration: 2 },
      { ...owner, deviceScopeId: "device-b" }, { ...owner, catalogGeneration: 2 }, { ...owner, workspaceId: id(11) }];
    list.mockImplementation(async target => page({ workspaceId: target.workspaceId }));
    for (const scope of scopes) await cache.load(cloudWorkspaceCollaborationKey(scope));
    expect(new Set(scopes.map(cloudWorkspaceCollaborationKey)).size).toBe(scopes.length);
    expect(list).toHaveBeenCalledTimes(scopes.length);
  });
  it("preserves unchanged row and collection references when slots or another role change", async () => {
    list.mockResolvedValueOnce(page({ guests: [guest(1), guest(2)] })); await cache.load(key);
    const before = cache.snapshots.getSnapshot(key).data!;
    list.mockResolvedValueOnce(page({ guests: [guest(1), guest(2)], writers: { limit: 10, used: 10, available: 0 } }));
    await cache.load(key, true);
    const slots = cache.snapshots.getSnapshot(key).data!;
    expect(slots.guests).toBe(before.guests); expect(slots.members).toBe(before.members);
    list.mockResolvedValueOnce(page({ guests: [guest(1), { ...guest(2), role: "viewer", revision: 2 }] }));
    await cache.load(key, true);
    const roles = cache.snapshots.getSnapshot(key).data!;
    expect(roles.guests[0]).toBe(before.guests[0]); expect(roles.guests[1]).not.toBe(before.guests[1]);
    expect(roles.members).toBe(before.members);
  });
  it("retains the same-key confirmation through a failed background read", async () => {
    await cache.load(key);
    const data = cache.snapshots.getSnapshot(key).data;
    const pending = deferred<CloudWorkspaceCollaborators>(); list.mockReturnValueOnce(pending.promise);
    const refresh = cache.load(key, true);
    expect(cache.snapshots.getSnapshot(key)).toMatchObject({ data, loading: false, refreshing: true });
    pending.reject(new Error("offline"));
    await expect(refresh).rejects.toThrow("offline");
    expect(cache.snapshots.getSnapshot(key).data).toBe(data);
  });
  it("paginates independent collections without replaying completed lists and shares each page read", async () => {
    list.mockResolvedValueOnce(page({ guestCursor: id(1), memberCursor: owner.accountId }));
    await cache.load(key);
    const invitations = cache.snapshots.getSnapshot(key).data!.invitations;
    const pending = deferred<CloudWorkspaceCollaborators>();
    list.mockReturnValueOnce(pending.promise);
    const guests = cache.loadMore(key, "guests");
    expect(cache.loadMore(key, "guests")).toBe(guests);
    list.mockResolvedValueOnce(page({ guests: [guest(1)], guestCursor: id(1), members: [{ userId: id(9), role: "viewer" }] }));
    await cache.loadMore(key, "members");
    pending.resolve(page({ guests: [guest(2)] }));
    await guests;
    const result = cache.snapshots.getSnapshot(key).data!;
    expect(result.guests.map(row => row.id)).toEqual([id(1), id(2)]);
    expect(result.members.map(row => row.userId)).toEqual([owner.accountId, id(9)]);
    expect(result.guestCursor).toBeNull(); expect(result.memberCursor).toBeNull();
    expect(result.invitations).toBe(invitations);
    expect(list).toHaveBeenCalledTimes(3);
  });
  it("revalidates the loaded page window and removes revoked rows", async () => {
    list.mockResolvedValueOnce(page({ guestCursor: id(1) })); await cache.load(key);
    list.mockResolvedValueOnce(page({ guests: [guest(2)] })); await cache.loadMore(key, "guests");
    list.mockResolvedValueOnce(page({ guests: [guest(2)], guestCursor: id(2) }));
    list.mockResolvedValueOnce(page({ guests: [guest(3)] }));
    await cache.load(key, true);
    expect(cache.snapshots.getSnapshot(key).data!.guests.map(row => row.id)).toEqual([id(2), id(3)]);
  });
  it("rejects a pre-refresh page after revocation without a sharing revision change", async () => {
    list.mockResolvedValueOnce(page({ guestCursor: id(1) })); await cache.load(key);
    const pending = deferred<CloudWorkspaceCollaborators>(); list.mockReturnValueOnce(pending.promise);
    const more = cache.loadMore(key, "guests");
    list.mockResolvedValueOnce(page({ guests: [guest(2)] }));
    await cache.load(key, true);
    pending.resolve(page({ guests: [guest(3)] }));
    await expect(more).rejects.toThrow("sharing changed");
    expect(cache.snapshots.getSnapshot(key).data!.guests.map(row => row.id)).toEqual([id(2)]);
  });
  it("does not start pagination against a window being replaced", async () => {
    list.mockResolvedValueOnce(page({ guestCursor: id(1) })); await cache.load(key);
    const pending = deferred<CloudWorkspaceCollaborators>(); list.mockReturnValueOnce(pending.promise);
    const refresh = cache.load(key, true);
    await Promise.resolve();
    await expect(cache.loadMore(key, "guests")).rejects.toThrow("refreshing");
    expect(list).toHaveBeenCalledTimes(2);
    pending.resolve(page()); await refresh;
  });
  it("rejects a sharing revision change between pages and invalidates the confirmation", async () => {
    list.mockResolvedValueOnce(page({ guestCursor: id(1) })); await cache.load(key);
    const before = cache.snapshots.getSnapshot(key);
    list.mockResolvedValueOnce(page({ guests: [guest(2)], accessRevision: 3 }));
    await expect(cache.loadMore(key, "guests")).rejects.toThrow("sharing changed");
    expect(cache.snapshots.getSnapshot(key).data).toBe(before.data);
    expect(cache.snapshots.getSnapshot(key).invalidationVersion).toBeGreaterThan(before.invalidationVersion);
  });
  it("fences stale pages and reads across a writer-slot mutation", async () => {
    list.mockResolvedValueOnce(page({ guestCursor: id(1) })); await cache.load(key);
    const pending = deferred<CloudWorkspaceCollaborators>(); list.mockReturnValueOnce(pending.promise);
    const more = cache.loadMore(key, "guests");
    list.mockResolvedValueOnce(page({ writers: { limit: 10, used: 10, available: 0 } }));
    const write = vi.fn().mockResolvedValue({ saved: true });
    await cache.mutate(key, write);
    pending.resolve(page({ guests: [guest(2)] }));
    await expect(more).rejects.toThrow("sharing changed");
    expect(cache.snapshots.getSnapshot(key).data!.writers!.available).toBe(0);
    expect(cache.snapshots.getSnapshot(key).data!.guests).toHaveLength(1);
  });
  it("refreshes a CAS conflict once without resubmitting the write", async () => {
    await cache.load(key);
    const conflict = new ControlPlaneError(409, "cloud_workspace_access_conflict", "Workspace sharing changed");
    const write = vi.fn().mockRejectedValue(conflict);
    list.mockResolvedValueOnce(page({ accessRevision: 7 }));
    await expect(cache.mutate(key, write)).rejects.toBe(conflict);
    expect(write).toHaveBeenCalledTimes(1);
    expect(afterMutation).toHaveBeenCalledTimes(1);
    expect(cache.snapshots.getSnapshot(key).data!.accessRevision).toBe(7);
  });
  it("prunes an account switch and refuses a late response before publication", async () => {
    await cache.load(key);
    const pending = deferred<CloudWorkspaceCollaborators>(); list.mockReturnValueOnce(pending.promise);
    const refresh = cache.load(key, true);
    await Promise.resolve(); current.mockReturnValue(false); cache.prune();
    pending.resolve(page({ accessRevision: 9 }));
    await expect(refresh).rejects.toThrow("account or device changed");
    expect(cache.snapshots.peekSnapshot(key).data).toBeUndefined();
  });
  it("withdraws rows on denied authority and keeps the denial visible without a retry loop", async () => {
    await cache.load(key);
    const denied = new ControlPlaneError(403, "cloud_workspace_capability_required", "Workspace management required");
    list.mockRejectedValue(denied);
    await expect(cache.load(key, true)).rejects.toBe(denied);
    expect(cache.snapshots.peekSnapshot(key).data).toBeUndefined();
    expect(cache.snapshots.peekSnapshot(key).error).toBe(denied);
    await expect(cache.load(key)).rejects.toBe(denied);
    expect(list).toHaveBeenCalledTimes(2);
  });
  it("bounds inactive workspace confirmations", async () => {
    cache = new CloudWorkspaceCollaborationCache({ list, isCurrent: current, maxEntries: 2 });
    list.mockImplementation(async target => page({ workspaceId: target.workspaceId }));
    for (let n = 1; n <= 3; n++) await cache.load(cloudWorkspaceCollaborationKey({ ...owner, workspaceId: id(n) }));
    expect(cache.snapshots.keys()).toHaveLength(2);
    expect(cache.snapshots.peekSnapshot(cloudWorkspaceCollaborationKey({ ...owner, workspaceId: id(1) })).data).toBeUndefined();
  });
});
