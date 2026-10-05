import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ identity: vi.fn(), list: vi.fn(), divergences: vi.fn(), epoch: 0, auth: null as (() => void) | null }));
vi.mock("../../platform/cloud-replicas", () => ({
  readCloudReplicaIdentity: api.identity, listCloudReplicas: api.list, readCloudReplicaDivergences: api.divergences,
}));
vi.mock("../../features/team/team-store", () => ({ getOrganizationStoreGeneration: () => api.epoch }));
vi.mock("../../features/auth/auth-store", () => ({ onAuthStateChange: (fn: () => void) => { api.auth = fn; return () => {}; } }));
import { cloudReplicaIdentityCache, cloudReplicaCache, cloudReplicaIdentityKey, cloudReplicaScopeKey,
  readCloudReplicaIdentityKey, readCloudReplicaScopeKey, warmCloudWorkspaceReplicas, clearCloudReplicaCaches } from "../cloud-replica-cache";

const accountUserId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const identity = { accountUserId, deviceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
const scope = { ...identity, ...target, accountEpoch: 0 };
const replica = { ...scope, replicaId: "33333333-3333-4333-8333-333333333333", desiredState: "active", observedState: "in_sync" };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
beforeEach(() => { clearCloudReplicaCaches(); vi.clearAllMocks(); api.epoch = 0;
  api.identity.mockResolvedValue(identity); api.list.mockResolvedValue([replica]); api.divergences.mockResolvedValue([]); });

describe("exact account/device/workspace replica snapshots", () => {
  it("shares intent reads with open reads and restores A → B → A synchronously", async () => {
    await Promise.all([warmCloudWorkspaceReplicas(accountUserId, target), warmCloudWorkspaceReplicas(accountUserId, target)]);
    expect(api.identity).toHaveBeenCalledOnce(); expect(api.list).toHaveBeenCalledOnce();
    const key = cloudReplicaScopeKey(scope), snapshot = cloudReplicaCache.getSnapshot(key).data;
    const b = { ...target, workspaceId: target.organizationId };
    await warmCloudWorkspaceReplicas(accountUserId, b);
    expect(cloudReplicaCache.getSnapshot(key).data).toBe(snapshot);
    await warmCloudWorkspaceReplicas(accountUserId, target);
    expect(api.list).toHaveBeenCalledTimes(2);
  });
  it("keys snapshots by account, device, organization, workspace and account epoch", () => {
    const key = cloudReplicaScopeKey(scope);
    cloudReplicaCache.setData(key, { replica: replica as never, divergences: [] });
    for (const changes of [
      { accountUserId: target.organizationId }, { deviceId: target.organizationId }, { organizationId: target.workspaceId },
      { workspaceId: target.organizationId }, { accountEpoch: 1 },
    ]) expect(cloudReplicaCache.getSnapshot(cloudReplicaScopeKey({ ...scope, ...changes })).data).toBeUndefined();
  });
  it("keeps the confirmed replica while offline and catches up on the next read", async () => {
    const key = cloudReplicaScopeKey(scope);
    await cloudReplicaCache.load(key, () => readCloudReplicaScopeKey(key));
    const confirmed = cloudReplicaCache.getSnapshot(key).data;
    api.list.mockRejectedValueOnce(new Error("offline"));
    await expect(cloudReplicaCache.load(key, () => readCloudReplicaScopeKey(key), { force: true })).rejects.toThrow("offline");
    expect(cloudReplicaCache.getSnapshot(key).data).toBe(confirmed);
    api.list.mockResolvedValueOnce([{ ...replica, eventCursor: 9 }]);
    await cloudReplicaCache.load(key, () => readCloudReplicaScopeKey(key), { force: true });
    expect(cloudReplicaCache.getSnapshot(key).data?.replica).toMatchObject({ eventCursor: 9 });
  });
  it("fences an older response after remove and preserves equal snapshot references", async () => {
    const key = cloudReplicaScopeKey(scope), pending = deferred<typeof replica[]>();
    api.list.mockReturnValueOnce(pending.promise);
    const old = cloudReplicaCache.load(key, () => readCloudReplicaScopeKey(key));
    await Promise.resolve();
    const removed = { replica: null, divergences: [] };
    cloudReplicaCache.setData(key, removed);
    pending.resolve([replica]); await old;
    expect(cloudReplicaCache.getSnapshot(key).data).toBe(removed);
    api.list.mockResolvedValueOnce([]);
    await cloudReplicaCache.load(key, () => readCloudReplicaScopeKey(key), { force: true });
    expect(cloudReplicaCache.getSnapshot(key).data).toBe(removed);
  });
  it("reads divergence paths for this exact replica and renders detachment on revocation", async () => {
    const key = cloudReplicaScopeKey(scope), changes = [{ path: "src/local.ts", detectedAt: 1 }];
    api.list.mockResolvedValueOnce([{ ...replica, observedState: "diverged" }]); api.divergences.mockResolvedValueOnce(changes);
    await cloudReplicaCache.load(key, () => readCloudReplicaScopeKey(key));
    expect(api.divergences).toHaveBeenCalledWith(scope, replica.replicaId);
    expect(cloudReplicaCache.getSnapshot(key).data?.divergences).toEqual(changes);
    api.list.mockResolvedValueOnce([{ ...replica, observedState: "detached", lastErrorCode: "workspace_access_revoked" }]);
    await cloudReplicaCache.load(key, () => readCloudReplicaScopeKey(key), { force: true });
    expect(cloudReplicaCache.getSnapshot(key).data?.replica).toMatchObject({ observedState: "detached" });
  });
  it("clears account data on authentication changes and bounds inactive owners", async () => {
    const key = cloudReplicaIdentityKey(accountUserId);
    await cloudReplicaIdentityCache.load(key, () => readCloudReplicaIdentityKey(key));
    await warmCloudWorkspaceReplicas(accountUserId, target);
    api.auth!();
    expect(cloudReplicaCache.keys()).toHaveLength(0); expect(cloudReplicaIdentityCache.keys()).toHaveLength(0);
    for (let i = 0; i < 40; i++) cloudReplicaCache.setData(`test-${i}`, { replica: null, divergences: [] });
    expect(cloudReplicaCache.keys().length).toBeLessThanOrEqual(32);
  });
});
