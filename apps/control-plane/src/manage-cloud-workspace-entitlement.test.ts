import { describe, expect, it } from "vitest";

import {
  CloudWorkspaceEntitlementManagementError,
  cloudWorkspaceEntitlementApprovalText,
  validateCloudWorkspaceEntitlementRequest,
  type CloudWorkspaceEntitlementSnapshot,
} from "./manage-cloud-workspace-entitlement.js";

const databaseUrl = "postgres://db.example.test:5432/zeros_alpha";
const organizationId = "00000000-0000-4000-8000-000000000001";
const actorUserId = "00000000-0000-4000-8000-000000000002";
const ownerUserId = "00000000-0000-4000-8000-000000000003";
const memberUserId = "00000000-0000-4000-8000-000000000004";

function request(
  overrides: Partial<
    Parameters<typeof validateCloudWorkspaceEntitlementRequest>[0]
  > = {},
) {
  return validateCloudWorkspaceEntitlementRequest({
    databaseUrl,
    channel: "alpha",
    railwayEnvironmentName: "alpha",
    execute: false,
    productionConfirmed: undefined,
    approval: undefined,
    organizationId,
    expectedOrganizationSlug: "acme-engineering",
    actorUserId,
    plan: "business",
    status: "active",
    validFrom: "2026-01-01T00:00:00Z",
    validUntil: "2030-01-01T00:00:00Z",
    seatLimit: "2",
    activeSeatUserIds: `${memberUserId},${ownerUserId}`,
    reason: "Activate the reviewed Alpha Organization entitlement.",
    ...overrides,
  });
}

describe("cloud-workspace Organization entitlement owner command", () => {
  it("canonicalizes explicit seats and binds approval to every authority input and current state", () => {
    const validated = request();
    expect(validated.next.activeSeatUserIds).toEqual([
      ownerUserId,
      memberUserId,
    ]);

    const approval = cloudWorkspaceEntitlementApprovalText(validated, null);
    expect(approval).toMatch(
      /^cloud-entitlement:alpha:[a-f0-9]{16}:00000000-0000-4000-8000-000000000001:00000000-0000-4000-8000-000000000002:none:[a-f0-9]{32}:[a-f0-9]{12}$/,
    );
    expect(approval).not.toContain("acme-engineering");
    expect(approval).not.toContain(ownerUserId);
    expect(approval).not.toContain("Activate the reviewed");

    const previous: CloudWorkspaceEntitlementSnapshot = {
      plan: "business",
      status: "trialing",
      cloudWorkspacesAllowed: true,
      seatLimit: 2,
      source: "operator",
      sourceReference: "operator:alpha:0123456789abcdef",
      validFrom: "2025-01-01T00:00:00.000Z",
      validUntil: "2027-01-01T00:00:00.000Z",
      revision: 1,
      activeSeatUserIds: [ownerUserId],
    };
    expect(cloudWorkspaceEntitlementApprovalText(validated, previous)).not.toBe(
      approval,
    );
    expect(
      cloudWorkspaceEntitlementApprovalText(
        request({ status: "trialing" }),
        null,
      ),
    ).not.toBe(approval);
    expect(
      cloudWorkspaceEntitlementApprovalText(
        request({ activeSeatUserIds: ownerUserId }),
        null,
      ),
    ).not.toBe(approval);
    expect(
      cloudWorkspaceEntitlementApprovalText(
        request({ validUntil: "none" }),
        null,
      ),
    ).not.toBe(approval);
    expect(
      cloudWorkspaceEntitlementApprovalText(
        request({
          databaseUrl: "postgres://other.example.test:5432/zeros_alpha",
        }),
        null,
      ),
    ).not.toBe(approval);
    expect(
      cloudWorkspaceEntitlementApprovalText(
        request({ channel: "beta", railwayEnvironmentName: "beta" }),
        null,
      ),
    ).not.toBe(approval);
    expect(
      cloudWorkspaceEntitlementApprovalText(
        request({
          organizationId: "00000000-0000-4000-8000-000000000005",
        }),
        null,
      ),
    ).not.toBe(approval);
    expect(
      cloudWorkspaceEntitlementApprovalText(
        request({ actorUserId: "00000000-0000-4000-8000-000000000006" }),
        null,
      ),
    ).not.toBe(approval);
    expect(
      cloudWorkspaceEntitlementApprovalText(
        request({ plan: "enterprise" }),
        null,
      ),
    ).not.toBe(approval);
    expect(
      cloudWorkspaceEntitlementApprovalText(request({ seatLimit: "3" }), null),
    ).not.toBe(approval);
    expect(
      cloudWorkspaceEntitlementApprovalText(
        request({
          reason: "Activate the separately reviewed Beta Organization plan.",
        }),
        null,
      ),
    ).not.toBe(approval);
    expect(
      cloudWorkspaceEntitlementApprovalText(validated, {
        ...previous,
        revision: 2,
      }),
    ).not.toBe(cloudWorkspaceEntitlementApprovalText(validated, previous));
  });

  it("fails closed on channel mismatch and production execution without a second acknowledgement", () => {
    expect(() => request({ railwayEnvironmentName: "production" })).toThrow(
      CloudWorkspaceEntitlementManagementError,
    );
    expect(() =>
      request({
        channel: "production",
        railwayEnvironmentName: "production",
        execute: true,
      }),
    ).toThrow(/production confirmation/i);
  });

  it("requires exact identities, an activation state, explicit validity, seats, and reason", () => {
    expect(() => request({ organizationId: "not-a-uuid" })).toThrow(
      CloudWorkspaceEntitlementManagementError,
    );
    expect(() => request({ expectedOrganizationSlug: "" })).toThrow(
      CloudWorkspaceEntitlementManagementError,
    );
    expect(() => request({ actorUserId: "not-a-uuid" })).toThrow(
      CloudWorkspaceEntitlementManagementError,
    );
    expect(() => request({ plan: "free" })).toThrow(/plan/i);
    expect(() => request({ status: "past_due" })).toThrow(/status/i);
    expect(() => request({ validFrom: "tomorrow" })).toThrow(/valid_from/i);
    expect(() =>
      request({
        validFrom: "2030-01-01T00:00:00Z",
        validUntil: "2029-01-01T00:00:00Z",
      }),
    ).toThrow(/valid_until/i);
    expect(() => request({ seatLimit: "0" })).toThrow(/seat_limit/i);
    expect(() => request({ activeSeatUserIds: "none" })).toThrow(/seat/i);
    expect(() =>
      request({ activeSeatUserIds: `${ownerUserId},${ownerUserId}` }),
    ).toThrow(/duplicate/i);
    expect(() => request({ activeSeatUserIds: "not-a-uuid" })).toThrow(/seat/i);
    expect(() => request({ seatLimit: "1" })).toThrow(/seat limit/i);
    expect(() => request({ reason: "too short" })).toThrow(
      CloudWorkspaceEntitlementManagementError,
    );
  });

  it("requires Pro activation to state that seats and seat limit are absent", () => {
    expect(() =>
      request({ plan: "pro", seatLimit: "2", activeSeatUserIds: "none" }),
    ).toThrow(/seat_limit=none/i);
    expect(() =>
      request({
        plan: "pro",
        seatLimit: "none",
        activeSeatUserIds: ownerUserId,
      }),
    ).toThrow(/active_seat_user_ids=none/i);

    expect(
      request({
        plan: "pro",
        seatLimit: "none",
        activeSeatUserIds: "none",
      }).next,
    ).toMatchObject({
      plan: "pro",
      seatLimit: null,
      activeSeatUserIds: [],
    });
  });
});
