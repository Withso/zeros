import { describe, expect, it } from "vitest";
import { hostedName, newHostedGeneration, openReceipt, r2Registry, sealReceipt, withHostedLease } from "../dev-environment/hosted-state.mjs";

const identity = { owner: "a".repeat(24), identity: "conductor:test-owner" };
const key = "ab".repeat(32);
function memory() {
  let value: any = null, revision = 0;
  return {
    async read() { return value ? structuredClone(value) : null; },
    async write(_owner: string, state: unknown, etag: string | undefined) {
      if ((value?.etag ?? undefined) !== etag) throw Object.assign(new Error("compare-and-swap conflict"), { code: "DEV_REGISTRY_CONFLICT" });
      value = { state: structuredClone(state), etag: String(++revision) }; return value.etag;
    },
  };
}

describe("hosted Dev registry", () => {
  it("encrypts credentials and authenticates both the ciphertext and owner", () => {
    const state = newHostedGeneration(identity);
    const sealed = sealReceipt(state, key);
    expect(sealed).not.toContain(state.keys.cookie);
    expect(openReceipt(sealed, key, identity.owner)).toEqual(state);
    expect(() => openReceipt(sealed, key, "b".repeat(24))).toThrow(/authenticate/);
    expect(() => openReceipt(sealed, "cd".repeat(32), identity.owner)).toThrow(/authenticate/);
  });

  it("rejects an oversized receipt before it can replace readable cleanup ownership", () => {
    const state = newHostedGeneration(identity);
    // Encryption adds base64 overhead, so the serialized plaintext being below
    // the read limit is insufficient to guarantee the stored receipt is usable.
    state.resources.largeHistory = "x".repeat(800 * 1024);
    expect(() => sealReceipt(state, key)).toThrow(/receipt.*size/i);
  });

  it("does not create resources or receipts while archiving a never-launched checkout", async () => {
    const store = memory();
    expect(await withHostedLease(store, identity, () => { throw new Error("must not run"); })).toEqual({ absent: true });
    expect(await store.read()).toBeNull();
  });

  it("serializes cloud and Mac provisioning and preserves cleanup after failure", async () => {
    const store = memory();
    await expect(withHostedLease(store, identity, async (lease: any) => {
      await expect(withHostedLease(store, identity, () => {})).rejects.toThrow(/Another process/);
      lease.state.status = "archiving"; lease.state.resources.database = { id: "retained-for-retry" }; await lease.save();
      throw new Error("provider unavailable");
    }, { create: true, heartbeat: false })).rejects.toThrow("provider unavailable");
    const saved = (await store.read())!.state;
    expect(saved.status).toBe("archiving"); expect(saved.lease).toBeUndefined();
    expect(() => newHostedGeneration(identity, saved)).toThrow(/Finish/);
  });

  it("reports a simultaneous lease acquisition as busy so a monitor can retry", async () => {
    const base = memory();
    let reads = 0, release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const store = { ...base, async read() {
      const snapshot = await base.read();
      if (++reads <= 2) { if (reads === 2) release(); await gate; }
      return snapshot;
    } };
    const claims = await Promise.allSettled([
      withHostedLease(store, identity, () => "one", { create: true, heartbeat: false }),
      withHostedLease(store, identity, () => "two", { create: true, heartbeat: false }),
    ]);
    expect(claims.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect((claims.find(result => result.status === "rejected") as PromiseRejectedResult).reason.code).toBe("DEV_LEASE_BUSY");
  });

  it("distinguishes R2 conditional-write conflicts from denied provider access", async () => {
    for (const status of [412, 403]) {
      const store = r2Registry({ endpoint: `https://${"a".repeat(32)}.r2.cloudflarestorage.com`, bucket: "zeros-dev-test",
        encryptionKey: key, accessKeyId: "test-key", secretAccessKey: "test-secret" }, {
        sdk: { PutObjectCommand: class {} },
        client: { send: async () => { throw { $metadata: { httpStatusCode: status } }; } },
      });
      const failure = await store.write(identity.owner, newHostedGeneration(identity)).catch(error => error);
      expect(failure.code).toBe(status === 412 ? "DEV_REGISTRY_CONFLICT" : undefined);
      expect(failure.message).not.toContain("test-secret");
    }
  });

  it("rotates credentials and resource names only after confirmed archive", () => {
    const first = newHostedGeneration(identity);
    expect(() => newHostedGeneration(identity, first)).toThrow(/Finish/);
    first.status = "archived"; first.archivedAt = new Date().toISOString();
    const second = newHostedGeneration(identity, first);
    expect(second.owner).toBe(first.owner); expect(second.generation).not.toBe(first.generation);
    expect(second.keys.cookie).not.toBe(first.keys.cookie); expect(hostedName(second)).not.toBe(hostedName(first));
    expect(hostedName(second).length).toBeLessThanOrEqual(63);
  });
  it("preserves transferred worker deletion evidence across archive and fresh generation", () => {
    const first = newHostedGeneration(identity);
    first.status = "archived"; first.archivedAt = new Date().toISOString();
    first.pendingWorkerDeletions = [{ id: "bx_test123", deletionOperationId: "bdop_" + "a".repeat(32),
      devOwner: first.owner, devGeneration: first.generation, accountScope: "dev-account", billingOrg: "dev-org", retiredAt: first.archivedAt }];
    const second = newHostedGeneration(identity, first);
    expect(second.pendingWorkerDeletions).toEqual(first.pendingWorkerDeletions);
    second.pendingWorkerDeletions[0].deleted = true;
    expect(first.pendingWorkerDeletions[0].deleted).toBeUndefined();
    expect(openReceipt(sealReceipt(second, key), key, identity.owner).pendingWorkerDeletions).toEqual(second.pendingWorkerDeletions);
  });

  it("fences an expired process after another machine takes over", async () => {
    const store = memory(); let now = 1;
    await expect(withHostedLease(store, identity, async (old: any) => {
      now += 130_000;
      await withHostedLease(store, identity, async (fresh: any) => { fresh.state.status = "archiving"; await fresh.save(); }, { now: () => now, heartbeat: false });
      await old.fence();
    }, { create: true, now: () => now, heartbeat: false })).rejects.toThrow(/no longer owns/);
    expect((await store.read())!.state.status).toBe("archiving");
  });

  it("serializes a fence with its own pending heartbeat write", async () => {
    const base = memory(); let block = false, finish: (() => void) | undefined;
    const store = { ...base, async write(...args: Parameters<typeof base.write>) {
      if (block) await new Promise<void>(resolve => { finish = resolve; });
      return base.write(...args);
    } };
    await withHostedLease(store, identity, async (lease: any) => {
      block = true;
      const save = lease.save(); await Promise.resolve();
      let fenced = false;
      const fence = lease.fence().then(() => { fenced = true; });
      await Promise.resolve(); await Promise.resolve();
      try { expect(fenced).toBe(false); }
      finally { block = false; finish!(); await save; await fence; }
    }, { create: true, heartbeat: false });
  });
});
