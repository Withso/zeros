import { describe, expect, it } from "vitest";

import { permissionModeIdForDisplay } from "../permission-mode-display";

describe("permissionModeIdForDisplay", () => {
  it("keeps the persisted icon stable while a provider bind is reconciling", () => {
    expect(
      permissionModeIdForDisplay({
        status: "warming",
        liveModeId: "default",
        persistedModeId: "accept-edits",
        fallbackModeId: "auto",
      }),
    ).toBe("accept-edits");
  });

  it("uses authoritative live mode updates after the session becomes ready", () => {
    expect(
      permissionModeIdForDisplay({
        status: "ready",
        liveModeId: "default",
        persistedModeId: "accept-edits",
        fallbackModeId: "auto",
      }),
    ).toBe("default");
  });

  it("still shows the provider mode during warming when no preference exists", () => {
    expect(
      permissionModeIdForDisplay({
        status: "warming",
        liveModeId: "agent",
        persistedModeId: null,
        fallbackModeId: "auto",
      }),
    ).toBe("agent");
  });
});
