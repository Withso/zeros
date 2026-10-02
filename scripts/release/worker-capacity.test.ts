import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BoatAccountAdmission, protectedBoatSnapshotCapacity, openBoatAccountDocument, sealBoatAccountDocument } from "../../apps/control-plane/src/cloud-workspaces/boat-account-admission";
import { reserveHostedAdmission } from "../dev-environment/hosted-admission.mjs";
import { newHostedGeneration, sealReceipt, openReceipt } from "../dev-environment/hosted-state.mjs";
import { assertWorkerSnapshotSlots, workerOwner } from "./worker-admission";
import { workerConnections } from "./worker-test-fixtures";

const profile = { boat: { accountScope: "shared-test", billingOrg: "synthetic-wallet", baseSnapshot: "retained-base" }, railway: { projectId: "canonical-project" },
  planetscale: { organization: "canonical-org", database: "canonical-db" }, cloudflare: { accountId: "canonical-account" } };
const account = createHash("sha256").update(JSON.stringify([profile.boat.accountScope, profile.boat.billingOrg, profile.railway.projectId,
  profile.planetscale.organization, profile.planetscale.database, profile.cloudflare.accountId])).digest("hex");
const base = [profile.boat.baseSnapshot];
const image = (id = "11111111-1111-4111-8111-111111111111") => ({ id, org_id: "22222222-2222-4222-8222-222222222222",
  account_scope: profile.boat.accountScope, snapshot_name: `zeros-org-${id.replaceAll("-", "")}`, created_at: new Date() } as any);
