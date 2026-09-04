import { describe, expect, it } from "vitest";

import {
  CloudWorkspaceObjectStorageManagementError,
  cloudWorkspaceObjectStorageApprovalText,
  validateCloudWorkspaceObjectStorageRequest,
} from "./manage-cloud-workspace-object-storage.js";

const databaseUrl = "postgres://db.example.test:5432/zeros_alpha";

function request(
  overrides: Partial<
    Parameters<typeof validateCloudWorkspaceObjectStorageRequest>[0]
  > = {},
) {
  return validateCloudWorkspaceObjectStorageRequest({
    databaseUrl,
    channel: "alpha",
    railwayEnvironmentName: "alpha",
    execute: false,
    productionConfirmed: undefined,
    approval: undefined,
    organizationId: "00000000-0000-4000-8000-000000000001",
    expectedOrganizationSlug: "acme-engineering",
    actorUserId: "00000000-0000-4000-8000-000000000002",
    maxOrganizationBytes: "107374182400",
    maxWorkspaceBytes: "10737418240",
    reason: "Approve the reviewed Alpha durable object-storage limits.",
    ...overrides,
  });
}

describe("cloud-workspace object-storage owner command", () => {
  it("target-binds approval independently from provider disk quota", () => {
    const validated = request();
    expect(cloudWorkspaceObjectStorageApprovalText(validated, null)).toMatch(
      /^cloud-object-storage:alpha:[a-f0-9]{16}:00000000-0000-4000-8000-000000000001:00000000-0000-4000-8000-000000000002:none:107374182400,10737418240:[a-f0-9]{12}$/,
    );
  });

  it("fails closed on unsafe identities, limits, channels, and production execution", () => {
    for (const overrides of [
      { organizationId: "not-a-uuid" },
      { actorUserId: "not-a-uuid" },
      { maxOrganizationBytes: "0" },
      { maxWorkspaceBytes: "9007199254740992" },
      { railwayEnvironmentName: "production" },
      { reason: "too short" },
    ]) {
      expect(() => request(overrides)).toThrow(
        CloudWorkspaceObjectStorageManagementError,
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

  it("rejects a workspace ceiling above its Organization ceiling", () => {
    expect(() =>
      request({
        maxOrganizationBytes: "67108864",
        maxWorkspaceBytes: "67108865",
      }),
    ).toThrow(/workspace.*must not exceed.*organization/i);
  });
});
