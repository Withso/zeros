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
describe("one account release and rollback headroom", () => {
  it("leaves six channel slots, one base and one cleanup slot unavailable to custom or Dev builds", async () => {
    const releaseNames = (["alpha", "beta", "production"] as const).flatMap(channel => [`zeros-${channel}-current`, `zeros-${channel}-rollback`]);
    const custom = image(), selected = [...base, ...releaseNames, custom.snapshot_name];
    expect(protectedBoatSnapshotCapacity(profile, selected, [], image("33333333-3333-4333-8333-333333333333").snapshot_name, "non-release").used).toBe(9);
    expect(() => protectedBoatSnapshotCapacity(profile, selected, [], "zeros-org-" + "4".repeat(32), "non-release")).not.toThrow();
    expect(() => protectedBoatSnapshotCapacity(profile, [...selected, "dev-external"], [], "zeros-org-" + "4".repeat(32), "non-release")).toThrow("image capacity reached");
    const candidate = `dev-${workerOwner("alpha")}-11111111-${"f".repeat(16)}`;
    expect(() => assertWorkerSnapshotSlots("alpha", candidate, profile, [...base, "zeros-alpha-current", "zeros-beta-current", "zeros-beta-rollback", "zeros-production-current", "zeros-production-rollback",
      custom.snapshot_name, "zeros-org-" + "4".repeat(32)].map(id => ({ provider: "boat", id })), [])).not.toThrow();
  });
  it("fences custom and Dev contenders through the same CAS when only one non-release slot remains", async () => {
    const store = storeFixture(), admission = new BoatAccountAdmission(store, profile), dev = newHostedGeneration({ owner: "a".repeat(24), identity: "synthetic-dev" });
    const inventory = [...base, "zeros-org-" + "9".repeat(32)];
    const results = await Promise.allSettled([admission.reserve(image(), inventory), reserveHostedAdmission(store, dev, profile, { kind: "builder",
      snapshotName: `dev-${dev.owner}-${dev.generation.slice(0, 8)}-${"b".repeat(16)}`, inventory: inventory.map(id => ({ provider: "boat", id })) })]);
    expect(results.filter(row => row.status === "fulfilled")).toHaveLength(1);
    expect((await store.readAdmission()).state.reservations.filter((row: any) => row.snapshotName && !row.snapshotReleasedAt)).toHaveLength(1);
  });
  it("never expires uncertain custom snapshots and releases only physically confirmed compute/snapshot capacity", async () => {
    const store = storeFixture(), admission = new BoatAccountAdmission(store, profile), first = image();
    await admission.reserve(first, base); await admission.release(first, { computeDeleted: false, snapshotDeleted: false });
    const next = image("33333333-3333-4333-8333-333333333333");
    await expect(admission.reserve(next, base)).rejects.toThrow("image capacity reached");
    await admission.release(first, { computeDeleted: true, snapshotDeleted: false });
    await admission.reserve(next, base); await admission.release(next, { computeDeleted: true, snapshotDeleted: false });
    await expect(admission.reserve(image("44444444-4444-4444-8444-444444444444"), base)).rejects.toThrow("image capacity reached");
    await admission.release(first, { computeDeleted: true, snapshotDeleted: true });
    await expect(admission.reserve(image("44444444-4444-4444-8444-444444444444"), base)).resolves.toBeDefined();
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
