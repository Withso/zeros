import { describe, expect, it, vi } from "vitest";
import {
  CloudWorkspaceResourceUsageCache, cloudWorkspaceResourceUsageKey,
  canPollCloudWorkspaceResourceUsage, type CloudWorkspaceResourceUsageOwner,
} from "../cloud-workspace-resource-usage-cache";

const owner: CloudWorkspaceResourceUsageOwner = {
  accountId: "44444444-4444-4444-8444-444444444444", accountGeneration: 1, catalogGeneration: 1,
  organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222",
  generation: 7, engineInstanceId: "33333333-3333-4333-8333-333333333333", authorityEpoch: 2, admissionId: "runtime-a",
};
function sample(target = owner, sampledAt = "2026-10-07T10:00:00Z") {
  return { version: 1 as const, organizationId: target.organizationId, workspaceId: target.workspaceId,
    generation: target.generation, engineInstanceId: target.engineInstanceId, sampledAt,
    cpu: { cores: 2, usedPercent: 40 },
    memory: { totalBytes: 100, availableBytes: 60, usedBytes: 40, usedPercent: 40 },
    disk: { totalBytes: 100, availableBytes: 70, usedBytes: 30, usedPercent: 30 } };
}
const key = cloudWorkspaceResourceUsageKey(owner);
describe("resource usage exact runtime cache", () => {
  it("shares one flight and retains confirmed same-key data through revalidation and failures", async () => {
    let resolve!: (value: ReturnType<typeof sample>) => void;
    const pending = new Promise<ReturnType<typeof sample>>(yes => { resolve = yes; });
    const read = vi.fn().mockReturnValueOnce(pending);
    const cache = new CloudWorkspaceResourceUsageCache({ read, isCurrent: () => true });
    const first = cache.load(key); expect(cache.load(key)).toBe(first);
    resolve(sample()); await first;
    const confirmed = cache.snapshots.getSnapshot(key).data;
    read.mockResolvedValueOnce(sample()); await cache.load(key, true);
    expect(cache.snapshots.getSnapshot(key).data).toBe(confirmed);
    read.mockRejectedValueOnce(new Error("offline"));
    const refresh = cache.load(key, true);
    expect(cache.snapshots.getSnapshot(key).data).toBe(confirmed);
    await expect(refresh).rejects.toThrow("offline");
    expect(cache.snapshots.getSnapshot(key).data).toBe(confirmed);
  });
  it("isolates accounts, catalogs, organization, generation, engine and admission, restoring A → B → A", async () => {
    const read = vi.fn(async (target: CloudWorkspaceResourceUsageOwner) => sample(target));
    const cache = new CloudWorkspaceResourceUsageCache({ read, isCurrent: () => true });
    await cache.load(key); const confirmed = cache.snapshots.getSnapshot(key).data;
    const scopes = [ { ...owner, accountId: owner.workspaceId }, { ...owner, accountGeneration: 2 },
      { ...owner, catalogGeneration: 2 }, { ...owner, organizationId: owner.workspaceId },
      { ...owner, generation: 8 }, { ...owner, engineInstanceId: owner.workspaceId },
      { ...owner, authorityEpoch: 3 }, { ...owner, admissionId: "runtime-b" } ];
    for (const scope of scopes) await cache.load(cloudWorkspaceResourceUsageKey(scope));
    expect(await cache.load(key)).toBe(confirmed); expect(read).toHaveBeenCalledTimes(9);
  });
  it("fences late retired/invalidation results and rejects foreign or out-of-order samples", async () => {
    let current = true, resolve!: (value: ReturnType<typeof sample>) => void;
    const read = vi.fn().mockResolvedValue(sample());
    const cache = new CloudWorkspaceResourceUsageCache({ read, isCurrent: () => current });
    await cache.load(key);
    read.mockResolvedValueOnce(sample(owner, "2026-10-07T09:59:59Z"));
    await expect(cache.load(key, true)).rejects.toThrow(/older/);
    read.mockResolvedValueOnce(sample({ ...owner, generation: 8 }));
    await expect(cache.load(key, true)).rejects.toThrow(/identity/);
    read.mockReturnValueOnce(new Promise(yes => { resolve = yes; }));
    const old = cache.load(key, true); await Promise.resolve();
    current = false; cache.prune(); resolve(sample());
    await expect(old).rejects.toThrow(/changed/);
    expect(cache.snapshots.peekSnapshot(key).data).toBeUndefined();
  });
  it("bounds inactive samples and returns unavailable for old runtimes", async () => {
    const read = vi.fn(async (target: CloudWorkspaceResourceUsageOwner) => sample(target));
    const cache = new CloudWorkspaceResourceUsageCache({ read, isCurrent: () => true, maxEntries: 16 });
    for (let index = 0; index < 40; index++) await cache.load(cloudWorkspaceResourceUsageKey({ ...owner, admissionId: `runtime-${index}` }));
    expect(cache.snapshots.keys()).toHaveLength(16);
    read.mockResolvedValueOnce(null as never); expect(await cache.load(key)).toBeNull();
  });
  it("allows polling only for an active visible open running connected cloud surface", () => {
    const gates = { cloud: true, active: true, open: true, featureActive: true, visible: true, connected: true,
      status: "ready", recovery: false };
    expect(canPollCloudWorkspaceResourceUsage(gates)).toBe(true);
    for (const field of ["cloud", "active", "open", "featureActive", "visible", "connected"] as const)
      expect(canPollCloudWorkspaceResourceUsage({ ...gates, [field]: false })).toBe(false);
    for (const status of ["setting_up", "waking", "stopped", "stopping", "failed", "archived"])
      expect(canPollCloudWorkspaceResourceUsage({ ...gates, status })).toBe(false);
    expect(canPollCloudWorkspaceResourceUsage({ ...gates, recovery: true })).toBe(false);
  });
});
