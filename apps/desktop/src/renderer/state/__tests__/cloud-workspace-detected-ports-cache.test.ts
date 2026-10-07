import { describe, expect, it, vi } from "vitest";
import { CloudWorkspaceDetectedPortsCache, cloudWorkspaceDetectedPortsKey } from "../cloud-workspace-detected-ports-cache";
const owner = { accountId: "44444444-4444-4444-8444-444444444444", accountGeneration: 1, catalogGeneration: 1,
  organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222", generation: 7 };
const unknown = { version: 1 as const, organizationId: owner.organizationId, workspaceId: owner.workspaceId,
  generation: owner.generation, status: "ready", observedAt: null, ports: null };
const empty = { ...unknown, observedAt: "2026-10-07T10:00:00Z", ports: [] };
const key = cloudWorkspaceDetectedPortsKey(owner);
describe("narrow detected ports exact-generation cache", () => {
  it("shares a read and preserves unknown, confirmed empty and same-key refresh failures", async () => {
    const read = vi.fn().mockResolvedValue(unknown);
    const cache = new CloudWorkspaceDetectedPortsCache({ read, isCurrent: () => true });
    const first = cache.load(key); expect(cache.load(key)).toBe(first); await first;
    expect(cache.snapshots.getSnapshot(key).data?.ports).toBeNull();
    read.mockResolvedValueOnce(empty); await cache.load(key, true);
    const confirmed = cache.snapshots.getSnapshot(key).data;
    expect(confirmed?.ports).toEqual([]);
    read.mockRejectedValueOnce(new Error("offline"));
    await expect(cache.load(key, true)).rejects.toThrow("offline");
    expect(cache.snapshots.getSnapshot(key).data).toBe(confirmed);
    read.mockResolvedValueOnce(empty); await cache.load(key, true);
    expect(cache.snapshots.getSnapshot(key).data).toBe(confirmed);
  });
  it("does not attach old generation replies after retirement and bounds inactive owners", async () => {
    let current = true, resolve!: (value: typeof empty) => void;
    const read = vi.fn().mockReturnValueOnce(new Promise(yes => { resolve = yes; }));
    const cache = new CloudWorkspaceDetectedPortsCache({ read, isCurrent: () => current, maxEntries: 16 });
    const old = cache.load(key); await Promise.resolve(); current = false; cache.prune(); resolve(empty);
    await expect(old).rejects.toThrow(/changed/); expect(cache.snapshots.peekSnapshot(key).data).toBeUndefined();
    current = true; read.mockImplementation(async target => ({ ...empty, generation: target.generation }));
    for (let generation = 1; generation < 40; generation++) await cache.load(cloudWorkspaceDetectedPortsKey({ ...owner, generation }));
    expect(cache.snapshots.keys()).toHaveLength(16);
  });
  it("derives request identities from the key and rejects a foreign response", async () => {
    const read = vi.fn().mockResolvedValueOnce({ ...empty, generation: 8 });
    const cache = new CloudWorkspaceDetectedPortsCache({ read, isCurrent: () => true });
    await expect(cache.load(key)).rejects.toThrow(/identity/);
    expect(read).toHaveBeenCalledWith(owner); expect(cache.snapshots.getSnapshot(key).data).toBeUndefined();
  });
});
