import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  CloudWorkspaceObjectRotationManagementError,
  cloudWorkspaceObjectRotationRetryApprovalText,
  validateCloudWorkspaceObjectRotationRetry,
} from "./manage-cloud-workspace-object-rotation.js";

const databaseUrl = "postgres://db.example.test:5432/zeros_alpha";
const key1 = randomBytes(32).toString("base64url");
const key2 = randomBytes(32).toString("base64url");

function request(
  overrides: Partial<
    Parameters<typeof validateCloudWorkspaceObjectRotationRetry>[0]
  > = {},
) {
  return validateCloudWorkspaceObjectRotationRetry({
    databaseUrl,
    channel: "alpha",
    railwayEnvironmentName: "alpha",
    execute: false,
    productionConfirmed: undefined,
    approval: undefined,
    organizationId: "00000000-0000-4000-8000-000000000001",
    expectedOrganizationSlug: "acme-engineering",
    blobId: "00000000-0000-4000-8000-000000000002",
    targetKeyVersion: "2",
    actorUserId: "00000000-0000-4000-8000-000000000003",
    reason: "Retry the reviewed terminal Alpha object-key rotation.",
    objectKeysJson: JSON.stringify({ 1: key1, 2: key2 }),
    currentObjectKeyVersion: "2",
    ...overrides,
  });
}

describe("cloud-workspace object-rotation retry owner command", () => {
  it("binds approval to the exact deployment, actor, blob, key, snapshot, and reason", () => {
    const validated = request();
    expect(
      cloudWorkspaceObjectRotationRetryApprovalText(
        validated,
        "a".repeat(32),
      ),
    ).toMatch(
      /^cloud-object-rotation-retry:v1:alpha:[a-f0-9]{16}:00000000-0000-4000-8000-000000000001:00000000-0000-4000-8000-000000000003:00000000-0000-4000-8000-000000000002:k2:a{32}:[a-f0-9]{12}$/,
    );
  });

  it("fails closed on unsafe targets, keyrings, channels, and production execution", () => {
    for (const overrides of [
      { organizationId: "not-a-uuid" },
      { blobId: "not-a-uuid" },
      { actorUserId: "not-a-uuid" },
      { targetKeyVersion: "0" },
      { targetKeyVersion: "65536", currentObjectKeyVersion: "65536" },
      { currentObjectKeyVersion: "3" },
      { railwayEnvironmentName: "production" },
      { expectedOrganizationSlug: "" },
      { reason: "too short" },
      { objectKeysJson: "not-json" },
      { objectKeysJson: JSON.stringify({ 1: key1 }) },
      { objectKeysJson: JSON.stringify({ 1: "not-a-key", 2: key2 }) },
      {
        objectKeyV1: randomBytes(32).toString("base64url"),
        objectKeysJson: JSON.stringify({ 1: key1, 2: key2 }),
      },
      { objectKeysJson: `{${" ".repeat(16 * 1024)}}` },
    ]) {
      expect(() => request(overrides)).toThrow(
        CloudWorkspaceObjectRotationManagementError,
      );
    }
    expect(() =>
      request({
        channel: "production",
        railwayEnvironmentName: "production",
        execute: true,
      }),
    ).toThrow(/production confirmation/i);
  });

  it("accepts the compatible V1 key plus a versioned target keyring", () => {
    expect(() =>
      request({
        objectKeyV1: key1,
        objectKeysJson: JSON.stringify({ 2: key2 }),
      }),
    ).not.toThrow();
  });
});
