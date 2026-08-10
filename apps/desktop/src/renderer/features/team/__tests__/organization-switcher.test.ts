import { describe, expect, it } from "vitest";
import { organizationSwitcherSessionActions } from "../organization-switcher";

describe("organization switcher session actions", () => {
  it("never exposes account management or logout while signed out", () => {
    expect(organizationSwitcherSessionActions("unauthenticated")).toEqual({
      showManagement: false,
      sessionAction: "sign-in",
    });
  });

  it("shows authenticated management only for a confirmed session", () => {
    expect(organizationSwitcherSessionActions("authenticated")).toEqual({
      showManagement: true,
      sessionAction: "log-out",
    });
    expect(organizationSwitcherSessionActions("loading")).toEqual({
      showManagement: false,
      sessionAction: null,
    });
  });
});
