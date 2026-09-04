import { describe, expect, it } from "vitest";

import { securityNotificationContent } from "./security-notification-outbox.js";

describe("customer deletion notifications", () => {
  it("renders the fixed 30-day account recovery notice and validated locator", () => {
    const content = securityNotificationContent("account_deletion_scheduled", {
      recovery_code: "ZD-ABCD-2345",
      purge_after: "2026-10-01T00:00:00.000Z",
    });
    expect(content.subject).toContain("scheduled for deletion");
    expect(content.html).toContain("30 days");
    expect(content.html).toContain("ZD-ABCD-2345");
  });

  it("never reflects an invalid locator or arbitrary payload markup", () => {
    const content = securityNotificationContent(
      "organization_deletion_scheduled",
      {
        recovery_code: '<img src=x onerror="alert(1)">',
        arbitrary: "<script>alert(1)</script>",
      },
    );
    expect(content.html).not.toContain("<script>");
    expect(content.html).not.toContain("onerror");
  });
});
