import { describe, expect, it } from "vitest";

import { shouldShowBlockedDesignModePlaceholder } from "../design-workspace-access";

describe("blocked design-mode route", () => {
  it("stays inert (no placeholder, no design UI) while staff identity is unresolved", () => {
    expect(
      shouldShowBlockedDesignModePlaceholder({
        workspaceRoute: true,
        designRequested: true,
        designActive: false,
        internalUserResolutionSettled: false,
      }),
    ).toBe(false);
  });

  it("shows the placeholder only after access has authoritatively settled off", () => {
    expect(
      shouldShowBlockedDesignModePlaceholder({
        workspaceRoute: true,
        designRequested: true,
        designActive: false,
        internalUserResolutionSettled: true,
      }),
    ).toBe(true);
  });

  it("never covers an enabled design route or an unrelated route", () => {
    expect(
      shouldShowBlockedDesignModePlaceholder({
        workspaceRoute: true,
        designRequested: true,
        designActive: true,
        internalUserResolutionSettled: true,
      }),
    ).toBe(false);
    expect(
      shouldShowBlockedDesignModePlaceholder({
        workspaceRoute: false,
        designRequested: true,
        designActive: false,
        internalUserResolutionSettled: true,
      }),
    ).toBe(false);
  });
});
