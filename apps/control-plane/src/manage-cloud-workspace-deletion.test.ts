import { describe, expect, it } from "vitest";
import {
  cloudWorkspaceDeletionErrorMessage,
  validateCloudWorkspaceDeletionRequest,
  type CloudWorkspaceDeletionRequestInput,
} from "./manage-cloud-workspace-deletion.js";

const input: CloudWorkspaceDeletionRequestInput = {
  databaseUrl: "postgres://operator:synthetic-password@database.example.test/cloud_test",
  channel: "alpha", execute: false,
  approvalId: "11111111-1111-4111-8111-111111111111",
  organizationId: "22222222-2222-4222-8222-222222222222",
  expectedOrganizationSlug: "sample-org",
  actorUserId: "33333333-3333-4333-8333-333333333333",
  workspaceIds: "55555555-5555-4555-8555-555555555555,44444444-4444-4444-8444-444444444444",
  reason: "Delete archived synthetic cloud workspaces",
};

describe("cloud workspace deletion operator input", () => {
  it("normalizes a bounded exact id set and keeps configuration and output free of database credentials", () => {
    const parsed = validateCloudWorkspaceDeletionRequest(input);
    expect(parsed).toMatchObject({ execute: false, allowRunning: false, channel: "alpha", workspaceIds: [
      "44444444-4444-4444-8444-444444444444", "55555555-5555-4555-8555-555555555555",
    ] });
    expect(parsed.targetFingerprint).toMatch(/^[a-f0-9]{16}$/);
    expect(JSON.stringify(parsed)).not.toContain("synthetic-password");
    expect(JSON.stringify(parsed)).not.toContain("database.example.test");
    expect(cloudWorkspaceDeletionErrorMessage(new Error("sensitive driver detail synthetic-password")))
      .not.toContain("synthetic-password");
  });

  it("binds the fingerprint to the database routing and login, independently of password rotation", () => {
    const fingerprint = validateCloudWorkspaceDeletionRequest(input).targetFingerprint;
    expect(validateCloudWorkspaceDeletionRequest({ ...input,
      databaseUrl: "postgres://operator:rotated-synthetic-password@database.example.test:5432/cloud_test",
    }).targetFingerprint).toBe(fingerprint);
    for (const databaseUrl of [
      "postgres://another@database.example.test/cloud_test", "postgres://operator@elsewhere.example.test/cloud_test",
      "postgres://operator@database.example.test:5433/cloud_test", "postgres://operator@database.example.test/another_test",
    ]) expect(validateCloudWorkspaceDeletionRequest({ ...input, databaseUrl }).targetFingerprint).not.toBe(fingerprint);
    expect(validateCloudWorkspaceDeletionRequest({ ...input, channel: "beta" }).targetFingerprint).not.toBe(fingerprint);
  });

  it.each([undefined, "", "production", "Production", "staging"])("refuses an invalid or Production channel: %s", channel => {
    expect(() => validateCloudWorkspaceDeletionRequest({ ...input, channel })).toThrow();
  });

  it("refuses deployment/channel disagreement", () => {
    expect(() => validateCloudWorkspaceDeletionRequest({ ...input, railwayEnvironmentName: "beta" }))
      .toThrow("RAILWAY_ENVIRONMENT_NAME");
  });

  it.each([undefined, "", "all", "*", "/tmp/local-workspace", "cloud://sample/workspace",
    "44444444-4444-4444-8444-444444444444,44444444-4444-4444-8444-444444444444"])(
    "requires explicit non-repeated cloud UUIDs: %s", workspaceIds => {
      expect(() => validateCloudWorkspaceDeletionRequest({ ...input, workspaceIds })).toThrow(/workspace|UUID/i);
    },
  );

  it.each([undefined, "short", "x".repeat(513)])("requires an audit reason of 16–512 characters", reason => {
    expect(() => validateCloudWorkspaceDeletionRequest({ ...input, reason })).toThrow(/reason|16.*512/i);
  });

  it.each(["approvalId", "organizationId", "actorUserId"] as const)("requires a concrete %s", field => {
    expect(() => validateCloudWorkspaceDeletionRequest({ ...input, [field]: undefined })).toThrow(/UUID/i);
  });

  it("rejects driver routing overrides without echoing the URL", () => {
    expect(() => validateCloudWorkspaceDeletionRequest({ ...input,
      databaseUrl: `${input.databaseUrl}?host=another.example.test`,
    })).toThrow(/DATABASE_URL/);
    try {
      validateCloudWorkspaceDeletionRequest({ ...input, databaseUrl: `invalid:${input.databaseUrl}` });
    } catch (error) {
      expect(cloudWorkspaceDeletionErrorMessage(error)).not.toContain("synthetic-password");
    }
  });
});
