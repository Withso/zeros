import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { assertWorkerSnapshotSlots, reconcileWorkerSnapshotHolds, reserveWorkerSlot, workerOwner, workerSnapshotName } from "./worker-admission";

const profile = { boat: { accountScope: "shared-test", billingOrg: "synthetic-org", baseSnapshot: "retained-base" },
  railway: { projectId: "test-project" }, planetscale: { organization: "test-org", database: "test-db" }, cloudflare: { accountId: "test-account" } };
const state = () => ({ owner: workerOwner("alpha"), generation: "11111111-1111-4111-8111-111111111111", status: "provisioning",
  createdAt: new Date().toISOString(), resources: { images: [] } });
const snapshot = (channel: "alpha" | "beta" | "production", suffix: string) => `dev-${workerOwner(channel)}-11111111-${suffix}`;
const inventory = (names: string[]) => names.map(id => ({ provider: "boat", id }));
const account = createHash("sha256").update(JSON.stringify([profile.boat.accountScope, profile.boat.billingOrg,
  profile.railway.projectId, profile.planetscale.organization, profile.planetscale.database, profile.cloudflare.accountId])).digest("hex");

describe("shared Boat release snapshot slots", () => {
  it.each(["alpha", "beta", "production"] as const)("allows a third %s name within the account limit", channel => {
    const names = ["retained-base", snapshot(channel, "current"), snapshot(channel, "rollback")];
    expect(assertWorkerSnapshotSlots(channel, snapshot(channel, "candidate"), profile, inventory(names), []).used).toBe(4);
  });
  it.each([0, 1, 4])("admits the tenth name across Dev/custom/release names with legacy headroom %s", snapshotHeadroom => {
    const names = ["retained-base", snapshot("alpha", "current"), snapshot("alpha", "rollback"),
      "dev-one", "dev-two", "dev-three", "zeros-org-one", "zeros-org-two", "zeros-org-three"];
    const selected = { ...profile, admission: { snapshotHeadroom } };
    expect(assertWorkerSnapshotSlots("alpha", workerSnapshotName(state(), "a".repeat(64)), selected, inventory(names), []))
      .toEqual({ used: 10, headroom: 0, limit: 10 });
  });
  it("refuses an eleventh name, an unconfirmed base and a candidate belonging to another channel", () => {
    const candidate = workerSnapshotName(state(), "a".repeat(64));
    const names = ["retained-base", ...Array.from({ length: 9 }, (_, index) => `other-${index}`)];
    expect(() => assertWorkerSnapshotSlots("alpha", candidate, profile, inventory(names), [])).toThrow(/capacity/);
    expect(() => assertWorkerSnapshotSlots("alpha", candidate, profile, [], [])).toThrow("protected base");
    expect(() => assertWorkerSnapshotSlots("beta", candidate, profile, inventory(["retained-base"]), [])).toThrow("another channel");
    expect(() => assertWorkerSnapshotSlots("alpha", candidate, { ...profile, admission: { maxBuilders: 2 } }, inventory(["retained-base"]), [])).toThrow("builder policy");
  });
  it("counts pending and retired-builder snapshot holds once, never releasing them by age", () => {
    const held = snapshot("alpha", "rollback");
    const reservations = [{ kind: "builder", snapshotName: held, releasedAt: "2020-01-01T00:00:00.000Z" }];
    const names = inventory(["retained-base", ...Array.from({ length: 8 }, (_, index) => `other-${index}`)]);
    const candidate = workerSnapshotName(state(), "a".repeat(64));
    expect(() => assertWorkerSnapshotSlots("alpha", candidate, profile, names, reservations)).toThrow("snapshot capacity");
    expect(assertWorkerSnapshotSlots("alpha", held, profile, [...names, { provider: "boat", id: held }], reservations).used).toBe(10);
    expect(assertWorkerSnapshotSlots("alpha", candidate, profile, names, [{ ...reservations[0], snapshotReleasedAt: "2020-01-02T00:00:00.000Z" }]).used).toBe(10);
  });
  it("reserves through Dev's account CAS before any builder and rejects stale cross-channel contenders", async () => {
    let ledger: any = { version: 1, owner: "account-admission", account, reservations: [] };
    const store = { list: vi.fn(async () => ({ records: [], quarantine: [] })), readAdmission: vi.fn(async () => ({ state: structuredClone(ledger), etag: "test" })),
      writeAdmission: vi.fn(async (next: any) => { ledger = structuredClone(next); }) };
    const owner = state(), lease = { state: owner, save: vi.fn(), fence: vi.fn() };
    await reserveWorkerSlot(store, lease, profile, "alpha", workerSnapshotName(owner, "a".repeat(64)), inventory(["retained-base"]));
    expect(store.writeAdmission).toHaveBeenCalledOnce();
    expect(ledger.reservations).toContainEqual(expect.objectContaining({ kind: "builder", snapshotName: expect.any(String) }));
    const beta = { ...state(), owner: workerOwner("beta"), generation: "22222222-2222-4222-8222-222222222222" };
    await expect(reserveWorkerSlot(store, { ...lease, state: beta }, profile, "beta", workerSnapshotName(beta, "b".repeat(64)), inventory(["retained-base"]))).rejects.toThrow("admission cap");
    expect(store.writeAdmission).toHaveBeenCalledOnce();
  });
  it("releases an externally retired acknowledged image only after complete inventory, exact absence and builder physical deletion proof", async () => {
    const owner = state(), old = snapshot("alpha", "rollback"), next = workerSnapshotName(owner, "a".repeat(64));
    const image: any = { purpose: "release-worker", snapshotId: old, sourceCommit: "b".repeat(40), buildSha256: "c".repeat(64), qualified: true,
      snapshotRequested: true, snapshotCreate: { phase: "acknowledged" }, builder: { id: "bx_old", deleted: true, deletionOperationId: `bdop_${"d".repeat(32)}` },
      candidate: { snapshotId: old, sourceCommit: "b".repeat(40), buildSha256: "c".repeat(64) } };
    owner.resources.images.push(image as never);
    let ledger: any = { version: 1, owner: "account-admission", account, reservations: [{ kind: "builder", owner: owner.owner, generation: owner.generation,
      computeId: `snapshot:${old}`, snapshotName: old, createdAt: owner.createdAt, releasedAt: owner.createdAt }] };
    const store = { list: vi.fn(async () => ({ records: [], quarantine: [] })), readAdmission: vi.fn(async () => ({ state: structuredClone(ledger), etag: "test" })),
      writeAdmission: vi.fn(async (value: any) => { ledger = structuredClone(value); }) };
    const retained = { state: owner, save: vi.fn(async () => {}), fence: vi.fn(async () => {}) };
    const names = inventory(["retained-base", ...Array.from({ length: 8 }, (_, index) => `other-${index}`)]);
    const request = vi.fn(async () => ({ status: 404 }));
    expect(() => assertWorkerSnapshotSlots("alpha", next, profile, names, ledger.reservations)).toThrow("snapshot capacity");
    await reconcileWorkerSnapshotHolds(store, retained, profile, names, request);
    expect(request).toHaveBeenCalledWith("GET", `/named-snapshots/${old}`);
    expect(image).toMatchObject({ snapshotDeleted: true, snapshotRetirementReason: "externally-pruned-after-builder-cleanup" });
    expect(ledger.reservations).toEqual([]);
    await expect(reserveWorkerSlot(store, retained, profile, "alpha", next, names)).resolves.toBeDefined();
  });
  it("never clears an uncertain snapshot create, incomplete cleanup, or inventory/readback disagreement", async () => {
    const old = snapshot("alpha", "rollback"), known: any = { purpose: "release-worker", snapshotId: old, sourceCommit: "b".repeat(40), buildSha256: "c".repeat(64), qualified: true,
      snapshotRequested: true, snapshotCreate: { phase: "acknowledged" }, builder: { id: "bx_old", deleted: true, deletionOperationId: `bdop_${"d".repeat(32)}` },
      candidate: { snapshotId: old, sourceCommit: "b".repeat(40), buildSha256: "c".repeat(64) } };
    for (const patch of [{ snapshotCreate: { phase: "uncertain" } }, { builder: { id: "bx_old", retiredAt: new Date().toISOString() } }, { candidate: undefined }]) {
      const owner = state(), image = { ...known, ...patch }; owner.resources.images.push(image as never);
      const request = vi.fn(), store = { writeAdmission: vi.fn() };
      await reconcileWorkerSnapshotHolds(store, { state: owner, save: vi.fn(), fence: vi.fn() }, profile, inventory(["retained-base"]), request);
      expect(request).not.toHaveBeenCalled(); expect(store.writeAdmission).not.toHaveBeenCalled(); expect(image.snapshotDeleted).toBeUndefined();
    }
    for (const status of [200, 401, 500]) {
      const owner = state(), image = { ...known }; owner.resources.images.push(image as never);
      await expect(reconcileWorkerSnapshotHolds({}, { state: owner, save: vi.fn(), fence: vi.fn() }, profile, inventory(["retained-base"]), vi.fn(async () => ({ status })))).rejects.toThrow("inventory");
      expect(image.snapshotDeleted).toBeUndefined();
    }
  });
});
