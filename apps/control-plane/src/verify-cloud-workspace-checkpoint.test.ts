import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { checkpointVerificationMessage, validateCheckpointVerification } from "./verify-cloud-workspace-checkpoint.js";

function input() {
  return { databaseUrl: "postgres://fixture@localhost/fixture_alpha", channel: "alpha", railwayEnvironmentName: "alpha",
    organizationId: randomUUID(), expectedOrganizationSlug: "fixture", actorUserId: randomUUID(), workspaceId: randomUUID(), verify: false };
}
describe("checkpoint proof operator guards", () => {
  it("defaults to a metadata plan and binds one exact workspace and target", () => {
    const value = input();
    expect(validateCheckpointVerification(value)).toMatchObject({ channel: "alpha", verify: false,
      organizationId: value.organizationId, workspaceId: value.workspaceId });
    expect(validateCheckpointVerification({ ...value, databaseUrl: value.databaseUrl.replace("fixture_alpha", "another") }).targetFingerprint)
      .not.toBe(validateCheckpointVerification(value).targetFingerprint);
  });
  it.each(["development", "beta", "production", undefined])("refuses %s channel", channel => {
    expect(() => validateCheckpointVerification({ ...input(), channel })).toThrow(/Alpha/);
  });
  it.each(["beta", "production", undefined])("refuses %s deployment", railwayEnvironmentName => {
    expect(() => validateCheckpointVerification({ ...input(), railwayEnvironmentName })).toThrow(/Alpha/);
  });
  it.each(["organizationId", "actorUserId", "workspaceId", "expectedOrganizationSlug"] as const)("requires exact %s", field => {
    expect(() => validateCheckpointVerification({ ...input(), [field]: "" })).toThrow();
  });
  it.each(["fixture--team", "legacy_fixture", "组织"])("preserves the persisted Organization slug %s for the exact database match", expectedOrganizationSlug => {
    expect(validateCheckpointVerification({ ...input(), expectedOrganizationSlug }).expectedOrganizationSlug).toBe(expectedOrganizationSlug);
  });
  it("rejects database routing overrides and suppresses driver/provider error text", () => {
    expect(() => validateCheckpointVerification({ ...input(), databaseUrl: "postgres://fixture@localhost/fixture?host=elsewhere" })).toThrow();
    expect(checkpointVerificationMessage(new Error("fixture credential-bearing provider body")))
      .toBe("Checkpoint verification failed; no database or provider details are printed");
  });
});
