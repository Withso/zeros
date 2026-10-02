import { describe, expect, it } from "vitest";
import { staffRoleApprovalText, validateStaffRoleRequest } from "./manage-staff.js";

const subjectUserId = "11111111-1111-4111-8111-111111111111";
const actorUserId = "22222222-2222-4222-8222-222222222222";
const ownerOrganizationId = "33333333-3333-4333-8333-333333333333";
const base = {
  databaseUrl: "postgresql://operator@database.test/postgres",
  channel: "beta", execute: false, subjectUserId, actorUserId,
  expectedEmail: "owner@example.test", nextRole: "platform_owner",
  reason: "Bootstrap the reviewed Beta organization owner.",
};

describe("optional staff organization ownership requirement", () => {
  it("leaves the existing request shape and approval unchanged when absent", () => {
    const request = validateStaffRoleRequest(base);
    expect(request).not.toHaveProperty("ownerOrganizationId");
    const approval = staffRoleApprovalText(request, null);
    expect(approval.split(":")).toHaveLength(8);
    expect(staffRoleApprovalText(validateStaffRoleRequest({ ...base }), null)).toBe(approval);
  });

  it("retains the exact supplied UUID and binds it into the approval", () => {
    const request = validateStaffRoleRequest({ ...base, ownerOrganizationId });
    expect(request).toHaveProperty("ownerOrganizationId", ownerOrganizationId);
    const approval = staffRoleApprovalText(request, null);
    expect(approval).toContain(ownerOrganizationId);
    expect(approval).not.toBe(staffRoleApprovalText(validateStaffRoleRequest(base), null));
    expect(approval).not.toBe(staffRoleApprovalText(validateStaffRoleRequest({
      ...base, ownerOrganizationId: "44444444-4444-4444-8444-444444444444",
    }), null));
  });

  it.each(["", "not-a-uuid", "33333333-3333-4333-8333-333333333333:another-org"])("refuses malformed organization %s", ownerOrganizationId => {
    expect(() => validateStaffRoleRequest({ ...base, ownerOrganizationId })).toThrow("Organization");
  });
});
