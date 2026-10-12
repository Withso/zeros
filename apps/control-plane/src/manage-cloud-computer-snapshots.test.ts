import { describe, expect, it } from "vitest";
import { computerSnapshotMigrationErrorMessage, validateComputerSnapshotMigration,
  type ComputerSnapshotMigrationInput } from "./manage-cloud-computer-snapshots.js";

const input: ComputerSnapshotMigrationInput = {
  databaseUrl: "postgres://operator:synthetic-password@database.example.test/cloud_test",
  channel: "alpha", execute: false, approvalId: "11111111-1111-4111-8111-111111111111",
  organizationId: "22222222-2222-4222-8222-222222222222", expectedOrganizationSlug: "example-org",
  actorUserId: "33333333-3333-4333-8333-333333333333", reason: "Promote current Computer captures to durable names",
  accountScope: "fixture-account", billingOrg: "team_00000000-0000-0000-0000-000000000001",
};
describe("Computer snapshot migration guards", () => {
  it("defaults to planning and retains only a database fingerprint", () => {
    const parsed = validateComputerSnapshotMigration(input);
    expect(parsed.execute).toBe(false);
    expect(parsed.targetFingerprint).toMatch(/^[a-f0-9]{16}$/);
    expect(JSON.stringify(parsed)).not.toContain("synthetic-password");
    expect(JSON.stringify(parsed)).not.toContain("database.example.test");
  });
  it.each([undefined, "", "production", "Production", "staging"])("refuses channel %s", channel => {
    expect(() => validateComputerSnapshotMigration({ ...input, channel })).toThrow();
  });
  it.each(["production", "beta"])("refuses an incompatible deployment %s", railwayEnvironmentName => {
    expect(() => validateComputerSnapshotMigration({ ...input, railwayEnvironmentName })).toThrow();
  });
  it.each(["organizationId", "actorUserId", "approvalId", "accountScope", "billingOrg", "expectedOrganizationSlug", "reason"] as const)(
    "requires an exact %s", field => {
      expect(() => validateComputerSnapshotMigration({ ...input, [field]: undefined })).toThrow();
    },
  );
  it("binds the plan target to channel, database and account without binding password rotation", () => {
    const first = validateComputerSnapshotMigration(input);
    expect(validateComputerSnapshotMigration({ ...input, databaseUrl: input.databaseUrl.replace("synthetic-password", "rotated") }).targetFingerprint)
      .toBe(first.targetFingerprint);
    expect(validateComputerSnapshotMigration({ ...input, channel: "beta" }).targetFingerprint).not.toBe(first.targetFingerprint);
    expect(validateComputerSnapshotMigration({ ...input, databaseUrl: input.databaseUrl.replace("cloud_test", "different_test") }).targetFingerprint)
      .not.toBe(first.targetFingerprint);
  });
  it("rejects routing overrides and never exposes arbitrary provider or driver errors", () => {
    expect(() => validateComputerSnapshotMigration({ ...input, databaseUrl: `${input.databaseUrl}?host=elsewhere` })).toThrow();
    expect(computerSnapshotMigrationErrorMessage(new Error("synthetic private details"))).not.toContain("synthetic private details");
  });
});
