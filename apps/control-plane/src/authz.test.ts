import { describe, expect, it } from "vitest";

import {
  canCreateOrganization,
  requireOrganizationCreationCapability,
  requireStaffRole,
} from "./authz.js";

describe("staff capability boundaries", () => {
  it("allows only the exact staff role requested by a privileged operation", () => {
    expect(requireStaffRole("support_admin", "support_admin")).toBe(
      "support_admin",
    );

    for (const role of [null, "developer"] as const) {
      expect(() => requireStaffRole(role, "support_admin")).toThrow(
        expect.objectContaining({ status: 404, code: "not_found" }),
      );
    }
  });

  it("allows organization creation only with an active Pro entitlement", () => {
    expect(canCreateOrganization(true)).toBe(true);
    expect(canCreateOrganization(false)).toBe(false);
    expect(() => requireOrganizationCreationCapability(true)).not.toThrow();
    expect(() => requireOrganizationCreationCapability(false)).toThrow(
      expect.objectContaining({ status: 403, code: "pro_required" }),
    );
  });
});
