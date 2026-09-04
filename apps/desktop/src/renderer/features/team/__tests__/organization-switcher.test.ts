import { describe, expect, it } from "vitest";
import { organizationSwitcherSessionActions } from "../organization-switcher";

describe("organization switcher session actions", () => {
  it("never exposes account management or logout while signed out", () => {
    expect(organizationSwitcherSessionActions("unauthenticated", true)).toEqual(
      {
        showManagement: false,
        showCreateOrganization: false,
        sessionAction: "sign-in",
      },
    );
  });

  it("shows organization creation only for a confirmed capable session", () => {
    expect(organizationSwitcherSessionActions("authenticated", false)).toEqual({
      showManagement: true,
      showCreateOrganization: false,
      sessionAction: "log-out",
    });
    expect(organizationSwitcherSessionActions("authenticated", true)).toEqual({
      showManagement: true,
      showCreateOrganization: true,
      sessionAction: "log-out",
    });
    expect(organizationSwitcherSessionActions("loading", true)).toEqual({
      showManagement: false,
      showCreateOrganization: false,
      sessionAction: null,
    });
  });
});
