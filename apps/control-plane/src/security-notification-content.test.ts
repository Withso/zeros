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
    expect(content.html).toContain('href="mailto:hi@zeros.build"');
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

describe("cloud workspaces archived notice (retention S3)", () => {
  it("lists the workspaces by name, escaped and bounded, counts the rest, and says when backups go", () => {
    const content = securityNotificationContent("cloud_workspaces_archived", {
      run: "r", workspaces: [{ name: "<img src=x onerror=alert(1)>", organization: "Acme & Co" }, { name: "api", organization: "Acme & Co" }],
      more: 3, backupRemovalAt: "2027-01-20T00:00:00.000Z",
    });
    expect(content.subject).toBe("Inactive Zeros cloud workspaces were archived");
    expect(content.html).not.toContain("<img");
    expect(content.html).toContain("&#60;img src=x onerror=alert(1)&#62;");
    expect(content.html).toContain("Acme &#38; Co");
    expect(content.html).toContain("and 3 more");
    expect(content.html).toContain("2027-01-20");
    expect(content.html).toContain("30 days");
  });

  it("reflects nothing malformed", () => {
    const content = securityNotificationContent("cloud_workspaces_archived", {
      workspaces: [{ name: 1 }, "x", null], more: "lots", backupRemovalAt: "<b>soon</b>",
    });
    expect(content.html).not.toContain("lots");
    expect(content.html).not.toContain("<b>");
  });
});
