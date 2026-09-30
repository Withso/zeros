import { expect, it, vi } from "vitest";
import * as state from "../dev-environment/hosted-state.mjs";
import { archiveHosted } from "../dev-environment/hosted-lifecycle.mjs";
import * as gcCli from "../dev-environment/gc-cli.mjs";
const identity = { owner: "a".repeat(24), identity: "test" };
const profile: any = { railway: { projectId: "project", serviceId: "service", protectedEnvironmentIds: ["alpha", "beta", "production"] },
  planetscale: { organization: "org", database: "db", protectedBranch: "main" }, cloudflare: { accountId: "account", zoneId: "zone", domain: "example.com" },
  registry: { bucket: "registry", encryptionKey: "a".repeat(64) }, storage: { bucket: "objects" }, boat: { baseSnapshot: "base", protectedSnapshots: ["release"], accountScope: "scope", billingOrg: "org" } };

it("requires a private scheduled profile and qualified Node 22.18+ before GC can run", () => {
  const env = { ZEROS_DEV_GC_PROFILE_PATH: "/run/secrets/dev-profile.json" };
  expect(() => (gcCli as any).assertScheduledGcRuntime(env, "22.18.0")).not.toThrow();
  for (const version of ["20.20.0", "22.17.0", "23.0.0", "25.1.0"]) expect(() => (gcCli as any).assertScheduledGcRuntime(env, version)).toThrow(/Node/);
  expect(() => (gcCli as any).assertScheduledGcRuntime({}, "22.18.0")).toThrow(/profile/);
});

it("records a verifiable archive intent before compute stops", async () => {
  const record = state.newHostedGeneration(identity);
  const lease: any = { state: record, fence: vi.fn(), save: vi.fn() };
  const services: any = Object.fromEntries(["stopBackend", "deleteBackend", "deleteWorkers", "deleteImages", "deleteWeb", "deleteWebhook", "deleteObjects", "deleteDatabase"].map(k => [k, vi.fn()]));
  services.stopBackend.mockImplementation(() => { expect(record.archiveIntent?.signature).toMatch(/^[a-f0-9]{64}$/); });
  await archiveHosted(lease, profile, services);
  expect(record.version).toBe(2);
});
it("does not silently age out legacy receipts", () => {
  const record: any = state.newHostedGeneration(identity); record.version = 1; record.createdAt = "2000-01-01T00:00:00Z";
  expect((state as any).hostedGcEligibility(record, profile).eligible).toBe(false);
});
it("enrolls an explicit archive retry of a legacy tombstone without resurrecting resources", async () => {
  const record: any = state.newHostedGeneration(identity); record.version = 1; record.status = "archived"; delete record.keys;
  const stopBackend = vi.fn(), lease = { state: record, save: vi.fn(), fence: vi.fn() };
  await archiveHosted(lease, profile, { stopBackend });
  expect(state.hostedGcEligibility(record, profile).eligible).toBe(true);
  expect(stopBackend).not.toHaveBeenCalled();
  expect(lease.save).toHaveBeenCalled();
});
it("requires signed archive intent or explicitly enrolled maximum lifetime", () => {
  const record: any = state.newHostedGeneration(identity);
  record.status = "archiving"; record.archiveRequestedAt = "2000-01-01T00:00:00Z";
  expect((state as any).hostedGcEligibility(record, profile).eligible).toBe(false);
  record.archiveIntent = { version: 1, signature: "b".repeat(64) };
  expect((state as any).hostedGcEligibility(record, profile).eligible).toBe(false);
});
it("finishes paginated registry inventory and rejects a missing continuation", async () => {
  class Command { input: any; constructor(input: any) { this.input = input; } }
  const record = state.newHostedGeneration(identity), body = state.sealReceipt(record, profile.registry.encryptionKey);
  let page = 0, incomplete = false;
  const store = state.r2Registry({ ...profile.registry, endpoint: `https://${"a".repeat(32)}.r2.cloudflarestorage.com`, bucket: "test-dev-registry", accessKeyId: "synthetic", secretAccessKey: "synthetic" }, {
    sdk: { ListObjectsV2Command: Command, GetObjectCommand: Command },
    client: { send: vi.fn(async (command: any) => {
      if (command.input.Key) return { ETag: "1", ContentLength: body.length, Body: { transformToString: async () => body } };
      if (incomplete) return { Contents: [], IsTruncated: true };
      if (++page === 1) return { Contents: [], IsTruncated: true, NextContinuationToken: "next" };
      return { Contents: [{ Key: `environments/v1/${identity.owner}.json` }], IsTruncated: false };
    }) },
  });
  expect((await store.list()).records).toHaveLength(1); expect(page).toBe(2);
  incomplete = true; await expect(store.list()).rejects.toThrow(/pagination/);
});

