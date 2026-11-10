import { describe, expect, it } from "vitest";
import {
  cloudWorkspacePageUrl,
  numberedCloudWorkspacePageUrl,
  organizationDashboardUrl,
} from "../organization-links";

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

describe("cloud workspace page links", () => {
  const id = "6e3a9d2b-4c8f-4a01-b7e5-0d2f3c8a9b46";

  it("links the web workspace page on the configured origin", () => {
    expect(cloudWorkspacePageUrl("https://app-alpha.zeros.build/", id)).toBe(
      `https://app-alpha.zeros.build/workspace/${id}`,
    );
    expect(cloudWorkspacePageUrl("https://preview.example/base?x=1#y", id.toUpperCase())).toBe(
      `https://preview.example/workspace/${id}`,
    );
  });

  it("falls back to the production origin for malformed or non-web configuration", () => {
    for (const base of ["not a url", "javascript:alert(1)", undefined])
      expect(cloudWorkspacePageUrl(base, id)).toBe(`https://app.zeros.build/workspace/${id}`);
  });

  it("refuses an id that is not a workspace UUID", () => {
    expect(() => cloudWorkspacePageUrl("https://app.zeros.build", "../ops")).toThrow();
  });
});

describe("numbered cloud workspace pages", () => {
  it("addresses a workspace by its organization's ID and number, and a chat by its session", () => {
    const address = { owner: "acme-labs", number: 310 };
    expect(numberedCloudWorkspacePageUrl("https://app-alpha.zeros.build/base?x=1#y", address)).toBe(
      "https://app-alpha.zeros.build/acme-labs/w/310",
    );
    expect(numberedCloudWorkspacePageUrl(undefined, address, "7e2b720c-ab56-441d-b189-6e7d1eb7a628")).toBe(
      "https://app.zeros.build/acme-labs/w/310?session=7e2b720c-ab56-441d-b189-6e7d1eb7a628",
    );
    expect(numberedCloudWorkspacePageUrl(undefined, address, "chat:1")).toBe(
      "https://app.zeros.build/acme-labs/w/310?session=chat%3A1",
    );
    for (const session of ["", "a/b", "a b", "a".repeat(201)])
      expect(() => numberedCloudWorkspacePageUrl(undefined, address, session)).toThrow();
  });
});
