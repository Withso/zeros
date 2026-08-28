import { describe, expect, it } from "vitest";

import { requireStaffRole } from "./authz.js";

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
});
