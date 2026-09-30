import { expect, it } from "vitest";
import { reserveHostedAdmission } from "../dev-environment/hosted-admission.mjs";
import { newHostedGeneration } from "../dev-environment/hosted-state.mjs";
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
it("reserves snapshot headroom before builder allocation and retains an uncertain reservation", async () => {
  const store = fixture(), state = newHostedGeneration({ owner: "a".repeat(24), identity: "a" });
  const selected = { ...profile, admission: { maxBuilders: 2, maxBuildersPerOwner: 2 } };
  const inventory = [{ provider: "boat", id: "base" }, ...Array.from({ length: 7 }, (_, i) => ({ provider: "boat", id: `release-${i}` }))];
  const snapshotName = `dev-${state.owner}-${state.generation.slice(0, 8)}-first`;
  await reserveHostedAdmission(store, state, selected, { kind: "builder", inventory, snapshotName });
  await expect(reserveHostedAdmission(store, state, selected, { kind: "builder", inventory, snapshotName: snapshotName + "other", now: Date.now() + 86400_000 })).rejects.toThrow(/snapshot capacity/);
});
