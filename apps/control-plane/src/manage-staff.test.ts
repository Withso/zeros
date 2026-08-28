import { describe, expect, it } from "vitest";

import {
  StaffManagementError,
  staffRoleApprovalText,
  validateStaffRoleRequest,
} from "./manage-staff.js";

const databaseUrl = "postgres://db.example.test:5432/zeros_alpha";
const subjectUserId = "00000000-0000-4000-8000-000000000001";
const actorUserId = "00000000-0000-4000-8000-000000000002";

function request(
  overrides: Partial<Parameters<typeof validateStaffRoleRequest>[0]> = {},
) {
  return validateStaffRoleRequest({
    databaseUrl,
    channel: "alpha",
    railwayEnvironmentName: "alpha",
    execute: false,
    productionConfirmed: undefined,
    approval: undefined,
    subjectUserId,
    expectedEmail: "support@example.test",
    actorUserId,
    nextRole: "support_admin",
    reason: "Bootstrap the reviewed recovery operator.",
    ...overrides,
  });
}

describe("staff-role owner command", () => {
  it("binds approval to the database, channel, actors, transition, and reason", () => {
    const validated = request();
    const approval = staffRoleApprovalText(validated, null);

    expect(approval).toMatch(
      /^staff:alpha:[a-f0-9]{16}:00000000-0000-4000-8000-000000000001:00000000-0000-4000-8000-000000000002:none:support_admin:[a-f0-9]{12}$/,
    );
    expect(approval).not.toContain("support@example.test");
    expect(approval).not.toContain("Bootstrap");
    expect(staffRoleApprovalText(validated, "developer")).not.toBe(approval);
  });

  it("fails closed on channel mismatch and production execution without a second acknowledgement", () => {
    expect(() => request({ railwayEnvironmentName: "production" })).toThrow(
      StaffManagementError,
    );

    expect(() =>
      request({
        channel: "production",
        railwayEnvironmentName: "production",
        execute: true,
      }),
    ).toThrow(/production confirmation/i);
  });

  it("requires exact bounded identities, email, role, and audit reason", () => {
    expect(() => request({ subjectUserId: "not-a-uuid" })).toThrow(
      StaffManagementError,
    );
    expect(() => request({ expectedEmail: "not-an-email" })).toThrow(
      StaffManagementError,
    );
    expect(() => request({ nextRole: "owner" })).toThrow(StaffManagementError);
    expect(() => request({ reason: "too short" })).toThrow(
      StaffManagementError,
    );
  });
});
