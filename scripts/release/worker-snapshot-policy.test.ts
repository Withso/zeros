import { describe, expect, it } from "vitest";
import { WorkerNamedAdmissionLedgerSchema, WorkerNamedReviewEvidenceSchema, WorkerNameRetirementSchema, workerNamedRetirementSha256 } from "./worker-named-retirement-contracts";

const compute = { maxActiveGenerations: 4, maxGenerationsPerOwner: 1, maxBuilders: 1, maxBuildersPerOwner: 1 };
const ledger = <Policy,>(policy: Policy) => ({ version: 1, owner: "account-admission", account: "a".repeat(64), reservations: [], policy });

describe("snapshot policy compatibility", () => {
  it.each([{}, { maxNamedSnapshots: 9 }, { snapshotHeadroom: 1 }, { maxNamedSnapshots: 10, snapshotHeadroom: 1 }])("preserves old and current policies without defaults or digest changes: %j", legacy => {
    const original = ledger({ ...compute, ...legacy }), before = structuredClone(original);
    const parsed = WorkerNamedAdmissionLedgerSchema.parse(original);
    expect(parsed).toEqual(before); expect(original).toEqual(before);
    expect(workerNamedRetirementSha256(parsed)).toBe(workerNamedRetirementSha256(before));
    expect(Object.keys(parsed.policy!)).toEqual(Object.keys(before.policy!));
  });
  it.each([
    { ...compute, maxNamedSnapshots: 11 }, { ...compute, maxNamedSnapshots: 0 }, { ...compute, snapshotHeadroom: -1 },
    { ...compute, snapshotHeadroom: null }, { ...compute, maxBuilders: undefined }, { ...compute, maxBuilders: 0 },
    { ...compute, providerLimit: 100 },
  ])("retains strict historical field validation and required compute fields: %j", policy => {
    expect(WorkerNamedAdmissionLedgerSchema.safeParse(ledger(policy)).success).toBe(false);
  });
  it("keeps strict ledger ownership and unknown-key rejection", () => {
    expect(WorkerNamedAdmissionLedgerSchema.safeParse({ ...ledger(compute), owner: "other-owner" }).success).toBe(false);
    expect(WorkerNamedAdmissionLedgerSchema.safeParse({ ...ledger(compute), extra: true }).success).toBe(false);
  });
  it("bounds complete inventories independently of the provider plan", () => {
    const schemas = [WorkerNamedReviewEvidenceSchema.shape.inventory.shape.names, WorkerNameRetirementSchema.options[0].shape.namespace.shape.names];
    const names = Array.from({ length: 10_000 }, (_, index) => `retained-${index}`);
    for (const schema of schemas) {
      expect(schema.parse(names)).toEqual(names);
      expect(schema.safeParse([...names, "overflow"]).success).toBe(false);
      expect(schema.safeParse(["invalid name"]).success).toBe(false);
      expect(schema.safeParse([]).success).toBe(false);
    }
  });
});