function storeFixture() {
  let state: any = { version: 1, owner: "account-admission", account, reservations: [] }, revision = "1";
  return { list: async () => ({ records: [], quarantine: [] }), readAdmission: async () => ({ state: structuredClone(state), etag: revision }),
    writeAdmission: async (next: any, etag: string) => { if (etag !== revision) throw Object.assign(new Error(), { code: "DEV_REGISTRY_CONFLICT" });
      state = structuredClone(next); revision = String(Number(revision) + 1); return revision; },
    readDocument: async () => null };
}
describe("provider-owned named-snapshot quota", () => {
  it.each(["alpha", "beta", "production", "dev", "custom"] as const)("admits an upgraded plan's %s name with identical accounting and no claimed quota", channel => {
    const selected = [...base, ...Array.from({ length: 20 }, (_, index) => `foreign-${index}`)];
    const release = channel !== "dev" && channel !== "custom";
    const candidate = release ? `zeros-${channel}-next` : channel === "custom" ? image().snapshot_name : "dev-next";
    const configured = { ...profile, admission: { snapshotHeadroom: 1, maxNamedSnapshots: 9 } };
    expect(protectedBoatSnapshotCapacity(configured, selected, [], candidate, release ? "release" : "non-release"))
      .toEqual({ used: 22 });
    expect(protectedBoatSnapshotCapacity(configured, [...selected, "held-by-another"], [], candidate)).toEqual({ used: 23 });
    if (release) expect(assertWorkerSnapshotSlots(channel, candidate, configured, selected.map(id => ({ provider: "boat", id })), []).used).toBe(22);
  });
  it("allows custom preflight and reservations beyond ten while retaining compute admission and every name hold", async () => {
    const store = storeFixture(), admission = new BoatAccountAdmission(store, { ...profile, admission: { snapshotHeadroom: 1, maxNamedSnapshots: 9 } });
    const inventory = [...base, ...Array.from({ length: 20 }, (_, index) => `zeros-org-existing-${index}`)], first = image();
    await expect(admission.capacity(inventory)).resolves.toEqual({ used: 21 });
    await admission.reserve(first, inventory);
    await expect(admission.capacity(inventory)).rejects.toThrow("image capacity reached");
    await admission.release(first, { computeDeleted: true, snapshotDeleted: false });
    await expect(admission.capacity(inventory)).resolves.toEqual({ used: 22 });
    const reservations = (await store.readAdmission()).state.reservations;
    expect(protectedBoatSnapshotCapacity(profile, [...inventory, first.snapshot_name], reservations, first.snapshot_name)).toEqual({ used: 22 });
    await expect(admission.reserve(image("33333333-3333-4333-8333-333333333333"), inventory)).resolves.toBeDefined();
  });
  it("retains both custom and Dev name holds through a stale CAS when compute policy permits both builders", async () => {
    const selected = { ...profile, admission: { maxBuilders: 2 } };
    const store = storeFixture(), admission = new BoatAccountAdmission(store, selected), dev = newHostedGeneration({ owner: "a".repeat(24), identity: "synthetic-dev" });
    const inventory = [...base, ...Array.from({ length: 20 }, (_, index) => `other-${index}`)];
    const read = store.readAdmission, write = store.writeAdmission;
    let reads = 0, conflicts = 0, releaseReads!: () => void;
    const bothRead = new Promise<void>(resolve => { releaseReads = resolve; });
    store.readAdmission = async () => {
      const current = await read();
      if (++reads <= 2) { if (reads === 2) releaseReads(); await bothRead; }
      return current;
    };
    store.writeAdmission = async (next, etag) => {
      try { return await write(next, etag); }
      catch (error) { if ((error as any).code === "DEV_REGISTRY_CONFLICT") conflicts++; throw error; }
    };
    const results = await Promise.allSettled([admission.reserve(image(), inventory), reserveHostedAdmission(store, dev, selected, { kind: "builder",
      snapshotName: `dev-${dev.owner}-${dev.generation.slice(0, 8)}-${"b".repeat(16)}`, inventory: inventory.map(id => ({ provider: "boat", id })) })]);
    expect(results.filter(row => row.status === "fulfilled")).toHaveLength(2);
    expect(conflicts).toBe(1);
    expect((await store.readAdmission()).state.reservations.filter((row: any) => row.snapshotName && !row.snapshotReleasedAt)).toHaveLength(2);
  });
  it("keeps the builder cap independent when custom and Dev contenders have spare names", async () => {
    const store = storeFixture(), admission = new BoatAccountAdmission(store, profile), dev = newHostedGeneration({ owner: "a".repeat(24), identity: "synthetic-dev" });
    const results = await Promise.allSettled([admission.reserve(image(), base), reserveHostedAdmission(store, dev, profile, { kind: "builder",
      snapshotName: `dev-${dev.owner}-${dev.generation.slice(0, 8)}-next`, inventory: base.map(id => ({ provider: "boat", id })) })]);
    expect(results.filter(row => row.status === "fulfilled")).toHaveLength(1);
    expect((await store.readAdmission()).state.reservations.filter(row => row.kind === "builder" && !row.releasedAt)).toHaveLength(1);
  });
  it("keeps protected-base, account and custom candidate identity checks", async () => {
    expect(() => protectedBoatSnapshotCapacity(profile, [], [], image().snapshot_name)).toThrow("image capacity reached");
    expect(() => protectedBoatSnapshotCapacity(profile, base, [], "zeros-alpha-next", "non-release")).toThrow("image capacity reached");
    const store = storeFixture(), admission = new BoatAccountAdmission(store, profile), first = image();
    await expect(admission.reserve({ ...first, account_scope: "other-account" }, base)).rejects.toThrow("image capacity reached");
    await expect(admission.reserve({ ...first, snapshot_name: "zeros-alpha-next" }, base)).rejects.toThrow("image capacity reached");
    const saved = await store.readAdmission(); saved.state.account = "f".repeat(64); await store.writeAdmission(saved.state, saved.etag);
    await expect(admission.capacity(base)).rejects.toThrow("image capacity reached");
    await expect(admission.reserve(first, base)).rejects.toThrow("image capacity reached");
  });
  it("requires the protected base in actual inventory even when a ledger row names it", () => {
    const hold = { kind: "builder" as const, owner: "a".repeat(24), generation: image().id, snapshotName: profile.boat.baseSnapshot,
      computeId: `snapshot:${profile.boat.baseSnapshot}`, createdAt: new Date().toISOString() };
    expect(() => protectedBoatSnapshotCapacity(profile, [], [hold], image().snapshot_name)).toThrow("image capacity reached");
  });
  it("never expires uncertain custom snapshots and releases only physically confirmed compute/snapshot capacity", async () => {
    const store = storeFixture(), admission = new BoatAccountAdmission(store, profile), first = image();
    const inventory = [...base, ...Array.from({ length: 7 }, (_, index) => `retained-${index}`)];
    await admission.reserve(first, inventory); await admission.release(first, { computeDeleted: false, snapshotDeleted: false });
    const next = image("33333333-3333-4333-8333-333333333333");
    await expect(admission.reserve(next, inventory)).rejects.toThrow("image capacity reached");
    await admission.release(first, { computeDeleted: true, snapshotDeleted: false });
    await admission.reserve(next, inventory); await admission.release(next, { computeDeleted: true, snapshotDeleted: false });
    await expect(admission.reserve(image("44444444-4444-4444-8444-444444444444"), inventory)).resolves.toBeDefined();
    expect((await store.readAdmission()).state.reservations.filter(row => row.snapshotName && !row.snapshotReleasedAt)).toHaveLength(3);
    await admission.release(first, { computeDeleted: true, snapshotDeleted: true });
    expect((await store.readAdmission()).state.reservations.filter(row => row.snapshotName && !row.snapshotReleasedAt)).toHaveLength(2);
  });
  it("uses the authenticated existing encrypted ledger format instead of a separate per-channel counter", () => {
    const key = "e".repeat(64), state = { version: 1, owner: "account-admission", account, reservations: [] };
    expect(openBoatAccountDocument(sealReceipt(state, key), key, state.owner)).toEqual(state);
    expect(openBoatAccountDocument(sealBoatAccountDocument(state, key), key, state.owner)).toEqual(state);
    expect(() => openBoatAccountDocument(sealReceipt(state, key), "f".repeat(64), state.owner)).toThrow();
    const hosted = newHostedGeneration({ owner: "a".repeat(24), identity: "synthetic" });
    expect(openReceipt(sealBoatAccountDocument(hosted, key), key, hosted.owner)).toEqual(hosted);
  });
  it("allows a canary target only from the fenced exact-source release receipt, never an arbitrary owner VM", async () => {
    const request: any = { channel: "alpha", ownerUserId: "22222222-2222-4222-8222-222222222222", runId: "123", operationId: "11111111-1111-4111-8111-111111111111",
      sourceSha: "a".repeat(40), ...workerConnections().find(row => row.kind === "codex-chatgpt"), qualificationProfile: "smoke", target: { id: "bx_test", sourceCommit: "a".repeat(40), buildSha256: "b".repeat(64), snapshotId: "test-image", attempt: "11111111-1111-4111-8111-111111111111" } };
    const job = { id: request.operationId, kind: request.kind, credentialId: request.credentialId, credentialRevision: request.credentialRevision,
      designationId: request.designationId, model: request.model, qualificationProfile: "smoke", phase: "starting", image: { snapshotId: "test-image", sourceCommit: request.sourceSha, buildSha256: request.target.buildSha256 } };
    const record = { agentQualificationId: job.id, purpose: "native-agent-qualification", sourceCommit: request.sourceSha, sourceImage: "test-image", machineAttestationStarted: true, nativeDispatchStarted: true, builder: { id: "bx_test" } };
    const state: any = { owner: workerOwner("alpha"), lease: { expiresAt: Date.now() + 120_000 }, releaseRuns: [{ runId: "123", actorUserId: request.ownerUserId, sourceSha: request.sourceSha,
      qualificationProfile: "smoke", releaseCanaryBindings: workerConnections(), canaries: [job] }], resources: { images: [record] } };
    const store = { ...storeFixture(), readDocument: async () => ({ state, etag: "1" }) }, admission = new BoatAccountAdmission(store, profile);
    await expect(admission.assertCanary(request)).resolves.toBeUndefined();
    state.resources.images[0].builder.id = "bx_other";
    await expect(admission.assertCanary(request)).rejects.toThrow("canary");
    state.resources.images[0].builder.id = "bx_test"; state.lease.expiresAt = Date.now() - 1;
    await expect(admission.assertCanary(request)).rejects.toThrow("canary");
  });
});
