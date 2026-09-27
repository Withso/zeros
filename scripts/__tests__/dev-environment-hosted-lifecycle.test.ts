import { describe, it, expect, vi } from "vitest";
import { newHostedGeneration } from "../dev-environment/hosted-state.mjs";
import { archiveHosted, startHosted } from "../dev-environment/hosted-lifecycle.mjs";

const identity = { owner: "a".repeat(24), identity: "test" };
const profile = { railway: { projectId: "project", serviceId: "service", protectedEnvironmentIds: ["alpha"] },
  planetscale: { organization: "org", database: "db", protectedBranch: "main" },
  cloudflare: { accountId: "account", zoneId: "zone", domain: "example.com" }, registry: { bucket: "dev-registry" }, storage: { bucket: "dev-storage" } };
function fixture() {
  const lease: any = { state: newHostedGeneration(identity), save: vi.fn(), fence: vi.fn() };
  const events: string[] = [];
  const services: any = Object.fromEntries(["preflight", "captureSource", "ensureImage", "ensureDatabase", "ensureBackend", "stopBackend", "migrate", "ensureWebhook", "deployBackend", "deployWeb", "verify", "deleteWorkers", "deleteBackend", "deleteImages", "deleteWeb", "deleteWebhook", "deleteObjects", "deleteDatabase"].map(k => [k, vi.fn(async () => { events.push(k); })]));
  services.captureSource.mockImplementation(async () => { events.push("captureSource"); return { sourceSha256: "a".repeat(64), workerInputsSha256: "b".repeat(64), commit: "c".repeat(40) }; });
  return { lease, events, services };
}
describe("hosted Dev lifecycle", () => {
  it("reuses a ready generation, deletes immediately on archive and creates fresh keys on relaunch", async () => {
    const f = fixture();
    await startHosted(f.lease, identity, profile, f.services);
    const first = structuredClone(f.lease.state); f.events.length = 0;
    expect((await startHosted(f.lease, identity, profile, f.services)).reused).toBe(true);
    expect(f.events).toEqual(["preflight", "captureSource", "verify"]);
    f.events.length = 0;
    await archiveHosted(f.lease, profile, f.services);
    expect(f.events).toEqual(["stopBackend", "deleteBackend", "deleteWorkers", "deleteImages", "deleteWeb", "deleteWebhook", "deleteObjects", "deleteDatabase"]);
    expect(f.lease.state.keys).toBeUndefined(); expect(f.lease.state.status).toBe("archived");
    await startHosted(f.lease, identity, profile, f.services);
    expect(f.lease.state.generation).not.toBe(first.generation);
    expect(f.lease.state.keys.cookie).not.toBe(first.keys.cookie);
  });
  it("retains the database and archive fence on uncertain worker deletion, then retries only unfinished steps", async () => {
    const f = fixture(); f.services.deleteWorkers.mockRejectedValueOnce(new Error("unknown provider outcome"));
    await expect(archiveHosted(f.lease, profile, f.services)).rejects.toThrow("unknown provider outcome");
    expect(f.lease.state.status).toBe("archiving"); expect(f.services.deleteDatabase).not.toHaveBeenCalled();
    expect(f.services.deleteBackend).toHaveBeenCalledOnce();
    await expect(startHosted(f.lease, identity, profile, f.services)).rejects.toThrow(/archive is incomplete/);
    await archiveHosted(f.lease, profile, f.services);
    expect(f.services.stopBackend).toHaveBeenCalledTimes(1); expect(f.services.deleteWorkers).toHaveBeenCalledTimes(2);
    f.events.length = 0; await archiveHosted(f.lease, profile, f.services); expect(f.events).toEqual([]);
  });
  it("never publishes readiness if the deployed backend is stale or the web facade is unreachable", async () => {
    const f = fixture(); f.services.verify.mockRejectedValue(new Error("wrong source"));
    await expect(startHosted(f.lease, identity, profile, f.services)).rejects.toThrow("wrong source");
    expect(f.lease.state.status).toBe("provisioning"); expect(f.lease.state.source).toBeUndefined();
  });
  it("carries pending builder storage receipts through archive and a fresh generation", async () => {
    const f = fixture(), builder = { id: "bx_23456789", deletionOperationId: "bdop_" + "a".repeat(32),
      deleteRequested: true, retiredAt: new Date().toISOString(), deletionStage: "waiting_for_uploads" };
    f.lease.state.resources.images = [{ builder }];
    const selected = { ...profile, boat: { accountScope: "test-scope", billingOrg: "test-org" } };
    const result = await archiveHosted(f.lease, selected, f.services);
    expect(result.delayedImageStorageRemoval).toBe(true);
    expect(f.lease.state.pendingBuilderDeletions).toEqual([{ ...builder, accountScope: "test-scope", billingOrg: "test-org" }]);
    await startHosted(f.lease, identity, selected, f.services);
    expect(f.lease.state.pendingBuilderDeletions).toHaveLength(1);
  });
  it("reconciles a stopped unchanged deployment without replacing its database generation", async () => {
    const f = fixture(); await startHosted(f.lease, identity, profile, f.services);
    const generation = f.lease.state.generation, keys = { ...f.lease.state.keys };
    f.services.verify.mockRejectedValueOnce(new Error("backend stopped"));
    f.events.length = 0;
    expect((await startHosted(f.lease, identity, profile, f.services)).reused).toBe(false);
    expect(f.lease.state.generation).toBe(generation); expect(f.lease.state.keys).toEqual(keys);
    expect(f.events).toContain("deployBackend"); expect(f.lease.state.status).toBe("ready");
  });
});
