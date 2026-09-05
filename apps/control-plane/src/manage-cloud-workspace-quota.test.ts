import { describe, expect, it } from "vitest";

import {
  CloudWorkspaceQuotaManagementError,
  cloudWorkspaceQuotaApprovalText,
  validateCloudWorkspaceQuotaRequest,
} from "./manage-cloud-workspace-quota.js";

const databaseUrl = "postgres://db.example.test:5432/zeros_alpha";
const organizationId = "00000000-0000-4000-8000-000000000001";
const actorUserId = "00000000-0000-4000-8000-000000000002";

function request(
  overrides: Partial<
    Parameters<typeof validateCloudWorkspaceQuotaRequest>[0]
  > = {},
) {
  return validateCloudWorkspaceQuotaRequest({
    databaseUrl,
    channel: "alpha",
    railwayEnvironmentName: "alpha",
    execute: false,
    productionConfirmed: undefined,
    approval: undefined,
    organizationId,
    expectedOrganizationSlug: "acme-engineering",
    actorUserId,
    maxWorkspaces: "8",
    maxRunningWorkspaces: "4",
    maxCpuMillicores: "16000",
    maxMemoryMiB: "32768",
    maxStorageMiB: "163840",
    reason: "Approve the reviewed Alpha cloud workspace pilot quota.",
    ...overrides,
  });
}

describe("cloud-workspace quota owner command", () => {
  it("binds approval to the database, channel, organization, actor, transition, and reason", () => {
    const validated = request();
    const approval = cloudWorkspaceQuotaApprovalText(validated, null);

    expect(approval).toMatch(
      /^cloud-quota:alpha:[a-f0-9]{16}:00000000-0000-4000-8000-000000000001:00000000-0000-4000-8000-000000000002:none:8,4,16000,32768,163840:[a-f0-9]{12}$/,
    );
    expect(approval).not.toContain("acme-engineering");
    expect(approval).not.toContain("Approve the reviewed");
    expect(
      cloudWorkspaceQuotaApprovalText(validated, {
        maxWorkspaces: 5,
        maxRunningWorkspaces: 2,
        maxCpuMillicores: 10_000,
        maxMemoryMiB: 20_480,
        maxStorageMiB: 102_400,
      }),
    ).not.toBe(approval);
  });

  it("fails closed on channel mismatch and production execution without a second acknowledgement", () => {
    expect(() => request({ railwayEnvironmentName: "production" })).toThrow(
      CloudWorkspaceQuotaManagementError,
    );

    expect(() =>
      request({
        channel: "production",
        railwayEnvironmentName: "production",
        execute: true,
      }),
    ).toThrow(/production confirmation/i);
  });

  it("requires exact identities, slug, bounded quota values, and audit reason", () => {
    expect(() => request({ organizationId: "not-a-uuid" })).toThrow(
      CloudWorkspaceQuotaManagementError,
    );
    expect(() => request({ expectedOrganizationSlug: "" })).toThrow(
      CloudWorkspaceQuotaManagementError,
    );
    expect(() => request({ actorUserId: "not-a-uuid" })).toThrow(
      CloudWorkspaceQuotaManagementError,
    );
    expect(() => request({ maxWorkspaces: "0" })).toThrow(
      CloudWorkspaceQuotaManagementError,
    );
    expect(() =>
      request({ maxWorkspaces: "2", maxRunningWorkspaces: "3" }),
    ).toThrow(/running workspace/i);
    expect(() => request({ maxCpuMillicores: "249" })).toThrow(
      CloudWorkspaceQuotaManagementError,
    );
    expect(() => request({ reason: "too short" })).toThrow(
      CloudWorkspaceQuotaManagementError,
    );
  });
});
