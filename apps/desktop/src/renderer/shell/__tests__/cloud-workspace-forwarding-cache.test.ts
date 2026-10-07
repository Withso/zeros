import { describe, expect, it, vi } from "vitest";
import { CloudWorkspaceForwardingCache, cloudWorkspaceForwardingKey, type CloudWorkspaceForwardingOwner } from "../conversation/cloud-workspace-forwarding-cache";

const owner: CloudWorkspaceForwardingOwner = { account: "1", catalog: 2, generation: 3,
  organizationId: "organization", workspaceId: "workspace", authorityId: "authority", deviceId: "device", keyVersion: 1 };
const defaults = { forwardingEnabled: false, autoForwardEnabled: true };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
describe("cloud port preference ownership", () => {
  it("deduplicates exact owner reads and retains confirmed preferences during refresh", async () => {
    const next = deferred<typeof defaults>(); const read = vi.fn().mockResolvedValueOnce(defaults).mockImplementation(() => next.promise);
    const cache = new CloudWorkspaceForwardingCache({ read, write: vi.fn(), isCurrent: () => true });
    const key = cloudWorkspaceForwardingKey(owner);
    const a = cache.load(key), b = cache.load(key); await Promise.all([a, b]); expect(read).toHaveBeenCalledTimes(1);
    const refresh = cache.load(key, true); expect(cache.snapshots.getSnapshot(key).data).toBe(defaults);
    next.resolve({ forwardingEnabled: true, autoForwardEnabled: false }); await refresh;
    expect(cache.snapshots.getSnapshot(key).data?.forwardingEnabled).toBe(true);
  });
  it.each(["account", "catalog", "generation", "organizationId", "workspaceId", "authorityId", "deviceId", "keyVersion"] as const)("fences a delayed read after %s changes", async field => {
    let current = owner; const pending = deferred<typeof defaults>();
    const cache = new CloudWorkspaceForwardingCache({ read: () => pending.promise, write: vi.fn(),
      isCurrent: candidate => cloudWorkspaceForwardingKey(candidate) === cloudWorkspaceForwardingKey(current) });
    const key = cloudWorkspaceForwardingKey(owner), request = cache.load(key);
    await Promise.resolve(); current = { ...owner, [field]: typeof owner[field] === "number" ? Number(owner[field]) + 1 : "changed" };
    pending.resolve(defaults); await expect(request).rejects.toThrow("owner changed");
    expect(cache.snapshots.getSnapshot(key).data).toBeUndefined();
  });
  it("does not let an older preference read overwrite a successful switch action", async () => {
    const pending = deferred<typeof defaults>(), updated = { forwardingEnabled: true, autoForwardEnabled: true };
    const cache = new CloudWorkspaceForwardingCache({ read: () => pending.promise, write: async () => updated, isCurrent: () => true });
    const key = cloudWorkspaceForwardingKey(owner), read = cache.load(key); await Promise.resolve();
    await cache.write(key, { forwardingEnabled: true }); pending.resolve(defaults); await read;
    expect(cache.snapshots.getSnapshot(key).data).toEqual(updated);
  });
  it("prunes deleted owners and cannot publish a delayed write after replacement", async () => {
    let current = true; const pending = deferred<typeof defaults>();
    const cache = new CloudWorkspaceForwardingCache({ read: async () => defaults, write: () => pending.promise, isCurrent: () => current });
    const key = cloudWorkspaceForwardingKey(owner); await cache.load(key);
    const write = cache.write(key, { forwardingEnabled: true }); current = false; cache.prune(); pending.resolve(defaults);
    await expect(write).rejects.toThrow("owner changed"); expect(cache.snapshots.keys()).toEqual([]);
  });
  it("bounds retained inactive preference owners", async () => {
    const cache = new CloudWorkspaceForwardingCache({ read: async () => defaults, write: vi.fn(), isCurrent: () => true });
    for (let generation = 1; generation <= 40; generation++) await cache.load(cloudWorkspaceForwardingKey({ ...owner, generation }));
    expect(cache.snapshots.keys()).toHaveLength(32);
  });
});