it("plans without mutations and quarantines unknown inventory", async () => {
  const { planHostedGc } = await import("../dev-environment/hosted-gc.mjs");
  const record = state.newHostedGeneration(identity);
  const write = vi.fn();
  const result = await planHostedGc({ list: async () => ({ records: [{ state: record }], quarantine: [] }), write }, profile,
    { inventory: async () => [{ provider: "boat", id: "unknown-dev-looking-name" }] });
  expect(result.entries[0].eligible).toBe(false);
  expect(result.quarantine[0].reason).toBe("no-authenticated-receipt");
  expect(write).not.toHaveBeenCalled();
});
it("keeps authenticated cleanup eligible when an independent inventory provider is unavailable", async () => {
  const { planHostedGc } = await import("../dev-environment/hosted-gc.mjs");
  const record = state.newHostedGeneration(identity); state.recordArchiveIntent(record, profile);
  const result = await planHostedGc({ list: async () => ({ records: [{ state: record }], quarantine: [] }) }, profile,
    { inventory: async () => { throw new Error("denied"); } });
  expect(result.entries[0].eligible).toBe(true);
  expect(result.quarantine).toContainEqual({ reason: "incomplete-provider-inventory" });
});
it.each(["railway", "database", "snapshot", "connection", "registry"])("preserves protected %s resources", async kind => {
  const { assertHostedGcTargets } = await import("../dev-environment/hosted-gc.mjs");
  const record = state.newHostedGeneration(identity), selected = structuredClone(profile);
  if (kind === "railway") record.resources.railway = { id: "alpha" };
  if (kind === "database") record.resources.planetscale = { name: "main" };
  if (kind === "snapshot") record.resources.images = [{ snapshotId: "base" }];
  if (kind === "connection") { selected.protectedResources = { railwayServices: ["connection-service"] }; record.resources.railway = { serviceId: "connection-service" }; }
  if (kind === "registry") selected.storage.bucket = selected.registry.bucket;
  expect(() => assertHostedGcTargets(record, selected)).toThrow(/Protected/);
});
it("rechecks the generation after a stale scan and continues to the next owner on failure", async () => {
  const { applyHostedGc } = await import("../dev-environment/hosted-gc.mjs");
  const first = state.newHostedGeneration(identity); state.recordArchiveIntent(first, profile);
  const second = state.newHostedGeneration({ owner: "b".repeat(24), identity: "other" }); state.recordArchiveIntent(second, profile);
  const records = new Map([[first.owner, first], [second.owner, second]]);
  let revision = 0;
  const store = { read: async (owner: string) => ({ state: structuredClone(records.get(owner)), etag: String(revision) }),
    write: async (owner: string, value: any) => { records.set(owner, structuredClone(value)); return String(++revision); } };
  const services = Object.fromEntries(["stopBackend", "deleteBackend", "deleteWorkers", "deleteImages", "deleteWeb", "deleteWebhook", "deleteObjects", "deleteDatabase"].map(k => [k, vi.fn()]));
  const result = await applyHostedGc(store, profile, { entries: [
    { owner: first.owner, identity: first.identity, generation: "11111111-1111-4111-8111-111111111111", eligible: true },
    { owner: second.owner, identity: second.identity, generation: second.generation, eligible: true },
  ] }, async () => services);
  expect(result.results.map(row => row.outcome)).toEqual(["unconfirmed", "archived-or-retention-reconciled"]);
  expect(services.stopBackend).toHaveBeenCalledOnce();
});

it("does not mistake offline time or maintenance writes for user activity", () => {
  const record = state.newHostedGeneration(identity, undefined, 1_000_000);
  state.bindHostedLifetime(record, { ...profile, lifecycle: { maxLifetimeHours: 1, activityGraceHours: 1 } }, 1_000_000);
  const userActivity = record.lastUserActivityAt;
  record.lease = { token: "maintenance", expiresAt: 1_000_000 + 99 * 3600_000 };
  expect(state.hostedGcEligibility(record, profile, 1_000_000 + 2 * 3600_000).eligible).toBe(true);
  expect(record.lastUserActivityAt).toBe(userActivity);
});

it("bounds a stuck owner's turn, then stops the next owner's compute", async () => {
  const { applyHostedGc } = await import("../dev-environment/hosted-gc.mjs");
  const first = state.newHostedGeneration(identity), second = state.newHostedGeneration({ owner: "b".repeat(24), identity: "second" });
  for (const record of [first, second]) state.recordArchiveIntent(record, profile);
  const records = new Map([first, second].map(record => [record.owner, record])); let revision = 0;
  const store = { read: async (owner: string) => ({ state: structuredClone(records.get(owner)), etag: String(revision) }),
    write: async (owner: string, value: any) => { records.set(owner, structuredClone(value)); return String(++revision); } };
  const stop = vi.fn(async lease => {
    if (lease.state.owner !== first.owner) return;
    await new Promise<void>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("test deadline")), 1000);
      lease.signal.addEventListener("abort", () => { clearTimeout(timer); reject(lease.signal.reason); }, { once: true });
    });
  });
  const services: any = Object.fromEntries(["deleteBackend", "deleteWorkers", "deleteImages", "deleteWeb", "deleteWebhook", "deleteObjects", "deleteDatabase"].map(k => [k, vi.fn()]));
  services.stopBackend = stop;
  const started = Date.now();
  const result = await applyHostedGc(store, profile, { entries: [first, second].map(record => ({ ...record, eligible: true })) }, async () => services, { ownerBudgetMs: 40 });
  expect(Date.now() - started).toBeLessThan(500);
  expect(stop).toHaveBeenCalledTimes(2);
  expect(result.results.map(row => row.outcome)).toEqual(["unconfirmed", "archived-or-retention-reconciled"]);
});
