import { describe, expect, it } from "vitest";
import { organizationDashboardUrl } from "../organization-links";

describe("organization dashboard links", () => {
  it("opens a selected organization section on the web dashboard", () => {
    expect(
      organizationDashboardUrl("https://preview.example/base", {
        organizationId: "6dfb8df2-a31d-42e1-b95f-c37a90f24955",
        section: "members",
      }),
    ).toBe(
      "https://preview.example/?organization=6dfb8df2-a31d-42e1-b95f-c37a90f24955&section=members",
    );
  });

  it("falls back to the production origin for malformed configuration", () => {
    expect(
      organizationDashboardUrl("not a url", {
        action: "create-organization",
      }),
    ).toBe("https://app.zeros.build/?action=create-organization");
  });

  it("never opens a non-web scheme from build configuration", () => {
    expect(
      organizationDashboardUrl("javascript:alert(1)", {
        section: "profile",
      }),
    ).toBe("https://app.zeros.build/?section=profile");
    expect(organizationDashboardUrl("file:///tmp/fake-dashboard")).toBe(
      "https://app.zeros.build/",
    );
  });
});
