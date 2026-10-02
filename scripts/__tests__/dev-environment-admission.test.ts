import { expect, it } from "vitest";
import { reserveHostedAdmission } from "../dev-environment/hosted-admission.mjs";
import { newHostedGeneration } from "../dev-environment/hosted-state.mjs";
import { sha256 } from "../dev-environment/state.mjs";
const profile: any = { boat: { accountScope: "scope", billingOrg: "org", baseSnapshot: "base" }, railway: { projectId: "project" },
  planetscale: { organization: "org", database: "db" }, cloudflare: { accountId: "account" }, admission: { maxActiveGenerations: 1 } };
function fixture() {
  let value: any = null, revision = 0;
  return { list: async () => ({ records: [], quarantine: [] }), readAdmission: async () => value ? structuredClone(value) : null,
    writeAdmission: async (state: any, etag: any) => {
      if (value?.etag !== etag) throw Object.assign(new Error(), { code: "DEV_REGISTRY_CONFLICT" });
      value = { state: structuredClone(state), etag: String(++revision) }; return value.etag;
    } };
}
it("allows only one of two owners competing for the final generation slot", async () => {
  const store = fixture(), a = newHostedGeneration({ owner: "a".repeat(24), identity: "a" }), b = newHostedGeneration({ owner: "b".repeat(24), identity: "b" });
  const results = await Promise.allSettled([reserveHostedAdmission(store, a, profile), reserveHostedAdmission(store, b, profile)]);
  expect(results.filter(row => row.status === "fulfilled")).toHaveLength(1);
  expect((await store.readAdmission()).state.reservations).toHaveLength(1);
});
it("does not deadlock two unallocated provisioning receipts before their first reservation", async () => {
  const store = fixture(), a = newHostedGeneration({ owner: "a".repeat(24), identity: "a" }), b = newHostedGeneration({ owner: "b".repeat(24), identity: "b" });
  store.list = async () => ({ records: [{ state: a }, { state: b }] as any, quarantine: [] });
  const results = await Promise.allSettled([reserveHostedAdmission(store, a, profile), reserveHostedAdmission(store, b, profile)]);
  expect(results.filter(row => row.status === "fulfilled")).toHaveLength(1);
});
it("fails closed on quarantined ownership and corrupt admission rows", async () => {
  const store = fixture(), state = newHostedGeneration({ owner: "a".repeat(24), identity: "a" });
  store.list = async () => ({ records: [], quarantine: [{ reason: "unauthenticated" }] as any });
  await expect(reserveHostedAdmission(store, state, profile)).rejects.toThrow(/inventory/);
  store.list = async () => ({ records: [], quarantine: [] });
  await reserveHostedAdmission(store, state, profile);
  const current = await store.readAdmission(); current.state.reservations.push({ kind: "invalid" });
  await store.writeAdmission(current.state, current.etag);
  await expect(reserveHostedAdmission(store, state, profile)).rejects.toThrow(/ledger/);
});
it.each(["maxActiveGenerations", "maxGenerationsPerOwner", "maxBuilders", "maxBuildersPerOwner"])("still rejects invalid %s despite obsolete snapshot overrides", async key => {
  const store = fixture(), state = newHostedGeneration({ owner: "a".repeat(24), identity: "a" });
  const selected = { ...profile, admission: { [key]: 0, maxNamedSnapshots: 9, snapshotHeadroom: 1 } };
  await expect(reserveHostedAdmission(store, state, selected)).rejects.toThrow("Invalid Dev admission cap");
  expect(await store.readAdmission()).toBeNull();
});
it.each([
  { label: "third Alpha", owner: sha256("zeros-release-worker:alpha").slice(0, 24), names: ["zeros-alpha-current", "zeros-alpha-rollback"] },
  { label: "third Dev/custom", owner: "a".repeat(24), names: ["zeros-org-one", "dev-retained"] },
])("allows a $label snapshot without channel partitions", async ({ owner, names }) => {
  const store = fixture(), state = newHostedGeneration({ owner, identity: "synthetic" });
  const snapshotName = `dev-${state.owner}-${state.generation.slice(0, 8)}-next`;
  await expect(reserveHostedAdmission(store, state, profile, { kind: "builder", snapshotName,
    inventory: ["base", ...names].map(id => ({ provider: "boat", id })) })).resolves.toMatchObject({ snapshotName });
});
it("allows the tenth name with legacy headroom and keeps an absent uncertain reservation against the eleventh", async () => {
  const store = fixture(), state = newHostedGeneration({ owner: "a".repeat(24), identity: "a" });
  const selected = { ...profile, admission: { maxBuilders: 2, maxBuildersPerOwner: 2, maxNamedSnapshots: 9, snapshotHeadroom: 1 } };
  const inventory = ["base", ...Array.from({ length: 8 }, (_, index) => `other-${index}`)].map(id => ({ provider: "boat", id }));
  const snapshotName = `dev-${state.owner}-${state.generation.slice(0, 8)}-first`;
  await reserveHostedAdmission(store, state, selected, { kind: "builder", inventory, snapshotName });
  const current = await store.readAdmission();
  expect(current.state.policy.snapshotHeadroom).toBe(0);
  expect(current.state.policy.maxNamedSnapshots).toBe(10);
  // Compute release and age do not release this name, even if it is absent from inventory.
  current.state.reservations.find(row => row.snapshotName === snapshotName).releasedAt = "2020-01-01T00:00:00.000Z";
  await store.writeAdmission(current.state, current.etag);
  await expect(reserveHostedAdmission(store, state, selected, { kind: "builder", inventory, snapshotName: snapshotName + "other", now: Date.now() + 86400_000 })).rejects.toThrow(/snapshot capacity/);
});
