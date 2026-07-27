import { describe, expect, it } from "vitest";

import { isWorkspaceOpStillRunning } from "../git";

describe("workspace lifecycle transport errors", () => {
  it("observes sent requests whose response timed out or disconnected", () => {
    expect(
      isWorkspaceOpStillRunning(
        new Error("Request timeout: WORKSPACE_REQUEST"),
      ),
    ).toBe(true);
    expect(
      isWorkspaceOpStillRunning(
        new Error("Request timeout: engine disconnected"),
      ),
    ).toBe(true);
  });

  it("does not treat unsent reconnect queues as background operations", () => {
    expect(
      isWorkspaceOpStillRunning(
        new Error("Request timeout: WORKSPACE_REQUEST (reconnecting)"),
      ),
    ).toBe(false);
    expect(
      isWorkspaceOpStillRunning(
        new Error("Request timeout: WORKSPACE_REQUEST (queue full)"),
      ),
    ).toBe(false);
    expect(isWorkspaceOpStillRunning(new Error("engine unavailable"))).toBe(
      false,
    );
  });
});
