import { describe, expect, it } from "vitest";

import { shouldLeaveBlockedDesignWorkspace } from "../design-workspace-access";

describe("blocked design-workspace route", () => {
  it("waits fail-closed while the staff identity is unresolved", () => {
    expect(
      shouldLeaveBlockedDesignWorkspace({
        workspaceRoute: true,
        designRequested: true,
        designActive: false,
        internalUserResolutionSettled: false,
      }),
    ).toBe(false);
  });

  it("leaves only after access has authoritatively settled off", () => {
    expect(
      shouldLeaveBlockedDesignWorkspace({
        workspaceRoute: true,
        designRequested: true,
        designActive: false,
        internalUserResolutionSettled: true,
      }),
    ).toBe(true);
  });

  it("never leaves an enabled design route or an unrelated route", () => {
    expect(
      shouldLeaveBlockedDesignWorkspace({
        workspaceRoute: true,
        designRequested: true,
        designActive: true,
        internalUserResolutionSettled: true,
      }),
    ).toBe(false);
    expect(
      shouldLeaveBlockedDesignWorkspace({
        workspaceRoute: false,
        designRequested: true,
        designActive: false,
        internalUserResolutionSettled: true,
      }),
    ).toBe(false);
  });
});
