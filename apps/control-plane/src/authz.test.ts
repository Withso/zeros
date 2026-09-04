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

  it("allows organization creation only for standing Zeros staff roles", () => {
    expect(canCreateOrganization("platform_owner")).toBe(true);
    expect(canCreateOrganization("developer")).toBe(true);
    expect(canCreateOrganization("support_admin")).toBe(false);
    expect(canCreateOrganization(null)).toBe(false);

    expect(requireOrganizationCreationCapability("platform_owner")).toBe(
      "platform_owner",
    );
    expect(requireOrganizationCreationCapability("developer")).toBe(
      "developer",
    );
    for (const role of [null, "support_admin"] as const) {
      expect(() => requireOrganizationCreationCapability(role)).toThrow(
        expect.objectContaining({ status: 404, code: "not_found" }),
      );
    }
  });
});
